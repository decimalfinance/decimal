import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { prisma } from '../src/prisma.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  auth_sessions,
  organization_memberships,
  workspace_address_object_mappings,
  workspace_address_labels,
  workspace_objects,
  workspace_labels,
  workspace_addresses,
  global_entity_addresses,
  global_entities,
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
      organizationSlug: 'acme-treasury',
    },
    login.sessionToken,
  );

  const workspace = await post(
    `/organizations/${organization.organizationId}/workspaces`,
    {
      workspaceName: 'Primary Watch',
      workspaceSlug: 'primary-watch',
    },
    login.sessionToken,
  );

  const sessionResponse = await fetch(`${baseUrl}/auth/session`, {
    headers: authHeaders(login.sessionToken),
  });
  const session = await sessionResponse.json();

  assert.equal(session.organizations.length, 1);
  assert.equal(session.organizations[0].organizationSlug, 'acme-treasury');
  assert.equal(session.organizations[0].role, 'owner');
  assert.equal(session.organizations[0].workspaces.length, 1);
  assert.equal(session.organizations[0].workspaces[0].workspaceId, workspace.workspaceId);
});

test('workspace onboarding snapshot returns addresses, labels, and mappings for an org admin', async () => {
  const setup = await createOrganizationWorkspace();
  const workspace = setup.workspace;

  const address = await post(
    `/workspaces/${workspace.workspaceId}/addresses`,
    {
      chain: 'solana',
      address: 'Address1111111111111111111111111111111111',
      addressKind: 'treasury_wallet',
    },
    setup.sessionToken,
  );

  const label = await post(
    `/workspaces/${workspace.workspaceId}/labels`,
    {
      labelName: 'treasury',
      labelType: 'internal',
    },
    setup.sessionToken,
  );

  await post(
    `/workspaces/${workspace.workspaceId}/address-labels`,
    {
      workspaceAddressId: address.workspaceAddressId,
      labelId: label.labelId,
    },
    setup.sessionToken,
  );

  const object = await post(
    `/workspaces/${workspace.workspaceId}/objects`,
    {
      objectType: 'treasury',
      objectKey: 'main',
      displayName: 'Main Treasury',
    },
    setup.sessionToken,
  );

  await post(
    `/workspaces/${workspace.workspaceId}/address-object-mappings`,
    {
      workspaceAddressId: address.workspaceAddressId,
      workspaceObjectId: object.workspaceObjectId,
      mappingRole: 'owner',
      isPrimary: true,
    },
    setup.sessionToken,
  );

  const response = await fetch(`${baseUrl}/workspaces/${workspace.workspaceId}/onboarding`, {
    headers: authHeaders(setup.sessionToken),
  });

  assert.equal(response.status, 200);
  const snapshot = await response.json();

  assert.equal(snapshot.workspace.workspaceId, workspace.workspaceId);
  assert.equal(snapshot.addresses.length, 1);
  assert.equal(snapshot.labels.length, 1);
  assert.equal(snapshot.addressLabels.length, 1);
  assert.equal(snapshot.objects.length, 1);
  assert.equal(snapshot.addressObjectMappings.length, 1);
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
        addressKind: 'customer_wallet',
      }),
    },
  );

  assert.equal(createAddressResponse.status, 400);
  const error = await createAddressResponse.json();
  assert.equal(error.message, 'Admin access required');
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
      organizationSlug: 'beta-treasury',
    },
    login.sessionToken,
  );
  const workspace = await post(
    `/organizations/${organization.organizationId}/workspaces`,
    {
      workspaceName: 'Beta Ops',
      workspaceSlug: 'beta-ops',
    },
    login.sessionToken,
  );

  return {
    sessionToken: login.sessionToken as string,
    organization,
    workspace,
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
