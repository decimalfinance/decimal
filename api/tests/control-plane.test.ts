import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { executeClickHouse, insertClickHouseRows } from '../src/clickhouse.js';
import { prisma } from '../src/prisma.js';
import { deriveUsdcAtaForWallet } from '../src/solana.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  auth_sessions,
  organization_memberships,
  transfer_request_notes,
  transfer_request_events,
  exception_notes,
  exception_states,
  transfer_requests,
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
  await prisma.$executeRawUnsafe(TRUNCATE_SQL);
  await clearClickHouseTables();
});

after(async () => {
  if (closeServer) {
    await closeServer();
  }
  await prisma.$disconnect();
});

test('health endpoint returns ok', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('login creates a user session and session starts without organizations', async () => {
  const login = await post('/auth/login', {
    email: 'ops@example.com',
    displayName: 'Ops User',
  });

  assert.equal(login.status, 'authenticated');
  assert.ok(login.sessionToken);
  assert.equal(login.user.email, 'ops@example.com');
  assert.equal(login.organizations.length, 0);

  const sessionResponse = await fetch(`${baseUrl}/auth/session`, {
    headers: authHeaders(login.sessionToken),
  });

  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();

  assert.equal(session.authenticated, true);
  assert.equal(session.user.email, 'ops@example.com');
  assert.equal(session.organizations.length, 0);
});

test('organization creation and workspace creation are scoped to active member orgs', async () => {
  const login = await loginUser('owner@example.com', 'Owner');

  const organization = await post(
    '/organizations',
    {
      organizationName: 'Acme Treasury',
    },
    login.sessionToken,
  );

  const workspace = await post(
    `/organizations/${organization.organizationId}/workspaces`,
    {
      workspaceName: 'Primary Watch',
    },
    login.sessionToken,
  );

  const sessionResponse = await fetch(`${baseUrl}/auth/session`, {
    headers: authHeaders(login.sessionToken),
  });
  const session = await sessionResponse.json();

  assert.equal(session.organizations.length, 1);
  assert.equal(session.organizations[0].role, 'owner');
  assert.equal(session.organizations[0].workspaces.length, 1);
  assert.equal(session.organizations[0].workspaces[0].workspaceId, workspace.workspaceId);
});

test('wallets can be added to a workspace and listed back to members', async () => {
  const setup = await createOrganizationWorkspace();
  const workspace = setup.workspace;

  const address = await post(
    `/workspaces/${workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Main Treasury',
    },
    setup.sessionToken,
  );

  const response = await fetch(`${baseUrl}/workspaces/${workspace.workspaceId}/addresses`, {
    headers: authHeaders(setup.sessionToken),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].workspaceAddressId, address.workspaceAddressId);
  assert.equal(payload.items[0].displayName, 'Main Treasury');
});

test('internal matching context returns wallet-first transfer setup', async () => {
  const setup = await createOrganizationWorkspace();
  const workspaceId = setup.workspace.workspaceId;
  const recipientWallet = 'So11111111111111111111111111111111111111112';
  const expectedAta = deriveUsdcAtaForWallet(recipientWallet);

  const address = await post(
    `/workspaces/${workspaceId}/addresses`,
    {
      chain: 'solana',
      address: recipientWallet,
      displayName: 'Vendor Wallet',
    },
    setup.sessionToken,
  );

  const transferRequest = await post(
    `/workspaces/${workspaceId}/transfer-requests`,
    {
      destinationWorkspaceAddressId: address.workspaceAddressId,
      requestType: 'wallet_transfer',
      amountRaw: '10000',
      status: 'submitted',
    },
    setup.sessionToken,
  );

  const contextResponse = await fetch(
    `${baseUrl}/internal/workspaces/${workspaceId}/matching-context`,
  );
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json();

  assert.equal(context.addresses.length, 1);
  assert.equal(context.transferRequests.length, 1);
  assert.equal(context.transferRequests[0].transferRequestId, transferRequest.transferRequestId);
  assert.equal(context.transferRequests[0].destinationWorkspaceAddress.address, recipientWallet);
  assert.equal(context.transferRequests[0].destinationWorkspaceAddress.usdcAtaAddress, expectedAta);
  assert.equal(context.transferRequests[0].amountRaw, '10000');
});

test('recipient wallet setup derives a USDC receiving address and supports wallet-first transfer requests', async () => {
  const setup = await createOrganizationWorkspace();
  const workspaceId = setup.workspace.workspaceId;
  const recipientWallet = 'So11111111111111111111111111111111111111112';
  const expectedAta = deriveUsdcAtaForWallet(recipientWallet);

  const address = await post(
    `/workspaces/${workspaceId}/addresses`,
    {
      chain: 'solana',
      address: recipientWallet,
      displayName: 'Vendor Wallet',
    },
    setup.sessionToken,
  );

  assert.equal(address.usdcAtaAddress, expectedAta);
  assert.equal(address.propertiesJson.usdcAtaAddress, expectedAta);

  const transferRequest = await post(
    `/workspaces/${workspaceId}/transfer-requests`,
    {
      destinationWorkspaceAddressId: address.workspaceAddressId,
      requestType: 'vendor_payout',
      amountRaw: '10000',
      status: 'submitted',
    },
    setup.sessionToken,
  );

  assert.equal(transferRequest.destinationWorkspaceAddress.address, recipientWallet);
  assert.equal(transferRequest.destinationWorkspaceAddress.usdcAtaAddress, expectedAta);

  const contextResponse = await fetch(`${baseUrl}/internal/workspaces/${workspaceId}/matching-context`);
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json();

  assert.equal(context.transferRequests.length, 1);
  assert.equal(context.transferRequests[0].transferRequestId, transferRequest.transferRequestId);
  assert.equal(context.transferRequests[0].destinationWorkspaceAddress.address, recipientWallet);
  assert.equal(context.transferRequests[0].destinationWorkspaceAddress.usdcAtaAddress, expectedAta);
});

test('joined members can read org workspaces but cannot mutate workspace onboarding', async () => {
  const setup = await createOrganizationWorkspace();
  const member = await loginUser('member@example.com', 'Member');

  await post(`/organizations/${setup.organization.organizationId}/join`, {}, member.sessionToken);

  const workspacesResponse = await fetch(
    `${baseUrl}/organizations/${setup.organization.organizationId}/workspaces`,
    {
      headers: authHeaders(member.sessionToken),
    },
  );
  assert.equal(workspacesResponse.status, 200);

  const createAddressResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/addresses`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(member.sessionToken),
      },
      body: JSON.stringify({
        chain: 'solana',
        address: 'MemberAddress1111111111111111111111111111111',
      }),
    },
  );

  assert.equal(createAddressResponse.status, 400);
  const error = await createAddressResponse.json();
  assert.equal(error.message, 'Admin access required');
});

