import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../src/app.js';
import { executeClickHouse, insertClickHouseRows } from '../src/clickhouse.js';
import { prisma } from '../src/prisma.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  auth_sessions,
  organization_memberships,
  approval_decisions,
  approval_policies,
  execution_records,
  transfer_request_notes,
  transfer_request_events,
  exception_notes,
  exception_states,
  export_jobs,
  payment_order_events,
  payment_orders,
  payment_requests,
  payees,
  transfer_requests,
  destinations,
  counterparties,
  workspace_addresses,
  workspaces,
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
  await executeWithDeadlockRetry(() => prisma.$executeRawUnsafe(TRUNCATE_SQL));
  await clearClickHouseTables();
});

after(async () => {
  if (closeServer) {
    await closeServer();
  }
  await prisma.$disconnect();
});

test('payment orders create a business intent and submit into the existing request policy flow', async () => {
  const setup = await createPaymentOrderSetup();

  const paymentOrder = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      sourceWorkspaceAddressId: setup.sourceAddress.workspaceAddressId,
      amountRaw: '10000',
      memo: 'Invoice 1234 payout',
      externalReference: 'INV-1234',
      invoiceNumber: '1234',
      sourceBalanceSnapshotJson: {
        status: 'known',
        balanceRaw: '25000',
        observedAt: '2026-04-10T12:00:00.000Z',
      },
      submitNow: true,
    },
    setup.sessionToken,
  );

  assert.equal(paymentOrder.memo, 'Invoice 1234 payout');
  assert.equal(paymentOrder.externalReference, 'INV-1234');
  assert.equal(paymentOrder.sourceWorkspaceAddressId, setup.sourceAddress.workspaceAddressId);
  assert.equal(paymentOrder.destinationId, setup.destination.destinationId);
  assert.equal(paymentOrder.transferRequests.length, 1);
  assert.equal(paymentOrder.reconciliationDetail.status, 'approved');
  assert.equal(paymentOrder.derivedState, 'ready_for_execution');
  assert.equal(paymentOrder.balanceWarning.status, 'sufficient');

  const transferRequest = await prisma.transferRequest.findUniqueOrThrow({
    where: { transferRequestId: paymentOrder.transferRequestId },
  });
  assert.equal(transferRequest.paymentOrderId, paymentOrder.paymentOrderId);
  assert.equal(transferRequest.sourceWorkspaceAddressId, setup.sourceAddress.workspaceAddressId);
  assert.equal(transferRequest.destinationId, setup.destination.destinationId);
  assert.equal(transferRequest.status, 'approved');

  const list = await get(`/workspaces/${setup.workspace.workspaceId}/payment-orders`, setup.sessionToken);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].paymentOrderId, paymentOrder.paymentOrderId);
});

test('payment requests capture user intent and promote into payment orders', async () => {
  const setup = await createPaymentOrderSetup();

  const paymentRequest = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-requests`,
    {
      destinationId: setup.destination.destinationId,
      amountRaw: '15000',
      reason: 'Pay Fuyo LLC for INV-102',
      externalReference: 'INV-102',
      createOrderNow: true,
      sourceWorkspaceAddressId: setup.sourceAddress.workspaceAddressId,
      submitOrderNow: true,
    },
    setup.sessionToken,
  );

  assert.equal(paymentRequest.reason, 'Pay Fuyo LLC for INV-102');
  assert.equal(paymentRequest.externalReference, 'INV-102');
  assert.equal(paymentRequest.state, 'converted_to_order');
  assert.ok(paymentRequest.paymentOrder.paymentOrderId);

  const paymentOrder = await get(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders/${paymentRequest.paymentOrder.paymentOrderId}`,
    setup.sessionToken,
  );
  assert.equal(paymentOrder.paymentRequestId, paymentRequest.paymentRequestId);
  assert.equal(paymentOrder.memo, 'Pay Fuyo LLC for INV-102');
  assert.equal(paymentOrder.externalReference, 'INV-102');
  assert.equal(paymentOrder.transferRequests.length, 1);
  assert.equal(paymentOrder.derivedState, 'ready_for_execution');
  assert.equal(paymentOrder.paymentRequest.reason, 'Pay Fuyo LLC for INV-102');

  const list = await get(`/workspaces/${setup.workspace.workspaceId}/payment-requests`, setup.sessionToken);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].paymentOrder.paymentOrderId, paymentOrder.paymentOrderId);
});

