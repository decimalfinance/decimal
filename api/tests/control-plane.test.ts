import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { executeClickHouse } from '../src/clickhouse.js';
import { prisma } from '../src/prisma.js';
import { resetRateLimitBuckets } from '../src/rate-limit.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  auth_sessions,
  idempotency_records,
  organization_memberships,
  approval_decisions,
  approval_policies,
  execution_records,
  transfer_request_notes,
  transfer_request_events,
  exception_notes,
  exception_states,
  collection_request_events,
  collection_requests,
  collection_runs,
  payment_runs,
  payment_order_events,
  payment_orders,
  payment_requests,
  transfer_requests,
  destinations,
  counterparties,
  treasury_wallets,
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

test('public health, capabilities, and OpenAPI endpoints expose the lean API surface', async () => {
  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true });

  const capabilitiesResponse = await fetch(`${baseUrl}/capabilities`);
  assert.equal(capabilitiesResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.product, 'axoria');
  assert.equal(capabilities.version, 1);
  assert.ok(capabilities.workflows.some((workflow: { id: string }) => workflow.id === 'single_payment'));
  assert.ok(capabilities.workflows.some((workflow: { id: string }) => workflow.id === 'csv_to_payment_run'));
  assert.equal(capabilities.apiSurface.idempotency.includes('Idempotency-Key'), true);

  const openApiResponse = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(openApiResponse.status, 200);
  const openApi = await openApiResponse.json();
  assert.equal(openApi.openapi, '3.1.0');
  assert.ok(openApi.paths['/workspaces/{workspaceId}/payment-requests']);
  assert.ok(openApi.paths['/workspaces/{workspaceId}/payment-orders']);
  assert.equal(openApi.paths['/workspaces/{workspaceId}/api-keys'], undefined);
  assert.equal(openApi.paths['/workspaces/{workspaceId}/agent/tasks'], undefined);
});

test('public routes enforce configured rate limits', async () => {
  const originalEnabled = config.rateLimitEnabled;
  const originalPublicMax = config.publicRateLimitMax;
  const originalPublicWindow = config.publicRateLimitWindowMs;

  try {
    config.rateLimitEnabled = true;
    config.publicRateLimitMax = 2;
    config.publicRateLimitWindowMs = 60_000;
    resetRateLimitBuckets();

    assert.equal((await fetch(`${baseUrl}/capabilities`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/capabilities`)).status, 200);
    const limited = await fetch(`${baseUrl}/capabilities`);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'rate_limit_exceeded');
  } finally {
    config.rateLimitEnabled = originalEnabled;
    config.publicRateLimitMax = originalPublicMax;
    config.publicRateLimitWindowMs = originalPublicWindow;
    resetRateLimitBuckets();
  }
});

test('session auth supports organization, workspace, address-book, and policy setup', async () => {
  const login = await post('/auth/login', { email: 'ops@example.com' });
  assert.equal(login.status, 'authenticated');
  assert.ok(login.sessionToken);

  const organization = await post(
    '/organizations',
    { organizationName: 'Acme Treasury' },
    login.sessionToken,
  );
  assert.equal(organization.organizationName, 'Acme Treasury');

  const workspace = await post(
    `/organizations/${organization.organizationId}/workspaces`,
    { workspaceName: 'USDC Ops' },
    login.sessionToken,
  );
  assert.equal(workspace.workspaceName, 'USDC Ops');

  const treasuryWallet = await post(
    `/workspaces/${workspace.workspaceId}/treasury-wallets`,
    {
      chain: 'solana',
      address: Keypair.generate().publicKey.toBase58(),
      displayName: 'Ops Vault',
    },
    login.sessionToken,
  );
  assert.equal(treasuryWallet.displayName, 'Ops Vault');

  const counterparty = await post(
    `/workspaces/${workspace.workspaceId}/counterparties`,
    { displayName: 'Fuyo LLC' },
    login.sessionToken,
  );
  assert.equal(counterparty.displayName, 'Fuyo LLC');

  const destinationWallet = Keypair.generate().publicKey.toBase58();
  const destination = await post(
    `/workspaces/${workspace.workspaceId}/destinations`,
    {
      walletAddress: destinationWallet,
      label: 'Fuyo payout wallet',
      counterpartyId: counterparty.counterpartyId,
      trustState: 'trusted',
    },
    login.sessionToken,
  );
  assert.equal(destination.label, 'Fuyo payout wallet');
  assert.equal(destination.trustState, 'trusted');

  const policy = await get(`/workspaces/${workspace.workspaceId}/approval-policy`, login.sessionToken);
  assert.equal(policy.isActive, true);

  const inbox = await get(`/workspaces/${workspace.workspaceId}/approval-inbox`, login.sessionToken);
  assert.deepEqual(inbox.items, []);

  const session = await get('/auth/session', login.sessionToken);
  assert.equal(session.authenticated, true);
  assert.equal(session.authType, 'user_session');
  assert.equal(session.organizations.length, 1);
});

async function get(path: string, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? authHeaders(token) : undefined,
  });

  if (!response.ok) {
    assert.fail(`${path} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function post(path: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? authHeaders(token) : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    assert.fail(`${path} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function authHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
  };
}

async function clearClickHouseTables() {
  for (const table of [
    'exceptions',
    'settlement_matches',
    'request_book_snapshots',
    'matcher_events',
    'observed_payments',
    'observed_transfers',
    'observed_transactions',
  ]) {
    await executeClickHouse(`TRUNCATE TABLE IF EXISTS usdc_ops.${table}`);
  }
}

async function executeWithDeadlockRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !error.message.includes('deadlock detected')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}