test('creating a transfer request writes a durable creation event and detail timeline', async () => {
  const setup = await createOrganizationWorkspace();
  const destinationAddress = await post(
    `/workspaces/${setup.workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Vendor Wallet',
    },
    setup.sessionToken,
  );

  const transferRequest = await post(
    `/workspaces/${setup.workspace.workspaceId}/transfer-requests`,
    {
      destinationWorkspaceAddressId: destinationAddress.workspaceAddressId,
      requestType: 'vendor_payout',
      amountRaw: '2500000',
      status: 'submitted',
    },
    setup.sessionToken,
  );

  const response = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/transfer-requests/${transferRequest.transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );

  assert.equal(response.status, 200);
  const detail = await response.json();

  assert.equal(detail.transferRequestId, transferRequest.transferRequestId);
  assert.equal(detail.events.length, 1);
  assert.equal(detail.events[0].eventType, 'request_created');
  assert.equal(detail.events[0].afterState, 'submitted');
  assert.equal(detail.events[0].actorType, 'user');
  assert.equal(detail.requestDisplayState, 'pending');
  assert.equal(detail.timeline[0].timelineType, 'request_event');
  assert.deepEqual(detail.availableTransitions, ['pending_approval']);
});

test('transfer request transitions enforce the lifecycle graph and add timeline notes', async () => {
  const setup = await createTransferRequestSetup({ status: 'draft' });

  const invalid = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/transfer-requests/${setup.transferRequest.transferRequestId}/transitions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        toStatus: 'approved',
      }),
    },
  );

  assert.equal(invalid.status, 400);
  const invalidPayload = await invalid.json();
  assert.match(invalidPayload.message, /Invalid request status transition/);

  const transitioned = await post(
    `/workspaces/${setup.workspace.workspaceId}/transfer-requests/${setup.transferRequest.transferRequestId}/transitions`,
    {
      toStatus: 'submitted',
      note: 'Ready for reviewer handoff',
      payloadJson: {
        channel: 'ops_console',
      },
    },
    setup.sessionToken,
  );

  assert.equal(transitioned.status, 'submitted');
  assert.deepEqual(transitioned.availableTransitions, ['pending_approval']);

  const detailResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/transfer-requests/${setup.transferRequest.transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();

  assert.equal(detail.events.length, 2);
  assert.equal(detail.events[1].eventType, 'status_transition');
  assert.equal(detail.events[1].beforeState, 'draft');
  assert.equal(detail.events[1].afterState, 'submitted');
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.notes[0].body, 'Ready for reviewer handoff');
  assert.equal(detail.timeline.filter((item: { timelineType: string }) => item.timelineType === 'request_note').length, 1);
});

test('workspace members can add request notes without admin mutation access', async () => {
  const setup = await createTransferRequestSetup();
  const member = await loginUser('member@example.com', 'Member');
  await post(`/organizations/${setup.organization.organizationId}/join`, {}, member.sessionToken);

  const response = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/transfer-requests/${setup.transferRequest.transferRequestId}/notes`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(member.sessionToken),
      },
      body: JSON.stringify({
        body: 'Investigating vendor confirmation.',
      }),
    },
  );

  assert.equal(response.status, 201);
  const note = await response.json();
  assert.equal(note.body, 'Investigating vendor confirmation.');
  assert.equal(note.authorUser.email, 'member@example.com');
});

