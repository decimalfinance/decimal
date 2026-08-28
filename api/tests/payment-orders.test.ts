import assert from 'node:assert/strict';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../src/app.js';
import { prisma } from '../src/infra/prisma.js';
import { requireTestDatabase } from './helpers/require-test-database.js';
import { setInvoiceIntakeRuntimeForTests } from '../src/payments/invoice-intake.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  auth_sessions,
  organization_wallet_authorizations,
  spending_limit_executions,
  spending_limit_policy_destinations,
  spending_limit_policies,
  agent_wallets,
  automation_agents,
  user_wallets,
  organization_invites,
  organization_memberships,
  execution_records,
  transfer_request_notes,
  transfer_request_events,
  payment_order_events,
  decimal_proposals,
  payment_orders,
  transfer_requests,
  counterparty_wallets,
  counterparties,
  treasury_wallets,
  inbound_email_attachments,
  inbound_email_messages,
  organizations,
  users
RESTART IDENTITY CASCADE
`;

let baseUrl = '';
let closeServer: (() => Promise<void>) | undefined;

before(async () => {
  await prisma.$connect();
  await requireTestDatabase();
  const app = createApp();
  const server = app.listen(0);

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  closeServer = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };
});

beforeEach(async () => {
  // Drain detached intake before truncating: the previous test's extraction
  // must not still be running against tables this one is wiping.
  await drainAsyncIntake();
  setInvoiceIntakeRuntimeForTests(null);
  await executeWithDeadlockRetry(() => prisma.$executeRawUnsafe(TRUNCATE_SQL));
});

after(async () => {
  if (closeServer) {
    await closeServer();
  }
  await prisma.$disconnect();
});

test('manual payment orders are the single payment intent entity', async () => {
  const setup = await createPaymentOrderSetup();

  const paymentOrder = await post(
    `/organizations/${setup.organization.organizationId}/payment-orders`,
    {
      counterpartyWalletId: setup.counterpartyWallet.counterpartyWalletId,
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      amountRaw: '10000',
      memo: 'Invoice 1234 payout',
      externalReference: 'INV-1234',
      invoiceNumber: '1234',
      sourceBalanceSnapshotJson: {
        status: 'known',
        balanceRaw: '25000',
        observedAt: '2026-04-10T12:00:00.000Z',
      },
    },
    setup.sessionToken,
  );

  assert.equal(paymentOrder.memo, 'Invoice 1234 payout');
  assert.equal(paymentOrder.externalReference, 'INV-1234');
  assert.equal(paymentOrder.state, 'submitted');
  assert.equal(paymentOrder.derivedState, 'submitted');
  assert.equal(paymentOrder.inputBatchId, null);
  assert.equal(paymentOrder.transferRequests.length, 0);
  assert.equal(paymentOrder.balanceWarning.status, 'sufficient');
});

test('invoice upload parks every bill in review; clearing review advances it', async () => {
  const setup = await createPaymentOrderSetup();
  const newVendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [
        {
          counterparty: setup.counterpartyWallet.label,
          amount: 0.01,
          currency: 'USDC',
          reference: 'INV-UPLOAD-TRUSTED',
          due_date: '2026-04-15',
          wallet_address: setup.counterpartyWallet.walletAddress,
          notes: 'April services',
        },
        {
          counterparty: 'New Review Vendor',
          amount: 0.02,
          currency: 'USDC',
          reference: 'INV-UPLOAD-REVIEW',
          due_date: '2026-04-18',
          wallet_address: newVendorWallet,
          notes: null,
        },
      ],
      modelLatencyMs: 7,
      pageCount: 1,
    }),
  });

  const result = await post(
    `/organizations/${setup.organization.organizationId}/invoices/upload`,
    {
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('fake-pdf').toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );

  assert.equal(result.createdCount, 2);
  assert.equal(result.skippedCount, 0);
  // Review is mandatory for every uploaded bill — trusted vendor or not.
  assert.equal(result.paymentOrders[0].decision, 'draft');
  assert.equal(result.paymentOrders[0].paymentOrder.state, 'draft');
  assert.equal(result.paymentOrders[0].paymentOrder.transferRequests.length, 0);
  assert.equal(result.paymentOrders[1].decision, 'draft');
  assert.equal(result.paymentOrders[1].paymentOrder.state, 'draft');
  assert.equal(result.paymentOrders[1].paymentOrder.transferRequests.length, 0);

  const reviewOrder = result.paymentOrders[1].paymentOrder;
  const cleared = await post(
    `/organizations/${setup.organization.organizationId}/payment-orders/${reviewOrder.paymentOrderId}/submit`,
    {
      submitNote: 'Verified invoice and wallet by email.',
      autoAdvance: false,
    },
    setup.sessionToken,
  );

  assert.equal(cleared.state, 'submitted');
  assert.equal(cleared.derivedState, 'submitted');
  assert.equal(cleared.transferRequests.length, 0);

  const wallet = await prisma.counterpartyWallet.findUniqueOrThrow({
    where: {
      organizationId_walletAddress: {
        organizationId: setup.organization.organizationId,
        walletAddress: newVendorWallet,
      },
    },
  });
  assert.equal(wallet.trustState, 'trusted');
});

test('invoice upload stores the original document, links orders to it, and serves it back', async () => {
  const setup = await createPaymentOrderSetup();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [
        {
          counterparty: setup.counterpartyWallet.label,
          amount: 0.01,
          currency: 'USDC',
          reference: 'INV-DOC-STORE',
          due_date: '2026-08-01',
          wallet_address: setup.counterpartyWallet.walletAddress,
          notes: 'Document storage test',
        },
      ],
      modelLatencyMs: 5,
      pageCount: 3,
    }),
  });

  const pdfBytes = Buffer.from('%PDF-1.4 fake invoice document body');
  const upload = await post(
    `/organizations/${setup.organization.organizationId}/invoices/upload`,
    {
      filename: 'acme-invoice.pdf',
      mimeType: 'application/pdf',
      dataBase64: pdfBytes.toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );

  assert.ok(upload.invoiceDocumentId, 'upload response carries the stored document id');
  assert.equal(upload.paymentOrders[0].paymentOrder.invoiceDocumentId, upload.invoiceDocumentId);

  const meta = await get(
    `/organizations/${setup.organization.organizationId}/invoice-documents/${upload.invoiceDocumentId}/meta`,
    setup.sessionToken,
  );
  assert.equal(meta.filename, 'acme-invoice.pdf');
  assert.equal(meta.mimeType, 'application/pdf');
  assert.equal(meta.byteSize, pdfBytes.length);
  assert.equal(meta.pageCount, 3);

  const fileResponse = await fetch(
    `${baseUrl}/organizations/${setup.organization.organizationId}/invoice-documents/${upload.invoiceDocumentId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get('content-type'), 'application/pdf');
  const served = Buffer.from(await fileResponse.arrayBuffer());
  assert.ok(served.equals(pdfBytes), 'served bytes match the uploaded file exactly');

  // Same file uploaded again dedupes to the same stored document.
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [
        {
          counterparty: setup.counterpartyWallet.label,
          amount: 0.02,
          currency: 'USDC',
          reference: 'INV-DOC-STORE-2',
          due_date: '2026-08-02',
          wallet_address: setup.counterpartyWallet.walletAddress,
          notes: 'Second upload of the same file',
        },
      ],
      modelLatencyMs: 5,
      pageCount: 3,
    }),
  });
  const reupload = await post(
    `/organizations/${setup.organization.organizationId}/invoices/upload`,
    {
      filename: 'acme-invoice-copy.pdf',
      mimeType: 'application/pdf',
      dataBase64: pdfBytes.toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  assert.equal(reupload.invoiceDocumentId, upload.invoiceDocumentId);

  const documentCount = await prisma.invoiceDocument.count({
    where: { organizationId: setup.organization.organizationId },
  });
  assert.equal(documentCount, 1);
});

