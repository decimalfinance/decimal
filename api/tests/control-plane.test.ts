import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { executeClickHouse, insertClickHouseRows } from '../src/clickhouse.js';
import { getOrResolveAddressLabels } from '../src/address-label-registry.js';
import { prisma } from '../src/prisma.js';
import { resetRateLimitBuckets } from '../src/rate-limit.js';
import { deriveUsdcAtaForWallet } from '../src/solana.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  auth_sessions,
  api_keys,
  idempotency_records,
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
  resetRateLimitBuckets();
  config.rateLimitEnabled = false;
  await executeWithDeadlockRetry(() => prisma.$executeRawUnsafe(TRUNCATE_SQL));
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

  const capabilitiesResponse = await fetch(`${baseUrl}/capabilities`);
  assert.equal(capabilitiesResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.product, 'stablecoin-ops-control-plane');
  assert.equal(capabilities.version, 1);
  assert.ok(
    capabilities.workflows.some((workflow: { id: string }) => workflow.id === 'csv_to_payment_run'),
  );
  assert.equal(capabilities.apiSurface.idempotency.includes('Idempotency-Key'), true);
  assert.ok(
    capabilities.agentActionContracts.some(
      (contract: { id: string; requiredScope: string }) =>
        contract.id === 'explain_reconciliation' && contract.requiredScope === 'reconciliation:read',
    ),
  );
  assert.ok(
    capabilities.agentActionContracts.some(
      (contract: { id: string; requiredScope: string }) =>
        contract.id === 'export_payment_proof' && contract.requiredScope === 'proofs:read',
    ),
  );
});

test('public and API-key routes enforce configured rate limits', async () => {
  const setup = await createOrganizationWorkspace();
  const key = await post(
    `/workspaces/${setup.workspace.workspaceId}/api-keys`,
    { label: 'rate limited agent' },
    setup.sessionToken,
  );

  const originalEnabled = config.rateLimitEnabled;
  const originalPublicMax = config.publicRateLimitMax;
  const originalPublicWindow = config.publicRateLimitWindowMs;
  const originalApiKeyMax = config.apiKeyRateLimitMax;
  const originalApiKeyWindow = config.apiKeyRateLimitWindowMs;

  try {
    config.rateLimitEnabled = true;
    config.publicRateLimitMax = 2;
    config.publicRateLimitWindowMs = 60_000;
    resetRateLimitBuckets();

    assert.equal((await fetch(`${baseUrl}/capabilities`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/capabilities`)).status, 200);
    const publicLimited = await fetch(`${baseUrl}/capabilities`);
    assert.equal(publicLimited.status, 429);
    assert.equal((await publicLimited.json()).code, 'rate_limit_exceeded');

    config.apiKeyRateLimitMax = 1;
    config.apiKeyRateLimitWindowMs = 60_000;
    resetRateLimitBuckets();

    const firstAgentRequest = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/agent/tasks`, {
      headers: authHeaders(key.token),
    });
    assert.equal(firstAgentRequest.status, 200);

    const secondAgentRequest = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/agent/tasks`, {
      headers: authHeaders(key.token),
    });
    assert.equal(secondAgentRequest.status, 429);
    assert.equal((await secondAgentRequest.json()).code, 'rate_limit_exceeded');
  } finally {
    config.rateLimitEnabled = originalEnabled;
    config.publicRateLimitMax = originalPublicMax;
    config.publicRateLimitWindowMs = originalPublicWindow;
    config.apiKeyRateLimitMax = originalApiKeyMax;
    config.apiKeyRateLimitWindowMs = originalApiKeyWindow;
    resetRateLimitBuckets();
  }
});

test('login creates a user session and session starts without organizations', async () => {
  const invalidLoginResponse = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email: 'not-an-email' }),
  });
  assert.equal(invalidLoginResponse.status, 400);
  const invalidLogin = await invalidLoginResponse.json();
  assert.equal(invalidLogin.error, 'ValidationError');
  assert.ok(Array.isArray(invalidLogin.issues));

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

test('duplicate names are rejected for organizations, workspaces, wallets, counterparties, and destinations', async () => {
  const login = await loginUser('owner@example.com', 'Owner');

  const organization = await post(
    '/organizations',
    {
      organizationName: 'Acme Treasury',
    },
    login.sessionToken,
  );

  let response = await fetch(`${baseUrl}/organizations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(login.sessionToken),
    },
    body: JSON.stringify({
      organizationName: 'acme treasury',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Organization name "acme treasury" already exists/i);

  const workspace = await post(
    `/organizations/${organization.organizationId}/workspaces`,
    {
      workspaceName: 'Primary Watch',
    },
    login.sessionToken,
  );

  response = await fetch(`${baseUrl}/organizations/${organization.organizationId}/workspaces`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(login.sessionToken),
    },
    body: JSON.stringify({
      workspaceName: 'primary watch',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Workspace name "primary watch" already exists/i);

  const address = await post(
    `/workspaces/${workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Vendor Wallet',
    },
    login.sessionToken,
  );

  response = await fetch(`${baseUrl}/workspaces/${workspace.workspaceId}/addresses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(login.sessionToken),
    },
    body: JSON.stringify({
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111113',
      displayName: 'vendor wallet',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Wallet name "vendor wallet" already exists/i);

  const counterparty = await post(
    `/workspaces/${workspace.workspaceId}/counterparties`,
    {
      displayName: 'Acme Vendor',
      category: 'vendor',
    },
    login.sessionToken,
  );

  response = await fetch(`${baseUrl}/workspaces/${workspace.workspaceId}/counterparties`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(login.sessionToken),
    },
    body: JSON.stringify({
      displayName: 'acme vendor',
      category: 'vendor',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Counterparty name "acme vendor" already exists/i);

  await post(
    `/workspaces/${workspace.workspaceId}/destinations`,
    {
      linkedWorkspaceAddressId: address.workspaceAddressId,
      counterpartyId: counterparty.counterpartyId,
      label: 'Acme payout wallet',
      trustState: 'trusted',
      destinationType: 'vendor_wallet',
      isInternal: false,
    },
    login.sessionToken,
  );

  const secondAddress = await post(
    `/workspaces/${workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111114',
      displayName: 'Treasury Wallet',
    },
    login.sessionToken,
  );

  response = await fetch(`${baseUrl}/workspaces/${workspace.workspaceId}/destinations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(login.sessionToken),
    },
    body: JSON.stringify({
      linkedWorkspaceAddressId: secondAddress.workspaceAddressId,
      label: 'acme payout wallet',
      trustState: 'trusted',
      destinationType: 'vendor_wallet',
      isInternal: false,
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Destination name "acme payout wallet" already exists/i);
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

test('wallet-first submitted requests route into approval and stay out of matching context', async () => {
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

  assert.equal(transferRequest.status, 'pending_approval');

  const contextResponse = await fetch(
    `${baseUrl}/internal/workspaces/${workspaceId}/matching-context`,
  );
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json();

  assert.equal(context.addresses.length, 1);
  assert.equal(context.transferRequests.length, 0);
});

test('recipient wallet setup derives a USDC receiving address and still routes raw wallet requests through approval policy', async () => {
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

  assert.equal(transferRequest.status, 'pending_approval');
  assert.equal(transferRequest.destinationWorkspaceAddress.address, recipientWallet);
  assert.equal(transferRequest.destinationWorkspaceAddress.usdcAtaAddress, expectedAta);

  const contextResponse = await fetch(`${baseUrl}/internal/workspaces/${workspaceId}/matching-context`);
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json();

  assert.equal(context.transferRequests.length, 0);
});

test('phase b flow supports counterparties, destinations, and destination-aware transfer requests', async () => {
  const setup = await createOrganizationWorkspace();
  const workspaceId = setup.workspace.workspaceId;
  const recipientWallet = 'So11111111111111111111111111111111111111112';
  const expectedAta = deriveUsdcAtaForWallet(recipientWallet);

  const address = await post(
    `/workspaces/${workspaceId}/addresses`,
    {
      chain: 'solana',
      address: recipientWallet,
      displayName: 'Acme Vendor Wallet',
    },
    setup.sessionToken,
  );

  const counterparty = await post(
    `/workspaces/${workspaceId}/counterparties`,
    {
      displayName: 'Acme Vendor',
      category: 'vendor',
      externalReference: 'VENDOR-ACME',
    },
    setup.sessionToken,
  );

  const destination = await post(
    `/workspaces/${workspaceId}/destinations`,
    {
      counterpartyId: counterparty.counterpartyId,
      linkedWorkspaceAddressId: address.workspaceAddressId,
      label: 'Acme payout wallet',
      destinationType: 'vendor_wallet',
      trustState: 'trusted',
      isInternal: false,
    },
    setup.sessionToken,
  );

  const transferRequest = await post(
    `/workspaces/${workspaceId}/transfer-requests`,
    {
      destinationId: destination.destinationId,
      requestType: 'vendor_payout',
      amountRaw: '10000',
      status: 'submitted',
    },
    setup.sessionToken,
  );

  assert.equal(transferRequest.status, 'approved');
  assert.equal(transferRequest.destinationId, destination.destinationId);
  assert.equal(transferRequest.destination.destinationId, destination.destinationId);
  assert.equal(transferRequest.destination.label, 'Acme payout wallet');
  assert.equal(transferRequest.destination.trustState, 'trusted');
  assert.equal(transferRequest.destination.counterparty.displayName, 'Acme Vendor');
  assert.equal(transferRequest.destinationWorkspaceAddress.address, recipientWallet);
  assert.equal(transferRequest.destinationWorkspaceAddress.usdcAtaAddress, expectedAta);

  const contextResponse = await fetch(`${baseUrl}/internal/workspaces/${workspaceId}/matching-context`);
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json();

  assert.equal(context.transferRequests.length, 1);
  assert.equal(context.transferRequests[0].destination.destinationId, destination.destinationId);
  assert.equal(context.transferRequests[0].destination.label, 'Acme payout wallet');
  assert.equal(context.transferRequests[0].destination.counterparty.displayName, 'Acme Vendor');
  assert.equal(context.transferRequests[0].destinationWorkspaceAddress.address, recipientWallet);
  assert.equal(context.transferRequests[0].destinationWorkspaceAddress.usdcAtaAddress, expectedAta);
});

test('destinations and wallets can be updated after creation', async () => {
  const setup = await createOrganizationWorkspace();
  const workspaceId = setup.workspace.workspaceId;

  const originalWallet = 'So11111111111111111111111111111111111111112';
  const correctedWallet = 'So11111111111111111111111111111111111111113';
  const correctedAta = deriveUsdcAtaForWallet(correctedWallet);

  const address = await post(
    `/workspaces/${workspaceId}/addresses`,
    {
      chain: 'solana',
      address: originalWallet,
      displayName: 'Vendor Wallet',
    },
    setup.sessionToken,
  );

  const destination = await post(
    `/workspaces/${workspaceId}/destinations`,
    {
      linkedWorkspaceAddressId: address.workspaceAddressId,
      label: 'Vendor payout wallet',
      trustState: 'unreviewed',
      destinationType: 'vendor_wallet',
      isInternal: false,
    },
    setup.sessionToken,
  );

  const updatedAddressResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/addresses/${address.workspaceAddressId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        address: correctedWallet,
        displayName: 'Corrected Vendor Wallet',
      }),
    },
  );
  assert.equal(updatedAddressResponse.status, 200);
  const updatedAddress = await updatedAddressResponse.json();
  assert.equal(updatedAddress.address, correctedWallet);
  assert.equal(updatedAddress.usdcAtaAddress, correctedAta);

  const updatedDestinationResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/destinations/${destination.destinationId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        trustState: 'trusted',
        notes: 'Approved after review',
      }),
    },
  );
  assert.equal(updatedDestinationResponse.status, 200);
  const updatedDestination = await updatedDestinationResponse.json();
  assert.equal(updatedDestination.trustState, 'trusted');
  assert.equal(updatedDestination.notes, 'Approved after review');
  assert.equal(updatedDestination.walletAddress, correctedWallet);
  assert.equal(updatedDestination.tokenAccountAddress, correctedAta);
});

test('destination trust state enforces request creation rules', async () => {
  const setup = await createOrganizationWorkspace();
  const workspaceId = setup.workspace.workspaceId;

  const address = await post(
    `/workspaces/${workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Vendor Wallet',
    },
    setup.sessionToken,
  );

  const unreviewedDestination = await post(
    `/workspaces/${workspaceId}/destinations`,
    {
      linkedWorkspaceAddressId: address.workspaceAddressId,
      label: 'Unreviewed vendor wallet',
      trustState: 'unreviewed',
    },
    setup.sessionToken,
  );

  const rejectedSubmitted = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/transfer-requests`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        destinationId: unreviewedDestination.destinationId,
        requestType: 'vendor_payout',
        amountRaw: '10000',
        status: 'submitted',
      }),
    },
  );
  assert.equal(rejectedSubmitted.status, 400);
  const rejectedPayload = await rejectedSubmitted.json();
  assert.match(rejectedPayload.message, /create the request as draft/i);

  const acceptedDraft = await post(
    `/workspaces/${workspaceId}/transfer-requests`,
    {
      destinationId: unreviewedDestination.destinationId,
      requestType: 'vendor_payout',
      amountRaw: '10000',
      status: 'draft',
    },
    setup.sessionToken,
  );
  assert.equal(acceptedDraft.status, 'draft');

  const blockedAddress = await post(
    `/workspaces/${workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111113',
      displayName: 'Blocked Vendor Wallet',
    },
    setup.sessionToken,
  );

  const blockedDestination = await post(
    `/workspaces/${workspaceId}/destinations`,
    {
      linkedWorkspaceAddressId: blockedAddress.workspaceAddressId,
      label: 'Blocked vendor wallet',
      trustState: 'blocked',
    },
    setup.sessionToken,
  );

  const blockedResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/transfer-requests`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        destinationId: blockedDestination.destinationId,
        requestType: 'vendor_payout',
        amountRaw: '10000',
        status: 'draft',
      }),
    },
  );
  assert.equal(blockedResponse.status, 400);
  const blockedPayload = await blockedResponse.json();
  assert.match(blockedPayload.message, /blocked and cannot be used/i);
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
  assert.equal(detail.events.length, 2);
  assert.equal(detail.events[0].eventType, 'request_created');
  assert.equal(detail.events[0].afterState, 'submitted');
  assert.equal(detail.events[0].actorType, 'user');
  assert.equal(detail.events[1].eventType, 'approval_required');
  assert.equal(detail.events[1].afterState, 'pending_approval');
  assert.equal(detail.requestDisplayState, 'pending');
  assert.equal(detail.timeline[0].timelineType, 'request_event');
  assert.deepEqual(detail.availableTransitions, []);
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

  assert.equal(transitioned.status, 'approved');
  assert.deepEqual(transitioned.availableTransitions, []);

  const detailResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/transfer-requests/${setup.transferRequest.transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();

  assert.equal(detail.events.length, 3);
  assert.equal(detail.events[1].eventType, 'status_transition');
  assert.equal(detail.events[1].beforeState, 'draft');
  assert.equal(detail.events[1].afterState, 'submitted');
  assert.equal(detail.events[2].eventType, 'approval_auto_approved');
  assert.equal(detail.events[2].afterState, 'approved');
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.notes[0].body, 'Ready for reviewer handoff');
  assert.equal(detail.timeline.filter((item: { timelineType: string }) => item.timelineType === 'request_note').length, 1);
});

