// DB-backed token store for the accounting connection. Replaces the spike's
// throwaway JSON file with the `accounting_connections` table (one row per org +
// provider). Builds QuickBooks clients that persist rotated refresh tokens back.

import type { AccountingConnection } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../infra/prisma.js';
import { QuickBooks, type QboTokens } from './quickbooks.js';

const PROVIDER = 'quickbooks';

function tokensFromRow(row: AccountingConnection): QboTokens {
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
export async function getQuickBooksForOrg(organizationId: string): Promise<QuickBooks | null> {
  const row = await getConnection(organizationId);
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
  await prisma.accountingConnection.update({
    where: { organizationId_provider: { organizationId, provider: PROVIDER } },
    data: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: new Date(tokens.expiresAt),
      refreshTokenExpiresAt: new Date(tokens.refreshExpiresAt),
      status: 'connected',
    },
  });
}

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
  await prisma.accountingConnection.upsert({
    where: { organizationId_provider: { organizationId, provider: PROVIDER } },
    create: { organizationId, provider: PROVIDER, ...data },
    update: data,
  });
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
    data: { status: 'disconnected' },
  });
}