test('bills workbench triages uploads; review confirm sends the bill onward', async () => {
  const setup = await createPaymentOrderSetup();
  const newVendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [
        {
          counterparty: 'Acme Cloud Services',
          amount: 4820,
          currency: 'USD',
          reference: 'INV-20411',
          due_date: '2026-08-01',
          wallet_address: newVendorWallet,
          notes: 'Cloud hosting — July',
          source_invoice: {
            vendorName: 'Acme Cloud Services',
            vendorAddress: null,
            vendorEmail: null,
            amount: 4820,
            currency: 'USD',
            invoiceNumber: 'INV-20411',
            invoiceDate: '2026-07-02',
            dueDate: '2026-08-01',
            terms: 'Net 30',
            poNumber: null,
            earlyPayDiscount: null,
            subtotal: 4820,
            taxAmount: 0,
            billToName: null,
            remitTo: { street: '450 Westlake Ave N', city: 'Seattle', state: 'WA', zip: '98109' },
            paymentDetails: { method: 'ACH', bankName: 'First Interstate Bank', accountLast4: '6621', routingNumber: null },
            walletAddress: newVendorWallet,
            lineItems: [
              { description: 'Cloud hosting — compute (July 2026)', quantity: 1, unitPrice: 2650, total: 2650 },
              { description: 'Object storage — 34 TB', quantity: 1, unitPrice: 2170, total: 2170 },
            ],
            categoryHint: 'Cloud hosting',
            confidence: { vendor: 0.98, amount: 0.97, overall: 0.95 },
            fieldConfidence: { invoiceNumber: 0.99, invoiceDate: 0.7, dueDate: 0.95, total: 0.97 },
          },
        },
      ],
      modelLatencyMs: 5,
      pageCount: 1,
    }),
  });

  const upload = await post(
    `/organizations/${setup.organization.organizationId}/invoices/upload`,
    {
      filename: 'acme-cloud-inv-20411.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 acme').toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  const billId = upload.paymentOrders[0].paymentOrder.paymentOrderId;
  assert.equal(upload.paymentOrders[0].paymentOrder.state, 'draft');
  // v3 pipeline: no bill enters the approval engine at upload — Confirm is the door.
  assert.equal(upload.paymentOrders[0].approvableId ?? null, null);

  const workbench = await get(
    `/organizations/${setup.organization.organizationId}/bills/workbench`,
    setup.sessionToken,
  );
  assert.equal(workbench.counts.draft, 1);
  const row = workbench.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === billId);
  assert.equal(row.bucket, 'draft');
  assert.equal(row.vendorName, 'Acme Cloud Services');
  assert.equal(row.description, 'Cloud hosting — compute (July 2026)');
  assert.equal(row.amountUsd, 4820);
  // Complete facts, nothing security-shaped open → ready for approval.
  assert.equal(row.readiness, 'ready');
  assert.equal(row.subStatus.text, 'Ready for approval');

  const review = await get(
    `/organizations/${setup.organization.organizationId}/bills/${billId}/draft`,
    setup.sessionToken,
  );
  assert.equal(review.readOnly, false);
  assert.equal(review.vendor.isNew, true);
  const invoiceDateField = review.fields.find((f: { key: string }) => f.key === 'invoiceDate');
  assert.equal(invoiceDateField.state, 'needs_look');
  const invoiceNumberField = review.fields.find((f: { key: string }) => f.key === 'invoiceNumber');
  assert.equal(invoiceNumberField.state, 'read');
  const poField = review.fields.find((f: { key: string }) => f.key === 'poNumber');
  assert.equal(poField.state, 'not_on_document');
  assert.equal(review.paymentBlock.bankName, 'First Interstate Bank');
  assert.equal(review.flags.some((f: { kind: string }) => f.kind === 'new_vendor'), true);
  assert.equal(review.flags.some((f: { blocking: boolean }) => f.blocking), false);

  const confirmed = await post(
    `/organizations/${setup.organization.organizationId}/bills/${billId}/confirm`,
    {
      fields: {
        invoiceNumber: 'INV-20411',
        invoiceDate: '2026-07-02',
        dueDate: '2026-08-01',
        terms: 'Net 30',
        currency: 'USD',
        total: 4820,
        taxAmount: 0,
        remitTo: { street: '450 Westlake Ave N', city: 'Seattle', state: 'WA', zip: '98109' },
      },
      // Tier-1: lines must carry amounts AND categories — approval routes on them.
      lines: [
        { description: 'Cloud hosting — compute (July 2026)', quantity: 1, unitPrice: 2650, amount: 2650, category: 'Cloud hosting & infrastructure' },
        { description: 'Object storage — 34 TB', quantity: 1, unitPrice: 2170, amount: 2170, category: 'Cloud hosting & infrastructure' },
      ],
      // vendor.name rides along: these two hold their value outside the fields
      // list, and used to have no confirmed state at all — so they were the
      // only fields somebody could be asked about and never tick off.
      confirmedFieldKeys: ['invoiceDate', 'vendor.name'],
      noteForApprovers: 'Recurring cloud bill, verified against the document.',
    },
    setup.sessionToken,
  );
  assert.equal(confirmed.detail.state, 'submitted');

  const after = await get(
    `/organizations/${setup.organization.organizationId}/bills/workbench`,
    setup.sessionToken,
  );
  assert.equal(after.counts.draft, 0);
  const afterRow = after.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === billId);
  assert.notEqual(afterRow.bucket, 'draft');

  // Bill detail (Screen 3): review facts + the approval side, viewer-aware.
  const detail = await get(
    `/organizations/${setup.organization.organizationId}/bills/${billId}/detail`,
    setup.sessionToken,
  );
  assert.equal(detail.draft.paymentOrderId, billId);
  assert.ok(detail.approval, 'the confirmed bill has an approvable');
  assert.equal(detail.viewer.isRequester, true);
  assert.ok(Array.isArray(detail.approval.steps));
  assert.ok(Array.isArray(detail.corrections));

  const reviewAfter = await get(
    `/organizations/${setup.organization.organizationId}/bills/${billId}/draft`,
    setup.sessionToken,
  );
  assert.equal(reviewAfter.readOnly, true);
  assert.equal(reviewAfter.verification.noteForApprovers, 'Recurring cloud bill, verified against the document.');
  const confirmedField = reviewAfter.fields.find((f: { key: string }) => f.key === 'invoiceDate');
  assert.equal(confirmedField.state, 'confirmed');
  assert.equal(reviewAfter.vendor.nameState, 'confirmed', 'and it survives a reload for the vendor too');
  assert.ok(reviewAfter.vendor.emailState, 'both vendor fields carry a state at all');
});