test('CSV import creates lightweight payees and payment requests', async () => {
  const setup = await createPaymentOrderSetup();
  const csv = [
    'payee,destination,amount,reference,due_date',
    `Fuyo LLC,${setup.destination.label},0.015,INV-CSV-1,2026-04-15`,
  ].join('\n');

  const result = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-requests/import-csv`,
    {
      csv,
      createOrderNow: true,
      sourceWorkspaceAddressId: setup.sourceAddress.workspaceAddressId,
      submitOrderNow: true,
    },
    setup.sessionToken,
  );

  assert.equal(result.imported, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.items[0].payee.name, 'Fuyo LLC');
  assert.equal(result.items[0].paymentRequest.amountRaw, '15000');
  assert.equal(result.items[0].paymentRequest.state, 'converted_to_order');
  assert.equal(result.items[0].paymentRequest.payeeId, result.items[0].payee.payeeId);

  const paymentOrder = await get(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders/${result.items[0].paymentRequest.paymentOrder.paymentOrderId}`,
    setup.sessionToken,
  );
  assert.equal(paymentOrder.payee.name, 'Fuyo LLC');
  assert.equal(paymentOrder.payeeId, result.items[0].payee.payeeId);
  assert.equal(paymentOrder.amountRaw, '15000');
  assert.equal(paymentOrder.externalReference, 'INV-CSV-1');
  assert.equal(paymentOrder.derivedState, 'ready_for_execution');

  const payees = await get(`/workspaces/${setup.workspace.workspaceId}/payees`, setup.sessionToken);
  assert.equal(payees.items.length, 1);
  assert.equal(payees.items[0].defaultDestinationId, setup.destination.destinationId);
});

