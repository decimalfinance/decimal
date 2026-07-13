import assert from 'node:assert/strict';
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
  assert.equal(paymentOrder.state, 'draft');
  assert.equal(paymentOrder.derivedState, 'draft');
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
  assert.equal(result.paymentOrders[0].decision, 'needs_review');
  assert.equal(result.paymentOrders[0].paymentOrder.state, 'needs_review');
  assert.equal(result.paymentOrders[0].paymentOrder.transferRequests.length, 0);
  assert.equal(result.paymentOrders[1].decision, 'needs_review');
  assert.equal(result.paymentOrders[1].paymentOrder.state, 'needs_review');
  assert.equal(result.paymentOrders[1].paymentOrder.transferRequests.length, 0);

  const reviewOrder = result.paymentOrders[1].paymentOrder;
  const cleared = await post(
    `/organizations/${setup.organization.organizationId}/payment-orders/${reviewOrder.paymentOrderId}/clear-review`,
    {
      reviewNote: 'Verified invoice and wallet by email.',
      autoAdvance: false,
    },
    setup.sessionToken,
  );

  assert.equal(cleared.state, 'draft');
  assert.equal(cleared.derivedState, 'draft');
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
  assert.equal(upload.paymentOrders[0].paymentOrder.state, 'needs_review');
  // v3 pipeline: no bill enters the approval engine at upload — Confirm is the door.
  assert.equal(upload.paymentOrders[0].approvableId ?? null, null);

  const workbench = await get(
    `/organizations/${setup.organization.organizationId}/bills/workbench`,
    setup.sessionToken,
  );
  assert.equal(workbench.counts.needs_review, 1);
  const row = workbench.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === billId);
  assert.equal(row.bucket, 'needs_review');
  assert.equal(row.vendorName, 'Acme Cloud Services');
  assert.equal(row.description, 'Cloud hosting — compute (July 2026)');
  assert.equal(row.amountUsd, 4820);
  // Complete facts, nothing security-shaped open → ready for approval.
  assert.equal(row.readiness, 'ready');
  assert.equal(row.subStatus.text, 'Ready for approval');

  const review = await get(
    `/organizations/${setup.organization.organizationId}/bills/${billId}/review`,
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
      confirmedFieldKeys: ['invoiceDate'],
      noteForApprovers: 'Recurring cloud bill, verified against the document.',
    },
    setup.sessionToken,
  );
  assert.equal(confirmed.detail.state, 'draft');

  const after = await get(
    `/organizations/${setup.organization.organizationId}/bills/workbench`,
    setup.sessionToken,
  );
  assert.equal(after.counts.needs_review, 0);
  const afterRow = after.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === billId);
  assert.notEqual(afterRow.bucket, 'needs_review');

  // Bill detail (Screen 3): review facts + the approval side, viewer-aware.
  const detail = await get(
    `/organizations/${setup.organization.organizationId}/bills/${billId}/detail`,
    setup.sessionToken,
  );
  assert.equal(detail.review.paymentOrderId, billId);
  assert.ok(detail.approval, 'the confirmed bill has an approvable');
  assert.equal(detail.viewer.isRequester, true);
  assert.ok(Array.isArray(detail.approval.steps));
  assert.ok(Array.isArray(detail.corrections));

  const reviewAfter = await get(
    `/organizations/${setup.organization.organizationId}/bills/${billId}/review`,
    setup.sessionToken,
  );
  assert.equal(reviewAfter.readOnly, true);
  assert.equal(reviewAfter.verification.noteForApprovers, 'Recurring cloud bill, verified against the document.');
  const confirmedField = reviewAfter.fields.find((f: { key: string }) => f.key === 'invoiceDate');
  assert.equal(confirmedField.state, 'confirmed');
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
  assert.equal(status!.paymentOrders[0]!.state, 'needs_review');

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
    assert.equal(item.paymentOrder.state, 'draft');
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