test('a field the model could not read is marked for a look, in its own words', async () => {
  // The whole "check this field" mechanism keyed off a self-reported 0-1
  // confidence, and never fired: every C-series document came back at 0.98,
  // a phone photograph of creased paper scoring the same as a clean PDF.
  // Asking a small model for calibrated probability asks for the one thing it
  // cannot give. Asking WHICH SITUATION it was in is a classification, which it
  // can — and the sentence it writes about the obstacle beats anything we could
  // write, because it names the actual obstacle.
  const setup = await createPaymentOrderSetup();
  const vendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [
        {
          counterparty: 'Northwind Supplies',
          amount: 3150,
          currency: 'USD',
          reference: 'NW-3388',
          due_date: '2026-08-06',
          wallet_address: vendorWallet,
          notes: 'Stamped',
          source_invoice: {
            vendorName: 'Northwind Supplies',
            vendorAddress: null,
            vendorEmail: null,
            amount: 3150,
            currency: 'USD',
            invoiceNumber: 'NW-3388',
            invoiceDate: '2026-07-22',
            dueDate: '2026-08-06',
            terms: 'Net 15',
            poNumber: null,
            earlyPayDiscount: null,
            subtotal: 3150,
            taxAmount: 0,
            billToName: null,
            remitTo: { street: null, city: null, state: null, zip: null },
            paymentDetails: { method: 'ACH', bankName: 'Buckeye Bank', accountLast4: '2201', routingNumber: null },
            walletAddress: vendorWallet,
            lineItems: [
              { description: 'Safety equipment', quantity: 1, unitPrice: 3150, total: 3150 },
            ],
            categoryHint: 'Job supplies',
            confidence: { vendor: 1, amount: 1, overall: 0.98 },
            // The old signal says everything is fine. The new one does not.
            fieldConfidence: { total: 1, dueDate: 1, invoiceNumber: 1 },
            fieldStatus: { total: 'unreadable', dueDate: 'confident', invoiceNumber: 'confident' },
            issues: [{ field: 'total', note: 'a red PAID stamp covers part of the figure' }],
          },
        },
      ],
      modelLatencyMs: 5,
      pageCount: 1,
    }),
  });

  const orgId = setup.organization.organizationId;
  const upload = await post(
    `/organizations/${orgId}/invoices/upload`,
    {
      filename: 'NW-3388.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('%PDF-1.4 stamped').toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  const billId = upload.paymentOrders[0].paymentOrder.paymentOrderId;

  const draft = await get(`/organizations/${orgId}/bills/${billId}/draft`, setup.sessionToken);
  const total = draft.fields.find((f: { key: string }) => f.key === 'total');
  assert.equal(total.state, 'needs_look', 'a figure under a stamp wants a human');
  assert.match(total.reason, /PAID stamp/, "and says why, in the model's own words");

  // A field it read cleanly is not dressed up as doubtful — a marker on
  // everything is a marker on nothing.
  const invoiceNumber = draft.fields.find((f: { key: string }) => f.key === 'invoiceNumber');
  assert.equal(invoiceNumber.state, 'read');
});