test('CSV import creates unreviewed destinations for raw wallet addresses', async () => {
  const setup = await createPaymentOrderSetup();
  const firstWallet = Keypair.generate().publicKey.toBase58();
  const secondWallet = Keypair.generate().publicKey.toBase58();
  const csv = [
    'payee,destination,amount,reference,due_date',
    `Acme Corp,${firstWallet},0.01,INV-1001,2026-04-15`,
    `Beta Supplies,${secondWallet},0.01,INV-1002,2026-04-18`,
  ].join('\n');

  const result = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-requests/import-csv`,
    {
      csv,
      createOrderNow: true,
      sourceWorkspaceAddressId: setup.sourceAddress.workspaceAddressId,
      submitOrderNow: false,
    },
    setup.sessionToken,
  );

  assert.equal(result.imported, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.items[0].payee.name, 'Acme Corp');
  assert.equal(result.items[1].payee.name, 'Beta Supplies');
  assert.equal(result.items[0].paymentRequest.amountRaw, '10000');
  assert.equal(result.items[1].paymentRequest.externalReference, 'INV-1002');

  const destinations = await get(`/workspaces/${setup.workspace.workspaceId}/destinations`, setup.sessionToken);
  const importedDestinations = destinations.items.filter((item: { walletAddress: string }) => [firstWallet, secondWallet].includes(item.walletAddress));
  assert.equal(importedDestinations.length, 2);
  assert.deepEqual(
    importedDestinations.map((item: { trustState: string }) => item.trustState).sort(),
    ['unreviewed', 'unreviewed'],
  );

  const addresses = await get(`/workspaces/${setup.workspace.workspaceId}/addresses`, setup.sessionToken);
  const importedAddresses = addresses.items.filter((item: { address: string }) => [firstWallet, secondWallet].includes(item.address));
  assert.equal(importedAddresses.length, 2);
  assert.ok(importedAddresses.every((item: { source: string; usdcAtaAddress: string | null }) => item.source === 'csv_import' && item.usdcAtaAddress));
});

test('payment order duplicate references and unsafe source wallets are rejected', async () => {
  const setup = await createPaymentOrderSetup();

  await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      sourceWorkspaceAddressId: setup.sourceAddress.workspaceAddressId,
      amountRaw: '10000',
      externalReference: 'DUP-1',
    },
    setup.sessionToken,
  );

  let response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/payment-orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(setup.sessionToken),
    },
    body: JSON.stringify({
      destinationId: setup.destination.destinationId,
      sourceWorkspaceAddressId: setup.sourceAddress.workspaceAddressId,
      amountRaw: '10000',
      externalReference: 'dup-1',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /already exists/i);

  response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/payment-orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(setup.sessionToken),
    },
    body: JSON.stringify({
      destinationId: setup.destination.destinationId,
      sourceWorkspaceAddressId: setup.destinationAddress.workspaceAddressId,
      amountRaw: '10000',
      externalReference: 'SRC-SAME',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Source wallet cannot be the same/i);

  const outsider = await createPaymentOrderSetup({
    userEmail: 'outsider@example.com',
    organizationName: 'Outsider Org',
    workspaceName: 'Outsider Workspace',
  });
  response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/payment-orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(setup.sessionToken),
    },
    body: JSON.stringify({
      destinationId: setup.destination.destinationId,
      sourceWorkspaceAddressId: outsider.sourceAddress.workspaceAddressId,
      amountRaw: '10000',
      externalReference: 'OUTSIDER-SOURCE',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Source wallet not found/i);
});

test('unreviewed destinations route payment orders to the approval inbox without activating matching', async () => {
  const setup = await createPaymentOrderSetup({ destinationTrustState: 'unreviewed' });

  const paymentOrder = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      sourceWorkspaceAddressId: setup.sourceAddress.workspaceAddressId,
      amountRaw: '10000',
      memo: 'New vendor review',
      submitNow: true,
    },
    setup.sessionToken,
  );

  assert.equal(paymentOrder.state, 'pending_approval');
  assert.equal(paymentOrder.derivedState, 'pending_approval');
  assert.equal(paymentOrder.reconciliationDetail.status, 'pending_approval');
  assert.equal(paymentOrder.reconciliationDetail.approvalState, 'pending_approval');
  assert.equal(paymentOrder.reconciliationDetail.approvalDecisions[0].action, 'routed_for_approval');
});

test('payment order execution handoff records external references and submitted signatures without custody', async () => {
  const setup = await createPaymentOrderSetup();
  const paymentOrder = await createSubmittedPaymentOrder(setup, 'EXEC-1');

  const execution = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders/${paymentOrder.paymentOrderId}/create-execution`,
    {
      executionSource: 'external_proposal',
      externalReference: 'squads://proposal/abc',
      metadataJson: {
        proposalId: 'abc',
      },
    },
    setup.sessionToken,
  );

  assert.equal(execution.transferRequestId, paymentOrder.transferRequestId);
  assert.equal(execution.executionSource, 'external_proposal');
  assert.equal(execution.state, 'ready_for_execution');
  assert.equal(execution.metadataJson.externalExecutionReference, 'squads://proposal/abc');

  const signature = '3E91VpnTrs4k5y9XrjJbeWZu7nHo4ZpD2sQAAAA1111111111111111111111111111';
  const updatedExecution = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders/${paymentOrder.paymentOrderId}/attach-signature`,
    {
      submittedSignature: signature,
      externalReference: 'squads://proposal/abc',
    },
    setup.sessionToken,
  );

  assert.equal(updatedExecution.submittedSignature, signature);
  assert.equal(updatedExecution.state, 'submitted_onchain');

  const detail = await get(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders/${paymentOrder.paymentOrderId}`,
    setup.sessionToken,
  );
  assert.equal(detail.derivedState, 'execution_recorded');
  assert.equal(detail.reconciliationDetail.status, 'submitted_onchain');
  assert.equal(detail.reconciliationDetail.latestExecution.submittedSignature, signature);
});