test('reconciliation and request detail expose derived display state, explanations, and linkage', async () => {
  const setup = await createTransferRequestSetup({ status: 'draft' });
  const transferId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const signature = '5JVqfMHsuF1JpFt8jgJVTFwGV2SehX3BKoGNFS2pPzKSWbUtfHvood77scjmVSUiAtJ3ua6SYqUkHhUu5WuVNEQz';
  const eventTime = '2026-04-06 13:30:15.083';
  const createdAt = '2026-04-06 13:30:44.010';

  await post(
    `/workspaces/${setup.workspace.workspaceId}/transfer-requests/${setup.transferRequest.transferRequestId}/transitions`,
    {
      toStatus: 'submitted',
      linkedPaymentId: paymentId,
      linkedTransferIds: [transferId],
      linkedSignature: signature,
      payloadJson: {
        source: 'test-seed',
      },
    },
    setup.sessionToken,
  );

  await insertClickHouseRows('observed_transfers', [
    {
      transfer_id: transferId,
      signature,
      slot: 411111111,
      event_time: eventTime,
      asset: 'usdc',
      source_token_account: 'Fe6xZzfQf6nmx4Z1TnYeo3gvBmXXuE3VtMuKmBGJe3dm',
      source_wallet: 'PGm4dkZcqPTkYKqAjNtAokVwJirJB8XQcGpYWBVcFMW',
      destination_token_account: setup.destinationAddress.usdcAtaAddress,
      destination_wallet: setup.destinationAddress.address,
      amount_raw: '2500000',
      amount_decimal: '2.500000',
      transfer_kind: 'spl_token_transfer_checked',
      instruction_index: 2,
      inner_instruction_index: null,
      route_group: 'ix 2',
      leg_role: 'direct_settlement',
      properties_json: JSON.stringify({ seeded: true }),
      created_at: createdAt,
    },
  ]);

  await insertClickHouseRows('observed_payments', [
    {
      payment_id: paymentId,
      signature,
      slot: 411111111,
      event_time: eventTime,
      asset: 'usdc',
      source_wallet: 'PGm4dkZcqPTkYKqAjNtAokVwJirJB8XQcGpYWBVcFMW',
      destination_wallet: setup.destinationAddress.address,
      gross_amount_raw: '2500000',
      gross_amount_decimal: '2.500000',
      net_destination_amount_raw: '2500000',
      net_destination_amount_decimal: '2.500000',
      fee_amount_raw: '0',
      fee_amount_decimal: '0.000000',
      route_count: 1,
      payment_kind: 'direct_settlement',
      reconstruction_rule: 'payment_book_fifo_allocator',
      confidence_band: 'exact',
      properties_json: JSON.stringify({ seeded: true }),
      created_at: createdAt,
    },
  ]);

  await insertClickHouseRows('settlement_matches', [
    {
      workspace_id: setup.workspace.workspaceId,
      transfer_request_id: setup.transferRequest.transferRequestId,
      signature,
      observed_transfer_id: transferId,
      match_status: 'matched_partial',
      confidence_score: 72,
      confidence_band: 'partial',
      matched_amount_raw: '1250000',
      amount_variance_raw: '1250000',
      destination_match_type: 'wallet_destination',
      time_delta_seconds: 12,
      match_rule: 'payment_book_fifo_allocator',
      candidate_count: 1,
      explanation: 'Observed payment only partially covered the requested amount.',
      observed_event_time: eventTime,
      matched_at: createdAt,
      updated_at: createdAt,
    },
  ]);

  await insertClickHouseRows('exceptions', [
    {
      workspace_id: setup.workspace.workspaceId,
      exception_id: crypto.randomUUID(),
      transfer_request_id: setup.transferRequest.transferRequestId,
      signature,
      observed_transfer_id: transferId,
      exception_type: 'partial_settlement',
      severity: 'warning',
      status: 'open',
      explanation: 'Residual requested amount remains after observed settlement.',
      properties_json: JSON.stringify({ remainingAmountRaw: '1250000' }),
      observed_event_time: eventTime,
      processed_at: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    },
  ]);

  const reconciliationResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(reconciliationResponse.status, 200);
  const reconciliation = await reconciliationResponse.json();

  assert.equal(reconciliation.items.length, 1);
  assert.equal(reconciliation.items[0].requestDisplayState, 'exception');
  assert.equal(reconciliation.items[0].matchExplanation, 'Observed payment only partially covered the requested amount.');
  assert.equal(reconciliation.items[0].exceptionExplanation, 'Residual requested amount remains after observed settlement.');
  assert.equal(reconciliation.items[0].linkedSignature, signature);
  assert.deepEqual(reconciliation.items[0].linkedTransferIds, [transferId]);
  assert.equal(reconciliation.items[0].linkedPaymentId, paymentId);
  assert.equal(reconciliation.items[0].exceptions[0].reasonCode, 'partial_settlement');

  const detailResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/transfer-requests/${setup.transferRequest.transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();

  assert.equal(detail.status, 'exception');
  assert.equal(detail.requestDisplayState, 'exception');
  assert.equal(detail.linkedSignature, signature);
  assert.deepEqual(detail.linkedTransferIds, [transferId]);
  assert.equal(detail.linkedPaymentId, paymentId);
  assert.equal(detail.matchExplanation, 'Observed payment only partially covered the requested amount.');
  assert.equal(detail.exceptionExplanation, 'Residual requested amount remains after observed settlement.');
  assert.equal(detail.linkedObservedTransfers.length, 1);
  assert.equal(detail.linkedObservedTransfers[0].transferId, transferId);
  assert.equal(detail.linkedObservedPayment.paymentId, paymentId);
  assert.equal(detail.timeline.some((item: { timelineType: string }) => item.timelineType === 'match_result'), true);
  assert.equal(detail.timeline.some((item: { timelineType: string }) => item.timelineType === 'exception'), true);
  assert.equal(
    detail.events.some(
      (event: { eventType: string; afterState: string }) =>
        event.eventType === 'settlement_exception_projected' && event.afterState === 'exception',
    ),
    true,
  );
});

test('dedicated reconciliation queue endpoint supports display-state filtering and detail lookup', async () => {
  const setup = await createSeededPartialExceptionRequest();

  const queueResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue?displayState=exception`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(queueResponse.status, 200);
  const queue = await queueResponse.json();

  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].transferRequestId, setup.transferRequest.transferRequestId);
  assert.equal(queue.items[0].requestDisplayState, 'exception');
  assert.equal(queue.items[0].status, 'exception');

  const detailResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue/${setup.transferRequest.transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();

  assert.equal(detail.transferRequestId, setup.transferRequest.transferRequestId);
  assert.equal(detail.requestDisplayState, 'exception');
  assert.equal(detail.exceptions.length, 1);
  assert.deepEqual(detail.availableTransitions, ['closed']);
  assert.deepEqual(detail.exceptions[0].availableActions, ['reviewed', 'expected', 'dismissed']);
});

test('exception actions and notes update detail state and preserve operator audit', async () => {
  const setup = await createSeededPartialExceptionRequest();
  const exceptionId = setup.exceptionId;

  const actionResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/exceptions/${exceptionId}/actions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        action: 'dismissed',
        note: 'False positive after vendor confirmation.',
      }),
    },
  );
  assert.equal(actionResponse.status, 200);
  const updated = await actionResponse.json();
  assert.equal(updated.status, 'dismissed');

  const noteResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/exceptions/${exceptionId}/notes`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        body: 'Captured in reconciliation review.',
      }),
    },
  );
  assert.equal(noteResponse.status, 201);

  const exceptionDetailResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/exceptions/${exceptionId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(exceptionDetailResponse.status, 200);
  const exceptionDetail = await exceptionDetailResponse.json();

  assert.equal(exceptionDetail.status, 'dismissed');
  assert.deepEqual(exceptionDetail.availableActions, ['reopen']);
  assert.equal(exceptionDetail.notes.length, 2);

  const requestDetailResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue/${setup.transferRequest.transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(requestDetailResponse.status, 200);
  const requestDetail = await requestDetailResponse.json();

  assert.equal(requestDetail.requestDisplayState, 'partial');
  assert.equal(requestDetail.status, 'partially_matched');
  assert.equal(requestDetail.exceptions[0].status, 'dismissed');
  assert.equal(requestDetail.exceptions[0].notes.length, 2);
  assert.equal(
    requestDetail.events.some(
      (event: { eventType: string; payloadJson: { exceptionAction?: string } }) =>
        event.eventType === 'exception_status_updated' &&
        event.payloadJson?.exceptionAction === 'dismissed',
    ),
    true,
  );
});