test('correcting the figures clears the arithmetic flag it was raised on', async () => {
  // The flag used to be computed from the raw extraction on every read, and a
  // save never wrote back to the extraction. So a bill whose lines disagreed
  // with its total could not be fixed by anyone: editing the lines, the tax or
  // the total changed nothing the gate looked at, and "Correct the figures" —
  // the only resolution offered — did nothing at all. The bill was stuck for
  // good. This walks the whole way round: flagged, corrected, cleared.
  const setup = await createPaymentOrderSetup();
  const vendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [
        {
          counterparty: 'Northwind Supplies',
          amount: 4820,
          currency: 'USD',
          reference: 'NW-3320',
          due_date: '2026-09-01',
          wallet_address: vendorWallet,
          notes: 'Warehouse supplies',
          source_invoice: {
            vendorName: 'Northwind Supplies',
            vendorAddress: null,
            vendorEmail: null,
            amount: 4820,
            currency: 'USD',
            invoiceNumber: 'NW-3320',
            invoiceDate: '2026-08-02',
            dueDate: '2026-09-01',
            terms: 'Net 30',
            poNumber: null,
            earlyPayDiscount: null,
            // The defect: the document says 4,820 but itemises only 4,000.
            subtotal: 4820,
            taxAmount: 0,
            billToName: null,
            remitTo: { street: '1 Dock Road', city: 'Tacoma', state: 'WA', zip: '98402' },
            paymentDetails: { method: 'ACH', bankName: 'Harbor Bank', accountLast4: '1188', routingNumber: null },
            walletAddress: vendorWallet,
            lineItems: [
              { description: 'Warehouse shelving units', quantity: 4, unitPrice: 650, total: 2600 },
              { description: 'Forklift annual service', quantity: 1, unitPrice: 900, total: 900 },
              { description: 'Safety equipment restock', quantity: 1, unitPrice: 500, total: 500 },
            ],
            categoryHint: 'Job supplies',
            confidence: { vendor: 0.97, amount: 0.9, overall: 0.93 },
            fieldConfidence: { invoiceNumber: 0.98, invoiceDate: 0.9, dueDate: 0.9, total: 0.9 },
          },
        },
      ],
      modelLatencyMs: 5,
      pageCount: 1,
    }),
  });

  const orgId = setup.organization.organizationId;
  const upload = await post(
    `/organizations/${orgId}/invoices/upload`,
    {
      filename: 'NW-3320.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 northwind').toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  const billId = upload.paymentOrders[0].paymentOrder.paymentOrderId;

  const flagged = await get(`/organizations/${orgId}/bills/${billId}/draft`, setup.sessionToken);

  // The ask screen lets somebody add a field the model did not suggest, so it
  // needs the whole vocabulary — and must not build its own, which would agree
  // today and drift the first time a field is added on one side only. Anything
  // it offered but the server did not enforce would be dropped on the way in,
  // which looks exactly like the tick not working.
  const { HIGHLIGHTABLE_FIELDS } = await import('../src/payments/question-fields.js');
  assert.deepEqual(flagged.highlightableFields, [...HIGHLIGHTABLE_FIELDS]);

  const raised = flagged.flags.find((f: { kind: string }) => f.kind === 'lines_do_not_sum');
  assert.ok(raised, 'lines of 4,000 against a total of 4,820 must be flagged');
  assert.equal(raised.blocking, true);
  // The flag it arrived carrying is on the record from the start — otherwise
  // the history would later say a problem was resolved that nothing ever said
  // existed.
  const openedWith = flagged.workLog.find((e: { kind: string }) => e.kind === 'flag_raised');
  assert.ok(openedWith, 'the opening flag is recorded at intake');
  assert.match(openedWith.text, /Lines do not add up/);
  // And WHY. The label names the check that fired; on its own it does not say
  // the lines came to $4,000 against a document reading $4,820, which is the
  // part somebody reading this back actually needs.
  assert.ok(openedWith.detail, 'the reason is on the record, not just the label');
  assert.match(openedWith.detail, /\$4,000\.00/);
  assert.match(openedWith.detail, /\$4,820\.00/);
  // And the row on the list agrees — both surfaces read one evaluator.
  const flaggedBoard = await get(`/organizations/${orgId}/bills/workbench`, setup.sessionToken);
  const flaggedRow = flaggedBoard.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === billId);
  assert.equal(flaggedRow.subStatus.text, 'Lines do not add up');

  const body = {
    fields: {
      invoiceNumber: 'NW-3320',
      invoiceDate: '2026-08-02',
      dueDate: '2026-09-01',
      terms: 'Net 30',
      currency: 'USD',
      // The decision: pay what the invoice itemises, not what it claims.
      total: 4000,
      taxAmount: 0,
      remitTo: { street: '1 Dock Road', city: 'Tacoma', state: 'WA', zip: '98402' },
    },
    lines: [
      { description: 'Warehouse shelving units', quantity: 4, unitPrice: 650, amount: 2600, category: 'Job supplies' },
      { description: 'Forklift annual service', quantity: 1, unitPrice: 900, amount: 900, category: 'Repairs & maintenance' },
      { description: 'Safety equipment restock', quantity: 1, unitPrice: 500, amount: 500, category: 'Job supplies' },
    ],
    confirmedFieldKeys: [] as string[],
    noteForApprovers: null as string | null,
  };

  await post(`/organizations/${orgId}/bills/${billId}/save`, body, setup.sessionToken);

  const fixed = await get(`/organizations/${orgId}/bills/${billId}/draft`, setup.sessionToken);
  assert.equal(
    fixed.flags.some((f: { kind: string }) => f.kind === 'lines_do_not_sum'),
    false,
    'the corrected figures agree, so the flag it was raised on is gone',
  );
  assert.equal(fixed.flags.some((f: { blocking: boolean }) => f.blocking), false);

  const board = await get(`/organizations/${orgId}/bills/workbench`, setup.sessionToken);
  const row = board.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === billId);
  assert.equal(row.amountUsd, 4000, 'the saved figure is what the queue shows');
  assert.notEqual(row.subStatus.text, 'Lines do not add up');

  // The change is on the bill you are still standing on. This record was always
  // written; until now the only screen that rendered it was the one you reach
  // AFTER confirming, so while a bill was being worked its history was invisible.
  const logged = fixed.workLog.find((e: { field: string | null }) => e.field === 'total');
  assert.ok(logged, 'changing the total is on the work log');
  assert.equal(logged.kind, 'field_changed');
  assert.match(logged.text, /Total due changed from \$4,820\.00 to \$4,000\.00/);
  assert.ok(logged.byName, 'and says who did it');
  assert.ok(logged.at, 'and when');

  // The flag stopping being true is itself a thing that happened. Flags are
  // derived, so without this a bill that was blocked and fixed would be
  // indistinguishable afterwards from one that was never questioned.
  const cleared = fixed.workLog.find((e: { kind: string }) => e.kind === 'flag_cleared');
  assert.ok(cleared, 'clearing the flag is recorded');
  assert.match(cleared.text, /Lines do not add up/);
  assert.ok(cleared.byName, 'attributed to whoever cleared it');
  // In order, and after the change that caused it.
  const order = fixed.workLog.map((e: { kind: string }) => e.kind);
  assert.ok(
    order.indexOf('field_changed') < order.indexOf('flag_cleared'),
    'the change comes before the flag it settled',
  );

  // And it can now actually leave review, which is the whole point.
  const confirmed = await post(`/organizations/${orgId}/bills/${billId}/confirm`, body, setup.sessionToken);
  assert.equal(confirmed.detail.state, 'submitted');

  // One edit, one line. Save and confirm each used to measure the change from
  // what the DOCUMENT said, so both wrote "total 4,820 -> 4,000" and the
  // history read as though the figure had been put back in between.
  const settled = await get(`/organizations/${orgId}/bills/${billId}/draft`, setup.sessionToken);
  const totalEdits = settled.workLog.filter((e: { field: string | null }) => e.field === 'total');
  assert.equal(totalEdits.length, 1, 'the same edit saved and then confirmed is one event, not two');

  // And the approver sees the same account of it, written the same way. The
  // approval view used to render the corrections blob instead: the raw field
  // key, the raw values, no time, and none of the flags — a worse account of
  // the bill for the person actually being asked to stand behind it.
  const detail = await get(`/organizations/${orgId}/bills/${billId}/detail`, setup.sessionToken);
  const shown = detail.draft.workLog.find((e: { field: string | null }) => e.field === 'total');
  assert.ok(shown, 'the correction reaches the approval view');
  assert.match(shown.text, /^Total due changed from/, 'named as the form names it, not as the code does');
  assert.doesNotMatch(shown.text, /\btotal\b/, 'the field key does not leak to an approver');
  assert.match(shown.text, /\$4,000\.00/, 'money reads as money');
  assert.ok(
    detail.draft.workLog.some((e: { kind: string }) => e.kind === 'flag_raised'),
    'and the flags travel with it, which the old version never showed at all',
  );
});

test('editing a field twice reads as a chain, not two edits from the original', async () => {
  const setup = await createPaymentOrderSetup();
  const vendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [
        {
          counterparty: 'Harbour Freight Co',
          amount: 1200,
          currency: 'USD',
          reference: 'HF-9001',
          due_date: '2026-09-10',
          wallet_address: vendorWallet,
          notes: 'Freight',
          source_invoice: {
            vendorName: 'Harbour Freight Co',
            vendorAddress: null,
            vendorEmail: null,
            amount: 1200,
            currency: 'USD',
            invoiceNumber: 'HF-9001',
            invoiceDate: '2026-08-10',
            dueDate: '2026-09-10',
            terms: 'Net 30',
            poNumber: null,
            earlyPayDiscount: null,
            subtotal: 1200,
            taxAmount: 0,
            billToName: null,
            remitTo: { street: '2 Quay St', city: 'Seattle', state: 'WA', zip: '98101' },
            paymentDetails: { method: 'ACH', bankName: 'Harbor Bank', accountLast4: '4410', routingNumber: null },
            walletAddress: vendorWallet,
            lineItems: [{ description: 'Freight', quantity: 1, unitPrice: 1200, total: 1200 }],
            categoryHint: 'Freight',
            confidence: { vendor: 0.95, amount: 0.95, overall: 0.95 },
            fieldConfidence: { invoiceNumber: 0.95, invoiceDate: 0.95, dueDate: 0.95, total: 0.95 },
          },
        },
      ],
      modelLatencyMs: 5,
      pageCount: 1,
    }),
  });

  const orgId = setup.organization.organizationId;
  const upload = await post(
    `/organizations/${orgId}/invoices/upload`,
    {
      filename: 'HF-9001.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 harbour').toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  const billId = upload.paymentOrders[0].paymentOrder.paymentOrderId;

  const bodyWith = (poNumber: string) => ({
    fields: {
      invoiceNumber: 'HF-9001',
      invoiceDate: '2026-08-10',
      dueDate: '2026-09-10',
      terms: 'Net 30',
      currency: 'USD',
      poNumber,
      total: 1200,
      taxAmount: 0,
      remitTo: { street: '2 Quay St', city: 'Seattle', state: 'WA', zip: '98101' },
    },
    lines: [{ description: 'Freight', quantity: 1, unitPrice: 1200, amount: 1200, category: 'Freight' }],
    confirmedFieldKeys: [] as string[],
    noteForApprovers: null as string | null,
  });

  await post(`/organizations/${orgId}/bills/${billId}/save`, bodyWith('PO-1'), setup.sessionToken);
  await post(`/organizations/${orgId}/bills/${billId}/save`, bodyWith('PO-2'), setup.sessionToken);

  const draft = await get(`/organizations/${orgId}/bills/${billId}/draft`, setup.sessionToken);
  const poEdits = draft.workLog.filter((e: { field: string | null }) => e.field === 'poNumber');
  assert.equal(poEdits.length, 2, 'two real edits, two entries');
  assert.match(poEdits[0].text, /PO number changed from nothing to PO-1/);
  // The second link starts where the first ended, rather than from the document.
  assert.match(poEdits[1].text, /PO number changed from PO-1 to PO-2/);
});