test('phase c routes thresholded requests into approval inbox and records approval decisions', async () => {
  const setup = await createOrganizationWorkspace();
  const workspaceId = setup.workspace.workspaceId;

  const address = await post(
    `/workspaces/${workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Vendor Wallet',
    },
    setup.sessionToken,
  );

  const destination = await post(
    `/workspaces/${workspaceId}/destinations`,
    {
      linkedWorkspaceAddressId: address.workspaceAddressId,
      label: 'Vendor payout wallet',
      trustState: 'trusted',
      destinationType: 'vendor_wallet',
      isInternal: false,
    },
    setup.sessionToken,
  );

  const transferRequest = await post(
    `/workspaces/${workspaceId}/transfer-requests`,
    {
      destinationId: destination.destinationId,
      requestType: 'vendor_payout',
      amountRaw: '100000000',
      status: 'submitted',
    },
    setup.sessionToken,
  );

  assert.equal(transferRequest.status, 'pending_approval');

  const inboxResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/approval-inbox`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(inboxResponse.status, 200);
  const inbox = await inboxResponse.json();

  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].transferRequestId, transferRequest.transferRequestId);
  assert.equal(inbox.items[0].approvalEvaluation.requiresApproval, true);
  assert.equal(
    inbox.items[0].approvalEvaluation.reasons.some((reason: { code: string }) => reason.code === 'external_amount_threshold_exceeded'),
    true,
  );

  const detailBeforeResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/reconciliation-queue/${transferRequest.transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailBeforeResponse.status, 200);
  const detailBefore = await detailBeforeResponse.json();

  assert.equal(detailBefore.approvalState, 'pending_approval');
  assert.equal(detailBefore.approvalDecisions.length, 1);
  assert.equal(detailBefore.approvalDecisions[0].action, 'routed_for_approval');

  const approveResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/transfer-requests/${transferRequest.transferRequestId}/approval-decisions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        action: 'approve',
        comment: 'Policy exception reviewed by treasury ops.',
      }),
    },
  );
  assert.equal(approveResponse.status, 200);
  const approved = await approveResponse.json();
  assert.equal(approved.status, 'approved');

  const detailAfterResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/reconciliation-queue/${transferRequest.transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailAfterResponse.status, 200);
  const detailAfter = await detailAfterResponse.json();

  assert.equal(detailAfter.approvalState, 'approved');
  assert.equal(detailAfter.approvalDecisions.length, 2);
  assert.equal(detailAfter.approvalDecisions[1].action, 'approve');
  assert.equal(detailAfter.approvalDecisions[1].comment, 'Policy exception reviewed by treasury ops.');
  assert.equal(
    detailAfter.events.some((event: { eventType: string; payloadJson: { action?: string } }) =>
      event.eventType === 'approval_decision' && event.payloadJson?.action === 'approve'),
    true,
  );
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

