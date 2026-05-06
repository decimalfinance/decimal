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
  wallet_challenges,
  user_wallets,
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
  assert.equal(capabilities.product, 'decimal');
  assert.equal(capabilities.version, 1);
  assert.ok(capabilities.workflows.some((workflow: { id: string }) => workflow.id === 'single_payment'));
  assert.ok(capabilities.workflows.some((workflow: { id: string }) => workflow.id === 'csv_to_payment_run'));
  assert.equal(capabilities.apiSurface.idempotency.includes('Idempotency-Key'), true);

  const openApiResponse = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(openApiResponse.status, 200);
  const openApi = await openApiResponse.json();
  assert.equal(openApi.openapi, '3.1.0');
  assert.ok(openApi.paths['/organizations/{organizationId}/payment-requests']);
  assert.ok(openApi.paths['/organizations/{organizationId}/payment-orders']);
  assert.equal(openApi.paths['/organizations/{organizationId}/api-keys'], undefined);
  assert.equal(openApi.paths['/organizations/{organizationId}/agent/tasks'], undefined);
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

test('session auth supports organization, address-book, and policy setup', async () => {
  const register = await post('/auth/register', {
    email: 'ops@example.com',
    password: 'DemoPass123!',
    displayName: 'Ops',
  });
  assert.equal(register.status, 'authenticated');
  assert.ok(register.sessionToken);
  await verifyRegisteredEmail(register);

  const organization = await post(
    '/organizations',
    { organizationName: 'Acme Treasury' },
    register.sessionToken,
  );
  assert.equal(organization.organizationName, 'Acme Treasury');

  const treasuryWallet = await post(
    `/organizations/${organization.organizationId}/treasury-wallets`,
    {
      chain: 'solana',
      address: Keypair.generate().publicKey.toBase58(),
      displayName: 'Ops Vault',
    },
    register.sessionToken,
  );
  assert.equal(treasuryWallet.displayName, 'Ops Vault');

  const counterparty = await post(
    `/organizations/${organization.organizationId}/counterparties`,
    { displayName: 'Fuyo LLC' },
    register.sessionToken,
  );
  assert.equal(counterparty.displayName, 'Fuyo LLC');

  const destinationWallet = Keypair.generate().publicKey.toBase58();
  const destination = await post(
    `/organizations/${organization.organizationId}/destinations`,
    {
      walletAddress: destinationWallet,
      label: 'Fuyo payout wallet',
      counterpartyId: counterparty.counterpartyId,
      trustState: 'trusted',
    },
    register.sessionToken,
  );
  assert.equal(destination.label, 'Fuyo payout wallet');
  assert.equal(destination.trustState, 'trusted');

  const policy = await get(`/organizations/${organization.organizationId}/approval-policy`, register.sessionToken);
  assert.equal(policy.isActive, true);

  const inbox = await get(`/organizations/${organization.organizationId}/approval-inbox`, register.sessionToken);
  assert.deepEqual(inbox.items, []);

  const summary = await get(`/organizations/${organization.organizationId}/summary`, register.sessionToken);
  assert.equal(summary.paymentsIncompleteCount, 0);
  assert.equal(summary.collectionsOpenCount, 0);
  assert.equal(summary.destinationsUnreviewedCount, 0);

  const session = await get('/auth/session', register.sessionToken);
  assert.equal(session.authenticated, true);
  assert.equal(session.authType, 'user_session');
  assert.equal(session.organizations.length, 1);
});

test('auth registration and login require the right password', async () => {
  const missingUser = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'missing@example.com',
      password: 'DemoPass123!',
    }),
  });
  assert.equal(missingUser.status, 401);
  assert.equal((await missingUser.json()).code, 'invalid_credentials');

  const register = await post('/auth/register', {
    email: 'auth@example.com',
    password: 'DemoPass123!',
    displayName: 'Auth User',
  });
  assert.equal(register.status, 'authenticated');
  await verifyRegisteredEmail(register);

  const duplicateRegister = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'auth@example.com',
      password: 'DemoPass123!',
      displayName: 'Auth User',
    }),
  });
  assert.equal(duplicateRegister.status, 409);
  assert.equal((await duplicateRegister.json()).code, 'conflict');

  const wrongPassword = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'auth@example.com',
      password: 'WrongPass123!',
    }),
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal((await wrongPassword.json()).code, 'invalid_credentials');

  const login = await post('/auth/login', {
    email: 'auth@example.com',
    password: 'DemoPass123!',
  });
  assert.equal(login.status, 'authenticated');
  assert.ok(login.sessionToken);
  assert.equal(login.user.email, 'auth@example.com');
});

