// Per-order GL sync + the background sweep. A settled payment order is pushed to
// the org's connected accounting system as a Bill + BillPayment. The push only
// runs once the payment is `settled` on-chain (verified money truth), and is
// idempotent at two layers: the QBO requestid and the unique accounting_syncs
// row per (payment order, provider).

import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { getQuickBooksForOrg } from './connections.js';
import { syncPaymentToQuickBooks } from './sync.js';

const PROVIDER = 'quickbooks';
const MAX_ATTEMPTS = 5;
const SWEEP_BATCH = 20;
const USDC_DECIMALS = 6;

export type AccountingSyncOutcome = 'synced' | 'skipped' | 'error';

type SyncFields = {
  status: string;
  requestId?: string;
  externalVendorId?: string | null;
  externalBillId?: string | null;
  externalBillPaymentId?: string | null;
  externalBillBalance?: number | null;
  error?: string | null;
  syncedAt?: Date | null;
  incrementAttempts?: boolean;
};

async function upsertSync(organizationId: string, paymentOrderId: string, fields: SyncFields): Promise<void> {
  const { incrementAttempts, requestId, ...rest } = fields;
  const base = { ...rest, requestId: requestId ?? `decimal_${paymentOrderId}` };
  await prisma.accountingSync.upsert({
    where: { paymentOrderId_provider: { paymentOrderId, provider: PROVIDER } },
    create: { organizationId, paymentOrderId, provider: PROVIDER, attempts: incrementAttempts ? 1 : 0, ...base },
    update: { ...base, ...(incrementAttempts ? { attempts: { increment: 1 } } : {}) },
  });
}

/**
 * Clear a failed sync's attempt counter so an operator's manual retry actually
 * runs (the sweep gives up at MAX_ATTEMPTS; a deliberate retry should not).
 * Only touches error rows — never re-opens a successful sync.
 */
export async function resetSyncForRetry(paymentOrderId: string): Promise<void> {
  await prisma.accountingSync.updateMany({
    where: { paymentOrderId, provider: PROVIDER, status: 'error' },
    data: { attempts: 0, status: 'pending', error: null },
  });
}

/** Sync one settled payment order. Idempotent and safe to call repeatedly. */
export async function syncSettledPaymentOrder(paymentOrderId: string): Promise<AccountingSyncOutcome> {
  const order = await prisma.paymentOrder.findUnique({
    where: { paymentOrderId },
    include: {
      counterparty: true,
      counterpartyWallet: true,
      proposals: { where: { executedSignature: { not: null } }, orderBy: { executedAt: 'desc' }, take: 1 },
      spendingLimitExecutions: { where: { signature: { not: null } }, orderBy: { executedAt: 'desc' }, take: 1 },
      accountingSyncs: { where: { provider: PROVIDER } },
    },
  });
  if (!order || order.state !== 'settled') {
    return 'skipped';
  }

  const existing = order.accountingSyncs[0] ?? null;
  if (existing?.status === 'synced') {
    return 'skipped';
  }
  if (existing?.status === 'error' && existing.attempts >= MAX_ATTEMPTS) {
    return 'skipped';
  }

  const map = await prisma.accountingAccountMap.findUnique({
    where: { organizationId_provider: { organizationId: order.organizationId, provider: PROVIDER } },
  });
  const qb = await getQuickBooksForOrg(order.organizationId);

  // Preconditions: a live connection + a complete account map. Record the
  // blocking reason so the UI can prompt "connect / finish mapping".
  const missing: string[] = [];
  if (!qb) missing.push('connection');
  if (!map?.clearingAccountId) missing.push('clearing_account');
  if (!map?.defaultExpenseAccountId) missing.push('default_expense_account');
  if (!qb || !map?.clearingAccountId || !map?.defaultExpenseAccountId) {
    await upsertSync(order.organizationId, paymentOrderId, {
      status: 'pending',
      error: `not ready: missing ${missing.join(', ')}`,
    });
    return 'skipped';
  }

  const vendorLabel = order.counterparty?.displayName ?? order.counterpartyWallet.label;
  const amountUsdc = Number(order.amountRaw) / 10 ** USDC_DECIMALS;
  const signature = order.proposals[0]?.executedSignature ?? order.spendingLimitExecutions[0]?.signature ?? null;
  const requestId = `decimal_${paymentOrderId}`;

  try {
    const result = await syncPaymentToQuickBooks(
      qb,
      {
        id: requestId,
        vendorLabel,
        amountUsdc,
        invoiceNumber: order.invoiceNumber,
        reference: order.externalReference,
        txSignature: signature,
      },
      {
        clearingAccountId: map.clearingAccountId,
        defaultExpenseAccountId: map.defaultExpenseAccountId,
        apAccountId: map.apAccountId,
      },
    );
    await upsertSync(order.organizationId, paymentOrderId, {
      status: 'synced',
      requestId,
      externalVendorId: result.vendorId,
      externalBillId: result.billId,
      externalBillPaymentId: result.billPaymentId,
      externalBillBalance: result.billBalance,
      error: null,
      syncedAt: new Date(),
    });
    logger.info('accounting_sync.synced', {
      organizationId: order.organizationId,
      paymentOrderId,
      billId: result.billId,
      billPaymentId: result.billPaymentId,
    });
    return 'synced';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertSync(order.organizationId, paymentOrderId, {
      status: 'error',
      requestId,
      error: message,
      incrementAttempts: true,
    });
    logger.warn('accounting_sync.failed', { organizationId: order.organizationId, paymentOrderId, error: message });
    return 'error';
  }
}

export type AccountingSweepSummary = { synced: number; skipped: number; error: number };

/** Find settled, not-yet-synced payment orders for connected orgs and sync them. */
export async function sweepUnsyncedSettledOrders(): Promise<AccountingSweepSummary> {
  const summary: AccountingSweepSummary = { synced: 0, skipped: 0, error: 0 };

  const connected = await prisma.accountingConnection.findMany({
    where: { provider: PROVIDER, status: 'connected' },
    select: { organizationId: true },
  });
  if (connected.length === 0) {
    return summary;
  }

  const orders = await prisma.paymentOrder.findMany({
    where: {
      organizationId: { in: connected.map((c) => c.organizationId) },
      state: 'settled',
      // exclude already-synced and error-exhausted orders
      accountingSyncs: {
        none: {
          provider: PROVIDER,
          OR: [{ status: 'synced' }, { status: 'error', attempts: { gte: MAX_ATTEMPTS } }],
        },
      },
    },
    orderBy: { updatedAt: 'asc' },
    take: SWEEP_BATCH,
    select: { paymentOrderId: true },
  });

  for (const order of orders) {
    const outcome = await syncSettledPaymentOrder(order.paymentOrderId);
    summary[outcome] += 1;
  }
  return summary;
}