test('phase d execution tracking separates approved, submitted, observed, and matched', async () => {
  const setup = await createTransferRequestSetup();
  const workspaceId = setup.workspace.workspaceId;
  const transferRequestId = setup.transferRequest.transferRequestId;
  const signature = '2U2yzRbpiNmj6fYH2Jjc2v4tmnG6hTdbu8fZ8vUUR9JiBf6qcWjHz1P7LidC9phHcU4TUkT9w7FRmFvh59qTQmAk';
  const transferId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const observedAt = '2026-04-08 09:11:42.100';
  const createdAt = '2026-04-08 09:11:42.230';

  const detailBeforeResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/reconciliation-queue/${transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailBeforeResponse.status, 200);
  const detailBefore = await detailBeforeResponse.json();

  assert.equal(detailBefore.status, 'approved');
  assert.equal(detailBefore.executionState, 'ready_for_execution');
  assert.equal(detailBefore.latestExecution, null);
  assert.equal(detailBefore.requestDisplayState, 'pending');

  const createExecutionResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/transfer-requests/${transferRequestId}/executions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        executionSource: 'manual_operator',
      }),
    },
  );
  assert.equal(createExecutionResponse.status, 201);
  const executionRecord = await createExecutionResponse.json();
  assert.equal(executionRecord.state, 'ready_for_execution');
  assert.equal(executionRecord.submittedSignature, null);

  const detailReadyResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/reconciliation-queue/${transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailReadyResponse.status, 200);
  const detailReady = await detailReadyResponse.json();

  assert.equal(detailReady.status, 'ready_for_execution');
  assert.equal(detailReady.executionState, 'ready_for_execution');
  assert.equal(detailReady.latestExecution.executionRecordId, executionRecord.executionRecordId);
  assert.equal(
    detailReady.timeline.some((item: { timelineType: string; eventType?: string }) =>
      item.timelineType === 'request_event' && item.eventType === 'execution_created'),
    true,
  );

  const attachSignatureResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/executions/${executionRecord.executionRecordId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        submittedSignature: signature,
      }),
    },
  );
  assert.equal(attachSignatureResponse.status, 200);
  const submittedExecution = await attachSignatureResponse.json();
  assert.equal(submittedExecution.state, 'submitted_onchain');
  assert.equal(submittedExecution.submittedSignature, signature);

  const detailSubmittedResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/reconciliation-queue/${transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailSubmittedResponse.status, 200);
  const detailSubmitted = await detailSubmittedResponse.json();

  assert.equal(detailSubmitted.status, 'submitted_onchain');
  assert.equal(detailSubmitted.executionState, 'submitted_onchain');
  assert.equal(detailSubmitted.latestExecution.submittedSignature, signature);
  assert.equal(detailSubmitted.observedExecutionTransaction, null);
  assert.equal(detailSubmitted.requestDisplayState, 'pending');

  await insertClickHouseRows('observed_transactions', [
    {
      signature,
      slot: 411664999,
      event_time: observedAt,
      yellowstone_created_at: observedAt,
      worker_received_at: observedAt,
      chain: 'solana',
      source_token_account: '6WmJ7Btk5oT7YfLgbj8kY6fX4bqVjLtt2tFvkZJw6i3F',
      source_wallet: 'PGm4dkZcqPTkYKqAjNtAokVwJirJB8XQcGpYWBVcFMW',
      destination_token_account: setup.destinationAddress.usdcAtaAddress,
      destination_wallet: setup.destinationAddress.address,
      amount_raw: '2500000',
      amount_decimal: '2.500000',
      status: 'observed',
      created_at: createdAt,
    },
  ]);

  const detailObservedResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/reconciliation-queue/${transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailObservedResponse.status, 200);
  const detailObserved = await detailObservedResponse.json();

  assert.equal(detailObserved.executionState, 'observed');
  assert.equal(detailObserved.observedExecutionTransaction.signature, signature);
  assert.equal(detailObserved.requestDisplayState, 'pending');

  await insertClickHouseRows('observed_transfers', [
    {
      transfer_id: transferId,
      signature,
      slot: 411664999,
      event_time: observedAt,
      asset: 'usdc',
      source_token_account: '6WmJ7Btk5oT7YfLgbj8kY6fX4bqVjLtt2tFvkZJw6i3F',
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
      slot: 411664999,
      event_time: observedAt,
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
      reconstruction_rule: 'single_destination_direct_credit',
      confidence_band: 'high',
      properties_json: JSON.stringify({ seeded: true }),
      created_at: createdAt,
    },
  ]);

  await insertClickHouseRows('settlement_matches', [
    {
      transfer_request_id: transferRequestId,
      workspace_id: workspaceId,
      signature,
      observed_transfer_id: transferId,
      match_status: 'matched_exact',
      confidence_score: 100,
      confidence_band: 'high',
      matched_amount_raw: '2500000',
      amount_variance_raw: '0',
      destination_match_type: 'exact',
      time_delta_seconds: 12,
      match_rule: 'payment_book_fifo_allocator',
      candidate_count: 1,
      explanation: 'Execution-linked payment matched exactly.',
      observed_event_time: observedAt,
      matched_at: createdAt,
      updated_at: createdAt,
    },
  ]);

  const detailSettledResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/reconciliation-queue/${transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailSettledResponse.status, 200);
  const detailSettled = await detailSettledResponse.json();

  assert.equal(detailSettled.executionState, 'settled');
  assert.equal(detailSettled.requestDisplayState, 'matched');
  assert.equal(detailSettled.linkedSignature, signature);
  assert.equal(detailSettled.linkedObservedPayment.paymentId, paymentId);
  assert.equal(
    detailSettled.timeline.some((item: { timelineType: string; eventType?: string }) =>
      item.timelineType === 'request_event' && item.eventType === 'execution_signature_attached'),
    true,
  );
  assert.equal(
    detailSettled.timeline.some((item: { timelineType: string; matchStatus?: string }) =>
      item.timelineType === 'match_result' && item.matchStatus === 'matched_exact'),
    true,
  );
});

test('execution records support broadcast failure without implying observed settlement', async () => {
  const setup = await createTransferRequestSetup();
  const workspaceId = setup.workspace.workspaceId;
  const transferRequestId = setup.transferRequest.transferRequestId;

  const createExecutionResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/transfer-requests/${transferRequestId}/executions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({ executionSource: 'manual_operator' }),
    },
  );
  assert.equal(createExecutionResponse.status, 201);
  const executionRecord = await createExecutionResponse.json();

  const failedResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/executions/${executionRecord.executionRecordId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        state: 'broadcast_failed',
      }),
    },
  );
  assert.equal(failedResponse.status, 200);
  const failedExecution = await failedResponse.json();
  assert.equal(failedExecution.state, 'broadcast_failed');

  const detailResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/reconciliation-queue/${transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();

  assert.equal(detail.status, 'ready_for_execution');
  assert.equal(detail.executionState, 'broadcast_failed');
  assert.equal(detail.observedExecutionTransaction, null);
  assert.equal(detail.requestDisplayState, 'pending');
  assert.equal(
    detail.timeline.some((item: { timelineType: string; eventType?: string }) =>
      item.timelineType === 'request_event' && item.eventType === 'execution_state_changed'),
    true,
  );
});