test('confirm judges the figures being submitted, not the ones last saved', async () => {
  // Correct the figures on screen and press Confirm without saving first. The
  // gate read the STORED bill to decide whether anything was blocking, so the
  // stale flag refused a submission that was already correct — and the message
  // quoted numbers that were no longer on the screen the person was looking at.
  const setup = await createPaymentOrderSetup();
  const vendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [
        {
          counterparty: 'Northwind Supplies',
          amount: 4820,
          currency: 'USD',
          reference: 'NW-3322',
          due_date: '2026-09-01',
          wallet_address: vendorWallet,
          notes: 'Warehouse supplies',
          source_invoice: {
            vendorName: 'Northwind Supplies',
            vendorAddress: null,
            vendorEmail: null,
            amount: 4820,
            currency: 'USD',
            invoiceNumber: 'NW-3322',
            invoiceDate: '2026-08-02',
            dueDate: '2026-09-01',
            terms: 'Net 30',
            poNumber: null,
            earlyPayDiscount: null,
            subtotal: 4820,
            taxAmount: 0,
            billToName: null,
            remitTo: { street: '1 Dock Road', city: 'Tacoma', state: 'WA', zip: '98402' },
            paymentDetails: { method: 'ACH', bankName: 'Harbor Bank', accountLast4: '1188', routingNumber: null },
            walletAddress: vendorWallet,
            lineItems: [
              { description: 'Warehouse shelving units', quantity: 4, unitPrice: 650, total: 2600 },
              { description: 'Forklift annual service', quantity: 1, unitPrice: 900, total: 900 },
              { description: 'Safety equipment restock', quantity: 1, unitPrice: 500, total: 500 },
            ],
            categoryHint: 'Job supplies',
            confidence: { vendor: 0.97, amount: 0.9, overall: 0.93 },
            fieldConfidence: { invoiceNumber: 0.98, invoiceDate: 0.9, dueDate: 0.9, total: 0.9 },
          },
        },
      ],
      modelLatencyMs: 5,
      pageCount: 1,
    }),
  });

  const orgId = setup.organization.organizationId;
  const upload = await post(
    `/organizations/${orgId}/invoices/upload`,
    {
      filename: 'NW-3322.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 northwind three').toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  const billId = upload.paymentOrders[0].paymentOrder.paymentOrderId;

  // Straight to confirm. No save in between — the figures exist only in the
  // request body, which is exactly how the screen sends them.
  const confirmed = await post(
    `/organizations/${orgId}/bills/${billId}/confirm`,
    {
      fields: {
        invoiceNumber: 'NW-3322',
        invoiceDate: '2026-08-02',
        dueDate: '2026-09-01',
        terms: 'Net 30',
        currency: 'USD',
        total: 4820,
        taxAmount: 820,
        remitTo: { street: '1 Dock Road', city: 'Tacoma', state: 'WA', zip: '98402' },
      },
      lines: [
        { description: 'Warehouse shelving units', quantity: 4, unitPrice: 650, amount: 2600, category: 'Job supplies' },
        { description: 'Forklift annual service', quantity: 1, unitPrice: 900, amount: 900, category: 'Repairs & maintenance' },
        { description: 'Safety equipment restock', quantity: 1, unitPrice: 500, amount: 500, category: 'Job supplies' },
      ],
      confirmedFieldKeys: [],
      noteForApprovers: null,
    },
    setup.sessionToken,
  );
  assert.equal(confirmed.detail.state, 'submitted');
});

test('a discrepancy keeps its name while somebody is fixing it', async () => {
  // Saving a bill part-way through used to rename the problem. The printed
  // subtotal was dropped the moment any correction existed, so the lines got
  // compared against the total with tax taken off — and "total does not
  // reconcile" turned into "lines do not add up", quoting a figure that appears
  // nowhere on the document. The history read as one problem being resolved and
  // a different one appearing in the same second, neither of which happened.
  const setup = await createPaymentOrderSetup();
  const vendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [
        {
          counterparty: 'Kepler Legal LLP',
          amount: 4820,
          currency: 'USD',
          reference: 'KL-1341',
          due_date: '2026-09-05',
          wallet_address: vendorWallet,
          notes: 'Legal',
          source_invoice: {
            vendorName: 'Kepler Legal LLP',
            vendorAddress: null,
            vendorEmail: null,
            amount: 4820,
            currency: 'USD',
            invoiceNumber: 'KL-1341',
            invoiceDate: '2026-08-05',
            dueDate: '2026-09-05',
            terms: 'Net 30',
            poNumber: null,
            earlyPayDiscount: null,
            // 4,000 + 320 tax is 4,320, but the document asks for 4,820.
            subtotal: 4000,
            taxAmount: 320,
            billToName: null,
            remitTo: { street: '9 Chancery Lane', city: 'Boston', state: 'MA', zip: '02110' },
            paymentDetails: { method: 'ACH', bankName: 'Bay State Bank', accountLast4: '7781', routingNumber: null },
            walletAddress: vendorWallet,
            lineItems: [
              { description: 'Contract review', quantity: 1, unitPrice: 3600, total: 3600 },
              { description: 'Regulatory filing', quantity: 1, unitPrice: 400, total: 400 },
            ],
            categoryHint: 'Legal & professional',
            confidence: { vendor: 0.96, amount: 0.9, overall: 0.92 },
            fieldConfidence: { invoiceNumber: 0.95, invoiceDate: 0.9, dueDate: 0.9, total: 0.9 },
          },
        },
      ],
      modelLatencyMs: 5,
      pageCount: 1,
    }),
  });

  const orgId = setup.organization.organizationId;
  const upload = await post(
    `/organizations/${orgId}/invoices/upload`,
    {
      filename: 'KL-1341.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 kepler').toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  const billId = upload.paymentOrders[0].paymentOrder.paymentOrderId;

  const before = await get(`/organizations/${orgId}/bills/${billId}/draft`, setup.sessionToken);
  assert.ok(before.flags.find((f: { kind: string }) => f.kind === 'total_does_not_reconcile'));

  // A save that changes nothing about the figures must not rename the problem.
  await post(
    `/organizations/${orgId}/bills/${billId}/save`,
    {
      fields: {
        invoiceNumber: 'KL-1341',
        invoiceDate: '2026-08-05',
        dueDate: '2026-09-05',
        terms: 'Net 30',
        currency: 'USD',
        total: 4820,
        taxAmount: 320,
        remitTo: { street: '9 Chancery Lane', city: 'Boston', state: 'MA', zip: '02110' },
      },
      lines: [
        { description: 'Contract review', quantity: 1, unitPrice: 3600, amount: 3600, category: 'Legal & professional' },
        { description: 'Regulatory filing', quantity: 1, unitPrice: 400, amount: 400, category: 'Legal & professional' },
      ],
      confirmedFieldKeys: [],
      noteForApprovers: null,
    },
    setup.sessionToken,
  );

  const after = await get(`/organizations/${orgId}/bills/${billId}/draft`, setup.sessionToken);
  assert.ok(
    after.flags.find((f: { kind: string }) => f.kind === 'total_does_not_reconcile'),
    'the same discrepancy, still called the same thing',
  );
  assert.equal(
    after.flags.some((f: { kind: string }) => f.kind === 'lines_do_not_sum'),
    false,
    'the lines were never in question — they add up to exactly what the person entered',
  );
  // And nothing was recorded as raised or resolved, because nothing was.
  assert.equal(
    after.workLog.filter((e: { kind: string }) => e.kind === 'flag_cleared').length,
    0,
    'a save that fixed nothing resolves nothing',
  );
  assert.equal(
    after.workLog.filter((e: { kind: string }) => e.kind === 'flag_raised').length,
    1,
    'and raises nothing new — just the one it arrived with',
  );
});