test('google oauth start uses stable local redirect URI when configured', async () => {
  const response = await fetch(`${baseUrl}/auth/google/start?returnTo=/setup&frontendOrigin=http://127.0.0.1:5174`, {
    redirect: 'manual',
  });
  if (response.status === 501) {
    assert.equal((await response.json()).code, 'google_oauth_not_configured');
    return;
  }
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.ok(location);
  const redirect = new URL(location);
  assert.equal(redirect.searchParams.get('redirect_uri'), 'http://127.0.0.1:3100/auth/google/callback');
});

test('email verification gates organization setup and wallet registration is user-scoped', async () => {
  const register = await post('/auth/register', {
    email: 'onboarding@example.com',
    password: 'DemoPass123!',
    displayName: 'Onboarding User',
  });
  assert.equal(register.user.emailVerifiedAt, null);

  const blockedOrganization = await fetch(`${baseUrl}/organizations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(register.sessionToken),
    },
    body: JSON.stringify({ organizationName: 'Blocked Org' }),
  });
  assert.equal(blockedOrganization.status, 403);

  await verifyRegisteredEmail(register);

  const organization = await post('/organizations', { organizationName: 'Verified Org' }, register.sessionToken);
  assert.equal(organization.organizationName, 'Verified Org');

  const embeddedWallet = await post(
    '/user-wallets/embedded',
    {
      walletAddress: Keypair.generate().publicKey.toBase58(),
      provider: 'privy',
      providerWalletId: 'privy-wallet-1',
      label: 'Embedded signer',
    },
    register.sessionToken,
  );
  assert.equal(embeddedWallet.walletType, 'privy_embedded');
  assert.equal(embeddedWallet.provider, 'privy');
  assert.ok(embeddedWallet.verifiedAt);

  const wallets = await get('/user-wallets', register.sessionToken);
  assert.equal(wallets.items.length, 1);
  assert.equal(wallets.items[0].userWalletId, embeddedWallet.userWalletId);

  const unsupportedManagedWallet = await fetch(`${baseUrl}/user-wallets/managed`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(register.sessionToken),
    },
    body: JSON.stringify({ provider: 'fireblocks', label: 'Fireblocks signer' }),
  });
  assert.equal(unsupportedManagedWallet.status, 501);
});

test('service token protection only applies to internal routes', async () => {
  const originalServiceToken = config.controlPlaneServiceToken;
  const originalNodeEnv = config.nodeEnv;

  try {
    config.controlPlaneServiceToken = 'service-token-check';
    config.nodeEnv = 'production';

    const register = await post('/auth/register', {
      email: 'service-token-check@example.com',
      password: 'DemoPass123!',
      displayName: 'Service Token Check',
    });
    assert.equal(register.status, 'authenticated');
    await verifyRegisteredEmail(register);

    const organizations = await get('/organizations', register.sessionToken);
    assert.deepEqual(organizations.items, []);

    const internalResponse = await fetch(`${baseUrl}/internal/matching-index`, {
      headers: authHeaders(register.sessionToken),
    });
    assert.equal(internalResponse.status, 401);
    assert.equal((await internalResponse.json()).message, 'Internal service token required');
  } finally {
    config.controlPlaneServiceToken = originalServiceToken;
    config.nodeEnv = originalNodeEnv;
  }
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

async function verifyRegisteredEmail(register: { sessionToken: string; devEmailVerificationCode?: string | null }) {
  const code = register.devEmailVerificationCode;
  assert.ok(code, 'registration should return a demo email verification code until email delivery exists');
  const result = await post('/auth/verify-email', { code }, register.sessionToken);
  assert.ok(result.user.emailVerifiedAt);
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