test('address label registry exposes seeded labels and supports upsert-style maintenance', async () => {
  const login = await loginUser('labels@example.com', 'Label Maintainer');

  const seededResponse = await fetch(`${baseUrl}/address-labels?search=Jupiter`, {
    headers: authHeaders(login.sessionToken),
  });
  assert.equal(seededResponse.status, 200);
  const seeded = await seededResponse.json();

  assert.equal(
    seeded.items.some(
      (item: { entityName: string; address: string }) =>
        item.entityName === 'Jupiter Aggregator Authority 11' &&
        item.address === '69yhtoJR4JYPPABZcSNkzuqbaFbwHsCkja1sP1Q2aVT5',
    ),
    true,
  );

  const createResponse = await fetch(`${baseUrl}/address-labels`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(login.sessionToken),
    },
    body: JSON.stringify({
      chain: 'solana',
      address: 'GP8StUXNYSZjPikyRsvkTbvRV1GBxMErb59cpeCJnDf1',
      entityName: 'Test Fee Recipient',
      entityType: 'aggregator',
      labelKind: 'fee_collector',
      roleTags: ['fee_recipient'],
      confidence: 'operator',
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.entityName, 'Test Fee Recipient');

  const patchResponse = await fetch(`${baseUrl}/address-labels/${created.addressLabelId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(login.sessionToken),
    },
    body: JSON.stringify({
      entityName: 'Updated Fee Recipient',
      notes: 'Confirmed from repeated operator review.',
    }),
  });
  assert.equal(patchResponse.status, 200);
  const updated = await patchResponse.json();
  assert.equal(updated.entityName, 'Updated Fee Recipient');
  assert.equal(updated.notes, 'Confirmed from repeated operator review.');
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

  assert.equal(detail.status, 'approved');
  assert.equal(detail.approvalState, 'approved');
  assert.equal(detail.executionState, 'execution_exception');
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
    false,
  );
});

test('reconciliation detail explains fee-adjusted partial matches with known recipient labels', async () => {
  const setup = await createTransferRequestSetup({ status: 'draft' });
  const transferId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const feePaymentId = crypto.randomUUID();
  const signature = '4wJeeY9Rw5qP3HmWGFGXaQ7YmtYQcJ8eftYgXriQKLXTTpQZVz3GuzoRzqkNmL26LXMEXfYZGA9ap9qbpTzcTtEC';
  const eventTime = '2026-04-06 21:57:04.352';
  const createdAt = '2026-04-06 22:01:16.671';
  const jupiterAuthorityWallet = '69yhtoJR4JYPPABZcSNkzuqbaFbwHsCkja1sP1Q2aVT5';

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
      slot: 411497760,
      event_time: eventTime,
      asset: 'usdc',
      source_token_account: '64HWdAaTsTVvsQWQnw4PKVWeQ5BQXJ5dT6fTwerqo9US',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_token_account: setup.destinationAddress.usdcAtaAddress,
      destination_wallet: setup.destinationAddress.address,
      amount_raw: '9182',
      amount_decimal: '0.009182',
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
      slot: 411497760,
      event_time: eventTime,
      asset: 'usdc',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_wallet: setup.destinationAddress.address,
      gross_amount_raw: '9182',
      gross_amount_decimal: '0.009182',
      net_destination_amount_raw: '9182',
      net_destination_amount_decimal: '0.009182',
      fee_amount_raw: '0',
      fee_amount_decimal: '0.000000',
      route_count: 1,
      payment_kind: 'direct',
      reconstruction_rule: 'route_group_balance_bundle',
      confidence_band: 'partial',
      properties_json: JSON.stringify({ seeded: true }),
      created_at: createdAt,
    },
    {
      payment_id: feePaymentId,
      signature,
      slot: 411497760,
      event_time: eventTime,
      asset: 'usdc',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_wallet: jupiterAuthorityWallet,
      gross_amount_raw: '818',
      gross_amount_decimal: '0.000818',
      net_destination_amount_raw: '818',
      net_destination_amount_decimal: '0.000818',
      fee_amount_raw: '0',
      fee_amount_decimal: '0.000000',
      route_count: 1,
      payment_kind: 'direct',
      reconstruction_rule: 'route_group_balance_bundle',
      confidence_band: 'partial',
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
      matched_amount_raw: '9182',
      amount_variance_raw: '818',
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

  const detailResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue/${setup.transferRequest.transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();

  assert.match(detail.matchExplanation, /Only 0\.009182 of the requested 2\.500000 USDC reached the expected destination/);
  assert.match(detail.matchExplanation, /Jupiter Aggregator Authority 11/);
  assert.equal(detail.relatedObservedPayments.length, 2);
  assert.equal(
    detail.relatedObservedPayments.some(
      (payment: { destinationLabel: string | null; recipientRole: string }) =>
        payment.destinationLabel === 'Jupiter Aggregator Authority 11' &&
        payment.recipientRole === 'known_fee_recipient',
    ),
    true,
  );
});

test('reconciliation detail auto-resolves unknown fee recipient labels from Orb tags', async () => {
  const setup = await createTransferRequestSetup({ status: 'draft' });
  const transferId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const feePaymentId = crypto.randomUUID();
  const signature = '8'.repeat(88);
  const eventTime = '2026-04-07 11:13:00.000';
  const createdAt = '2026-04-07 11:18:00.000';
  const jupiterAuthority9 = '3LoAYHuSd7Gh8d7RTFnhvYtiTiefdZ5ByamU42vkzd76';

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
      slot: 411620000,
      event_time: eventTime,
      asset: 'usdc',
      source_token_account: '64HWdAaTsTVvsQWQnw4PKVWeQ5BQXJ5dT6fTwerqo9US',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_token_account: setup.destinationAddress.usdcAtaAddress,
      destination_wallet: setup.destinationAddress.address,
      amount_raw: '9204',
      amount_decimal: '0.009204',
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
      slot: 411620000,
      event_time: eventTime,
      asset: 'usdc',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_wallet: setup.destinationAddress.address,
      gross_amount_raw: '9204',
      gross_amount_decimal: '0.009204',
      net_destination_amount_raw: '9204',
      net_destination_amount_decimal: '0.009204',
      fee_amount_raw: '0',
      fee_amount_decimal: '0.000000',
      route_count: 1,
      payment_kind: 'direct',
      reconstruction_rule: 'route_group_balance_bundle',
      confidence_band: 'partial',
      properties_json: JSON.stringify({ seeded: true }),
      created_at: createdAt,
    },
    {
      payment_id: feePaymentId,
      signature,
      slot: 411620000,
      event_time: eventTime,
      asset: 'usdc',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_wallet: jupiterAuthority9,
      gross_amount_raw: '796',
      gross_amount_decimal: '0.000796',
      net_destination_amount_raw: '796',
      net_destination_amount_decimal: '0.000796',
      fee_amount_raw: '0',
      fee_amount_decimal: '0.000000',
      route_count: 1,
      payment_kind: 'direct',
      reconstruction_rule: 'route_group_balance_bundle',
      confidence_band: 'partial',
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
      matched_amount_raw: '9204',
      amount_variance_raw: '796',
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

  const originalFetch = globalThis.fetch;
  const originalEnabled = config.orbTagsResolveEnabled;
  config.orbTagsResolveEnabled = true;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === config.orbTagsResolveUrl) {
      return new Response(
        JSON.stringify({
          tags: {
            [jupiterAuthority9]: {
              address: jupiterAuthority9,
              name: 'Jupiter Aggregator Authority 9',
              type: 'DeFi',
              category: 'DeFi',
              entityType: 'account',
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    return originalFetch(input as never, init);
  };

  try {
    const detailResponse = await fetch(
      `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue/${setup.transferRequest.transferRequestId}`,
      { headers: authHeaders(setup.sessionToken) },
    );
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();

    assert.match(detail.matchExplanation, /Jupiter Aggregator Authority 9/);
    assert.equal(
      detail.relatedObservedPayments.some(
        (payment: { destinationLabel: string | null }) =>
          payment.destinationLabel === 'Jupiter Aggregator Authority 9',
      ),
      true,
    );

    const stored = await prisma.addressLabel.findUnique({
      where: {
        chain_address: {
          chain: 'solana',
          address: jupiterAuthority9,
        },
      },
    });
    assert.equal(stored?.entityName, 'Jupiter Aggregator Authority 9');
    assert.equal(stored?.source, 'orb_auto');
  } finally {
    globalThis.fetch = originalFetch;
    config.orbTagsResolveEnabled = originalEnabled;
  }
});

test('reconciliation queue auto-resolves unknown fee recipient labels from Orb tags', async () => {
  const setup = await createTransferRequestSetup({ status: 'submitted' });
  const signature = 'V7rERoHke8dWKCsXYMsB1QAP9Gq3CPZ7wwg4WpwtCjJb6Psd3TQwmWEWRX3e1q3hv2NN5BgLmt4f9LaS1C1s7Jj';
  const transferId = '77777777-7777-4777-8777-777777777777';
  const paymentIdExpected = '88888888-8888-4888-8888-888888888888';
  const paymentIdFee = '99999999-9999-4999-8999-999999999999';
  const jupiterAuthority16 = 'HFqp6ErWHY6Uzhj8rFyjYuDya2mXUpYEk8VW75K9PSiY';
  const eventTime = '2026-04-07 11:32:44.313';
  const createdAt = '2026-04-07 11:38:15.253';

  await insertClickHouseRows('observed_transfers', [
    {
      transfer_id: transferId,
      signature,
      slot: 411600000,
      event_time: eventTime,
      asset: 'usdc',
      source_token_account: '64HWdAaTsTVvsQWQnw4PKVWeQ5BQXJ5dT6fTwerqo9US',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_token_account: 'Fe6xZzfQf6nmx4Z1TnYeo3gvBmXXuE3VtMuKmBGJe3dm',
      destination_wallet: setup.destinationAddress.address,
      amount_raw: '9204',
      amount_decimal: '0.009204',
      transfer_kind: 'transfer_checked',
      instruction_index: 2,
      inner_instruction_index: null,
      route_group: 'route-a',
      leg_role: 'direct_settlement',
      properties_json: null,
      created_at: createdAt,
    },
  ]);

  await insertClickHouseRows('observed_payments', [
    {
      payment_id: paymentIdExpected,
      signature,
      slot: 411600000,
      event_time: eventTime,
      asset: 'usdc',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_wallet: setup.destinationAddress.address,
      gross_amount_raw: '9204',
      gross_amount_decimal: '0.009204',
      net_destination_amount_raw: '9204',
      net_destination_amount_decimal: '0.009204',
      fee_amount_raw: '0',
      fee_amount_decimal: '0',
      route_count: 1,
      payment_kind: 'direct_settlement',
      reconstruction_rule: 'instruction_payment',
      confidence_band: 'high',
      properties_json: null,
      created_at: createdAt,
    },
    {
      payment_id: paymentIdFee,
      signature,
      slot: 411600000,
      event_time: eventTime,
      asset: 'usdc',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_wallet: jupiterAuthority16,
      gross_amount_raw: '796',
      gross_amount_decimal: '0.000796',
      net_destination_amount_raw: '796',
      net_destination_amount_decimal: '0.000796',
      fee_amount_raw: '0',
      fee_amount_decimal: '0',
      route_count: 1,
      payment_kind: 'fee_leg',
      reconstruction_rule: 'instruction_payment',
      confidence_band: 'high',
      properties_json: null,
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
      matched_amount_raw: '9204',
      amount_variance_raw: '796',
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

  const originalFetch = globalThis.fetch;
  const originalEnabled = config.orbTagsResolveEnabled;
  config.orbTagsResolveEnabled = true;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === config.orbTagsResolveUrl) {
      return new Response(
        JSON.stringify({
          tags: {
            [jupiterAuthority16]: {
              address: jupiterAuthority16,
              name: 'Jupiter Aggregator Authority 16',
              type: 'DeFi',
              category: 'DeFi',
              entityType: 'account',
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    return originalFetch(input as never, init);
  };

  try {
    const queueResponse = await fetch(
      `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue?displayState=partial`,
      { headers: authHeaders(setup.sessionToken) },
    );
    assert.equal(queueResponse.status, 200);
    const queue = await queueResponse.json();
    assert.equal(queue.items.length, 1);

    const stored = await prisma.addressLabel.findUnique({
      where: {
        chain_address: {
          chain: 'solana',
          address: jupiterAuthority16,
        },
      },
    });
    assert.equal(stored?.entityName, 'Jupiter Aggregator Authority 16');
    assert.equal(stored?.source, 'orb_auto');
  } finally {
    globalThis.fetch = originalFetch;
    config.orbTagsResolveEnabled = originalEnabled;
  }
});

test('address label resolver skips null Orb tags and still stores usable labels', async () => {
  const setup = await createTransferRequestSetup({ status: 'submitted' });
  const signature = '5w4JwH5nWZ9N6cY81mYAwU3S6fP3LhZq1BtYV4Bn8Jq2pHfNE3gEM6VKezxJXvLjVdv6vQ2MSmTYqZ6DxPzLy3EZ';
  const transferId = '12121212-1212-4212-8212-121212121212';
  const feeTransferId = '15151515-1515-4515-8515-151515151515';
  const nullTransferId = '16161616-1616-4616-8616-161616161616';
  const paymentIdExpected = '13131313-1313-4313-8313-131313131313';
  const paymentIdFee = '14141414-1414-4414-8414-141414141414';
  const nullAddress = '11111111111111111111111111111111';
  const labeledAddress = 'HFqp6ErWHY6Uzhj8rFyjYuDya2mXUpYEk8VW75K9PSiY';
  const eventTime = '2026-04-07 11:32:44.313';
  const createdAt = '2026-04-07 11:38:15.253';

  await insertClickHouseRows('observed_transfers', [
    {
      transfer_id: transferId,
      signature,
      slot: 411600001,
      event_time: eventTime,
      asset: 'usdc',
      source_token_account: '64HWdAaTsTVvsQWQnw4PKVWeQ5BQXJ5dT6fTwerqo9US',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_token_account: 'Fe6xZzfQf6nmx4Z1TnYeo3gvBmXXuE3VtMuKmBGJe3dm',
      destination_wallet: setup.destinationAddress.address,
      amount_raw: '9204',
      amount_decimal: '0.009204',
      transfer_kind: 'transfer_checked',
      instruction_index: 2,
      inner_instruction_index: null,
      route_group: `${signature}:ix:2`,
      leg_role: 'direct_settlement',
      properties_json: '{}',
    },
    {
      transfer_id: feeTransferId,
      signature,
      slot: 411600001,
      event_time: eventTime,
      asset: 'usdc',
      source_token_account: '64HWdAaTsTVvsQWQnw4PKVWeQ5BQXJ5dT6fTwerqo9US',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_token_account: '9w3N4xpmrRkUQW5p5P4L6r5aM5N8V7eV1oF2T3wY4uC7',
      destination_wallet: labeledAddress,
      amount_raw: '796',
      amount_decimal: '0.000796',
      transfer_kind: 'transfer_checked',
      instruction_index: 3,
      inner_instruction_index: null,
      route_group: `${signature}:ix:3`,
      leg_role: 'direct_settlement',
      properties_json: '{}',
    },
    {
      transfer_id: nullTransferId,
      signature,
      slot: 411600001,
      event_time: eventTime,
      asset: 'usdc',
      source_token_account: '64HWdAaTsTVvsQWQnw4PKVWeQ5BQXJ5dT6fTwerqo9US',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_token_account: '8w3N4xpmrRkUQW5p5P4L6r5aM5N8V7eV1oF2T3wY4uC7',
      destination_wallet: nullAddress,
      amount_raw: '1',
      amount_decimal: '0.000001',
      transfer_kind: 'transfer_checked',
      instruction_index: 4,
      inner_instruction_index: null,
      route_group: `${signature}:ix:4`,
      leg_role: 'direct_settlement',
      properties_json: '{}',
    },
  ]);

  await insertClickHouseRows('observed_payments', [
    {
      payment_id: paymentIdExpected,
      signature,
      slot: 411600001,
      event_time: eventTime,
      asset: 'usdc',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_wallet: setup.destinationAddress.address,
      gross_amount_raw: '9204',
      gross_amount_decimal: '0.009204',
      net_destination_amount_raw: '9204',
      net_destination_amount_decimal: '0.009204',
      fee_amount_raw: '0',
      fee_amount_decimal: '0.000000',
      route_count: 1,
      payment_kind: 'direct',
      reconstruction_rule: 'route_group_balance_bundle',
      confidence_band: 'high',
      properties_json: '{}',
      created_at: createdAt,
    },
    {
      payment_id: paymentIdFee,
      signature,
      slot: 411600001,
      event_time: eventTime,
      asset: 'usdc',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_wallet: labeledAddress,
      gross_amount_raw: '796',
      gross_amount_decimal: '0.000796',
      net_destination_amount_raw: '796',
      net_destination_amount_decimal: '0.000796',
      fee_amount_raw: '0',
      fee_amount_decimal: '0.000000',
      route_count: 1,
      payment_kind: 'direct',
      reconstruction_rule: 'route_group_balance_bundle',
      confidence_band: 'high',
      properties_json: '{}',
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
      matched_amount_raw: '9204',
      amount_variance_raw: '796',
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

  const originalFetch = globalThis.fetch;
  const originalEnabled = config.orbTagsResolveEnabled;
  config.orbTagsResolveEnabled = true;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === config.orbTagsResolveUrl) {
      return new Response(
        JSON.stringify({
          tags: {
            [nullAddress]: null,
            [labeledAddress]: {
              address: labeledAddress,
              name: 'Jupiter Aggregator Authority 16',
              type: 'DeFi',
              category: 'DeFi',
              entityType: 'account',
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }

    return originalFetch(input as never, init);
  };

  try {
    const detailResponse = await fetch(
      `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue/${setup.transferRequest.transferRequestId}`,
      { headers: authHeaders(setup.sessionToken) },
    );
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();

    assert.match(detail.matchExplanation, /Jupiter Aggregator Authority 16/);

    const stored = await prisma.addressLabel.findUnique({
      where: {
        chain_address: {
          chain: 'solana',
          address: labeledAddress,
        },
      },
    });
    assert.equal(stored?.entityName, 'Jupiter Aggregator Authority 16');

    const resolvedLabels = await getOrResolveAddressLabels('solana', [nullAddress]);
    const skipped = resolvedLabels.get(nullAddress) ?? await prisma.addressLabel.findUnique({
      where: {
        chain_address: {
          chain: 'solana',
          address: nullAddress,
        },
      },
    });
    assert.equal(skipped?.confidence, 'unresolved');
    assert.equal(skipped?.labelKind, 'unlabeled');
  } finally {
    globalThis.fetch = originalFetch;
    config.orbTagsResolveEnabled = originalEnabled;
  }
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
  assert.equal(queue.items[0].status, 'approved');
  assert.equal(queue.items[0].approvalState, 'approved');
  assert.equal(queue.items[0].executionState, 'execution_exception');

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

test('reconciliation explain endpoint returns deterministic outcome, edge cases, and evidence', async () => {
  const setup = await createSeededPartialExceptionRequest();

  const explainResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue/${setup.transferRequest.transferRequestId}/explain`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(explainResponse.status, 200);
  const explain = await explainResponse.json();

  assert.equal(explain.transferRequestId, setup.transferRequest.transferRequestId);
  assert.equal(explain.outcome, 'partial_settlement');
  assert.equal(explain.recommendedAction, 'review_partial_settlement');
  assert.equal(explain.amount.requestedRaw, '2500000');
  assert.equal(explain.amount.matchedRaw, '1250000');
  assert.equal(explain.matching.status, 'matched_partial');
  assert.equal(explain.confidence.band, 'partial');
  assert.equal(explain.edgeCases.length, 1);
  assert.equal(explain.edgeCases[0].code, 'partial_settlement');
  assert.equal(explain.evidence.linkedSignature, setup.signature);
  assert.equal(explain.evidence.observedTransfers[0].transferId, setup.transferId);
  assert.equal(explain.evidence.observedPayment.paymentId, setup.paymentId);

  const refreshResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue/${setup.transferRequest.transferRequestId}/refresh`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({ reason: 'agent-read-model-check' }),
    },
  );
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();

  assert.equal(refreshed.outcome, 'partial_settlement');
  assert.equal(refreshed.refresh.mode, 'read_model_refresh');
  assert.equal(refreshed.refresh.mutated, false);
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
  assert.equal(requestDetail.status, 'approved');
  assert.equal(requestDetail.approvalState, 'approved');
  assert.equal(requestDetail.executionState, 'observed');
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

test('phase e exception queue supports assignment, severity override, and resolution code', async () => {
  const setup = await createSeededPartialExceptionRequest();
  const member = await loginUser('reviewer@example.com', 'Reviewer');
  await post(`/organizations/${setup.organization.organizationId}/join`, {}, member.sessionToken);

  const updateResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/exceptions/${setup.exceptionId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        assignedToUserId: member.user.userId,
        severity: 'critical',
        resolutionCode: 'vendor_confirmed',
        note: 'Assigned for escalation review.',
      }),
    },
  );

  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.severity, 'critical');
  assert.equal(updated.resolutionCode, 'vendor_confirmed');
  assert.equal(updated.assignedToUserId, member.user.userId);

  const queueResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/exceptions?assigneeUserId=${member.user.userId}&severity=critical`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(queueResponse.status, 200);
  const queue = await queueResponse.json();
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].assignedToUser.email, 'reviewer@example.com');
  assert.equal(queue.items[0].resolutionCode, 'vendor_confirmed');
});