test('payment orders prepare a signer-ready Solana USDC transfer packet', async () => {
  const setup = await createPaymentOrderSetup();
  const draftOrder = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      amountRaw: '10000',
      externalReference: 'PREPARE-1',
      submitNow: false,
    },
    setup.sessionToken,
  );

  const prepared = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders/${draftOrder.paymentOrderId}/prepare-execution`,
    {
      sourceWorkspaceAddressId: setup.sourceAddress.workspaceAddressId,
    },
    setup.sessionToken,
  );

  assert.equal(prepared.executionPacket.kind, 'solana_spl_usdc_transfer');
  assert.equal(prepared.executionPacket.paymentOrderId, draftOrder.paymentOrderId);
  assert.equal(prepared.executionPacket.source.walletAddress, setup.sourceAddress.address);
  assert.equal(prepared.executionPacket.source.tokenAccountAddress, setup.sourceAddress.usdcAtaAddress);
  assert.equal(prepared.executionPacket.destination.walletAddress, setup.destinationAddress.address);
  assert.equal(prepared.executionPacket.destination.tokenAccountAddress, setup.destinationAddress.usdcAtaAddress);
  assert.equal(prepared.executionPacket.token.symbol, 'USDC');
  assert.equal(prepared.executionPacket.token.decimals, 6);
  assert.equal(prepared.executionPacket.amountRaw, '10000');
  assert.equal(prepared.executionPacket.instructions.length, 2);
  assert.equal(prepared.executionPacket.requiredSigners[0], setup.sourceAddress.address);
  assert.equal(prepared.executionPacket.signing.requiresRecentBlockhash, true);
  assert.equal(prepared.executionRecord.executionSource, 'prepared_solana_transfer');
  assert.equal(prepared.executionRecord.state, 'ready_for_execution');
  assert.equal(prepared.executionRecord.metadataJson.preparedExecution.executionRecordId, prepared.executionRecord.executionRecordId);

  const transferRequest = await prisma.transferRequest.findUniqueOrThrow({
    where: { transferRequestId: prepared.paymentOrder.transferRequestId },
  });
  assert.equal(transferRequest.sourceWorkspaceAddressId, setup.sourceAddress.workspaceAddressId);
  assert.equal(transferRequest.status, 'ready_for_execution');

  const events = await prisma.paymentOrderEvent.findMany({
    where: { paymentOrderId: draftOrder.paymentOrderId },
    orderBy: { createdAt: 'asc' },
  });
  assert.ok(events.some((event) => event.eventType === 'payment_order_source_selected'));
  assert.ok(events.some((event) => event.eventType === 'payment_order_execution_prepared'));
});

test('payment order execution preparation cannot bypass approval', async () => {
  const setup = await createPaymentOrderSetup({ destinationTrustState: 'unreviewed' });
  const draftOrder = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      sourceWorkspaceAddressId: setup.sourceAddress.workspaceAddressId,
      amountRaw: '10000',
      externalReference: 'PREPARE-APPROVAL',
      submitNow: false,
    },
    setup.sessionToken,
  );

  const response = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/payment-orders/${draftOrder.paymentOrderId}/prepare-execution`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({}),
    },
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /requires approval/i);

  const paymentOrder = await prisma.paymentOrder.findUniqueOrThrow({
    where: { paymentOrderId: draftOrder.paymentOrderId },
    include: { transferRequests: true },
  });
  assert.equal(paymentOrder.state, 'pending_approval');
  assert.equal(paymentOrder.transferRequests[0].status, 'pending_approval');

  const executionCount = await prisma.executionRecord.count({
    where: { transferRequestId: paymentOrder.transferRequests[0].transferRequestId },
  });
  assert.equal(executionCount, 0);
});