test('protected workspace routes reject anonymous callers', async () => {
  const setup = await createOrganizationWorkspace();

  const response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/addresses`);
  assert.equal(response.status, 401);
});

async function loginUser(email: string, displayName: string) {
  return post('/auth/login', {
    email,
    displayName,
  });
}

async function createOrganizationWorkspace() {
  const login = await loginUser('beta@example.com', 'Beta Ops');
  const organization = await post(
    '/organizations',
    {
      organizationName: 'Beta Treasury',
    },
    login.sessionToken,
  );
  const workspace = await post(
    `/organizations/${organization.organizationId}/workspaces`,
    {
      workspaceName: 'Beta Ops',
    },
    login.sessionToken,
  );

  return {
    sessionToken: login.sessionToken as string,
    organization,
    workspace,
  };
}

async function createTransferRequestSetup(options?: { status?: 'draft' | 'submitted' }) {
  const setup = await createOrganizationWorkspace();
  const destinationAddress = await post(
    `/workspaces/${setup.workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Vendor Wallet',
    },
    setup.sessionToken,
  );

  const transferRequest = await post(
    `/workspaces/${setup.workspace.workspaceId}/transfer-requests`,
    {
      destinationWorkspaceAddressId: destinationAddress.workspaceAddressId,
      requestType: 'vendor_payout',
      amountRaw: '2500000',
      status: options?.status ?? 'submitted',
    },
    setup.sessionToken,
  );

  return {
    ...setup,
    destinationAddress,
    transferRequest,
  };
}