test('newer worker exception rows override older operator exception state while preserving metadata', async () => {
  const setup = await createSeededPartialExceptionRequest();
  const operator = await prisma.user.findUniqueOrThrow({
    where: {
      email: 'beta@example.com',
    },
  });

  await prisma.exceptionState.create({
    data: {
      workspaceId: setup.workspace.workspaceId,
      exceptionId: setup.exceptionId,
      status: 'reviewed',
      updatedByUserId: operator.userId,
      assignedToUserId: operator.userId,
      resolutionCode: 'awaiting_follow_up',
      severity: 'critical',
    },
  });

  await insertClickHouseRows('exceptions', [
    {
      workspace_id: setup.workspace.workspaceId,
      exception_id: setup.exceptionId,
      transfer_request_id: setup.transferRequest.transferRequestId,
      signature: setup.signature,
      observed_transfer_id: setup.transferId,
      exception_type: 'partial_settlement',
      severity: 'warning',
      status: 'dismissed',
      explanation: 'Residual requested amount was later satisfied by a follow-on payment.',
      properties_json: JSON.stringify({ remainingAmountRaw: '0' }),
      observed_event_time: '2030-04-06 13:31:15.083',
      processed_at: '2030-04-06 13:31:44.010',
      created_at: '2026-04-06 13:30:44.010',
      updated_at: '2030-04-06 13:31:44.010',
    },
  ]);

  const queueResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue/${setup.transferRequest.transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(queueResponse.status, 200);
  const queueItem = await queueResponse.json();

  assert.equal(queueItem.requestDisplayState, 'partial');
  assert.equal(queueItem.exceptions[0].status, 'dismissed');
  assert.equal(queueItem.exceptions[0].assignedToUserId, operator.userId);
  assert.equal(queueItem.exceptions[0].resolutionCode, 'awaiting_follow_up');
  assert.equal(queueItem.exceptions[0].severity, 'critical');
});

test('phase e exports produce csv and record export history', async () => {
  const setup = await createSeededPartialExceptionRequest();

  const reconciliationExport = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/exports/reconciliation?format=csv`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(reconciliationExport.status, 200);
  const reconciliationCsv = await reconciliationExport.text();
  assert.match(reconciliationCsv, /transfer_request_id/);
  assert.match(reconciliationCsv, /exception_reason_codes/);

  const exceptionsExport = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/exports/exceptions?format=csv`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(exceptionsExport.status, 200);
  const exceptionsCsv = await exceptionsExport.text();
  assert.match(exceptionsCsv, /exception_id/);
  assert.match(exceptionsCsv, /partial_settlement/);

  const historyResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/export-jobs`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].exportKind, 'exceptions');
  assert.equal(history.items[1].exportKind, 'reconciliation');
});

test('phase e audit export and unified timeline include approval and execution stages', async () => {
  const setup = await createTransferRequestSetup();
  const transferRequestId = setup.transferRequest.transferRequestId;

  await post(
    `/workspaces/${setup.workspace.workspaceId}/transfer-requests/${transferRequestId}/executions`,
    {
      executionSource: 'manual_operator',
    },
    setup.sessionToken,
  );

  const detailResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/reconciliation-queue/${transferRequestId}`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();

  assert.equal(detail.timeline.some((item: { timelineType: string }) => item.timelineType === 'approval_decision'), true);
  assert.equal(detail.timeline.some((item: { timelineType: string }) => item.timelineType === 'execution_record'), true);

  const auditExport = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/exports/audit/${transferRequestId}?format=csv`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(auditExport.status, 200);
  const auditCsv = await auditExport.text();
  assert.match(auditCsv, /approval_decision/);
  assert.match(auditCsv, /execution_record/);

  const auditLogResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/audit-log?limit=20`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(auditLogResponse.status, 200);
  const auditLog = await auditLogResponse.json();
  assert.ok(auditLog.items.some((item: { entityType: string; eventType: string }) =>
    item.entityType === 'transfer_request' && item.eventType === 'request_created'));
  assert.ok(auditLog.items.some((item: { entityType: string; eventType: string }) =>
    item.entityType === 'approval' && item.eventType === 'approval_auto_approved'));
  assert.ok(auditLog.items.some((item: { entityType: string; eventType: string }) =>
    item.entityType === 'execution' && item.eventType === 'execution_ready_for_execution'));
  assert.ok(auditLog.items.some((item: { entityType: string; eventType: string }) =>
    item.entityType === 'export' && item.eventType === 'export_audit'));

  const executionAuditResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/audit-log?entityType=execution`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(executionAuditResponse.status, 200);
  const executionAudit = await executionAuditResponse.json();
  assert.ok(executionAudit.items.length >= 1);
  assert.ok(executionAudit.items.every((item: { entityType: string }) => item.entityType === 'execution'));
});

test('phase e ops health exposes lag and latency status', async () => {
  const setup = await createSeededPartialExceptionRequest();
  const signature = setup.signature;
  const testSlot = 999_999_999_001;
  const workerReceivedAt = '2026-04-06 13:30:20.083';
  const txWriteAt = '2026-04-06 13:30:21.083';

  await insertClickHouseRows('observed_transactions', [
    {
      signature,
      slot: testSlot,
      event_time: '2026-04-06 13:30:15.083',
      yellowstone_created_at: '2026-04-06 13:30:15.200',
      worker_received_at: workerReceivedAt,
      status: 'confirmed',
      properties_json: '{}',
      created_at: txWriteAt,
    },
  ]);

  const response = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/ops-health`,
    { headers: authHeaders(setup.sessionToken) },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.postgres, 'ok');
  assert.equal(payload.latestSlot, testSlot);
  assert.ok(payload.latencies.yellowstoneToWorkerMs.p50 !== null);
  assert.ok(payload.latencies.chainToWriteMs.p50 !== null);
  assert.equal(payload.openExceptionCount, 1);
});