test('payment orders derive settled and exception states from existing reconciliation truth', async () => {
  const setup = await createPaymentOrderSetup();
  const paymentOrder = await createSubmittedPaymentOrder(setup, 'MATCH-1');

  await seedExactSettlement({
    workspaceId: setup.workspace.workspaceId,
    transferRequestId: paymentOrder.transferRequestId,
    destinationWallet: setup.destinationAddress.address,
    destinationTokenAccount: setup.destinationAddress.usdcAtaAddress,
    amountRaw: '10000',
  });

  const settled = await get(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders/${paymentOrder.paymentOrderId}`,
    setup.sessionToken,
  );
  assert.equal(settled.derivedState, 'settled');
  assert.equal(settled.reconciliationDetail.requestDisplayState, 'matched');
  assert.equal(settled.reconciliationDetail.match.matchedAmountRaw, '10000');

  const proof = await get(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders/${paymentOrder.paymentOrderId}/proof`,
    setup.sessionToken,
  );
  assert.equal(proof.packetType, 'stablecoin_payment_proof');
  assert.equal(proof.status, 'complete');
  assert.equal(proof.intent.paymentOrderId, paymentOrder.paymentOrderId);
  assert.equal(proof.intent.amountRaw, '10000');
  assert.equal(proof.settlement.matchStatus, 'matched_exact');
  assert.equal(proof.settlement.matchedAmountRaw, '10000');

  const partialOrder = await createSubmittedPaymentOrder(setup, 'MATCH-PARTIAL');
  await seedPartialSettlement({
    workspaceId: setup.workspace.workspaceId,
    transferRequestId: partialOrder.transferRequestId,
    destinationWallet: setup.destinationAddress.address,
    destinationTokenAccount: setup.destinationAddress.usdcAtaAddress,
    amountRaw: '10000',
    matchedAmountRaw: '4000',
  });

  const partial = await get(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders/${partialOrder.paymentOrderId}`,
    setup.sessionToken,
  );
  assert.equal(partial.derivedState, 'exception');
  assert.equal(partial.reconciliationDetail.requestDisplayState, 'exception');
  assert.equal(partial.reconciliationDetail.exceptions[0].reasonCode, 'partial_settlement');

  const audit = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/payment-orders/${partialOrder.paymentOrderId}/audit-export?format=csv`,
    {
      headers: authHeaders(setup.sessionToken),
    },
  );
  assert.equal(audit.status, 200);
  const csv = await audit.text();
  assert.match(csv, /payment_order_id/);
  assert.match(csv, /MATCH-PARTIAL/);
  assert.match(csv, /partial_settlement/);
});

async function createSubmittedPaymentOrder(
  setup: Awaited<ReturnType<typeof createPaymentOrderSetup>>,
  reference: string,
) {
  return post(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      sourceWorkspaceAddressId: setup.sourceAddress.workspaceAddressId,
      amountRaw: '10000',
      externalReference: reference,
      sourceBalanceSnapshotJson: {
        status: 'known',
        balanceRaw: '100000',
      },
      submitNow: true,
    },
    setup.sessionToken,
  );
}

