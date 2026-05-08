import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../src/app.js';
import { prisma } from '../src/prisma.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  auth_sessions,
  wallet_challenges,
  user_wallets,
  organization_memberships,
  approval_decisions,
  approval_policies,
  execution_records,
  transfer_request_notes,
  transfer_request_events,
  collection_request_events,
  collection_requests,
  collection_runs,
  collection_sources,
  payment_runs,
  payment_order_events,
  payment_orders,
  payment_requests,
  transfer_requests,
  destinations,
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
  await executeWithDeadlockRetry(() => prisma.$executeRawUnsafe(TRUNCATE_SQL));
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
    `/organizations/${setup.organization.organizationId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
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
  assert.equal(paymentOrder.sourceTreasuryWalletId, setup.sourceAddress.treasuryWalletId);
  assert.equal(paymentOrder.destinationId, setup.destination.destinationId);
  assert.equal(paymentOrder.transferRequests.length, 1);
  assert.equal(paymentOrder.reconciliationDetail.status, 'approved');
  assert.equal(paymentOrder.derivedState, 'ready_for_execution');
  assert.equal(paymentOrder.balanceWarning.status, 'sufficient');

  const transferRequest = await prisma.transferRequest.findUniqueOrThrow({
    where: { transferRequestId: paymentOrder.transferRequestId },
  });
  assert.equal(transferRequest.paymentOrderId, paymentOrder.paymentOrderId);
  assert.equal(transferRequest.sourceTreasuryWalletId, setup.sourceAddress.treasuryWalletId);
  assert.equal(transferRequest.destinationId, setup.destination.destinationId);
  assert.equal(transferRequest.status, 'approved');

  const list = await get(`/organizations/${setup.organization.organizationId}/payment-orders`, setup.sessionToken);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].paymentOrderId, paymentOrder.paymentOrderId);
});

test('payment requests capture user intent and promote into payment orders', async () => {
  const setup = await createPaymentOrderSetup();

  const paymentRequest = await post(
    `/organizations/${setup.organization.organizationId}/payment-requests`,
    {
      destinationId: setup.destination.destinationId,
      amountRaw: '15000',
      reason: 'Pay Fuyo LLC for INV-102',
      externalReference: 'INV-102',
      createOrderNow: true,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      submitOrderNow: true,
    },
    setup.sessionToken,
  );

  assert.equal(paymentRequest.reason, 'Pay Fuyo LLC for INV-102');
  assert.equal(paymentRequest.externalReference, 'INV-102');
  assert.equal(paymentRequest.state, 'converted_to_order');
  assert.ok(paymentRequest.paymentOrder.paymentOrderId);

  const paymentOrder = await get(
    `/organizations/${setup.organization.organizationId}/payment-orders/${paymentRequest.paymentOrder.paymentOrderId}`,
    setup.sessionToken,
  );
  assert.equal(paymentOrder.paymentRequestId, paymentRequest.paymentRequestId);
  assert.equal(paymentOrder.memo, 'Pay Fuyo LLC for INV-102');
  assert.equal(paymentOrder.externalReference, 'INV-102');
  assert.equal(paymentOrder.transferRequests.length, 1);
  assert.equal(paymentOrder.derivedState, 'ready_for_execution');
  assert.equal(paymentOrder.paymentRequest.reason, 'Pay Fuyo LLC for INV-102');

  const list = await get(`/organizations/${setup.organization.organizationId}/payment-requests`, setup.sessionToken);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].paymentOrder.paymentOrderId, paymentOrder.paymentOrderId);
});

test('CSV import creates payment requests and orders against existing destinations', async () => {
  const setup = await createPaymentOrderSetup();
  const csv = [
    'counterparty,destination,amount,reference,due_date',
    `Fuyo LLC,${setup.destination.label},0.015,INV-CSV-1,2026-04-15`,
  ].join('\n');

  const result = await post(
    `/organizations/${setup.organization.organizationId}/payment-requests/import-csv`,
    {
      csv,
      createOrderNow: true,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      submitOrderNow: true,
    },
    setup.sessionToken,
  );

  assert.equal(result.imported, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.items[0].paymentRequest.amountRaw, '15000');
  assert.equal(result.items[0].paymentRequest.state, 'converted_to_order');
  assert.equal(result.items[0].paymentRequest.destinationId, setup.destination.destinationId);

  const paymentOrder = await get(
    `/organizations/${setup.organization.organizationId}/payment-orders/${result.items[0].paymentRequest.paymentOrder.paymentOrderId}`,
    setup.sessionToken,
  );
  assert.equal(paymentOrder.amountRaw, '15000');
  assert.equal(paymentOrder.externalReference, 'INV-CSV-1');
  assert.equal(paymentOrder.destinationId, setup.destination.destinationId);
  assert.equal(paymentOrder.derivedState, 'ready_for_execution');
});

test('CSV import creates unreviewed destinations for raw wallet addresses', async () => {
  const setup = await createPaymentOrderSetup();
  const firstWallet = Keypair.generate().publicKey.toBase58();
  const secondWallet = Keypair.generate().publicKey.toBase58();
  const csv = [
    'counterparty,destination,amount,reference,due_date',
    `Acme Corp,${firstWallet},0.01,INV-1001,2026-04-15`,
    `Beta Supplies,${secondWallet},0.01,INV-1002,2026-04-18`,
  ].join('\n');

  const result = await post(
    `/organizations/${setup.organization.organizationId}/payment-requests/import-csv`,
    {
      csv,
      createOrderNow: true,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      submitOrderNow: false,
    },
    setup.sessionToken,
  );

  assert.equal(result.imported, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.items[0].paymentRequest.amountRaw, '10000');
  assert.equal(result.items[1].paymentRequest.externalReference, 'INV-1002');

  const destinations = await get(`/organizations/${setup.organization.organizationId}/destinations`, setup.sessionToken);
  const importedDestinations = destinations.items.filter((item: { walletAddress: string }) => [firstWallet, secondWallet].includes(item.walletAddress));
  assert.equal(importedDestinations.length, 2);
  assert.deepEqual(
    importedDestinations.map((item: { trustState: string }) => item.trustState).sort(),
    ['unreviewed', 'unreviewed'],
  );

  const addresses = await get(`/organizations/${setup.organization.organizationId}/treasury-wallets`, setup.sessionToken);
  const importedAddresses = addresses.items.filter((item: { address: string }) => [firstWallet, secondWallet].includes(item.address));
  assert.equal(importedAddresses.length, 0);
});

test('payment runs import CSV rows and prepare one batch execution packet', async () => {
  const setup = await createPaymentOrderSetup();
  const secondDestinationAddress = await post(
    `/organizations/${setup.organization.organizationId}/treasury-wallets`,
    {
      chain: 'solana',
      address: Keypair.generate().publicKey.toBase58(),
      displayName: `Second vendor ${crypto.randomUUID().slice(0, 8)}`,
    },
    setup.sessionToken,
  );
  const secondDestination = await post(
    `/organizations/${setup.organization.organizationId}/destinations`,
    {
      walletAddress: secondDestinationAddress.address,
      tokenAccountAddress: secondDestinationAddress.usdcAtaAddress ?? undefined,
      label: `Second payout ${crypto.randomUUID().slice(0, 8)}`,
      trustState: 'trusted',
      destinationType: 'vendor_wallet',
      isInternal: false,
    },
    setup.sessionToken,
  );
  const csv = [
    'counterparty,destination,amount,reference,due_date',
    `Acme Corp,${setup.destination.label},0.01,RUN-1001,2026-04-15`,
    `Beta Supplies,${secondDestination.label},0.02,RUN-1002,2026-04-18`,
  ].join('\n');

  const imported = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/import-csv`,
    {
      runName: 'April payroll run',
      csv,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      submitOrderNow: true,
    },
    setup.sessionToken,
  );

  assert.equal(imported.importResult.imported, 2);
  assert.equal(imported.importResult.failed, 0);
  assert.equal(imported.paymentRun.runName, 'April payroll run');
  assert.equal(imported.paymentRun.totals.orderCount, 2);
  assert.equal(imported.paymentRun.totals.totalAmountRaw, '30000');
  assert.equal(imported.paymentRun.reconciliationSummary.requestedAmountRaw, '30000');
  assert.equal(imported.paymentRun.reconciliationSummary.matchedAmountRaw, '0');
  assert.equal(imported.paymentRun.reconciliationSummary.settlementCounts.pending, 2);

  const prepared = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/${imported.paymentRun.paymentRunId}/prepare-execution`,
    {
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
    },
    setup.sessionToken,
  );

  assert.equal(prepared.executionRecords.length, 2);
  assert.equal(prepared.executionPacket.kind, 'solana_spl_usdc_transfer_batch');
  assert.equal(prepared.executionPacket.transfers.length, 2);
  assert.equal(prepared.executionPacket.instructions.length, 4);
  assert.equal(prepared.executionPacket.amountRaw, '30000');
  assert.equal(prepared.paymentRun.derivedState, 'ready_for_execution');

  const preparedAgain = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/${imported.paymentRun.paymentRunId}/prepare-execution`,
    {
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
    },
    setup.sessionToken,
  );
  assert.deepEqual(
    preparedAgain.executionRecords.map((record: { executionRecordId: string }) => record.executionRecordId),
    prepared.executionRecords.map((record: { executionRecordId: string }) => record.executionRecordId),
  );

  const signature = '5'.repeat(88);
  const attached = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/${imported.paymentRun.paymentRunId}/attach-signature`,
    {
      submittedSignature: signature,
      submittedAt: '2026-04-10T12:00:00.000Z',
    },
    setup.sessionToken,
  );

  assert.equal(attached.executionRecords.length, 2);
  assert.ok(attached.executionRecords.every((record: { submittedSignature: string; state: string }) => record.submittedSignature === signature && record.state === 'submitted_onchain'));
  assert.equal(attached.paymentRun.derivedState, 'submitted_onchain');

  const runProof = await get(
    `/organizations/${setup.organization.organizationId}/payment-runs/${imported.paymentRun.paymentRunId}/proof`,
    setup.sessionToken,
  );
  assert.equal(runProof.packetType, 'stablecoin_payment_run_proof');
  assert.equal(runProof.detailLevel, 'summary');
  assert.match(runProof.proofId, /^decimal_payment_run_proof_/);
  assert.match(runProof.canonicalDigest, /^[a-f0-9]{64}$/);
  assert.equal(runProof.orderProofs.length, 0);
  assert.equal(runProof.readiness.counts.total, 2);
  assert.equal(runProof.reconciliationSummary.requestedAmountRaw, '30000');
  assert.equal(runProof.reconciliationSummary.settlementCounts.pending, 2);
  assert.equal(runProof.agentSummary.canTreatAsFinal, false);
  assert.match(runProof.orders[0].proofId, /^decimal_payment_proof_/);
  assert.match(runProof.orders[0].proofDigest, /^[a-f0-9]{64}$/);
  assert.match(runProof.orders[0].fullProofEndpoint, /\/payment-orders\/.+\/proof$/);
  assert.equal(runProof.orders[0].latestExecution, undefined);
  assert.equal(runProof.orders[0].match, undefined);
  assert.equal(runProof.orders[0].exceptions, undefined);

  const summaryRunProof = await get(
    `/organizations/${setup.organization.organizationId}/payment-runs/${imported.paymentRun.paymentRunId}/proof?detail=summary`,
    setup.sessionToken,
  );
  assert.equal(summaryRunProof.detailLevel, 'summary');
  assert.equal(summaryRunProof.orderProofs.length, 0);
  assert.equal(summaryRunProof.orders.length, 2);

  const compactRunProof = await get(
    `/organizations/${setup.organization.organizationId}/payment-runs/${imported.paymentRun.paymentRunId}/proof?detail=compact`,
    setup.sessionToken,
  );
  assert.equal(compactRunProof.detailLevel, 'compact');
  assert.equal(compactRunProof.orderProofs.length, 2);
  assert.equal(compactRunProof.orders[0].proofId, compactRunProof.orderProofs[0].proofId);
  assert.equal(compactRunProof.orders[0].proofDigest, compactRunProof.orderProofs[0].canonicalDigest);
  assert.equal(compactRunProof.orderProofs[0].sourceArtifacts, undefined);
  assert.equal(compactRunProof.orderProofs[0].auditTrail, undefined);
  assert.match(compactRunProof.orderProofs[0].fullProofEndpoint, /\/payment-orders\/.+\/proof$/);

  const fullRunProof = await get(
    `/organizations/${setup.organization.organizationId}/payment-runs/${imported.paymentRun.paymentRunId}/proof?detail=full`,
    setup.sessionToken,
  );
  assert.equal(fullRunProof.detailLevel, 'full');
  assert.equal(fullRunProof.orderProofs.length, 2);
  assert.ok(fullRunProof.orderProofs[0].sourceArtifacts);
  assert.ok(Array.isArray(fullRunProof.orderProofs[0].auditTrail));

});

test('payment run CSV preview detects duplicate rows and import is idempotent by key', async () => {
  const setup = await createPaymentOrderSetup();
  const csv = [
    'counterparty,destination,amount,reference,due_date',
    `Acme Corp,${setup.destination.label},0.01,RUN-IDEMP-1,2026-04-15`,
  ].join('\n');
  const duplicateCsv = [
    'counterparty,destination,amount,reference,due_date',
    `Acme Corp,${setup.destination.label},0.01,RUN-DUP-1,2026-04-15`,
    `Acme Corp,${setup.destination.label},0.01,RUN-DUP-1,2026-04-15`,
  ].join('\n');

  const preview = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/import-csv/preview`,
    { csv: duplicateCsv },
    setup.sessionToken,
  );
  assert.equal(preview.totalRows, 2);
  // Row 1 clean against an existing destination; row 2 flagged as duplicate.
  assert.equal(preview.ready, 1);
  assert.equal(preview.warnings, 1);
  assert.equal(preview.failed, 0);
  assert.equal(preview.canImport, true);
  assert.match(preview.csvFingerprint, /^[a-f0-9]{64}$/);
  assert.match(preview.items[1].warnings[0], /Duplicate CSV row/i);

  const imported = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/import-csv`,
    {
      runName: 'Idempotent run',
      csv,
      importKey: 'idem-run-1',
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      submitOrderNow: true,
    },
    setup.sessionToken,
  );
  const replay = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/import-csv`,
    {
      runName: 'Should not create another run',
      csv,
      importKey: 'idem-run-1',
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      submitOrderNow: true,
    },
    setup.sessionToken,
  );

  assert.equal(imported.paymentRun.paymentRunId, replay.paymentRun.paymentRunId);
  assert.equal(replay.importResult.idempotentReplay, true);
  assert.equal(replay.paymentRun.totals.orderCount, 1);

  const runCount = await prisma.paymentRun.count({
    where: { organizationId: setup.organization.organizationId },
  });
  assert.equal(runCount, 1);
});