test('internal ops metrics collect route and worker stage failures', async () => {
  const setup = await createOrganizationWorkspace();

  const missingRouteResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/definitely-missing`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(missingRouteResponse.status, 404);

  const workerStageResponse = await fetch(`${baseUrl}/internal/worker-stage-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-service-token': 'internal-secret',
    },
    body: JSON.stringify({
      stage: 'matching_index_refresh',
      status: 'error',
      message: 'refresh failed',
    }),
  });
  assert.equal(workerStageResponse.status, 200);

  const metricsResponse = await fetch(`${baseUrl}/internal/ops-metrics`, {
    headers: {
      'x-service-token': 'internal-secret',
    },
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.ok(metrics.routeMetrics.some((metric: { route: string; statusClass: string }) =>
    metric.route.includes('/definitely-missing') && metric.statusClass === '4xx'));
  assert.ok(metrics.workerStageMetrics.some((metric: { stage: string; status: string }) =>
    metric.stage === 'matching_index_refresh' && metric.status === 'error'));

  const healthResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/ops-health`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.ok(health.workerStageErrors.some((metric: { stage: string }) => metric.stage === 'matching_index_refresh'));
});

test('auth logout invalidates the session and protected routes reject the old token', async () => {
  const login = await loginUser('logout@example.com', 'Logout User');
  const organization = await post(
    '/organizations',
    {
      organizationName: 'Logout Treasury',
    },
    login.sessionToken,
  );

  const organizationsResponse = await fetch(`${baseUrl}/organizations`, {
    headers: authHeaders(login.sessionToken),
  });
  assert.equal(organizationsResponse.status, 200);
  const organizations = await organizationsResponse.json();
  assert.equal(organizations.items.length, 1);
  assert.equal(organizations.items[0].organizationId, organization.organizationId);
  assert.equal(organizations.items[0].isMember, true);

  const logoutResponse = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: authHeaders(login.sessionToken),
  });
  assert.equal(logoutResponse.status, 204);

  const sessionResponse = await fetch(`${baseUrl}/auth/session`, {
    headers: authHeaders(login.sessionToken),
  });
  assert.equal(sessionResponse.status, 401);

  const postLogoutOrganizations = await fetch(`${baseUrl}/organizations`, {
    headers: authHeaders(login.sessionToken),
  });
  assert.equal(postLogoutOrganizations.status, 401);
});

test('internal service routes enforce the control-plane token when configured', async () => {
  const setup = await createTransferRequestSetup();
  assert.equal(setup.transferRequest.status, 'approved');

  const originalToken = config.controlPlaneServiceToken;
  const originalNodeEnv = config.nodeEnv;

  config.controlPlaneServiceToken = '';
  config.nodeEnv = 'production';

  try {
    const response = await fetch(`${baseUrl}/internal/workspaces`);
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error, 'InternalServiceTokenNotConfigured');
  } finally {
    config.nodeEnv = originalNodeEnv;
  }

  config.controlPlaneServiceToken = 'internal-secret';

  try {
    let response = await fetch(`${baseUrl}/internal/workspaces`);
    assert.equal(response.status, 401);

    response = await fetch(`${baseUrl}/internal/workspaces`, {
      headers: {
        'x-service-token': 'wrong-token',
      },
    });
    assert.equal(response.status, 401);

    response = await fetch(`${baseUrl}/internal/workspaces`, {
      headers: {
        'x-service-token': 'internal-secret',
      },
    });
    assert.equal(response.status, 200);
    const workspacesPayload = await response.json();
    assert.equal(workspacesPayload.items.length, 1);
    assert.equal(workspacesPayload.items[0].workspaceId, setup.workspace.workspaceId);

    response = await fetch(`${baseUrl}/internal/workspaces/${setup.workspace.workspaceId}/matching-context`, {
      headers: {
        'x-service-token': 'internal-secret',
      },
    });
    assert.equal(response.status, 200);
    const context = await response.json();
    assert.equal(context.transferRequests.length, 1);
    assert.equal(context.transferRequests[0].transferRequestId, setup.transferRequest.transferRequestId);
    assert.equal(context.transferRequests[0].status, 'approved');
  } finally {
    config.controlPlaneServiceToken = originalToken;
    config.nodeEnv = originalNodeEnv;
  }
});

test('internal matching index exposes one snapshot and increments on relevant mutations', async () => {
  const setup = await createOrganizationWorkspace();
  const workspaceId = setup.workspace.workspaceId;
  const recipientWallet = 'So11111111111111111111111111111111111111112';
  const expectedAta = deriveUsdcAtaForWallet(recipientWallet);

  const beforeResponse = await fetch(`${baseUrl}/internal/matching-index`);
  assert.equal(beforeResponse.status, 200);
  const before = await beforeResponse.json();
  assert.equal(typeof before.version, 'number');

  await post(
    `/workspaces/${workspaceId}/addresses`,
    {
      chain: 'solana',
      address: recipientWallet,
      displayName: 'Matching Index Wallet',
    },
    setup.sessionToken,
  );

  const afterResponse = await fetch(`${baseUrl}/internal/matching-index`);
  assert.equal(afterResponse.status, 200);
  const after = await afterResponse.json();
  assert.equal(after.version > before.version, true);

  const workspaceSnapshot = after.workspaces.find(
    (workspace: { workspace: { workspaceId: string } }) =>
      workspace.workspace.workspaceId === workspaceId,
  );
  assert.ok(workspaceSnapshot);
  assert.equal(workspaceSnapshot.addresses.length, 1);
  assert.equal(workspaceSnapshot.addresses[0].address, recipientWallet);
  assert.equal(workspaceSnapshot.addresses[0].usdcAtaAddress, expectedAta);
});

test('internal matching index updates when execution evidence attaches a submitted signature', async () => {
  const setup = await createTransferRequestSetup();
  const workspaceId = setup.workspace.workspaceId;
  const transferRequestId = setup.transferRequest.transferRequestId;
  const signature = '2U2yzRbpiNmj6fYH2Jjc2v4tmnG6hTdbu8fZ8vUUR9JiBf6qcWjHz1P7LidC9phHcU4TUkT9w7FRmFvh59qTQmAk';

  const createExecutionResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/transfer-requests/${transferRequestId}/executions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({
        executionSource: 'manual_operator',
      }),
    },
  );
  assert.equal(createExecutionResponse.status, 201);
  const executionRecord = await createExecutionResponse.json();

  const beforeResponse = await fetch(`${baseUrl}/internal/matching-index`);
  assert.equal(beforeResponse.status, 200);
  const before = await beforeResponse.json();

  const attachSignatureResponse = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/executions/${executionRecord.executionRecordId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(setup.sessionToken),
      },
      body: JSON.stringify({ submittedSignature: signature }),
    },
  );
  assert.equal(attachSignatureResponse.status, 200);

  const afterResponse = await fetch(`${baseUrl}/internal/matching-index`);
  assert.equal(afterResponse.status, 200);
  const after = await afterResponse.json();
  assert.equal(after.version > before.version, true);

  const workspaceSnapshot = after.workspaces.find(
    (workspace: { workspace: { workspaceId: string } }) =>
      workspace.workspace.workspaceId === workspaceId,
  );
  const requestSnapshot = workspaceSnapshot.transferRequests.find(
    (request: { transferRequestId: string }) =>
      request.transferRequestId === transferRequestId,
  );
  assert.equal(requestSnapshot.latestExecution.submittedSignature, signature);
});

test('workspace API keys authenticate scoped agent clients and can be revoked', async () => {
  const setup = await createOrganizationWorkspace();

  const createdKey = await post(
    `/workspaces/${setup.workspace.workspaceId}/api-keys`,
    {
      label: 'reconciliation agent',
      scopes: ['workspace:read', 'workspace:write', 'payments:write', 'reconciliation:read'],
    },
    setup.sessionToken,
  );

  assert.equal(createdKey.label, 'reconciliation agent');
  assert.equal(createdKey.status, 'active');
  assert.ok(createdKey.token.startsWith('axoria_live_'));
  assert.equal(createdKey.tokenWarning.includes('only returns'), true);

  const listKeysResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/api-keys`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(listKeysResponse.status, 200);
  const listedKeys = await listKeysResponse.json();
  assert.equal(listedKeys.items.length, 1);
  assert.equal(listedKeys.items[0].apiKeyId, createdKey.apiKeyId);
  assert.equal(Object.hasOwn(listedKeys.items[0], 'token'), false);

  const agentSessionResponse = await fetch(`${baseUrl}/auth/session`, {
    headers: authHeaders(createdKey.token),
  });
  assert.equal(agentSessionResponse.status, 200);
  const agentSession = await agentSessionResponse.json();
  assert.equal(agentSession.authType, 'api_key');
  assert.equal(agentSession.actor.workspaceId, setup.workspace.workspaceId);
  assert.deepEqual(agentSession.actor.scopes, ['workspace:read', 'workspace:write', 'payments:write', 'reconciliation:read']);

  const readOnlyKey = await post(
    `/workspaces/${setup.workspace.workspaceId}/api-keys`,
    {
      label: 'read only agent',
      scopes: ['workspace:read'],
    },
    setup.sessionToken,
  );

  const deniedCreateAddressResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/addresses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(readOnlyKey.token),
    },
    body: JSON.stringify({
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111115',
      displayName: 'Denied Wallet',
    }),
  });
  assert.equal(deniedCreateAddressResponse.status, 403);
  assert.equal((await deniedCreateAddressResponse.json()).requiredScope, 'workspace:write');

  const createdAddress = await post(
    `/workspaces/${setup.workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Agent Created Wallet',
    },
    createdKey.token,
  );
  assert.equal(createdAddress.displayName, 'Agent Created Wallet');

  const secondWorkspace = await post(
    `/organizations/${setup.organization.organizationId}/workspaces`,
    {
      workspaceName: 'Second Workspace',
    },
    setup.sessionToken,
  );

  const crossWorkspaceResponse = await fetch(`${baseUrl}/workspaces/${secondWorkspace.workspaceId}/addresses`, {
    headers: authHeaders(createdKey.token),
  });
  assert.equal(crossWorkspaceResponse.status, 403);
  assert.match((await crossWorkspaceResponse.json()).message, /scoped to one workspace/i);

  const agentKeyManagementResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/api-keys`, {
    headers: authHeaders(createdKey.token),
  });
  assert.equal(agentKeyManagementResponse.status, 403);
  assert.equal((await agentKeyManagementResponse.json()).requiredScope, 'api_keys:write');

  const revokeResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/api-keys/${createdKey.apiKeyId}/revoke`,
    {
      method: 'POST',
      headers: authHeaders(setup.sessionToken),
    },
  );
  assert.equal(revokeResponse.status, 200);
  assert.equal((await revokeResponse.json()).status, 'revoked');

  const revokedSessionResponse = await fetch(`${baseUrl}/auth/session`, {
    headers: authHeaders(createdKey.token),
  });
  assert.equal(revokedSessionResponse.status, 401);
});

test('agent tasks expose actionable reconciliation work without frontend assumptions', async () => {
  const setup = await createOrganizationWorkspace();
  const key = await post(
    `/workspaces/${setup.workspace.workspaceId}/api-keys`,
    { label: 'ops agent' },
    setup.sessionToken,
  );
  const address = await post(
    `/workspaces/${setup.workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Approval Review Wallet',
    },
    setup.sessionToken,
  );

  const request = await post(
    `/workspaces/${setup.workspace.workspaceId}/transfer-requests`,
    {
      destinationWorkspaceAddressId: address.workspaceAddressId,
      requestType: 'wallet_transfer',
      amountRaw: '10000',
      status: 'submitted',
    },
    setup.sessionToken,
  );
  assert.equal(request.status, 'pending_approval');

  const tasksResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/agent/tasks`, {
    headers: authHeaders(key.token),
  });
  assert.equal(tasksResponse.status, 200);
  const tasks = await tasksResponse.json();
  const approvalTask = tasks.items.find((item: { taskId: string }) => item.taskId === `approval:${request.transferRequestId}`);
  assert.ok(approvalTask);
  assert.equal(approvalTask.kind, 'approval_review');
  assert.equal(approvalTask.resource.type, 'transfer_request');
  assert.ok(approvalTask.availableActions.some((action: { id: string }) => action.id === 'approve'));
});

test('agent task updates expose an SSE stream for API clients', async () => {
  const setup = await createOrganizationWorkspace();
  const key = await post(
    `/workspaces/${setup.workspace.workspaceId}/api-keys`,
    {
      label: 'streaming agent',
      scopes: ['reconciliation:read'],
    },
    setup.sessionToken,
  );
  const controller = new AbortController();

  const response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/agent/tasks/events`, {
    headers: authHeaders(key.token),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

  const reader = response.body?.getReader();
  assert.ok(reader);
  const chunk = await reader.read();
  const text = Buffer.from(chunk.value ?? new Uint8Array()).toString('utf8');
  assert.match(text, /event: agent_tasks_snapshot/);
  assert.match(text, new RegExp(setup.workspace.workspaceId));
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('agent exception task actions match the exception action API contract', async () => {
  const setup = await createSeededPartialExceptionRequest();
  const key = await post(
    `/workspaces/${setup.workspace.workspaceId}/api-keys`,
    {
      label: 'exception agent',
      scopes: ['reconciliation:read', 'exceptions:write'],
    },
    setup.sessionToken,
  );

  const tasksResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/agent/tasks`, {
    headers: authHeaders(key.token),
  });
  assert.equal(tasksResponse.status, 200);
  const tasks = await tasksResponse.json();
  const exceptionTask = tasks.items.find((item: { taskId: string }) => item.taskId === `exception:${setup.exceptionId}`);
  assert.ok(exceptionTask);
  assert.deepEqual(
    exceptionTask.availableActions.map((action: { body: { action: string } }) => action.body.action).sort(),
    ['dismissed', 'reviewed'],
  );
});

test('API-key payment mutations preserve machine actor identity in audit events', async () => {
  const setup = await createOrganizationWorkspace();
  const key = await post(
    `/workspaces/${setup.workspace.workspaceId}/api-keys`,
    {
      label: 'payment writer agent',
      scopes: ['workspace:read', 'payments:write'],
    },
    setup.sessionToken,
  );
  const address = await post(
    `/workspaces/${setup.workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Machine Audit Wallet',
    },
    setup.sessionToken,
  );
  const destination = await post(
    `/workspaces/${setup.workspace.workspaceId}/destinations`,
    {
      linkedWorkspaceAddressId: address.workspaceAddressId,
      label: 'Machine audit destination',
      trustState: 'trusted',
    },
    setup.sessionToken,
  );

  const order = await post(
    `/workspaces/${setup.workspace.workspaceId}/payment-orders`,
    {
      destinationId: destination.destinationId,
      amountRaw: '10000',
      memo: 'created by agent',
    },
    key.token,
  );

  const detailResponse = await fetch(
    `${baseUrl}/workspaces/${setup.workspace.workspaceId}/payment-orders/${order.paymentOrderId}`,
    { headers: authHeaders(key.token) },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.events[0].actorType, 'api_key');
  assert.equal(detail.events[0].actorId, key.apiKeyId);
  assert.equal(detail.createdByUserId, null);
});

