// DB-backed token store for the accounting connection. Replaces the spike's
// throwaway JSON file with the `accounting_connections` table (one row per org +
// provider). Builds QuickBooks clients that persist rotated refresh tokens back.

import type { AccountingConnection } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../infra/prisma.js';
import { QuickBooks, type QboTokens } from './quickbooks.js';

const PROVIDER = 'quickbooks';

/** What a client needs from the row. A bill's draft reads the chart through here on every open. */
const CLIENT_FIELDS = {
  realmId: true, accessToken: true, refreshToken: true, accessTokenExpiresAt: true, refreshTokenExpiresAt: true, status: true,
} as const;

type ClientFields = Pick<AccountingConnection, keyof typeof CLIENT_FIELDS>;

function tokensFromRow(row: ClientFields): QboTokens {
  return {
    realmId: row.realmId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.accessTokenExpiresAt.getTime(),
    refreshExpiresAt: row.refreshTokenExpiresAt.getTime(),
  };
}

export async function getConnection(organizationId: string): Promise<AccountingConnection | null> {
  return prisma.accountingConnection.findUnique({
    where: { organizationId_provider: { organizationId, provider: PROVIDER } },
  });
}

/** Build a QuickBooks client for an org that persists rotated tokens back to the DB. */
let testClient: ((organizationId: string) => QuickBooks | null) | null = null;
/** Replace the QuickBooks client in tests (a fake that records what is sent). `null` restores it. */
export function setQuickBooksForTests(fn: ((organizationId: string) => QuickBooks | null) | null) {
  testClient = fn;
}

export async function getQuickBooksForOrg(organizationId: string): Promise<QuickBooks | null> {
  if (testClient) return testClient(organizationId);
  const row = await prisma.accountingConnection.findUnique({
    where: { organizationId_provider: { organizationId, provider: PROVIDER } },
    select: CLIENT_FIELDS,
  });
  if (!row || row.status !== 'connected') {
    return null;
  }
  return new QuickBooks(
    tokensFromRow(row),
    (tokens) => persistTokens(organizationId, tokens),
    () => markNeedsReauth(organizationId),
  );
}

/** Flag a connection whose refresh token died — the operator must reconnect. */
export async function markNeedsReauth(organizationId: string): Promise<void> {
  await prisma.accountingConnection.updateMany({
    where: { organizationId, provider: PROVIDER, status: 'connected' },
    data: { status: 'needs_reauth' },
  });
}

export async function persistTokens(organizationId: string, tokens: QboTokens): Promise<void> {
  await prisma.accountingConnection.updateMany({
    where: { organizationId, provider: PROVIDER },
    data: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: new Date(tokens.expiresAt),
      refreshTokenExpiresAt: new Date(tokens.refreshExpiresAt),
      status: 'connected',
    },
  });
}

/**
 * Save what a sign-in returned. The same company, signing in again after its
 * tokens lapsed, keeps its yes to posting. A different company does not: that
 * yes was about the other books, and the account map held the other books' ids.
 */
export async function saveConnection(organizationId: string, tokens: QboTokens): Promise<void> {
  const data = {
    realmId: tokens.realmId,
    environment: config.quickbooksEnvironment,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: new Date(tokens.expiresAt),
    refreshTokenExpiresAt: new Date(tokens.refreshExpiresAt),
    status: 'connected',
  };
  await prisma.$transaction(async (tx) => {
    const where = { organizationId_provider: { organizationId, provider: PROVIDER } };
    const existing = await tx.accountingConnection.findUnique({ where, select: { realmId: true } });
    const otherCompany = existing !== null && existing.realmId !== tokens.realmId;
    await tx.accountingConnection.upsert({
      where,
      create: { organizationId, provider: PROVIDER, ...data },
      update: { ...data, ...(otherCompany ? { postingEnabledAt: null, postingEnabledByUserId: null } : {}) },
    });
    if (otherCompany) await tx.accountingAccountMap.deleteMany({ where: { organizationId, provider: PROVIDER } });
  });
}

/**
 * A person's yes: from this moment, approved bills go to QuickBooks. Connecting
 * only lets Decimal read. Saying yes twice keeps the first moment, which decides
 * what counts as backlog. The clock is the database's, the same one that stamps
 * approvals. Null when there is no live connection to say yes to.
 */
export async function enablePosting(organizationId: string, userId: string): Promise<Date | null> {
  await prisma.$executeRaw`
    UPDATE accounting_connections
    SET posting_enabled_at = now(), posting_enabled_by_user_id = ${userId}::uuid, updated_at = now()
    WHERE organization_id = ${organizationId}::uuid AND provider = ${PROVIDER}
      AND status = 'connected' AND posting_enabled_at IS NULL`;
  const row = await getConnection(organizationId);
  return row?.status === 'connected' ? row.postingEnabledAt : null;
}

/** When posting was turned on for this organisation's books, or null while it is off. */
export async function postingEnabledSince(organizationId: string): Promise<Date | null> {
  const row = await prisma.accountingConnection.findUnique({
    where: { organizationId_provider: { organizationId, provider: PROVIDER } },
    select: { postingEnabledAt: true },
  });
  return row?.postingEnabledAt ?? null;
}

export async function disconnect(organizationId: string): Promise<void> {
  const qb = await getQuickBooksForOrg(organizationId);
  if (qb) {
    try {
      await qb.revoke();
    } catch {
      // best-effort revoke; still mark disconnected locally
    }
  }
  await prisma.accountingConnection.updateMany({
    where: { organizationId, provider: PROVIDER },
    data: { status: 'disconnected', postingEnabledAt: null, postingEnabledByUserId: null },
  });
}
