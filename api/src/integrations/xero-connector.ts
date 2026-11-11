// Xero, as far as Decimal goes with it today: a setup that reads the books and
// asks its questions, where Go records the person's yes and nothing posts. A
// rehearsal of the setup, until posting to Xero is built.
//
// Two kinds of connection, by the row's environment:
// - live: Decimal's Xero app (xero-app.ts). The person signs in on Xero's site and
//   picks their organisation; the reader reads it through Xero's API.
// - fixture: on the bench without the app, a made-up organisation in Xero's own
//   JSON (config.xeroFixtureFile), behind a pretend sign-in, read through the same
//   reader. Rows made this way keep reading the made-up organisation.
//
// The connection is a row in accounting_connections like QuickBooks', under
// provider 'xero'. Everything that posts or syncs reads provider 'quickbooks' only,
// so it never sees this one.

import { readFileSync } from 'node:fs';
import type { AccountingConnection } from '@prisma/client';
import { config } from '../config.js';
import { errorToLogFields, logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import type { Connector } from './connectors.js';
import {
  httpXeroClient,
  removeXeroConnection,
  revokeXeroToken,
  xeroAppConfigured,
  xeroConnections,
  XeroSession,
  type XeroTokens,
} from './xero-app.js';
import { fixtureXeroClient, type XeroFixture } from './xero-fixture.js';
import { xeroReader, type XeroClient } from './xero-reader.js';

const PROVIDER = 'xero';
const LIVE = 'live';
const FIXTURE = 'fixture';
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

/** Xero is here with Decimal's Xero app, or on a bench with the made-up organisation. */
export const xeroAvailable = () => xeroAppConfigured() || xeroFixture() !== null;

const tenantOf = (fixture: XeroFixture) => String(fixture.Organisation.OrganisationID);

const where = (organizationId: string) => ({ organizationId_provider: { organizationId, provider: PROVIDER } });
const rowOf = (organizationId: string) => prisma.accountingConnection.findUnique({ where: where(organizationId) });

/** What a sign-in saves. Another organisation than before takes the old yes with it, as with QuickBooks. */
async function save(organizationId: string, tenantId: string, environment: string, tokens: XeroTokens): Promise<void> {
  const existing = await rowOf(organizationId);
  const data = {
    realmId: tenantId,
    environment,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: new Date(tokens.expiresAt),
    refreshTokenExpiresAt: new Date(tokens.refreshExpiresAt),
    status: 'connected',
  };
  await prisma.accountingConnection.upsert({
    where: where(organizationId),
    create: { organizationId, provider: PROVIDER, ...data },
    update: { ...data, ...(existing && existing.realmId !== tenantId ? { postingEnabledAt: null, postingEnabledByUserId: null } : {}) },
  });
}

/** A sign-in on Xero's site came back with this organisation. */
export function saveXeroConnection(organizationId: string, tenantId: string, tokens: XeroTokens): Promise<void> {
  return save(organizationId, tenantId, LIVE, tokens);
}

/** The bench's pretend sign-in: the made-up organisation, connected at once. */
export async function saveXeroSignIn(organizationId: string): Promise<string> {
  const fixture = xeroFixture();
  if (!fixture) throw new Error('This deployment has no Xero.');
  const tenantId = tenantOf(fixture);
  await save(organizationId, tenantId, FIXTURE, { accessToken: NO_TOKEN, refreshToken: NO_TOKEN, expiresAt: NEVER.getTime(), refreshExpiresAt: NEVER.getTime() });
  return tenantId;
}

const tokensOf = (row: AccountingConnection): XeroTokens => ({
  accessToken: row.accessToken,
  refreshToken: row.refreshToken,
  expiresAt: row.accessTokenExpiresAt.getTime(),
  refreshExpiresAt: row.refreshTokenExpiresAt.getTime(),
});

/**
 * The row's sign-in, kept alive. Each write names the refresh token it replaces,
 * so a read holding old tokens never writes over a newer sign-in.
 */
function sessionOf(organizationId: string, row: AccountingConnection): XeroSession {
  return new XeroSession(tokensOf(row), {
    async save(fresh, spent) {
      await prisma.accountingConnection.updateMany({
        where: { organizationId, provider: PROVIDER, refreshToken: spent },
        data: {
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken,
          accessTokenExpiresAt: new Date(fresh.expiresAt),
          refreshTokenExpiresAt: new Date(fresh.refreshExpiresAt),
        },
      });
    },
    async stored() {
      const now = await rowOf(organizationId);
      return now && now.status === 'connected' && now.realmId === row.realmId ? tokensOf(now) : null;
    },
    async lost(spent) {
      await prisma.accountingConnection.updateMany({
        where: { organizationId, provider: PROVIDER, refreshToken: spent, status: 'connected' },
        data: { status: 'needs_reauth' },
      });
    },
  });
}

/** The live connection's client, keeping its sign-in. Null for a made-up organisation, or without the app. */
function liveClient(organizationId: string, row: AccountingConnection): XeroClient | null {
  if (row.status !== 'connected' || row.environment === FIXTURE || !xeroAppConfigured()) return null;
  return httpXeroClient(row.realmId, sessionOf(organizationId, row));
}

/** For a check run by hand (scripts/xero-read-check.mts): Xero's API for the organisation signed in to, read only. */
export async function xeroClientFor(organizationId: string): Promise<XeroClient | null> {
  const row = await rowOf(organizationId);
  return row ? liveClient(organizationId, row) : null;
}

/** Best effort, on Xero's side: this organisation's connection to Decimal's app goes, then the sign-in. */
async function letGo(organizationId: string, row: AccountingConnection): Promise<void> {
  try {
    const session = sessionOf(organizationId, row);
    const accessToken = await session.accessToken();
    const connection = (await xeroConnections(accessToken)).find((c) => c.tenantId === row.realmId);
    if (connection) await removeXeroConnection(accessToken, connection.id);
    await revokeXeroToken(session.refreshToken);
  } catch (error) {
    logger.warn('xero.disconnect_incomplete', { organizationId, ...errorToLogFields(error) });
  }
}

/** Decimal stops reading the organisation. A real sign-in is ended on Xero's side too; the made-up one has nothing there. */
export async function disconnectXero(organizationId: string): Promise<void> {
  const row = await rowOf(organizationId);
  if (row && row.environment !== FIXTURE && row.status !== 'disconnected' && xeroAppConfigured()) await letGo(organizationId, row);
  await prisma.accountingConnection.updateMany({
    where: { organizationId, provider: PROVIDER },
    data: { status: 'disconnected', postingEnabledAt: null, postingEnabledByUserId: null },
  });
}

export const xeroConnector: Connector = {
  system: PROVIDER,
  posts: false,
  available: xeroAvailable,
  connection: async (organizationId) => {
    const row = await rowOf(organizationId);
    return row ? { companyId: row.realmId, status: row.status, postingSince: row.postingEnabledAt } : null;
  },
  reader: async (organizationId) => {
    const row = await rowOf(organizationId);
    if (!row || row.status !== 'connected') return null;
    if (row.environment === FIXTURE) {
      const fixture = xeroFixture();
      return fixture && row.realmId === tenantOf(fixture) ? xeroReader(fixtureXeroClient(fixture)) : null;
    }
    const client = liveClient(organizationId, row);
    return client ? xeroReader(client) : null;
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
