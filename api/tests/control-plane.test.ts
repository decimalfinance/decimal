import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import * as multisig from '@sqds/multisig';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { executeClickHouse } from '../src/clickhouse.js';
import { prisma } from '../src/prisma.js';
import { setPrivyWalletRuntimeForTests } from '../src/privy-wallets.js';
import { resetRateLimitBuckets } from '../src/rate-limit.js';
import { setSquadsTreasuryRuntimeForTests } from '../src/squads-treasury.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  auth_sessions,
  wallet_challenges,
  organization_wallet_authorizations,
  user_wallets,
  idempotency_records,
  organization_invites,
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
  decimal_proposals,
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
  setSquadsTreasuryRuntimeForTests(null);
  setPrivyWalletRuntimeForTests(null);
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
  assert.equal(capabilities.solana.network, config.solanaNetwork);
  assert.equal(capabilities.solana.rpcUrl, config.solanaRpcUrl);
  assert.ok(capabilities.solana.usdcMint);
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

test('organization membership is invite-only and email-bound', async () => {
  const owner = await post('/auth/register', {
    email: 'invite-owner@example.com',
    password: 'DemoPass123!',
    displayName: 'Invite Owner',
  });
  await verifyRegisteredEmail(owner);
  const organization = await post('/organizations', { organizationName: 'Invite Org' }, owner.sessionToken);

  const directJoinUser = await post('/auth/register', {
    email: 'direct-join@example.com',
    password: 'DemoPass123!',
    displayName: 'Direct Join',
  });
  await verifyRegisteredEmail(directJoinUser);
  const blockedJoin = await fetch(`${baseUrl}/organizations/${organization.organizationId}/join`, {
    method: 'POST',
    headers: authHeaders(directJoinUser.sessionToken),
  });
  assert.equal(blockedJoin.status, 403);
  assert.equal((await blockedJoin.json()).message, 'Organizations can only be joined through an invite link.');

  const invite = await post(
    `/organizations/${organization.organizationId}/invites`,
    { email: 'new-member@example.com', role: 'admin' },
    owner.sessionToken,
  );
  assert.equal(invite.invitedEmail, 'new-member@example.com');
  assert.equal(invite.role, 'admin');
  assert.equal(invite.status, 'pending');
  assert.ok(invite.inviteToken);
  assert.ok(invite.inviteLink.endsWith(`/invites/${invite.inviteToken}`));

  const preview = await get(`/invites/${invite.inviteToken}`);
  assert.equal(preview.organization.organizationId, organization.organizationId);
  assert.equal(preview.invitedEmail, 'new-member@example.com');

  const wrongUser = await post('/auth/register', {
    email: 'wrong-member@example.com',
    password: 'DemoPass123!',
    displayName: 'Wrong Member',
  });
  await verifyRegisteredEmail(wrongUser);
  const wrongAccept = await fetch(`${baseUrl}/invites/${invite.inviteToken}/accept`, {
    method: 'POST',
    headers: authHeaders(wrongUser.sessionToken),
  });
  assert.equal(wrongAccept.status, 403);

  const invitedUser = await post('/auth/register', {
    email: 'new-member@example.com',
    password: 'DemoPass123!',
    displayName: 'New Member',
  });
  await verifyRegisteredEmail(invitedUser);
  const accepted = await post(`/invites/${invite.inviteToken}/accept`, {}, invitedUser.sessionToken);
  assert.equal(accepted.organizationId, organization.organizationId);
  assert.equal(accepted.role, 'admin');
  assert.equal(accepted.invite.status, 'accepted');

  const members = await get(`/organizations/${organization.organizationId}/members`, owner.sessionToken);
  assert.equal(members.items.length, 2);
  assert.ok(members.items.some((item: { user: { email: string }; role: string }) => item.user.email === 'new-member@example.com' && item.role === 'admin'));

  const invites = await get(`/organizations/${organization.organizationId}/invites`, owner.sessionToken);
  assert.equal(invites.items.length, 1);
  assert.equal(invites.items[0].status, 'accepted');
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

test('personal wallets are separate from organization treasury wallets and require explicit authorization', async () => {
  const register = await post('/auth/register', {
    email: 'wallet-model@example.com',
    password: 'DemoPass123!',
    displayName: 'Wallet Model',
  });
  await verifyRegisteredEmail(register);

  const organization = await post('/organizations', { organizationName: 'Wallet Model Org' }, register.sessionToken);
  const personalWallet = await post(
    '/personal-wallets/embedded',
    {
      walletAddress: Keypair.generate().publicKey.toBase58(),
      provider: 'privy',
      providerWalletId: 'privy-personal-wallet-1',
      label: 'Personal signer',
    },
    register.sessionToken,
  );
  assert.equal(personalWallet.walletType, 'privy_embedded');

  const personalWallets = await get('/personal-wallets', register.sessionToken);
  assert.equal(personalWallets.items.length, 1);
  assert.equal(personalWallets.items[0].userWalletId, personalWallet.userWalletId);

  const treasuryWallet = await post(
    `/organizations/${organization.organizationId}/treasury-wallets`,
    {
      chain: 'solana',
      address: Keypair.generate().publicKey.toBase58(),
      displayName: 'Org treasury',
    },
    register.sessionToken,
  );
  assert.notEqual(treasuryWallet.address, personalWallet.walletAddress);

  const authorization = await post(
    `/organizations/${organization.organizationId}/wallet-authorizations`,
    {
      userWalletId: personalWallet.userWalletId,
      treasuryWalletId: treasuryWallet.treasuryWalletId,
      role: 'signer',
    },
    register.sessionToken,
  );
  assert.equal(authorization.scope, 'treasury_wallet');
  assert.equal(authorization.status, 'active');
  assert.equal(authorization.personalWallet.walletAddress, personalWallet.walletAddress);
  assert.equal(authorization.treasuryWallet.address, treasuryWallet.address);

  const authorizations = await get(
    `/organizations/${organization.organizationId}/wallet-authorizations?treasuryWalletId=${treasuryWallet.treasuryWalletId}`,
    register.sessionToken,
  );
  assert.equal(authorizations.items.length, 1);
  assert.equal(authorizations.items[0].walletAuthorizationId, authorization.walletAuthorizationId);

  const revoked = await post(
    `/organizations/${organization.organizationId}/wallet-authorizations/${authorization.walletAuthorizationId}/revoke`,
    {},
    register.sessionToken,
  );
  assert.equal(revoked.status, 'revoked');
  assert.ok(revoked.revokedAt);
});

test('users can delete their own Privy personal wallet and local authorizations are revoked', async () => {
  const originalPrivyAppId = config.privyAppId;
  const originalPrivyAppSecret = config.privyAppSecret;
  try {
    config.privyAppId = 'test-privy-app';
    config.privyAppSecret = 'test-privy-secret';

    const register = await post('/auth/register', {
      email: 'delete-wallet@example.com',
      password: 'DemoPass123!',
      displayName: 'Delete Wallet',
    });
    await verifyRegisteredEmail(register);

    const organization = await post('/organizations', { organizationName: 'Delete Wallet Org' }, register.sessionToken);
    const wallet = await post(
      '/personal-wallets/embedded',
      {
        walletAddress: Keypair.generate().publicKey.toBase58(),
        provider: 'privy',
        providerWalletId: 'privy-delete-wallet',
        label: 'Disposable Privy wallet',
      },
      register.sessionToken,
    );
    await post(
      `/organizations/${organization.organizationId}/wallet-authorizations`,
      {
        userWalletId: wallet.userWalletId,
        role: 'signer',
        scope: 'organization',
      },
      register.sessionToken,
    );

    let privyDeleteUrl = '';
    let privyDeleteMethod = '';
    setPrivyWalletRuntimeForTests({
      fetch: async (url, init) => {
        privyDeleteUrl = String(url);
        privyDeleteMethod = init?.method ?? 'GET';
        return new Response(null, { status: 204 });
      },
    });

    const response = await fetch(`${baseUrl}/personal-wallets/${wallet.userWalletId}`, {
      method: 'DELETE',
      headers: authHeaders(register.sessionToken),
    });
    assert.equal(response.status, 200);
    const deleted = await response.json();
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.remoteDeleted, true);
    assert.equal(deleted.revokedAuthorizationCount, 1);
    assert.equal(deleted.wallet.status, 'archived');
    assert.equal(deleted.wallet.providerWalletId, null);
    assert.equal(privyDeleteMethod, 'DELETE');
    assert.ok(privyDeleteUrl.endsWith('/v1/wallets/privy-delete-wallet'));

    const personalWallets = await get('/personal-wallets', register.sessionToken);
    assert.deepEqual(personalWallets.items, []);

    const revokedAuthorizations = await get(
      `/organizations/${organization.organizationId}/wallet-authorizations?status=revoked`,
      register.sessionToken,
    );
    assert.equal(revokedAuthorizations.items.length, 1);
    assert.equal(revokedAuthorizations.items[0].status, 'revoked');
  } finally {
    config.privyAppId = originalPrivyAppId;
    config.privyAppSecret = originalPrivyAppSecret;
    setPrivyWalletRuntimeForTests(null);
  }
});

test('Squads treasury creation prepares a signable transaction and persists the vault PDA after confirmation', async () => {
  const register = await post('/auth/register', {
    email: 'squads-treasury@example.com',
    password: 'DemoPass123!',
    displayName: 'Squads Treasury',
  });
  await verifyRegisteredEmail(register);

  const organization = await post('/organizations', { organizationName: 'Squads Treasury Org' }, register.sessionToken);
  const approver = await post('/auth/register', {
    email: 'squads-approver@example.com',
    password: 'DemoPass123!',
    displayName: 'Squads Approver',
  });
  await verifyRegisteredEmail(approver);
  const approverInvite = await post(
    `/organizations/${organization.organizationId}/invites`,
    { email: 'squads-approver@example.com', role: 'member' },
    register.sessionToken,
  );
  await post(`/invites/${approverInvite.inviteToken}/accept`, {}, approver.sessionToken);

  const creatorWalletAddress = Keypair.generate().publicKey.toBase58();
  const approverWalletAddress = Keypair.generate().publicKey.toBase58();
  const creatorWallet = await post(
    '/personal-wallets/embedded',
    {
      walletAddress: creatorWalletAddress,
      provider: 'privy',
      providerWalletId: 'privy-squads-creator',
      label: 'Creator signer',
    },
    register.sessionToken,
  );
  const approverWallet = await post(
    '/personal-wallets/embedded',
    {
      walletAddress: approverWalletAddress,
      provider: 'privy',
      providerWalletId: 'privy-squads-approver',
      label: 'Approver signer',
    },
    approver.sessionToken,
  );

  let onchainMultisig: {
    createKey: PublicKey;
    configAuthority: PublicKey;
    threshold: number;
    timeLock: number;
    transactionIndex: { toString(): string };
    staleTransactionIndex: { toString(): string };
    members: Array<{ key: PublicKey; permissions: { mask: number } }>;
  } | null = null;
  const proposalsByPda = new Map<string, {
    transactionIndex: { toString(): string };
    status: { __kind: string };
    approved: PublicKey[];
    rejected: PublicKey[];
    cancelled: PublicKey[];
  }>();
  const configTransactionsByPda = new Map<string, {
    index: { toString(): string };
    actions: multisig.types.ConfigAction[];
  }>();
  setSquadsTreasuryRuntimeForTests({
    getProgramTreasury: async () => Keypair.generate().publicKey,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 123,
    }),
    loadMultisig: async () => {
      assert.ok(onchainMultisig, 'test multisig should be configured before confirmation');
      return onchainMultisig;
    },
    loadProposal: async (proposalPda) => proposalsByPda.get(proposalPda.toBase58()) ?? null,
    loadConfigTransaction: async (configTransactionPda) => configTransactionsByPda.get(configTransactionPda.toBase58()) ?? null,
  });

  const intent = await post(
    `/organizations/${organization.organizationId}/treasury-wallets/squads/create-intent`,
    {
      displayName: 'Squads Ops Treasury',
      creatorPersonalWalletId: creatorWallet.userWalletId,
      threshold: 2,
      members: [
        {
          personalWalletId: creatorWallet.userWalletId,
          permissions: ['initiate', 'vote', 'execute'],
        },
        {
          personalWalletId: approverWallet.userWalletId,
          permissions: ['vote'],
        },
      ],
    },
    register.sessionToken,
  );

  assert.equal(intent.intent.provider, 'squads_v4');
  assert.equal(intent.intent.threshold, 2);
  assert.equal(intent.intent.members.length, 2);
  assert.equal(intent.transaction.encoding, 'base64');
  assert.equal(intent.transaction.requiredSigner, creatorWalletAddress);
  assert.ok(Buffer.from(intent.transaction.serializedTransaction, 'base64').length > 0);

  onchainMultisig = {
    createKey: Keypair.generate().publicKey,
    configAuthority: Keypair.generate().publicKey,
    threshold: 2,
    timeLock: 0,
    transactionIndex: { toString: () => '0' },
    staleTransactionIndex: { toString: () => '0' },
    members: [],
  };
  onchainMultisig.createKey = publicKeyFromString(intent.intent.createKey);
  onchainMultisig.configAuthority = publicKeyFromString('11111111111111111111111111111111');
  onchainMultisig.members = [
    { key: publicKeyFromString(creatorWalletAddress), permissions: { mask: 7 } },
    { key: publicKeyFromString(approverWalletAddress), permissions: { mask: 2 } },
  ];

  const treasuryWallet = await post(
    `/organizations/${organization.organizationId}/treasury-wallets/squads/confirm`,
    {
      signature: Keypair.generate().publicKey.toBase58(),
      displayName: 'Squads Ops Treasury',
      createKey: intent.intent.createKey,
      multisigPda: intent.intent.multisigPda,
      vaultIndex: intent.intent.vaultIndex,
    },
    register.sessionToken,
  );

  assert.equal(treasuryWallet.source, 'squads_v4');
  assert.equal(treasuryWallet.sourceRef, intent.intent.multisigPda);
  assert.equal(treasuryWallet.address, intent.intent.vaultPda);
  assert.equal(treasuryWallet.propertiesJson.squads.threshold, 2);
  assert.equal(treasuryWallet.propertiesJson.squads.members.length, 2);

  const authorizations = await get(
    `/organizations/${organization.organizationId}/wallet-authorizations?treasuryWalletId=${treasuryWallet.treasuryWalletId}`,
    register.sessionToken,
  );
  assert.equal(authorizations.items.length, 2);
  assert.deepEqual(
    authorizations.items.map((item: { role: string }) => item.role).sort(),
    ['squads_member', 'squads_member'],
  );

  const status = await get(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/status`,
    register.sessionToken,
  );
  assert.equal(status.provider, 'squads_v4');
  assert.equal(status.multisigPda, intent.intent.multisigPda);
  assert.equal(status.vaultPda, intent.intent.vaultPda);
  assert.equal(status.localStateMatchesChain, true);

  const detail = await get(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/detail`,
    register.sessionToken,
  );
  assert.equal(detail.treasuryWallet.treasuryWalletId, treasuryWallet.treasuryWalletId);
  assert.equal(detail.squads.provider, 'squads_v4');
  assert.equal(detail.squads.isAutonomous, true);
  assert.equal(detail.squads.threshold, 2);
  assert.equal(detail.squads.members.length, 2);
  assert.equal(detail.squads.capabilities.canInitiate, true);
  assert.equal(detail.squads.capabilities.canVote, true);
  assert.equal(detail.squads.capabilities.canExecute, true);
  const creatorDetail = detail.squads.members.find((member: { walletAddress: string }) => member.walletAddress === creatorWalletAddress);
  assert.equal(creatorDetail.linkStatus, 'linked');
  assert.equal(creatorDetail.personalWallet.userWalletId, creatorWallet.userWalletId);
  assert.equal(creatorDetail.organizationMembership.user.email, 'squads-treasury@example.com');
  assert.equal(creatorDetail.localAuthorization.role, 'squads_member');

  const invitedMember = await post('/auth/register', {
    email: 'squads-new-member@example.com',
    password: 'DemoPass123!',
    displayName: 'Squads New Member',
  });
  await verifyRegisteredEmail(invitedMember);
  const invite = await post(
    `/organizations/${organization.organizationId}/invites`,
    { email: 'squads-new-member@example.com', role: 'member' },
    register.sessionToken,
  );
  await post(`/invites/${invite.inviteToken}/accept`, {}, invitedMember.sessionToken);
  const newMemberWalletAddress = Keypair.generate().publicKey.toBase58();
  const newMemberWallet = await post(
    '/personal-wallets/embedded',
    {
      walletAddress: newMemberWalletAddress,
      provider: 'privy',
      providerWalletId: 'privy-squads-new-member',
      label: 'New member signer',
    },
    invitedMember.sessionToken,
  );

  const addMemberIntent = await post(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/config-proposals/add-member-intent`,
    {
      creatorPersonalWalletId: creatorWallet.userWalletId,
      newMemberPersonalWalletId: newMemberWallet.userWalletId,
      permissions: ['vote'],
      newThreshold: 3,
    },
    register.sessionToken,
  );
  assert.equal(addMemberIntent.intent.provider, 'squads_v4');
  assert.equal(addMemberIntent.intent.kind, 'config_proposal_create');
  assert.equal(addMemberIntent.intent.transactionIndex, '1');
  assert.equal(addMemberIntent.transaction.requiredSigner, creatorWalletAddress);
  assert.equal(addMemberIntent.intent.actions.length, 2);
  assert.deepEqual(
    addMemberIntent.intent.actions.map((action: { kind: string }) => action.kind),
    ['add_member', 'change_threshold'],
  );
  assert.equal(addMemberIntent.decimalProposal.proposalType, 'config_transaction');
  assert.equal(addMemberIntent.decimalProposal.semanticType, 'add_member');
  assert.equal(addMemberIntent.decimalProposal.squads.transactionIndex, '1');
  proposalsByPda.set(addMemberIntent.intent.proposalPda, {
    transactionIndex: { toString: () => '1' },
    status: { __kind: 'Active' },
    approved: [publicKeyFromString(creatorWalletAddress)],
    rejected: [],
    cancelled: [],
  });
  configTransactionsByPda.set(addMemberIntent.intent.configTransactionPda, {
    index: { toString: () => '1' },
    actions: [
      {
        __kind: 'AddMember',
        newMember: {
          key: publicKeyFromString(newMemberWalletAddress),
          permissions: multisig.types.Permissions.fromPermissions([multisig.types.Permission.Vote]),
        },
      },
      { __kind: 'ChangeThreshold', newThreshold: 3 },
    ],
  });
  onchainMultisig.transactionIndex = { toString: () => '1' };

  const pendingProposals = await get(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/config-proposals`,
    approver.sessionToken,
  );
  assert.equal(pendingProposals.items.length, 1);
  assert.equal(pendingProposals.items[0].status, 'active');
  assert.equal(pendingProposals.items[0].transactionIndex, '1');
  assert.equal(pendingProposals.items[0].approvals.length, 1);
  assert.equal(pendingProposals.items[0].approvals[0].walletAddress, creatorWalletAddress);
  assert.deepEqual(
    pendingProposals.items[0].pendingVoters.map((member: { walletAddress: string }) => member.walletAddress),
    [approverWalletAddress],
  );

  const singleProposal = await get(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/config-proposals/1`,
    approver.sessionToken,
  );
  assert.equal(singleProposal.proposalPda, addMemberIntent.intent.proposalPda);

  const decimalProposals = await get(
    `/organizations/${organization.organizationId}/proposals?status=all`,
    approver.sessionToken,
  );
  assert.equal(decimalProposals.items.length, 1);
  assert.equal(decimalProposals.items[0].decimalProposalId, addMemberIntent.decimalProposal.decimalProposalId);
  assert.equal(decimalProposals.items[0].voting.approvals[0].walletAddress, creatorWalletAddress);

  const blockedNonMemberProposalRead = await fetch(
    `${baseUrl}/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/config-proposals`,
    {
      headers: authHeaders(invitedMember.sessionToken),
    },
  );
  assert.equal(blockedNonMemberProposalRead.status, 403);
  assert.equal((await blockedNonMemberProposalRead.json()).code, 'not_squads_member');

  const approvalIntent = await post(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/config-proposals/1/approve-intent`,
    { memberPersonalWalletId: approverWallet.userWalletId },
    approver.sessionToken,
  );
  assert.equal(approvalIntent.intent.kind, 'config_proposal_approval');
  assert.equal(approvalIntent.intent.transactionIndex, '1');
  assert.equal(approvalIntent.transaction.requiredSigner, approverWalletAddress);
  proposalsByPda.set(addMemberIntent.intent.proposalPda, {
    transactionIndex: { toString: () => '1' },
    status: { __kind: 'Approved' },
    approved: [publicKeyFromString(creatorWalletAddress), publicKeyFromString(approverWalletAddress)],
    rejected: [],
    cancelled: [],
  });

  const executeIntent = await post(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/config-proposals/1/execute-intent`,
    { memberPersonalWalletId: creatorWallet.userWalletId },
    register.sessionToken,
  );
  assert.equal(executeIntent.intent.kind, 'config_proposal_execution');
  assert.equal(executeIntent.intent.transactionIndex, '1');
  assert.equal(executeIntent.transaction.requiredSigner, creatorWalletAddress);
  proposalsByPda.set(addMemberIntent.intent.proposalPda, {
    transactionIndex: { toString: () => '1' },
    status: { __kind: 'Executed' },
    approved: [publicKeyFromString(creatorWalletAddress), publicKeyFromString(approverWalletAddress)],
    rejected: [],
    cancelled: [],
  });

  onchainMultisig.threshold = 3;
  onchainMultisig.transactionIndex = { toString: () => '1' };
  // Squads bumps staleTransactionIndex to the just-executed config tx index
  // so any earlier *pending* proposals can no longer execute. The listing
  // endpoint must still surface the executed proposal at this index.
  onchainMultisig.staleTransactionIndex = { toString: () => '1' };
  onchainMultisig.members = [
    { key: publicKeyFromString(creatorWalletAddress), permissions: { mask: 7 } },
    { key: publicKeyFromString(approverWalletAddress), permissions: { mask: 2 } },
    { key: publicKeyFromString(newMemberWalletAddress), permissions: { mask: 2 } },
  ];

  const syncedDetail = await post(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/sync-members`,
    {},
    register.sessionToken,
  );
  assert.equal(syncedDetail.squads.threshold, 3);
  assert.equal(syncedDetail.squads.members.length, 3);
  const syncedNewMember = syncedDetail.squads.members.find((member: { walletAddress: string }) => member.walletAddress === newMemberWalletAddress);
  assert.equal(syncedNewMember.linkStatus, 'linked');
  assert.equal(syncedNewMember.personalWallet.userWalletId, newMemberWallet.userWalletId);
  assert.deepEqual(syncedNewMember.permissions, ['vote']);

  const syncedAuthorizations = await get(
    `/organizations/${organization.organizationId}/wallet-authorizations?treasuryWalletId=${treasuryWallet.treasuryWalletId}`,
    register.sessionToken,
  );
  assert.equal(syncedAuthorizations.items.length, 3);

  const allProposals = await get(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/config-proposals?status=all`,
    invitedMember.sessionToken,
  );
  assert.equal(allProposals.items.length, 1);
  assert.equal(allProposals.items[0].status, 'executed');

  const changeThresholdIntent = await post(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/config-proposals/change-threshold-intent`,
    {
      creatorPersonalWalletId: creatorWallet.userWalletId,
      newThreshold: 2,
    },
    register.sessionToken,
  );
  assert.equal(changeThresholdIntent.intent.kind, 'config_proposal_create');
  assert.equal(changeThresholdIntent.intent.transactionIndex, '2');
  assert.deepEqual(
    changeThresholdIntent.intent.actions.map((action: { kind: string }) => action.kind),
    ['change_threshold'],
  );
});