test('mutating routes support idempotent retries and reject key reuse with a different body', async () => {
  const setup = await createOrganizationWorkspace();
  const key = `wallet-create-${crypto.randomUUID()}`;
  const body = {
    chain: 'solana',
    address: 'So11111111111111111111111111111111111111112',
    displayName: 'Retry Safe Wallet',
  };

  const firstResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/addresses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      ...authHeaders(setup.sessionToken),
    },
    body: JSON.stringify(body),
  });
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();

  const retryResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/addresses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      ...authHeaders(setup.sessionToken),
    },
    body: JSON.stringify(body),
  });
  assert.equal(retryResponse.status, 201);
  assert.equal(retryResponse.headers.get('idempotency-replayed'), 'true');
  const retry = await retryResponse.json();
  assert.equal(retry.workspaceAddressId, first.workspaceAddressId);

  const listResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/addresses`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.items.length, 1);

  const conflictResponse = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/addresses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      ...authHeaders(setup.sessionToken),
    },
    body: JSON.stringify({
      ...body,
      displayName: 'Different Wallet Name',
    }),
  });
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).error, 'IdempotencyConflict');
});

test('address label endpoints support create, search, and patch flows directly', async () => {
  const login = await loginUser('labels@example.com', 'Label User');
  const created = await post(
    '/address-labels',
    {
      chain: 'solana',
      address: 'HFqp6ErWHY6Uzhj8rFyjYuDya2mXUpYEk8VW75K9PSiY',
      entityName: 'Jupiter Aggregator Authority 16',
      entityType: 'account',
      labelKind: 'aggregator_authority',
      roleTags: ['aggregator', 'swap_route'],
      source: 'manual',
      confidence: 'operator',
      isActive: true,
      notes: 'Seeded from operator review',
    },
    login.sessionToken,
  );

  const listResponse = await fetch(
    `${baseUrl}/address-labels?chain=solana&search=${encodeURIComponent('Aggregator Authority 16')}`,
    { headers: authHeaders(login.sessionToken) },
  );
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.equal(listPayload.items.length, 1);
  assert.equal(listPayload.items[0].addressLabelId, created.addressLabelId);
  assert.deepEqual(listPayload.items[0].roleTags, ['aggregator', 'swap_route']);

  const patchResponse = await fetch(`${baseUrl}/address-labels/${created.addressLabelId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(login.sessionToken),
    },
    body: JSON.stringify({
      isActive: false,
      notes: 'Disabled after review',
      roleTags: ['aggregator'],
    }),
  });
  assert.equal(patchResponse.status, 200);
  const updated = await patchResponse.json();
  assert.equal(updated.isActive, false);
  assert.equal(updated.notes, 'Disabled after review');
  assert.deepEqual(updated.roleTags, ['aggregator']);
});

