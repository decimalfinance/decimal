// Per-bill QuickBooks sync + the background sweep, in two moments:
//
//   - APPROVED: the bill is posted to QuickBooks as a Bill, with a line per
//     category confirmed in review. That is when the books learn the money is
//     owed — the standard accounts-payable order.
//   - PAID (settled): a BillPayment is recorded against that Bill. A bill paid
//     before it was ever posted gets both at once, as it always did.
//
// One accounting_syncs row per bill carries both: externalBillId once posted,
// externalBillPaymentId once paid. Idempotent at two layers: the QBO requestid
// and that unique row.

import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { getQuickBooksForOrg } from './connections.js';
import { postBillToQuickBooks, recordBillPaymentInQuickBooks, syncPaymentToQuickBooks } from './sync.js';
import { BUILTIN_ACCOUNT_PREFIX } from './default-chart.js';

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
      glCoding: true,
    },
  });
  if (!order || order.state !== 'settled') {
    return 'skipped';
  }

  const existing = order.accountingSyncs[0] ?? null;
  if (existing?.status === 'synced' && existing.externalBillPaymentId) {
    return 'skipped';
  }
  if (existing?.status === 'error' && existing.attempts >= MAX_ATTEMPTS) {
    return 'skipped';
  }

  const map = await prisma.accountingAccountMap.findUnique({
    where: { organizationId_provider: { organizationId: order.organizationId, provider: PROVIDER } },
  });
  const qb = await getQuickBooksForOrg(order.organizationId);

  // Preconditions: a live connection and the clearing account the payment
  // comes from. A bill posted at approval needs nothing else; one that was
  // never posted also needs somewhere for an uncategorised line to go. Record
  // the blocking reason so the UI can prompt "connect / finish mapping" —
  // without touching a bill that is already posted.
  const postedAlready = Boolean(existing?.externalBillId && existing.externalVendorId);
  const missing: string[] = [];
  if (!qb) missing.push('connection');
  if (!map?.clearingAccountId) missing.push('clearing_account');
  if (!postedAlready && !map?.defaultExpenseAccountId && !order.glCoding) missing.push('default_expense_account');
  if (!qb || !map?.clearingAccountId || missing.length > 0) {
    if (postedAlready) {
      await upsertSync(order.organizationId, paymentOrderId, { status: 'synced', error: `payment not recorded yet: missing ${missing.join(', ')}` });
      return 'skipped';
    }
    await upsertSync(order.organizationId, paymentOrderId, {
      status: 'pending',
      error: `not ready: missing ${missing.join(', ')}`,
    });
    return 'skipped';
  }

  const billHeader = (order.glCoding?.billHeader ?? {}) as { vendorName?: string | null; invoiceNumber?: string | null; billDate?: string | null };
  const vendorLabel = billHeader.vendorName?.trim() || order.counterparty?.displayName || order.counterpartyWallet.label;
  const amountUsdc = Number(order.amountRaw) / 10 ** USDC_DECIMALS;
  const signature = order.proposals[0]?.executedSignature ?? order.spendingLimitExecutions[0]?.signature ?? null;
  const requestId = `decimal_${paymentOrderId}`;

  // Posted at approval already: only the payment is left to record.
  if (existing?.externalBillId && existing.externalVendorId && !existing.externalBillPaymentId) {
    try {
      const paid = await recordBillPaymentInQuickBooks(
        qb,
        { id: requestId, vendorId: existing.externalVendorId, billId: existing.externalBillId, total: amountUsdc, txSignature: signature },
        map.clearingAccountId,
      );
      await upsertSync(order.organizationId, paymentOrderId, {
        status: 'synced', requestId, externalBillPaymentId: paid.billPaymentId, externalBillBalance: paid.billBalance, error: null, syncedAt: new Date(),
      });
      logger.info('accounting_sync.payment_recorded', { organizationId: order.organizationId, paymentOrderId, billPaymentId: paid.billPaymentId });
      return 'synced';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await upsertSync(order.organizationId, paymentOrderId, { status: 'error', requestId, error: `Recording the payment: ${message}`, incrementAttempts: true });
      logger.warn('accounting_sync.payment_failed', { organizationId: order.organizationId, paymentOrderId, error: message });
      return 'error';
    }
  }
  const rawLines = order.glCoding?.lines;
  const codedLines = Array.isArray(rawLines)
    ? (rawLines as Array<{ accountId?: unknown; amount?: unknown; description?: unknown }>)
        .filter((l) => l?.accountId)
        .map((l) => ({ accountId: String(l.accountId), amount: Number(l.amount) || 0, description: (l.description as string | null) ?? null }))
    : undefined;

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
        codedLines: codedLines && codedLines.length > 0 ? codedLines : undefined,
        docNumber: billHeader.invoiceNumber ?? order.invoiceNumber,
        txnDate: billHeader.billDate ?? null,
      },
      {
        clearingAccountId: map.clearingAccountId,
        // per-payment coded account if the operator set one, else the org default
        defaultExpenseAccountId: order.glCoding?.codedExpenseAccountId ?? map.defaultExpenseAccountId ?? '',
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

  const orgIds = connected.map((c) => c.organizationId);

  // Approved bills not yet in QuickBooks: posted now. Catches a bill approved
  // before QuickBooks was connected, a post the approval hook could not make,
  // and retries of one that failed (until MAX_ATTEMPTS; a person can retry).
  const approved = await approvedBillIds(orgIds);
  if (approved.length > 0) {
    const due = await prisma.paymentOrder.findMany({
      where: {
        paymentOrderId: { in: approved },
        state: { notIn: ['draft', 'cancelled', 'settled'] },
        NOT: { accountingSyncs: { some: { provider: PROVIDER, OR: [{ externalBillId: { not: null } }, { status: 'error', attempts: { gte: MAX_ATTEMPTS } }] } } },
      },
      orderBy: { updatedAt: 'asc' },
      take: SWEEP_BATCH,
      select: { paymentOrderId: true },
    });
    for (const order of due) {
      const outcome = await syncApprovedBill(order.paymentOrderId);
      summary[outcome] += 1;
    }
  }

  // Paid bills: record the payment against a bill posted at approval, and
  // retry any settled sync that errored.
  const orders = await prisma.paymentOrder.findMany({
    where: {
      organizationId: { in: orgIds },
      state: 'settled',
      accountingSyncs: {
        some: {
          provider: PROVIDER,
          OR: [
            { status: 'error', attempts: { lt: MAX_ATTEMPTS } },
            { status: 'synced', externalBillId: { not: null }, externalBillPaymentId: null },
          ],
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

/** Bills whose approval is complete (approved or auto-approved), for these organisations. */
async function approvedBillIds(organizationIds: string[]): Promise<string[]> {
  if (organizationIds.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT DISTINCT attributes->>'paymentOrderId' AS id FROM approval.approvables
    WHERE type = 'invoice' AND macro_state IN ('approved', 'auto_approved')
      AND organization_id = ANY(${organizationIds}::uuid[])`;
  return rows.map((r) => r.id).filter((id): id is string => Boolean(id));
}

/**
 * Post one approved bill to QuickBooks as a Bill. Idempotent: a bill already
 * posted is skipped, and QuickBooks itself dedupes on the requestid.
 *
 * An organisation without QuickBooks is not an error and leaves no trace. One
 * that is connected but cannot take the bill — a category missing from its
 * chart, no categories at all — records the reason as an error, which lands in
 * the inbox of whoever manages accounting.
 */
export async function syncApprovedBill(paymentOrderId: string): Promise<AccountingSyncOutcome> {
  const order = await prisma.paymentOrder.findUnique({
    where: { paymentOrderId },
    include: { counterparty: true, counterpartyWallet: true, accountingSyncs: { where: { provider: PROVIDER } }, glCoding: true },
  });
  if (!order || order.state === 'draft' || order.state === 'cancelled') return 'skipped';
  const approved = await approvedBillIds([order.organizationId]);
  if (!approved.includes(paymentOrderId)) return 'skipped';
  const existing = order.accountingSyncs[0] ?? null;
  if (existing?.externalBillId) return 'skipped';
  if (existing?.status === 'error' && existing.attempts >= MAX_ATTEMPTS) return 'skipped';

  const qb = await getQuickBooksForOrg(order.organizationId);
  if (!qb) return 'skipped';
  const requestId = `decimal_${paymentOrderId}`;
  const fail = async (message: string): Promise<AccountingSyncOutcome> => {
    await upsertSync(order.organizationId, paymentOrderId, { status: 'error', requestId, error: message, incrementAttempts: true });
    logger.warn('accounting_sync.bill_failed', { organizationId: order.organizationId, paymentOrderId, error: message });
    return 'error';
  };

  // The categories confirmed in review. A bill confirmed before these were
  // recorded gets them now, from what review stored.
  let coding = order.glCoding;
  if (!coding) {
    const { recordReviewCoding } = await import('./gl-coding.js');
    await recordReviewCoding(order.organizationId, paymentOrderId, null).catch(() => null);
    coding = await prisma.paymentOrderGlCoding.findUnique({ where: { paymentOrderId } });
  }
  type Line = { accountId?: string; accountName?: string | null; amount?: number; description?: string | null };
  let lines = (Array.isArray(coding?.lines) ? coding!.lines : []) as Line[];
  const outsideChart = (ls: Line[]) => ls.filter((l) => !l.accountId || l.accountId.startsWith(BUILTIN_ACCOUNT_PREFIX));
  // Categories recorded against the standard list (before QuickBooks was
  // connected) or missing from the chart then: look again against the chart
  // as it is now, so a retry after fixing the chart goes through.
  if (outsideChart(lines).length > 0) {
    const { recordReviewCoding } = await import('./gl-coding.js');
    await recordReviewCoding(order.organizationId, paymentOrderId, null).catch(() => null);
    const again = await prisma.paymentOrderGlCoding.findUnique({ where: { paymentOrderId } });
    if (Array.isArray(again?.lines)) lines = again!.lines as Line[];
  }
  if (lines.length === 0) return fail('No categories were recorded for this bill, so there is nothing to post.');
  const notInChart = outsideChart(lines);
  if (notInChart.length > 0) {
    const names = [...new Set(notInChart.map((l) => l.accountName ?? 'Uncategorized'))];
    return fail(`${names.map((n) => `"${n}"`).join(', ')} ${names.length === 1 ? 'is' : 'are'} not in your QuickBooks chart of accounts. Pick a QuickBooks category on the bill, then retry.`);
  }

  const map = await prisma.accountingAccountMap.findUnique({
    where: { organizationId_provider: { organizationId: order.organizationId, provider: PROVIDER } },
  });
  const billHeader = (coding?.billHeader ?? {}) as { vendorName?: string | null; invoiceNumber?: string | null; billDate?: string | null };
  try {
    const posted = await postBillToQuickBooks(
      qb,
      {
        id: requestId,
        vendorLabel: billHeader.vendorName?.trim() || order.counterparty?.displayName || order.counterpartyWallet.label,
        amountUsdc: Number(order.amountRaw) / 10 ** USDC_DECIMALS,
        invoiceNumber: order.invoiceNumber,
        reference: order.externalReference,
        codedLines: lines.map((l) => ({ accountId: l.accountId!, amount: Number(l.amount) || 0, description: l.description ?? null })),
        docNumber: billHeader.invoiceNumber ?? order.invoiceNumber,
        txnDate: billHeader.billDate ?? null,
      },
      { apAccountId: map?.apAccountId ?? null },
    );
    await upsertSync(order.organizationId, paymentOrderId, {
      status: 'synced', requestId, externalVendorId: posted.vendorId, externalBillId: posted.billId, externalBillPaymentId: null,
      externalBillBalance: posted.billBalance, error: null, syncedAt: new Date(),
    });
    logger.info('accounting_sync.bill_posted', { organizationId: order.organizationId, paymentOrderId, billId: posted.billId });
    return 'synced';
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** A person's "Retry": whichever moment the bill is at. */
export async function syncBillNow(paymentOrderId: string): Promise<AccountingSyncOutcome> {
  const order = await prisma.paymentOrder.findUnique({ where: { paymentOrderId }, select: { state: true } });
  if (!order) return 'skipped';
  return order.state === 'settled' ? syncSettledPaymentOrder(paymentOrderId) : syncApprovedBill(paymentOrderId);
}