async function createPaymentOrderSetup(options?: {
  userEmail?: string;
  organizationName?: string;
  workspaceName?: string;
  destinationTrustState?: 'trusted' | 'unreviewed' | 'restricted' | 'blocked';
}) {
  const login = await post('/auth/login', {
    email: options?.userEmail ?? 'phase-f@example.com',
    displayName: 'Phase F Operator',
  });

  const organization = await post(
    '/organizations',
    {
      organizationName: options?.organizationName ?? 'Phase F Treasury',
    },
    login.sessionToken,
  );

  const workspace = await post(
    `/organizations/${organization.organizationId}/workspaces`,
    {
      workspaceName: options?.workspaceName ?? 'Phase F Workspace',
    },
    login.sessionToken,
  );

  const sourceAddress = await post(
    `/workspaces/${workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'PGm4dkZcqPTkYKqAjNtAokVwJirJB8XQcGpYWBVcFMW',
      displayName: 'Ops source wallet',
    },
    login.sessionToken,
  );

  const destinationAddress = await post(
    `/workspaces/${workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      displayName: 'Vendor destination wallet',
    },
    login.sessionToken,
  );

  const counterparty = await post(
    `/workspaces/${workspace.workspaceId}/counterparties`,
    {
      displayName: `Vendor ${crypto.randomUUID().slice(0, 8)}`,
      category: 'vendor',
    },
    login.sessionToken,
  );

  const destination = await post(
    `/workspaces/${workspace.workspaceId}/destinations`,
    {
      linkedWorkspaceAddressId: destinationAddress.workspaceAddressId,
      counterpartyId: counterparty.counterpartyId,
      label: `Vendor payout ${crypto.randomUUID().slice(0, 8)}`,
      trustState: options?.destinationTrustState ?? 'trusted',
      destinationType: 'vendor_wallet',
      isInternal: false,
    },
    login.sessionToken,
  );

  return {
    sessionToken: login.sessionToken as string,
    organization,
    workspace,
    sourceAddress,
    destinationAddress,
    counterparty,
    destination,
  };
}

async function seedExactSettlement(args: {
  workspaceId: string;
  transferRequestId: string;
  destinationWallet: string;
  destinationTokenAccount: string;
  amountRaw: string;
}) {
  const transferId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const signature = `5Exact${crypto.randomUUID().replaceAll('-', '')}`;
  const eventTime = '2026-04-10 12:30:00.000';
  const createdAt = '2026-04-10 12:30:01.000';

  await insertClickHouseRows('observed_transfers', [
    observedTransferRow({ transferId, signature, destinationWallet: args.destinationWallet, destinationTokenAccount: args.destinationTokenAccount, amountRaw: args.amountRaw, eventTime, createdAt }),
  ]);

  await insertClickHouseRows('observed_payments', [
    observedPaymentRow({ paymentId, signature, destinationWallet: args.destinationWallet, amountRaw: args.amountRaw, eventTime, createdAt }),
  ]);

  await insertClickHouseRows('settlement_matches', [
    {
      workspace_id: args.workspaceId,
      transfer_request_id: args.transferRequestId,
      signature,
      observed_transfer_id: transferId,
      match_status: 'matched_exact',
      confidence_score: 100,
      confidence_band: 'exact',
      matched_amount_raw: args.amountRaw,
      amount_variance_raw: '0',
      destination_match_type: 'wallet_destination',
      time_delta_seconds: 1,
      match_rule: 'payment_book_fifo_allocator',
      candidate_count: 1,
      explanation: 'Payment order matched exactly.',
      observed_event_time: eventTime,
      matched_at: createdAt,
      updated_at: createdAt,
    },
  ]);
}