test('Squads vault payment proposals turn payment orders into executable treasury proposals', async () => {
  const register = await post('/auth/register', {
    email: 'squads-payment@example.com',
    password: 'DemoPass123!',
    displayName: 'Squads Payment',
  });
  await verifyRegisteredEmail(register);
  const organization = await post('/organizations', { organizationName: 'Squads Payment Org' }, register.sessionToken);
  const signerWalletAddress = Keypair.generate().publicKey.toBase58();
  const signerWallet = await post(
    '/personal-wallets/embedded',
    {
      walletAddress: signerWalletAddress,
      provider: 'privy',
      providerWalletId: 'privy-squads-payment-signer',
      label: 'Payment signer',
    },
    register.sessionToken,
  );

  const programTreasury = Keypair.generate().publicKey;
  let onchainMultisig: {
    createKey: PublicKey;
    configAuthority: PublicKey;
    threshold: number;
    timeLock: number;
    transactionIndex: { toString(): string };
    staleTransactionIndex: { toString(): string };
    members: Array<{ key: PublicKey; permissions: { mask: number } }>;
  } | null = null;
  const proposalsByPda = new Map<string, {
    transactionIndex: { toString(): string };
    status: { __kind: string };
    approved: PublicKey[];
    rejected: PublicKey[];
    cancelled: PublicKey[];
  }>();
  setSquadsTreasuryRuntimeForTests({
    getProgramTreasury: async () => programTreasury,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 456,
    }),
    loadMultisig: async () => {
      assert.ok(onchainMultisig, 'test multisig should be configured before confirmation');
      return onchainMultisig;
    },
    loadProposal: async (proposalPda) => proposalsByPda.get(proposalPda.toBase58()) ?? null,
    loadConfigTransaction: async () => null,
    loadVaultTransaction: async () => null,
  });

  const createIntent = await post(
    `/organizations/${organization.organizationId}/treasury-wallets/squads/create-intent`,
    {
      displayName: 'Payment Treasury',
      creatorPersonalWalletId: signerWallet.userWalletId,
      threshold: 1,
      members: [{
        personalWalletId: signerWallet.userWalletId,
        permissions: ['initiate', 'vote', 'execute'],
      }],
    },
    register.sessionToken,
  );
  onchainMultisig = {
    createKey: publicKeyFromString(createIntent.intent.createKey),
    configAuthority: publicKeyFromString('11111111111111111111111111111111'),
    threshold: 1,
    timeLock: 0,
    transactionIndex: { toString: () => '0' },
    staleTransactionIndex: { toString: () => '0' },
    members: [{ key: publicKeyFromString(signerWalletAddress), permissions: { mask: 7 } }],
  };
  const treasuryWallet = await post(
    `/organizations/${organization.organizationId}/treasury-wallets/squads/confirm`,
    {
      signature: Keypair.generate().publicKey.toBase58(),
      displayName: 'Payment Treasury',
      createKey: createIntent.intent.createKey,
      multisigPda: createIntent.intent.multisigPda,
      vaultIndex: createIntent.intent.vaultIndex,
    },
    register.sessionToken,
  );

  const counterparty = await post(
    `/organizations/${organization.organizationId}/counterparties`,
    { displayName: 'Vendor' },
    register.sessionToken,
  );
  const destination = await post(
    `/organizations/${organization.organizationId}/destinations`,
    {
      walletAddress: Keypair.generate().publicKey.toBase58(),
      label: 'Vendor wallet',
      counterpartyId: counterparty.counterpartyId,
      trustState: 'trusted',
    },
    register.sessionToken,
  );
  const paymentOrder = await post(
    `/organizations/${organization.organizationId}/payment-orders`,
    {
      destinationId: destination.destinationId,
      sourceTreasuryWalletId: treasuryWallet.treasuryWalletId,
      amountRaw: '10000',
      externalReference: 'INV-SQUADS-1',
    },
    register.sessionToken,
  );

  const paymentProposal = await post(
    `/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/vault-proposals/payment-intent`,
    {
      paymentOrderId: paymentOrder.paymentOrderId,
      creatorPersonalWalletId: signerWallet.userWalletId,
    },
    register.sessionToken,
  );
  assert.equal(paymentProposal.intent.kind, 'vault_payment_proposal_create');
  assert.equal(paymentProposal.intent.proposalType, 'vault_transaction');
  assert.equal(paymentProposal.intent.semanticType, 'send_payment');
  assert.equal(paymentProposal.intent.transactionIndex, '1');
  assert.equal(paymentProposal.transaction.requiredSigner, signerWalletAddress);
  assert.equal(paymentProposal.decimalProposal.proposalType, 'vault_transaction');
  assert.equal(paymentProposal.decimalProposal.paymentOrderId, paymentOrder.paymentOrderId);
  assert.equal(paymentProposal.decimalProposal.semanticPayloadJson.amountRaw, '10000');
  const preparedPaymentOrder = await get(
    `/organizations/${organization.organizationId}/payment-orders/${paymentOrder.paymentOrderId}`,
    register.sessionToken,
  );
  assert.equal(preparedPaymentOrder.derivedState, 'proposal_prepared');
  assert.equal(preparedPaymentOrder.canCreateSquadsPaymentProposal, false);
  assert.equal(preparedPaymentOrder.squadsPaymentProposal.decimalProposalId, paymentProposal.decimalProposal.decimalProposalId);

  const duplicateProposalResponse = await fetch(
    `${baseUrl}/organizations/${organization.organizationId}/treasury-wallets/${treasuryWallet.treasuryWalletId}/squads/vault-proposals/payment-intent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(register.sessionToken),
      },
      body: JSON.stringify({
        paymentOrderId: paymentOrder.paymentOrderId,
        creatorPersonalWalletId: signerWallet.userWalletId,
      }),
    },
  );
  assert.equal(duplicateProposalResponse.status, 409);

  proposalsByPda.set(paymentProposal.intent.proposalPda, {
    transactionIndex: { toString: () => '1' },
    status: { __kind: 'Approved' },
    approved: [publicKeyFromString(signerWalletAddress)],
    rejected: [],
    cancelled: [],
  });
  onchainMultisig.transactionIndex = { toString: () => '1' };

  const proposals = await get(
    `/organizations/${organization.organizationId}/proposals?status=all`,
    register.sessionToken,
  );
  assert.equal(proposals.items.length, 1);
  assert.equal(proposals.items[0].status, 'approved');
  assert.equal(proposals.items[0].voting.approvals[0].walletAddress, signerWalletAddress);

  const confirmed = await post(
    `/organizations/${organization.organizationId}/proposals/${paymentProposal.decimalProposal.decimalProposalId}/confirm-submission`,
    { signature: Keypair.generate().publicKey.toBase58() },
    register.sessionToken,
  );
  assert.equal(confirmed.localStatus, 'submitted');
  const submittedPaymentOrder = await get(
    `/organizations/${organization.organizationId}/payment-orders/${paymentOrder.paymentOrderId}`,
    register.sessionToken,
  );
  assert.equal(submittedPaymentOrder.derivedState, 'proposal_submitted');
  assert.equal(submittedPaymentOrder.squadsLifecycle.submittedSignature, confirmed.submittedSignature);

  const executed = await post(
    `/organizations/${organization.organizationId}/proposals/${paymentProposal.decimalProposal.decimalProposalId}/confirm-execution`,
    { signature: Keypair.generate().publicKey.toBase58() },
    register.sessionToken,
  );
  assert.equal(executed.localStatus, 'executed');
  const executedPaymentOrder = await get(
    `/organizations/${organization.organizationId}/payment-orders/${paymentOrder.paymentOrderId}`,
    register.sessionToken,
  );
  assert.equal(executedPaymentOrder.derivedState, 'proposal_executed');
  assert.equal(executedPaymentOrder.squadsLifecycle.executedSignature, executed.executedSignature);
  assert.equal(executedPaymentOrder.reconciliationDetail.latestExecution.submittedSignature, executed.executedSignature);
});

test('Privy personal wallet signing endpoint signs only transactions requiring that wallet', async () => {
  const originalPrivyAppId = config.privyAppId;
  const originalPrivyAppSecret = config.privyAppSecret;
  try {
    config.privyAppId = 'test-privy-app';
    config.privyAppSecret = 'test-privy-secret';

    const register = await post('/auth/register', {
      email: 'privy-signer@example.com',
      password: 'DemoPass123!',
      displayName: 'Privy Signer',
    });
    await verifyRegisteredEmail(register);

    const walletAddress = Keypair.generate().publicKey.toBase58();
    const wallet = await post(
      '/personal-wallets/embedded',
      {
        walletAddress,
        provider: 'privy',
        providerWalletId: 'privy-signing-wallet',
        label: 'Privy signer',
      },
      register.sessionToken,
    );
    const serializedTransactionBase64 = buildSquadsCreateLikeTransactionBase64(walletAddress);
    let privyRequestBody: unknown = null;
    setPrivyWalletRuntimeForTests({
      fetch: async (_url, init) => {
        privyRequestBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(
          JSON.stringify({
            method: 'signTransaction',
            data: {
              signed_transaction: serializedTransactionBase64,
              encoding: 'base64',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const signed = await post(
      `/personal-wallets/${wallet.userWalletId}/sign-versioned-transaction`,
      { serializedTransactionBase64 },
      register.sessionToken,
    );

    assert.equal(signed.userWalletId, wallet.userWalletId);
    assert.equal(signed.walletAddress, walletAddress);
    assert.equal(signed.signedTransactionBase64, serializedTransactionBase64);
    assert.deepEqual(privyRequestBody, {
      method: 'signTransaction',
      params: {
        transaction: serializedTransactionBase64,
        encoding: 'base64',
      },
    });

    const rejected = await fetch(`${baseUrl}/personal-wallets/${wallet.userWalletId}/sign-versioned-transaction`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(register.sessionToken),
      },
      body: JSON.stringify({
        serializedTransactionBase64: buildSquadsCreateLikeTransactionBase64(Keypair.generate().publicKey.toBase58()),
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).message, 'Personal wallet is not a required signer for this transaction.');
  } finally {
    config.privyAppId = originalPrivyAppId;
    config.privyAppSecret = originalPrivyAppSecret;
    setPrivyWalletRuntimeForTests(null);
  }
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

function publicKeyFromString(value: string) {
  return new PublicKey(value);
}

function buildSquadsCreateLikeTransactionBase64(requiredSigner: string) {
  const signer = new PublicKey(requiredSigner);
  const instruction = new TransactionInstruction({
    programId: new PublicKey(config.squadsProgramId),
    keys: [{ pubkey: signer, isSigner: true, isWritable: true }],
    data: Buffer.alloc(0),
  });
  const message = new TransactionMessage({
    payerKey: signer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [instruction],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
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