async function createSeededPartialExceptionRequest() {
  const setup = await createTransferRequestSetup({ status: 'draft' });
  const transferId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const exceptionId = crypto.randomUUID();
  const signature = '5JVqfMHsuF1JpFt8jgJVTFwGV2SehX3BKoGNFS2pPzKSWbUtfHvood77scjmVSUiAtJ3ua6SYqUkHhUu5WuVNEQz';
  const eventTime = '2026-04-06 13:30:15.083';
  const createdAt = '2026-04-06 13:30:44.010';

  await post(
    `/workspaces/${setup.workspace.workspaceId}/transfer-requests/${setup.transferRequest.transferRequestId}/transitions`,
    {
      toStatus: 'submitted',
      linkedPaymentId: paymentId,
      linkedTransferIds: [transferId],
      linkedSignature: signature,
      payloadJson: {
        source: 'test-seed',
      },
    },
    setup.sessionToken,
  );

  await insertClickHouseRows('observed_transfers', [
    {
      transfer_id: transferId,
      signature,
      slot: 411111111,
      event_time: eventTime,
      asset: 'usdc',
      source_token_account: 'Fe6xZzfQf6nmx4Z1TnYeo3gvBmXXuE3VtMuKmBGJe3dm',
      source_wallet: 'PGm4dkZcqPTkYKqAjNtAokVwJirJB8XQcGpYWBVcFMW',
      destination_token_account: setup.destinationAddress.usdcAtaAddress,
      destination_wallet: setup.destinationAddress.address,
      amount_raw: '2500000',
      amount_decimal: '2.500000',
      transfer_kind: 'spl_token_transfer_checked',
      instruction_index: 2,
      inner_instruction_index: null,
      route_group: 'ix 2',
      leg_role: 'direct_settlement',
      properties_json: JSON.stringify({ seeded: true }),
      created_at: createdAt,
    },
  ]);

  await insertClickHouseRows('observed_payments', [
    {
      payment_id: paymentId,
      signature,
      slot: 411111111,
      event_time: eventTime,
      asset: 'usdc',
      source_wallet: 'PGm4dkZcqPTkYKqAjNtAokVwJirJB8XQcGpYWBVcFMW',
      destination_wallet: setup.destinationAddress.address,
      gross_amount_raw: '2500000',
      gross_amount_decimal: '2.500000',
      net_destination_amount_raw: '2500000',
      net_destination_amount_decimal: '2.500000',
      fee_amount_raw: '0',
      fee_amount_decimal: '0.000000',
      route_count: 1,
      payment_kind: 'direct_settlement',
      reconstruction_rule: 'payment_book_fifo_allocator',
      confidence_band: 'exact',
      properties_json: JSON.stringify({ seeded: true }),
      created_at: createdAt,
    },
  ]);

  await insertClickHouseRows('settlement_matches', [
    {
      workspace_id: setup.workspace.workspaceId,
      transfer_request_id: setup.transferRequest.transferRequestId,
      signature,
      observed_transfer_id: transferId,
      match_status: 'matched_partial',
      confidence_score: 72,
      confidence_band: 'partial',
      matched_amount_raw: '1250000',
      amount_variance_raw: '1250000',
      destination_match_type: 'wallet_destination',
      time_delta_seconds: 12,
      match_rule: 'payment_book_fifo_allocator',
      candidate_count: 1,
      explanation: 'Observed payment only partially covered the requested amount.',
      observed_event_time: eventTime,
      matched_at: createdAt,
      updated_at: createdAt,
    },
  ]);

  await insertClickHouseRows('exceptions', [
    {
      workspace_id: setup.workspace.workspaceId,
      exception_id: exceptionId,
      transfer_request_id: setup.transferRequest.transferRequestId,
      signature,
      observed_transfer_id: transferId,
      exception_type: 'partial_settlement',
      severity: 'warning',
      status: 'open',
      explanation: 'Residual requested amount remains after observed settlement.',
      properties_json: JSON.stringify({ remainingAmountRaw: '1250000' }),
      observed_event_time: eventTime,
      processed_at: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    },
  ]);

  return {
    ...setup,
    transferId,
    paymentId,
    exceptionId,
    signature,
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

  assert.ok(
    response.status === 200 || response.status === 201,
    `expected 200 or 201 but received ${response.status}`,
  );

  return response.json();
}

function authHeaders(sessionToken: string) {
  return {
    authorization: `Bearer ${sessionToken}`,
  };
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
