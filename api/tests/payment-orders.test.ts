import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../src/app.js';
import { prisma } from '../src/infra/prisma.js';
import { setInvoiceIntakeRuntimeForTests } from '../src/payments/invoice-intake.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  auth_sessions,
  wallet_challenges,
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
  collection_request_events,
  collection_requests,
  collection_runs,
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

test('invoice upload creates draft orders for trusted wallets and review-gated orders for new wallets', async () => {
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
  assert.equal(result.paymentOrders[0].decision, 'drafted');
  assert.equal(result.paymentOrders[0].paymentOrder.state, 'draft');
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
