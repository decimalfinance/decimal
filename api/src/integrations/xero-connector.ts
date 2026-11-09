// Xero, as far as Decimal goes with it today: on the bench only, a made-up
// organisation in Xero's own JSON (config.xeroFixtureFile) read through the real
// Xero reader, behind a pretend sign-in. Decimal has no Xero app, so there is no
// real sign-in, and nothing posts to Xero. Go records the person's yes and that is
// all: a rehearsal of the setup.
//
// The connection is a row in accounting_connections like QuickBooks', under
// provider 'xero', so it survives the bench's restarts. Everything that posts or
// syncs reads provider 'quickbooks' only, so it never sees this one.

import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { prisma } from '../infra/prisma.js';
import type { Connector } from './connectors.js';
import { fixtureXeroClient, type XeroFixture } from './xero-fixture.js';
import { xeroReader } from './xero-reader.js';

const PROVIDER = 'xero';
/** The row's token columns can't be empty. Nothing here is a token. */
const NO_TOKEN = 'fixture';
const NEVER = new Date('9999-12-31T00:00:00Z');

let loaded: { path: string; fixture: XeroFixture } | null = null;

/** The made-up organisation, read once per file. Null when this deployment has none. */
export function xeroFixture(): XeroFixture | null {
  const path = config.xeroFixtureFile;
  if (!path) return null;
  if (loaded?.path !== path) loaded = { path, fixture: JSON.parse(readFileSync(path, 'utf8')) as XeroFixture };
  return loaded.fixture;
}

const tenantOf = (fixture: XeroFixture) => String(fixture.Organisation.OrganisationID);

const rowOf = (organizationId: string) =>
  prisma.accountingConnection.findUnique({ where: { organizationId_provider: { organizationId, provider: PROVIDER } } });

/**
 * What a sign-in would save: the organisation it came back with. Another
 * organisation than before takes the old yes with it, as with QuickBooks.
 */
export async function saveXeroSignIn(organizationId: string): Promise<string> {
  const fixture = xeroFixture();
  if (!fixture) throw new Error('This deployment has no Xero.');
  const tenantId = tenantOf(fixture);
  const existing = await rowOf(organizationId);
  const data = {
    realmId: tenantId,
    environment: 'fixture',
    accessToken: NO_TOKEN,
    refreshToken: NO_TOKEN,
    accessTokenExpiresAt: NEVER,
    refreshTokenExpiresAt: NEVER,
    status: 'connected',
  };
  await prisma.accountingConnection.upsert({
    where: { organizationId_provider: { organizationId, provider: PROVIDER } },
    create: { organizationId, provider: PROVIDER, ...data },
    update: { ...data, ...(existing && existing.realmId !== tenantId ? { postingEnabledAt: null, postingEnabledByUserId: null } : {}) },
  });
  return tenantId;
}

export async function disconnectXero(organizationId: string): Promise<void> {
  await prisma.accountingConnection.updateMany({
    where: { organizationId, provider: PROVIDER },
    data: { status: 'disconnected', postingEnabledAt: null, postingEnabledByUserId: null },
  });
}

export const xeroConnector: Connector = {
  system: PROVIDER,
  posts: false,
  available: () => xeroFixture() !== null,
  connection: async (organizationId) => {
    const row = await rowOf(organizationId);
    return row ? { companyId: row.realmId, status: row.status, postingSince: row.postingEnabledAt } : null;
  },
  reader: async (organizationId) => {
    const fixture = xeroFixture();
    const row = fixture ? await rowOf(organizationId) : null;
    if (!fixture || !row || row.status !== 'connected' || row.realmId !== tenantOf(fixture)) return null;
    return xeroReader(fixtureXeroClient(fixture));
  },
  signInPath: (organizationId) => `/organizations/${organizationId}/integrations/xero/sign-in`,
  // The yes, kept as QuickBooks keeps it, the first moment only. Nothing reads it to post.
  enablePosting: async (organizationId, userId) => {
    await prisma.accountingConnection.updateMany({
      where: { organizationId, provider: PROVIDER, status: 'connected', postingEnabledAt: null },
      data: { postingEnabledAt: new Date(), postingEnabledByUserId: userId },
    });
    const row = await rowOf(organizationId);
    return row?.status === 'connected' ? row.postingEnabledAt : null;
  },
};