test('deciding to pay the itemised total records the decision, not just the number', async () => {
  // Retyping the total to $4,000 and retyping it because the invoice does not
  // add up look identical to an approver. This is the difference: the number
  // moves AND the reason travels with it.
  const setup = await createPaymentOrderSetup();
  const vendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [
        {
          counterparty: 'Northwind Supplies',
          amount: 4820,
          currency: 'USD',
          reference: 'NW-3321',
          due_date: '2026-09-01',
          wallet_address: vendorWallet,
          notes: 'Warehouse supplies',
          source_invoice: {
            vendorName: 'Northwind Supplies',
            vendorAddress: null,
            vendorEmail: null,
            amount: 4820,
            currency: 'USD',
            invoiceNumber: 'NW-3321',
            invoiceDate: '2026-08-02',
            dueDate: '2026-09-01',
            terms: 'Net 30',
            poNumber: null,
            earlyPayDiscount: null,
            subtotal: 4820,
            taxAmount: 0,
            billToName: null,
            remitTo: { street: '1 Dock Road', city: 'Tacoma', state: 'WA', zip: '98402' },
            paymentDetails: { method: 'ACH', bankName: 'Harbor Bank', accountLast4: '1188', routingNumber: null },
            walletAddress: vendorWallet,
            lineItems: [
              { description: 'Warehouse shelving units', quantity: 4, unitPrice: 650, total: 2600 },
              { description: 'Forklift annual service', quantity: 1, unitPrice: 900, total: 900 },
              { description: 'Safety equipment restock', quantity: 1, unitPrice: 500, total: 500 },
            ],
            categoryHint: 'Job supplies',
            confidence: { vendor: 0.97, amount: 0.9, overall: 0.93 },
            fieldConfidence: { invoiceNumber: 0.98, invoiceDate: 0.9, dueDate: 0.9, total: 0.9 },
          },
        },
      ],
      modelLatencyMs: 5,
      pageCount: 1,
    }),
  });

  const orgId = setup.organization.organizationId;
  const upload = await post(
    `/organizations/${orgId}/invoices/upload`,
    {
      filename: 'NW-3321.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 northwind two').toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  const billId = upload.paymentOrders[0].paymentOrder.paymentOrderId;

  const before = await get(`/organizations/${orgId}/bills/${billId}/draft`, setup.sessionToken);
  const blocked = before.flags.find((f: { blocking: boolean }) => f.blocking);
  assert.ok(blocked, 'the bill is blocked to begin with');
  assert.ok(
    blocked.resolutions.some((r: { action: string }) => r.action === 'pay_the_lines'),
    'and the way out is offered on the flag itself',
  );

  const after = await post(
    `/organizations/${orgId}/bills/${billId}/pay-itemised`,
    { reason: 'Invoice does not add up; asked the vendor for a corrected copy.' },
    setup.sessionToken,
  );

  assert.equal(after.flags.some((f: { blocking: boolean }) => f.blocking), false, 'nothing blocks it now');
  const decision = after.flags.find((f: { kind: string }) => f.kind === 'short_paid');
  assert.ok(decision, 'the decision is on the bill');
  assert.match(decision.message, /corrected copy/);
  assert.match(decision.message, /\$4,820\.00/, 'and says what the document printed');

  const board = await get(`/organizations/${orgId}/bills/workbench`, setup.sessionToken);
  const row = board.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === billId);
  assert.equal(row.amountUsd, 4000, 'the queue shows the amount that will actually be paid');

  // The account of one action reads in the order it happened: what changed,
  // what was decided, what that settled. All three are written in the same
  // instant, so without a fixed order among them the flag came back resolved
  // above the edit that resolved it.
  const kinds = after.workLog.map((e: { kind: string }) => e.kind);
  const changed = kinds.lastIndexOf('field_changed');
  const decided = kinds.lastIndexOf('policy_overridden');
  const settled = kinds.lastIndexOf('flag_cleared');
  assert.ok(changed < decided, 'the edit comes before the decision');
  assert.ok(decided < settled, 'the decision comes before what it settled');

  // And the decision is named, not slugged. "pay_the_itemised_total" was
  // appearing as the headline above somebody's sentence about a vendor.
  const decisionEntry = after.workLog[decided];
  assert.match(decisionEntry.text, /^Paying the itemised total/);
  assert.doesNotMatch(decisionEntry.text, /pay_the_itemised_total/);

  // Deciding twice is not a thing: there is no discrepancy left to decide.
  await assert.rejects(
    post(
      `/organizations/${orgId}/bills/${billId}/pay-itemised`,
      { reason: 'Trying it a second time.' },
      setup.sessionToken,
    ),
  );
});