test('approval policy, inbox, members, and export history endpoints are usable directly', async () => {
  const setup = await createOrganizationWorkspace();
  const member = await loginUser('reviewer@example.com', 'Reviewer');
  await post(`/organizations/${setup.organization.organizationId}/join`, {}, member.sessionToken);

  let response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/approval-policy`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(response.status, 200);
  const policy = await response.json();
  assert.equal(policy.isActive, true);
  assert.equal(policy.ruleJson.requireTrustedDestination, true);

  response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/approval-policy`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(setup.sessionToken),
    },
    body: JSON.stringify({
      ruleJson: {
        externalApprovalThresholdRaw: '1000',
      },
    }),
  });
  assert.equal(response.status, 200);
  const updatedPolicy = await response.json();
  assert.equal(updatedPolicy.ruleJson.externalApprovalThresholdRaw, '1000');

  const address = await post(
    `/workspaces/${setup.workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Approval Wallet',
    },
    setup.sessionToken,
  );

  const destination = await post(
    `/workspaces/${setup.workspace.workspaceId}/destinations`,
    {
      linkedWorkspaceAddressId: address.workspaceAddressId,
      label: 'Approval destination',
      trustState: 'trusted',
      destinationType: 'vendor_wallet',
      isInternal: false,
    },
    setup.sessionToken,
  );

  const request = await post(
    `/workspaces/${setup.workspace.workspaceId}/transfer-requests`,
    {
      destinationId: destination.destinationId,
      requestType: 'vendor_payout',
      amountRaw: '5000',
      status: 'submitted',
    },
    setup.sessionToken,
  );
  assert.equal(request.status, 'pending_approval');

  response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/approval-inbox?status=pending_approval`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(response.status, 200);
  const inbox = await response.json();
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].transferRequestId, request.transferRequestId);

  response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/members`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(response.status, 200);
  const members = await response.json();
  assert.equal(members.items.length, 2);

  response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/export-jobs`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(response.status, 200);
  const emptyHistory = await response.json();
  assert.equal(emptyHistory.items.length, 0);

  response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/exports/reconciliation?format=json`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(response.status, 200);
  const exportPayload = await response.json();
  assert.ok(Array.isArray(exportPayload.items));

  response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/export-jobs`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(response.status, 200);
  const exportHistory = await response.json();
  assert.equal(exportHistory.items.length, 1);
  assert.equal(exportHistory.items[0].exportKind, 'reconciliation');
});

test('observed transfers endpoint filters to tracked wallets and keeps neutral route labels', async () => {
  const setup = await createOrganizationWorkspace();
  const trackedAddress = await post(
    `/workspaces/${setup.workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      displayName: 'Tracked Wallet',
    },
    setup.sessionToken,
  );

  await insertClickHouseRows('observed_transfers', [
    {
      transfer_id: crypto.randomUUID(),
      signature: '5w4JwH5nWZ9N6cY81mYAwU3S6fP3LhZq1BtYV4Bn8Jq2pHfNE3gEM6VKezxJXvLjVdv6vQ2MSmTYqZ6DxPzLy3EZ',
      slot: 411600001,
      event_time: '2026-04-07 11:32:44.313',
      asset: 'usdc',
      source_token_account: '64HWdAaTsTVvsQWQnw4PKVWeQ5BQXJ5dT6fTwerqo9US',
      source_wallet: 'VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti',
      destination_token_account: trackedAddress.usdcAtaAddress,
      destination_wallet: trackedAddress.address,
      amount_raw: '9204',
      amount_decimal: '0.009204',
      transfer_kind: 'transfer_checked',
      instruction_index: 2,
      inner_instruction_index: null,
      route_group: 'route-a',
      leg_role: 'other_destination',
      properties_json: '{}',
      created_at: '2026-04-07 11:38:15.253',
    },
    {
      transfer_id: crypto.randomUUID(),
      signature: '4x4JwH5nWZ9N6cY81mYAwU3S6fP3LhZq1BtYV4Bn8Jq2pHfNE3gEM6VKezxJXvLjVdv6vQ2MSmTYqZ6DxPzLy3EA',
      slot: 411600002,
      event_time: '2026-04-07 11:40:44.313',
      asset: 'usdc',
      source_token_account: '11111111111111111111111111111111',
      source_wallet: '11111111111111111111111111111111',
      destination_token_account: '22222222222222222222222222222222',
      destination_wallet: '22222222222222222222222222222222',
      amount_raw: '1000',
      amount_decimal: '0.001000',
      transfer_kind: 'transfer_checked',
      instruction_index: 3,
      inner_instruction_index: null,
      route_group: 'route-b',
      leg_role: 'direct_settlement',
      properties_json: '{}',
      created_at: '2026-04-07 11:41:15.253',
    },
  ]);

  const response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/transfers?limit=20`, {
    headers: authHeaders(setup.sessionToken),
  });
  assert.equal(response.status, 200);
  const transfers = await response.json();
  assert.equal(transfers.items.length, 1);
  assert.equal(transfers.items[0].destinationWallet, trackedAddress.address);
  assert.equal(transfers.items[0].legRole, 'other_destination');
});

test('transfer request and exception endpoints reject invalid mutation cases directly', async () => {
  const seeded = await createSeededPartialExceptionRequest();
  const outsider = await loginUser('outsider@example.com', 'Outsider');
  const draftRequest = await post(
    `/workspaces/${seeded.workspace.workspaceId}/transfer-requests`,
    {
      destinationId: seeded.destination.destinationId,
      requestType: 'vendor_payout',
      amountRaw: '10000',
      status: 'draft',
    },
    seeded.sessionToken,
  );

  let response = await fetch(
    `${baseUrl}/workspaces/${seeded.workspace.workspaceId}/transfer-requests/${draftRequest.transferRequestId}/executions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(seeded.sessionToken),
      },
      body: JSON.stringify({
        executionSource: 'manual',
        metadataJson: {},
      }),
    },
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Execution records can only be created/i);

  response = await fetch(`${baseUrl}/workspaces/${seeded.workspace.workspaceId}/exceptions/${seeded.exceptionId}`, {
    headers: authHeaders(seeded.sessionToken),
  });
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.exceptionId, seeded.exceptionId);

  response = await fetch(`${baseUrl}/workspaces/${seeded.workspace.workspaceId}/exceptions/${seeded.exceptionId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(seeded.sessionToken),
    },
    body: JSON.stringify({
      assignedToUserId: outsider.user.userId,
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Assignee must be an active member of this organization/i);
});

test('protected workspace routes reject anonymous callers', async () => {
  const setup = await createOrganizationWorkspace();

  const response = await fetch(`${baseUrl}/workspaces/${setup.workspace.workspaceId}/addresses`, {
    headers: {
      'x-request-id': 'agent-request-1',
    },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('x-request-id'), 'agent-request-1');
  const payload = await response.json();
  assert.equal(payload.code, 'unauthorized');
  assert.equal(payload.requestId, 'agent-request-1');
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

  const destination = await post(
    `/workspaces/${setup.workspace.workspaceId}/destinations`,
    {
      linkedWorkspaceAddressId: destinationAddress.workspaceAddressId,
      label: 'Vendor payout wallet',
      trustState: 'trusted',
      destinationType: 'vendor_wallet',
      isInternal: false,
    },
    setup.sessionToken,
  );

  const transferRequest = await post(
    `/workspaces/${setup.workspace.workspaceId}/transfer-requests`,
    {
      destinationId: destination.destinationId,
      requestType: 'vendor_payout',
      amountRaw: '2500000',
      status: options?.status ?? 'submitted',
    },
    setup.sessionToken,
  );

  return {
    ...setup,
    destinationAddress,
    destination,
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