test('payment run cancellation and close are explicit lifecycle actions', async () => {
  const setup = await createPaymentOrderSetup();
  const cancellableCsv = [
    'counterparty,destination,amount,reference,due_date',
    `Cancel Corp,${setup.destination.label},0.01,RUN-CANCEL-1,2026-04-15`,
  ].join('\n');
  const cancellable = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/import-csv`,
    {
      runName: 'Cancellable run',
      csv: cancellableCsv,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      submitOrderNow: false,
    },
    setup.sessionToken,
  );

  const cancelled = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/${cancellable.paymentRun.paymentRunId}/cancel`,
    {},
    setup.sessionToken,
  );
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.derivedState, 'cancelled');
  assert.equal(cancelled.paymentOrders[0].state, 'cancelled');
  assert.equal(cancelled.paymentOrders[0].derivedState, 'cancelled');

  const closableCsv = [
    'counterparty,destination,amount,reference,due_date',
    `Close Corp,${setup.destination.label},0.01,RUN-CLOSE-1,2026-04-15`,
  ].join('\n');
  const closable = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/import-csv`,
    {
      runName: 'Closable run',
      csv: closableCsv,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      submitOrderNow: true,
    },
    setup.sessionToken,
  );
  const order = closable.paymentRun.paymentOrders[0];
  await seedExactSettlement({
    organizationId: setup.organization.organizationId,
    transferRequestId: order.transferRequestId,
    amountRaw: '10000',
  });

  const closed = await post(
    `/organizations/${setup.organization.organizationId}/payment-runs/${closable.paymentRun.paymentRunId}/close`,
    {},
    setup.sessionToken,
  );
  assert.equal(closed.state, 'closed');
  assert.equal(closed.derivedState, 'closed');
  assert.equal(closed.paymentOrders[0].state, 'closed');
  assert.equal(closed.paymentOrders[0].derivedState, 'closed');

  const transferRequest = await prisma.transferRequest.findUniqueOrThrow({
    where: { transferRequestId: order.transferRequestId },
  });
  assert.equal(transferRequest.status, 'closed');
});

test('collections create inbound expected transfers against owned receiving wallets', async () => {
  const setup = await createPaymentOrderSetup();
  const payerWallet = Keypair.generate().publicKey.toBase58();
  const dualRoleSource = await post(
    `/organizations/${setup.organization.organizationId}/collection-sources`,
    {
      counterpartyId: setup.counterparty.counterpartyId,
      walletAddress: setup.destinationAddress.address,
      tokenAccountAddress: setup.destinationAddress.usdcAtaAddress,
      label: 'Vendor payer wallet',
      trustState: 'trusted',
    },
    setup.sessionToken,
  );

  assert.equal(dualRoleSource.walletAddress, setup.destinationAddress.address);
  assert.equal(dualRoleSource.trustState, 'trusted');

  const collection = await post(
    `/organizations/${setup.organization.organizationId}/collections`,
    {
      receivingTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      collectionSourceId: dualRoleSource.collectionSourceId,
      amountRaw: '25000',
      reason: 'Collect invoice AR-1001',
      externalReference: 'AR-1001',
      dueAt: '2026-04-20T00:00:00.000Z',
    },
    setup.sessionToken,
  );

  assert.equal(collection.state, 'open');
  assert.equal(collection.derivedState, 'open');
  assert.equal(collection.amountRaw, '25000');
  assert.equal(collection.receivingTreasuryWallet.treasuryWalletId, setup.sourceAddress.treasuryWalletId);
  assert.equal(collection.receivingTreasuryWallet.address, setup.sourceAddress.address);
  assert.equal(collection.collectionSourceId, dualRoleSource.collectionSourceId);
  assert.equal(collection.collectionSource.walletAddress, setup.destinationAddress.address);
  assert.equal(collection.payerWalletAddress, setup.destinationAddress.address);
  assert.ok(collection.transferRequestId);

  const adHocCollection = await post(
    `/organizations/${setup.organization.organizationId}/collections`,
    {
      receivingTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      counterpartyId: setup.counterparty.counterpartyId,
      payerWalletAddress: payerWallet,
      amountRaw: '26000',
      reason: 'Collect ad hoc payer',
      externalReference: 'AR-1002',
    },
    setup.sessionToken,
  );
  assert.equal(adHocCollection.collectionSource.walletAddress, payerWallet);
  assert.equal(adHocCollection.collectionSource.trustState, 'unreviewed');

  const transferRequest = await prisma.transferRequest.findUniqueOrThrow({
    where: { transferRequestId: collection.transferRequestId },
    include: { destination: true },
  });
  assert.equal(transferRequest.requestType, 'collection_request');
  assert.equal(transferRequest.status, 'approved');
  assert.equal(transferRequest.sourceTreasuryWalletId, null);
  assert.equal(transferRequest.destination.walletAddress, setup.sourceAddress.address);
  assert.equal(transferRequest.destination.tokenAccountAddress, setup.sourceAddress.usdcAtaAddress);
  assert.equal(transferRequest.destination.isInternal, true);
  assert.equal(transferRequest.destination.destinationType, 'internal_collection_receiver');

  const publicDestinations = await get(`/organizations/${setup.organization.organizationId}/destinations`, setup.sessionToken);
  assert.ok(
    publicDestinations.items.every((destination: { destinationId: string }) => destination.destinationId !== transferRequest.destinationId),
    'internal collection receiver should not appear in the normal destination address book',
  );

  const destinationsWithInternal = await get(
    `/organizations/${setup.organization.organizationId}/destinations?includeInternal=true`,
    setup.sessionToken,
  );
  assert.ok(
    destinationsWithInternal.items.some((destination: { destinationId: string }) => destination.destinationId === transferRequest.destinationId),
    'internal collection receiver should remain inspectable when explicitly requested',
  );

  const collected = await get(
    `/organizations/${setup.organization.organizationId}/collections/${collection.collectionRequestId}`,
    setup.sessionToken,
  );
  assert.equal(collected.derivedState, 'open');
  assert.equal(collected.reconciliationDetail.requestDisplayState, 'pending');
  assert.equal(collected.reconciliationDetail.match, null);

  const proof = await get(
    `/organizations/${setup.organization.organizationId}/collections/${collection.collectionRequestId}/proof`,
    setup.sessionToken,
  );
  assert.equal(proof.packetType, 'stablecoin_collection_proof');
  assert.equal(proof.status, 'in_progress');
  assert.equal(proof.collectionSourceReview.status, 'awaiting_observation');
  assert.equal(proof.collectionSourceReview.expectedSourceWallet, setup.destinationAddress.address);
  assert.equal(proof.collectionSourceReview.observedSourceWallet, null);
  assert.equal(proof.readiness.status, 'in_progress');

});

test('collection runs import CSV rows into a batch of inbound collection requests', async () => {
  const setup = await createPaymentOrderSetup();
  const firstPayerWallet = Keypair.generate().publicKey.toBase58();
  const secondPayerWallet = Keypair.generate().publicKey.toBase58();
  const csv = [
    'counterparty,receiving_wallet,payer_wallet,amount,reference,due_date',
    `Acme Customer,${setup.sourceAddress.displayName},${firstPayerWallet},0.03,AR-RUN-1,2026-04-20`,
    `Beta Customer,${setup.sourceAddress.address},${secondPayerWallet},0.04,AR-RUN-2,2026-04-21`,
  ].join('\n');

  const preview = await post(
    `/organizations/${setup.organization.organizationId}/collection-runs/import-csv/preview`,
    { csv },
    setup.sessionToken,
  );
  assert.equal(preview.totalRows, 2);
  assert.equal(preview.ready, 2);
  assert.equal(preview.failed, 0);
  assert.equal(preview.canImport, true);
  assert.match(preview.csvFingerprint, /^[a-f0-9]{64}$/);

  const imported = await post(
    `/organizations/${setup.organization.organizationId}/collection-runs/import-csv`,
    {
      runName: 'April receivables',
      csv,
      importKey: 'collection-run-1',
      notes: 'Monthly AR upload',
    },
    setup.sessionToken,
  );

  assert.equal(imported.importResult.imported, 2);
  assert.equal(imported.importResult.failed, 0);
  assert.equal(imported.collectionRun.runName, 'April receivables');
  assert.equal(imported.collectionRun.summary.total, 2);
  assert.equal(imported.collectionRun.summary.totalAmountRaw, '70000');
  assert.equal(imported.collectionRun.collectionRequests.length, 2);
  assert.equal(imported.collectionRun.collectionRequests[0].transferRequest.requestType, 'collection_request');

  const replay = await post(
    `/organizations/${setup.organization.organizationId}/collection-runs/import-csv`,
    {
      runName: 'Should replay',
      csv,
      importKey: 'collection-run-1',
    },
    setup.sessionToken,
  );
  assert.equal(replay.importResult.idempotentReplay, true);
  assert.equal(replay.collectionRun.collectionRunId, imported.collectionRun.collectionRunId);

  const transferRequestCount = await prisma.transferRequest.count({
    where: {
      organizationId: setup.organization.organizationId,
      requestType: 'collection_request',
    },
  });
  assert.equal(transferRequestCount, 2);

  const collectionSources = await get(`/organizations/${setup.organization.organizationId}/collection-sources`, setup.sessionToken);
  const importedSources = collectionSources.items.filter((item: { walletAddress: string }) => [firstPayerWallet, secondPayerWallet].includes(item.walletAddress));
  assert.equal(importedSources.length, 2);
  assert.deepEqual(
    importedSources.map((item: { trustState: string }) => item.trustState).sort(),
    ['unreviewed', 'unreviewed'],
  );

  const destinations = await get(`/organizations/${setup.organization.organizationId}/destinations?includeInternal=true`, setup.sessionToken);
  const payerDestinations = destinations.items.filter((item: { walletAddress: string }) => [firstPayerWallet, secondPayerWallet].includes(item.walletAddress));
  assert.equal(payerDestinations.length, 0);

  const runProof = await get(
    `/organizations/${setup.organization.organizationId}/collection-runs/${imported.collectionRun.collectionRunId}/proof`,
    setup.sessionToken,
  );
  assert.equal(runProof.packetType, 'stablecoin_collection_run_proof');
  assert.equal(runProof.collections.length, 2);
  assert.equal(runProof.readiness.status, 'needs_review');
  assert.equal(runProof.collections[0].sourceReviewStatus, 'source_needs_review');

});

test('payment order duplicate references and unsafe source wallets are rejected', async () => {
  const setup = await createPaymentOrderSetup();

  await post(
    `/organizations/${setup.organization.organizationId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      amountRaw: '10000',
      externalReference: 'DUP-1',
    },
    setup.sessionToken,
  );

  let response = await fetch(`${baseUrl}/organizations/${setup.organization.organizationId}/payment-orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(setup.sessionToken),
    },
    body: JSON.stringify({
      destinationId: setup.destination.destinationId,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      amountRaw: '10000',
      externalReference: 'dup-1',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /already exists/i);

  response = await fetch(`${baseUrl}/organizations/${setup.organization.organizationId}/payment-orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(setup.sessionToken),
    },
    body: JSON.stringify({
      destinationId: setup.destination.destinationId,
      sourceTreasuryWalletId: setup.destinationAddress.treasuryWalletId,
      amountRaw: '10000',
      externalReference: 'SRC-SAME',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Source wallet cannot be the same/i);

  const outsider = await createPaymentOrderSetup({
    userEmail: 'outsider@example.com',
    organizationName: 'Outsider Organization',
  });
  response = await fetch(`${baseUrl}/organizations/${setup.organization.organizationId}/payment-orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(setup.sessionToken),
    },
    body: JSON.stringify({
      destinationId: setup.destination.destinationId,
      sourceTreasuryWalletId: outsider.sourceAddress.treasuryWalletId,
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
    `/organizations/${setup.organization.organizationId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
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
    `/organizations/${setup.organization.organizationId}/payment-orders/${paymentOrder.paymentOrderId}/create-execution`,
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
    `/organizations/${setup.organization.organizationId}/payment-orders/${paymentOrder.paymentOrderId}/attach-signature`,
    {
      submittedSignature: signature,
      externalReference: 'squads://proposal/abc',
    },
    setup.sessionToken,
  );

  assert.equal(updatedExecution.submittedSignature, signature);
  assert.equal(updatedExecution.state, 'submitted_onchain');

  const detail = await get(
    `/organizations/${setup.organization.organizationId}/payment-orders/${paymentOrder.paymentOrderId}`,
    setup.sessionToken,
  );
  assert.equal(detail.derivedState, 'execution_recorded');
  assert.equal(detail.reconciliationDetail.status, 'submitted_onchain');
  assert.equal(detail.reconciliationDetail.latestExecution.submittedSignature, signature);
});