async function seedPartialSettlement(args: {
  workspaceId: string;
  transferRequestId: string;
  destinationWallet: string;
  destinationTokenAccount: string;
  amountRaw: string;
  matchedAmountRaw: string;
}) {
  const transferId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const exceptionId = crypto.randomUUID();
  const signature = `5Partial${crypto.randomUUID().replaceAll('-', '')}`;
  const eventTime = '2026-04-10 12:31:00.000';
  const createdAt = '2026-04-10 12:31:01.000';
  const variance = (BigInt(args.amountRaw) - BigInt(args.matchedAmountRaw)).toString();

  await insertClickHouseRows('observed_transfers', [
    observedTransferRow({ transferId, signature, destinationWallet: args.destinationWallet, destinationTokenAccount: args.destinationTokenAccount, amountRaw: args.matchedAmountRaw, eventTime, createdAt }),
  ]);

  await insertClickHouseRows('observed_payments', [
    observedPaymentRow({ paymentId, signature, destinationWallet: args.destinationWallet, amountRaw: args.matchedAmountRaw, eventTime, createdAt }),
  ]);

  await insertClickHouseRows('settlement_matches', [
    {
      workspace_id: args.workspaceId,
      transfer_request_id: args.transferRequestId,
      signature,
      observed_transfer_id: transferId,
      match_status: 'matched_partial',
      confidence_score: 72,
      confidence_band: 'partial',
      matched_amount_raw: args.matchedAmountRaw,
      amount_variance_raw: variance,
      destination_match_type: 'wallet_destination',
      time_delta_seconds: 1,
      match_rule: 'payment_book_fifo_allocator',
      candidate_count: 1,
      explanation: 'Payment order was partially settled.',
      observed_event_time: eventTime,
      matched_at: createdAt,
      updated_at: createdAt,
    },
  ]);

  await insertClickHouseRows('exceptions', [
    {
      workspace_id: args.workspaceId,
      exception_id: exceptionId,
      transfer_request_id: args.transferRequestId,
      signature,
      observed_transfer_id: transferId,
      exception_type: 'partial_settlement',
      severity: 'warning',
      status: 'open',
      explanation: 'Residual requested amount remains after observed settlement.',
      properties_json: JSON.stringify({ remainingAmountRaw: variance }),
      observed_event_time: eventTime,
      processed_at: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    },
  ]);
}

function observedTransferRow(args: {
  transferId: string;
  signature: string;
  destinationWallet: string;
  destinationTokenAccount: string;
  amountRaw: string;
  eventTime: string;
  createdAt: string;
}) {
  return {
    transfer_id: args.transferId,
    signature: args.signature,
    slot: 411111111,
    event_time: args.eventTime,
    asset: 'usdc',
    source_token_account: 'Fe6xZzfQf6nmx4Z1TnYeo3gvBmXXuE3VtMuKmBGJe3dm',
    source_wallet: 'PGm4dkZcqPTkYKqAjNtAokVwJirJB8XQcGpYWBVcFMW',
    destination_token_account: args.destinationTokenAccount,
    destination_wallet: args.destinationWallet,
    amount_raw: args.amountRaw,
    amount_decimal: '0.010000',
    transfer_kind: 'spl_token_transfer_checked',
    instruction_index: 2,
    inner_instruction_index: null,
    route_group: 'ix 2',
    leg_role: 'direct_settlement',
    properties_json: JSON.stringify({ seeded: true }),
    created_at: args.createdAt,
  };
}

function observedPaymentRow(args: {
  paymentId: string;
  signature: string;
  destinationWallet: string;
  amountRaw: string;
  eventTime: string;
  createdAt: string;
}) {
  return {
    payment_id: args.paymentId,
    signature: args.signature,
    slot: 411111111,
    event_time: args.eventTime,
    asset: 'usdc',
    source_wallet: 'PGm4dkZcqPTkYKqAjNtAokVwJirJB8XQcGpYWBVcFMW',
    destination_wallet: args.destinationWallet,
    gross_amount_raw: args.amountRaw,
    gross_amount_decimal: '0.010000',
    net_destination_amount_raw: args.amountRaw,
    net_destination_amount_decimal: '0.010000',
    fee_amount_raw: '0',
    fee_amount_decimal: '0.000000',
    route_count: 1,
    payment_kind: 'direct_settlement',
    reconstruction_rule: 'payment_book_fifo_allocator',
    confidence_band: 'exact',
    properties_json: JSON.stringify({ seeded: true }),
    created_at: args.createdAt,
  };
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

async function clearClickHouseTables() {
  const tables = [
    'raw_observations',
    'observed_transactions',
    'observed_transfers',
    'observed_payments',
    'matcher_events',
    'request_book_snapshots',
    'settlement_matches',
    'exceptions',
  ];

  for (const table of tables) {
    await executeClickHouse(`TRUNCATE TABLE usdc_ops.${table}`);
  }
}