test('a bill routed to its own submitter deadlocks: the task exists, the rules forbid it', async () => {
  // The engine's own tests drive executeCommand directly. Nothing exercised the
  // path a person actually takes: session auth, the user→person lookup, the
  // engine's refusals mapped to status codes, and the post-commit bridge that
  // moves the bill. That is the whole distance between "the engine works" and
  // "someone can approve a bill".
  const setup = await createPaymentOrderSetup();
  const vendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [{
        counterparty: 'Approvable Vendor Co',
        amount: 1200,
        currency: 'USD',
        reference: 'INV-APPROVE-1',
        due_date: '2026-09-01',
        wallet_address: vendorWallet,
        notes: 'Services',
        source_invoice: null,
      }],
      modelLatencyMs: 1,
      pageCount: 1,
    }),
  });

  const org = setup.organization.organizationId;
  const upload = await post(
    `/organizations/${org}/invoices/upload`,
    {
      filename: 'approvable.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 approvable').toString('base64'),
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  const billId = upload.paymentOrders[0].paymentOrder.paymentOrderId;

  await post(
    `/organizations/${org}/bills/${billId}/confirm`,
    {
      fields: { invoiceNumber: 'INV-APPROVE-1', currency: 'USD', total: 1200 },
      lines: [{ description: 'Services', quantity: 1, unitPrice: 1200, amount: 1200, category: 'Professional services' }],
      confirmedFieldKeys: [],
    },
    setup.sessionToken,
  );

  const detail = await get(`/organizations/${org}/bills/${billId}/detail`, setup.sessionToken);
  assert.ok(detail.approval, 'the confirmed bill is in the engine');

  // THE DEADLOCK, asserted as it currently behaves.
  //
  // compile.ts, finding no eligible approver, deliberately assigns the org
  // owner — reasoning that a recorded self-approval behind the R1 opt-in
  // ceremony beats a silent pass. But the owner here is also the submitter, so
  // R1 forbids the very task they were just handed. The bill is routed to
  // someone who is not allowed to act on it, and there is no way forward from
  // the button.
  //
  // Kept green rather than left failing so it does not block the suite: this
  // is what the system does today, and it is a defect, not a design. When the
  // fallback stops conscripting an approver (access-research synthesis §5.2),
  // this flips to asserting a 200 and a bill that leaves review.
  assert.ok(detail.viewer.openTaskId, 'the owner-submitter was handed a task');

  // …and the screen is told so BEFORE offering the button. This is the whole
  // fix: the engine's answer was always correct, it just arrived as a 409 after
  // the click, naming a rule code and nothing a person could act on.
  assert.equal(detail.viewer.cannotApprove.rule, 'R1');
  assert.match(detail.viewer.cannotApprove.why, /You submitted this bill/);
  assert.match(detail.viewer.cannotApprove.remedy, /Approval flow page/);

  const refusal = await postExpectingStatus(
    `/organizations/${org}/approvals/tasks/${detail.viewer.openTaskId}/command`,
    { command: { kind: 'approve' }, idempotencyKey: `test-approve-${billId}` },
    setup.sessionToken,
    409,
  );
  assert.equal(refusal.details.rule, 'R1', 'refused for the rule that says a submitter may not approve');

  const after = await get(`/organizations/${org}/bills/${billId}/detail`, setup.sessionToken);
  assert.equal(after.approval.macroState, 'pending_approval', 'and the bill goes nowhere');
});

test('async intake returns the document immediately and processes in the background', async () => {
  const setup = await createPaymentOrderSetup();
  const newVendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [{
        counterparty: 'Async Vendor Co',
        amount: 250,
        currency: 'USD',
        reference: 'INV-ASYNC-1',
        due_date: '2026-08-15',
        wallet_address: newVendorWallet,
        notes: null,
      }],
      modelLatencyMs: 5,
      pageCount: 1,
    }),
  });

  const upload = await post(
    `/organizations/${setup.organization.organizationId}/invoices/upload-async`,
    {
      filename: 'async-invoice.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 async').toString('base64'),
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  assert.ok(upload.invoiceDocumentId);

  // Poll status until the background read completes.
  let status: { status: string; paymentOrders: Array<{ paymentOrderId: string; state: string }>; processingError: string | null } | null = null;
  for (let i = 0; i < 40; i += 1) {
    status = await get(
      `/organizations/${setup.organization.organizationId}/invoice-documents/${upload.invoiceDocumentId}/status`,
      setup.sessionToken,
    );
    if (status!.status !== 'processing') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status!.status, 'processed', status!.processingError ?? '');
  assert.equal(status!.paymentOrders.length, 1);
  assert.equal(status!.paymentOrders[0]!.state, 'draft');

  // The same file again dedupes to the already-processed document.
  const again = await post(
    `/organizations/${setup.organization.organizationId}/invoices/upload-async`,
    {
      filename: 'async-invoice-copy.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 async').toString('base64'),
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  assert.equal(again.invoiceDocumentId, upload.invoiceDocumentId);
  assert.equal(again.reused, true);
});

test('a needs-review upload can be dismissed as not a bill', async () => {
  const setup = await createPaymentOrderSetup();
  const newVendorWallet = Keypair.generate().publicKey.toBase58();
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [{
        counterparty: 'Statement Sender LLC',
        amount: 120,
        currency: 'USD',
        reference: 'STMT-1',
        due_date: null,
        wallet_address: newVendorWallet,
        notes: null,
      }],
      modelLatencyMs: 5,
      pageCount: 1,
    }),
  });
  const upload = await post(
    `/organizations/${setup.organization.organizationId}/invoices/upload`,
    {
      filename: 'statement.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 statement').toString('base64'),
      autoAdvance: false,
    },
    setup.sessionToken,
  );
  const billId = upload.paymentOrders[0].paymentOrder.paymentOrderId;

  const dismissed = await post(
    `/organizations/${setup.organization.organizationId}/bills/${billId}/not-a-bill`,
    { reason: 'statement', note: 'Monthly statement, not an invoice.' },
    setup.sessionToken,
  );
  assert.equal(dismissed.state, 'cancelled');

  const workbench = await get(
    `/organizations/${setup.organization.organizationId}/bills/workbench`,
    setup.sessionToken,
  );
  const row = workbench.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === billId);
  assert.equal(row.bucket, 'needs_attention');
});

test('CSV batch import creates PaymentOrders with a shared input batch id', async () => {
  const setup = await createPaymentOrderSetup();
  const secondWallet = await createCounterpartyWallet(setup, {
    label: 'Second trusted vendor',
    walletAddress: Keypair.generate().publicKey.toBase58(),
  });
  const csv = [
    'payee,destination,amount,reference,due_date',
    `${setup.counterpartyWallet.label},${setup.counterpartyWallet.walletAddress},0.01,CSV-1001,2026-04-15`,
    `${secondWallet.label},${secondWallet.walletAddress},0.02,CSV-1002,2026-04-16`,
  ].join('\n');

  const preview = await post(
    `/organizations/${setup.organization.organizationId}/payment-orders/batch-csv/preview`,
    { csv },
    setup.sessionToken,
  );
  assert.equal(preview.totalRows, 2);
  assert.equal(preview.ready, 2);
  assert.equal(preview.canImport, true);

  const imported = await post(
    `/organizations/${setup.organization.organizationId}/payment-orders/batch-csv`,
    {
      csv,
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      batchLabel: 'April vendor batch',
      autoAdvance: false,
    },
    setup.sessionToken,
  );

  assert.equal(imported.imported, 2);
  assert.equal(imported.failed, 0);
  assert.equal(imported.inputBatchLabel, 'April vendor batch');
  assert.equal(new Set(imported.paymentOrders.map((item: { inputBatchId: string }) => item.inputBatchId)).size, 1);
  for (const item of imported.paymentOrders) {
    assert.equal(item.status, 'imported');
    assert.equal(item.paymentOrder.inputBatchId, imported.inputBatchId);
    assert.equal(item.paymentOrder.inputBatchLabel, 'April vendor batch');
    assert.equal(item.paymentOrder.state, 'submitted');
    assert.equal(item.paymentOrder.transferRequests.length, 0);
  }

  const list = await get(
    `/organizations/${setup.organization.organizationId}/payment-orders?inputBatchId=${imported.inputBatchId}`,
    setup.sessionToken,
  );
  assert.equal(list.items.length, 2);
});