test('payment orders prepare a signer-ready Solana USDC transfer packet', async () => {
  const setup = await createPaymentOrderSetup();
  const draftOrder = await post(
    `/organizations/${setup.organization.organizationId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      amountRaw: '10000',
      externalReference: 'PREPARE-1',
      submitNow: false,
    },
    setup.sessionToken,
  );

  const prepared = await post(
    `/organizations/${setup.organization.organizationId}/payment-orders/${draftOrder.paymentOrderId}/prepare-execution`,
    {
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
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

  const preparedAgain = await post(
    `/organizations/${setup.organization.organizationId}/payment-orders/${draftOrder.paymentOrderId}/prepare-execution`,
    {
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
    },
    setup.sessionToken,
  );
  assert.equal(preparedAgain.executionRecord.executionRecordId, prepared.executionRecord.executionRecordId);

  const transferRequest = await prisma.transferRequest.findUniqueOrThrow({
    where: { transferRequestId: prepared.paymentOrder.transferRequestId },
  });
  assert.equal(transferRequest.sourceTreasuryWalletId, setup.sourceAddress.treasuryWalletId);
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
    `/organizations/${setup.organization.organizationId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
      amountRaw: '10000',
      externalReference: 'PREPARE-APPROVAL',
      submitNow: false,
    },
    setup.sessionToken,
  );

  const response = await fetch(
    `${baseUrl}/organizations/${setup.organization.organizationId}/payment-orders/${draftOrder.paymentOrderId}/prepare-execution`,
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
    organizationId: setup.organization.organizationId,
    transferRequestId: paymentOrder.transferRequestId,
    amountRaw: '10000',
  });

  const settled = await get(
    `/organizations/${setup.organization.organizationId}/payment-orders/${paymentOrder.paymentOrderId}`,
    setup.sessionToken,
  );
  assert.equal(settled.derivedState, 'settled');
  assert.equal(settled.reconciliationDetail.requestDisplayState, 'matched');
  assert.equal(settled.reconciliationDetail.match.matchedAmountRaw, '10000');

  const proof = await get(
    `/organizations/${setup.organization.organizationId}/payment-orders/${paymentOrder.paymentOrderId}/proof`,
    setup.sessionToken,
  );
  assert.equal(proof.packetType, 'stablecoin_payment_proof');
  assert.match(proof.proofId, /^decimal_payment_proof_/);
  assert.match(proof.canonicalDigest, /^[a-f0-9]{64}$/);
  assert.equal(proof.status, 'complete');
  assert.equal(proof.readiness.status, 'complete');
  assert.deepEqual(proof.readiness.warnings, []);
  assert.equal(proof.intent.paymentOrderId, paymentOrder.paymentOrderId);
  assert.equal(proof.intent.amountRaw, '10000');
  assert.equal(proof.intent.amountUsdc, '0.010000');
  assert.equal(proof.settlement.matchStatus, 'rpc_verified');
  assert.equal(proof.settlement.matchedAmountRaw, '10000');
  assert.equal(proof.settlement.reconciliationOutcome, 'matched_exact');
  assert.equal(proof.agentSummary.canTreatAsFinal, true);
  assert.equal(proof.verification.reconciliation.outcome, 'matched_exact');

  const partialOrder = await createSubmittedPaymentOrder(setup, 'MATCH-PARTIAL');
  await seedPartialSettlement({
    organizationId: setup.organization.organizationId,
    transferRequestId: partialOrder.transferRequestId,
    amountRaw: '10000',
    matchedAmountRaw: '4000',
  });

  const partial = await get(
    `/organizations/${setup.organization.organizationId}/payment-orders/${partialOrder.paymentOrderId}`,
    setup.sessionToken,
  );
  assert.equal(partial.derivedState, 'exception');
  assert.equal(partial.reconciliationDetail.requestDisplayState, 'exception');
  assert.equal(partial.reconciliationDetail.exceptions[0].reasonCode, 'rpc_settlement_mismatch');

  const partialProof = await get(
    `/organizations/${setup.organization.organizationId}/payment-orders/${partialOrder.paymentOrderId}/proof`,
    setup.sessionToken,
  );
  assert.equal(partialProof.status, 'exception');
  assert.equal(partialProof.settlement.reconciliationOutcome, 'exception');
});