test('payment proof reflects the collapsed payment lifecycle', async () => {
  const setup = await createPaymentOrderSetup();
  const paymentOrder = await post(
    `/organizations/${setup.organization.organizationId}/payment-orders`,
    {
      counterpartyWalletId: setup.counterpartyWallet.counterpartyWalletId,
      sourceTreasuryWalletId: setup.sourceTreasuryWallet.treasuryWalletId,
      amountRaw: '10000',
      externalReference: 'PROOF-1',
    },
    setup.sessionToken,
  );

  await seedExactSettlement({
    organizationId: setup.organization.organizationId,
    paymentOrderId: paymentOrder.paymentOrderId,
    amountRaw: '10000',
  });

  const proof = await get(
    `/organizations/${setup.organization.organizationId}/payment-orders/${paymentOrder.paymentOrderId}/proof`,
    setup.sessionToken,
  );
  assert.equal(proof.status, 'complete');
  assert.equal(proof.intent.paymentOrderId, paymentOrder.paymentOrderId);
  assert.equal(proof.readiness.status, 'complete');
  assert.ok(proof.canonicalDigest);
});

async function createPaymentOrderSetup(options?: {
  userEmail?: string;
  organizationName?: string;
  counterpartyWalletTrustState?: 'trusted' | 'unreviewed' | 'restricted' | 'blocked';
}) {
  const register = await post('/auth/register', {
    email: options?.userEmail ?? `payments-${crypto.randomUUID()}@example.com`,
    password: 'DemoPass123!',
    displayName: 'Payments Operator',
  });
  await verifyRegisteredEmail(register);

  const organization = await post(
    '/organizations',
    {
      organizationName: options?.organizationName ?? `Payments ${crypto.randomUUID().slice(0, 8)}`,
    },
    register.sessionToken,
  );

  const sourceTreasuryWallet = await post(
    `/organizations/${organization.organizationId}/treasury-wallets`,
    {
      chain: 'solana',
      address: Keypair.generate().publicKey.toBase58(),
      displayName: 'Ops source wallet',
    },
    register.sessionToken,
  );

  const counterparty = await post(
    `/organizations/${organization.organizationId}/counterparties`,
    {
      displayName: `Vendor ${crypto.randomUUID().slice(0, 8)}`,
      category: 'vendor',
    },
    register.sessionToken,
  );

  const counterpartyWallet = await createCounterpartyWallet(
    {
      sessionToken: register.sessionToken,
      organization,
    },
    {
      counterpartyId: counterparty.counterpartyId,
      label: `Vendor payout ${crypto.randomUUID().slice(0, 8)}`,
      walletAddress: Keypair.generate().publicKey.toBase58(),
      trustState: options?.counterpartyWalletTrustState ?? 'trusted',
    },
  );

  return {
    sessionToken: register.sessionToken as string,
    organization,
    sourceTreasuryWallet,
    counterparty,
    counterpartyWallet,
  };
}

async function createCounterpartyWallet(
  setup: { sessionToken: string; organization: { organizationId: string } },
  input: {
    counterpartyId?: string;
    label: string;
    walletAddress: string;
    trustState?: 'trusted' | 'unreviewed' | 'restricted' | 'blocked';
  },
) {
  return post(
    `/organizations/${setup.organization.organizationId}/counterparty-wallets`,
    {
      counterpartyId: input.counterpartyId,
      walletAddress: input.walletAddress,
      label: input.label,
      trustState: input.trustState ?? 'trusted',
      walletType: 'vendor_wallet',
      isInternal: false,
    },
    setup.sessionToken,
  );
}

async function seedExactSettlement(args: {
  organizationId: string;
  paymentOrderId: string;
  amountRaw: string;
}) {
  const paymentOrder = await prisma.paymentOrder.findFirstOrThrow({
    where: {
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
    },
  });
  const request = await prisma.transferRequest.create({
    data: {
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
      counterpartyWalletId: paymentOrder.counterpartyWalletId,
      sourceTreasuryWalletId: paymentOrder.sourceTreasuryWalletId,
      requestType: 'payment_order',
      asset: 'usdc',
      amountRaw: BigInt(args.amountRaw),
      status: 'matched',
      propertiesJson: {},
    },
  });
  const signature = `5Exact${crypto.randomUUID().replaceAll('-', '')}`;
  await prisma.executionRecord.create({
    data: {
      transferRequestId: request.transferRequestId,
      organizationId: args.organizationId,
      executionSource: 'test_rpc_verification',
      state: 'settled',
      submittedSignature: signature,
      submittedAt: new Date('2026-04-10T12:30:00.000Z'),
      metadataJson: {
        rpcSettlementVerification: {
          status: 'settled',
          signature,
          checkedAt: '2026-04-10T12:30:01.000Z',
          items: [{
            expectedAmountRaw: args.amountRaw,
            observedDeltaRaw: args.amountRaw,
            settled: true,
          }],
        },
      },
    },
  });
  await prisma.paymentOrder.update({
    where: { paymentOrderId: args.paymentOrderId },
    data: { state: 'settled' },
  });
}

async function post(path: string, body: unknown, sessionToken?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionToken ? authHeaders(sessionToken) : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();

  assert.ok(
    response.status === 200 || response.status === 201,
    `expected 200 or 201 but received ${response.status}: ${text}`,
  );

  return JSON.parse(text);
}

/** POST that expects a specific refusal, for asserting a rule actually bites. */
async function postExpectingStatus(path: string, body: unknown, sessionToken: string, status: number) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(sessionToken) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, status, `expected ${status} but received ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function get(path: string, sessionToken: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: authHeaders(sessionToken),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function verifyRegisteredEmail(register: { sessionToken: string; devEmailVerificationCode?: string | null }) {
  const code = register.devEmailVerificationCode;
  assert.ok(code, 'registration should return a demo email verification code until email delivery exists');
  await post('/auth/verify-email', { code }, register.sessionToken);
}

function authHeaders(sessionToken: string) {
  return {
    authorization: `Bearer ${sessionToken}`,
  };
}

async function executeWithDeadlockRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Code: `40P01`') && !message.includes('deadlock detected')) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }

  throw lastError;
}