async function createSubmittedPaymentOrder(
  setup: Awaited<ReturnType<typeof createPaymentOrderSetup>>,
  reference: string,
) {
  return post(
    `/organizations/${setup.organization.organizationId}/payment-orders`,
    {
      destinationId: setup.destination.destinationId,
      sourceTreasuryWalletId: setup.sourceAddress.treasuryWalletId,
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
  destinationTrustState?: 'trusted' | 'unreviewed' | 'restricted' | 'blocked';
}) {
  const register = await post('/auth/register', {
    email: options?.userEmail ?? 'phase-f@example.com',
    password: 'DemoPass123!',
    displayName: 'Phase F Operator',
  });
  await verifyRegisteredEmail(register);

  const organization = await post(
    '/organizations',
    {
      organizationName: options?.organizationName ?? 'Phase F Treasury',
    },
    register.sessionToken,
  );

  const sourceAddress = await post(
    `/organizations/${organization.organizationId}/treasury-wallets`,
    {
      chain: 'solana',
      address: 'PGm4dkZcqPTkYKqAjNtAokVwJirJB8XQcGpYWBVcFMW',
      displayName: 'Ops source wallet',
    },
    register.sessionToken,
  );

  const destinationAddress = await post(
    `/organizations/${organization.organizationId}/treasury-wallets`,
    {
      chain: 'solana',
      address: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      displayName: 'Vendor destination wallet',
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

  const destination = await post(
    `/organizations/${organization.organizationId}/destinations`,
    {
      walletAddress: destinationAddress.address,
      tokenAccountAddress: destinationAddress.usdcAtaAddress ?? undefined,
      counterpartyId: counterparty.counterpartyId,
      label: `Vendor payout ${crypto.randomUUID().slice(0, 8)}`,
      trustState: options?.destinationTrustState ?? 'trusted',
      destinationType: 'vendor_wallet',
      isInternal: false,
    },
    register.sessionToken,
  );

  return {
    sessionToken: register.sessionToken as string,
    organization,
    sourceAddress,
    destinationAddress,
    counterparty,
    destination,
  };
}

async function seedExactSettlement(args: {
  organizationId: string;
  transferRequestId: string;
  amountRaw: string;
}) {
  const signature = `5Exact${crypto.randomUUID().replaceAll('-', '')}`;
  const request = await prisma.transferRequest.update({
    where: { transferRequestId: args.transferRequestId },
    data: { status: 'matched' },
  });
  await prisma.executionRecord.create({
    data: {
      transferRequestId: args.transferRequestId,
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
  if (request.paymentOrderId) {
    await prisma.paymentOrder.update({
      where: { paymentOrderId: request.paymentOrderId },
      data: { state: 'settled' },
    });
  }
}

async function seedPartialSettlement(args: {
  organizationId: string;
  transferRequestId: string;
  amountRaw: string;
  matchedAmountRaw: string;
}) {
  const signature = `5Partial${crypto.randomUUID().replaceAll('-', '')}`;
  const variance = (BigInt(args.amountRaw) - BigInt(args.matchedAmountRaw)).toString();
  const request = await prisma.transferRequest.update({
    where: { transferRequestId: args.transferRequestId },
    data: { status: 'submitted_onchain' },
  });
  await prisma.executionRecord.create({
    data: {
      transferRequestId: args.transferRequestId,
      organizationId: args.organizationId,
      executionSource: 'test_rpc_verification',
      state: 'submitted_onchain',
      submittedSignature: signature,
      submittedAt: new Date('2026-04-10T12:31:00.000Z'),
      metadataJson: {
        rpcSettlementVerification: {
          status: 'mismatch',
          signature,
          checkedAt: '2026-04-10T12:31:01.000Z',
          items: [{
            expectedAmountRaw: args.amountRaw,
            observedDeltaRaw: args.matchedAmountRaw,
            settled: false,
            varianceRaw: variance,
          }],
        },
      },
    },
  });
  if (request.paymentOrderId) {
    await prisma.paymentOrder.update({
      where: { paymentOrderId: request.paymentOrderId },
      data: { state: 'executed' },
    });
  }
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

async function verifyRegisteredEmail(register: { sessionToken: string; devEmailVerificationCode?: string | null }) {
  const code = register.devEmailVerificationCode;
  assert.ok(code, 'registration should return a demo email verification code until email delivery exists');
  await post('/auth/verify-email', { code }, register.sessionToken);
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
