// Per-bill posting to the team's books + the background sweep, in two moments:
//
//   - APPROVED: the bill is posted to the books the team posts to, QuickBooks or
//     Xero (connections.ts postingTarget), with a line per category confirmed in
//     review. That is when the books learn the money is owed — the standard
//     accounts-payable order. How each system takes it is books-poster.ts.
//   - PAID (settled): a BillPayment is recorded against that Bill, in QuickBooks
//     only: payments are frozen. A bill paid before it was ever posted gets both at
//     once, as it always did.
//
// One accounting_syncs row per bill and system carries both: externalBillId once
// posted, externalBillPaymentId once paid. Idempotent at two layers: the system's
// own (QuickBooks' requestid, Xero's Idempotency-Key) and that unique row. One bill
// goes into one set of books.
//
// Nothing here writes until a person has turned posting on (a setup's Go), and a
// bill approved before that moment is not posted by itself. Connecting alone only
// lets Decimal read.

import type { Prisma } from '@prisma/client';
import { billsApprovedSince } from '../approvals/store.js';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { readOutcome } from '../integrations/setup/outcome.js';
import { xeroIsMadeUp, xeroWriteClientFor } from '../integrations/xero-connector.js';
import { BillGone, PostedUnchecked, quickBooksBooks, type Books } from './books-poster.js';
import { getQuickBooksForOrg, postingEnabledSince, postingTarget, type PostingTarget } from './connections.js';
import { postingDateChoiceOf, postingDateFor } from './closed-period.js';
import { PostedTotalDiffers, recordBillPaymentInQuickBooks, syncPaymentToQuickBooks } from './sync.js';
import { BUILTIN_ACCOUNT_PREFIX } from './default-chart.js';
import { vendorForBill } from './vendor-match.js';
import { xeroBooks } from './xero-books.js';
import { systemName } from '../payments/bill-flags.js';

/** Where paid bills record their payment: QuickBooks only, while payments are frozen. */
const PROVIDER = 'quickbooks';
export const MAX_ATTEMPTS = 5;
const SWEEP_BATCH = 20;
const USDC_DECIMALS = 6;

/** `held`: it may be in the books already, and nothing goes until someone says (books-check.ts). */
export type AccountingSyncOutcome = 'synced' | 'skipped' | 'error' | 'held';

/**
 * Where a bill's posting stands, as the bill's page and the books screen say it. `retrying`:
 * the sweep will try a failed bill again by itself, so nothing promises a retry that isn't coming.
 * `linked`: it was in the books already, entered by hand, and someone said it's the same bill.
 */
export function postingOf(sync: {
  provider: string; status: string; externalBillId: string | null; error: string | null; attempts: number; syncedAt: Date | null; updatedAt: Date; metadataJson: unknown;
}) {
  const at = sync.updatedAt.toISOString();
  // Which books, by name: QuickBooks or Xero.
  const books = systemName(sync.provider);
  if (sync.externalBillId) {
    const meta = sync.metadataJson;
    const linked = typeof meta === 'object' && meta !== null && (meta as Record<string, unknown>).linkedFromBooks === true;
    return { status: 'posted' as const, books, at: (sync.syncedAt ?? sync.updatedAt).toISOString(), error: null, retrying: false, linked };
  }
  if (sync.status === 'error') return { status: 'failed' as const, books, at, error: sync.error, retrying: sync.attempts < MAX_ATTEMPTS, linked: false };
  // It may be in the books already: nothing goes until someone says.
  if (sync.status === 'held') return { status: 'held' as const, books, at, error: sync.error, retrying: false, linked: false };
  return { status: 'pending' as const, books, at, error: sync.error, retrying: false, linked: false };
}

type SyncFields = {
  status: string;
  metadataJson?: Prisma.InputJsonValue;
  requestId?: string;
  externalVendorId?: string | null;
  externalBillId?: string | null;
  externalBillPaymentId?: string | null;
  externalBillBalance?: number | null;
  error?: string | null;
  syncedAt?: Date | null;
  incrementAttempts?: boolean;
};

/** Linked to a bill already in the books rather than posted (books-check.ts). */
function isLinkedFromBooks(metadata: unknown): boolean {
  return typeof metadata === 'object' && metadata !== null && (metadata as Record<string, unknown>).linkedFromBooks === true;
}

async function upsertSync(provider: string, organizationId: string, paymentOrderId: string, fields: SyncFields): Promise<void> {
  const { incrementAttempts, requestId, ...rest } = fields;
  const base = { ...rest, requestId: requestId ?? `decimal_${paymentOrderId}` };
  await prisma.accountingSync.upsert({
    where: { paymentOrderId_provider: { paymentOrderId, provider } },
    create: { organizationId, paymentOrderId, provider, attempts: incrementAttempts ? 1 : 0, ...base },
    update: { ...base, ...(incrementAttempts ? { attempts: { increment: 1 } } : {}) },
  });
}

/**
 * Clear a failed sync's attempt counter so an operator's manual retry actually
 * runs (the sweep gives up at MAX_ATTEMPTS; a deliberate retry should not).
 * Only touches error and held rows — never re-opens a successful sync. A held one
 * looks in the books again: the bill there may have gone.
 */
export async function resetSyncForRetry(paymentOrderId: string): Promise<void> {
  await prisma.accountingSync.updateMany({
    where: { paymentOrderId, status: { in: ['error', 'held'] } },
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

  const since = await postingEnabledSince(order.organizationId);
  if (!since) return 'skipped';
  if (!existing?.externalBillId) {
    const approved = await billsApprovedSince(order.organizationId, since);
    if (!approved.includes(paymentOrderId)) return 'skipped';
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
      await upsertSync(PROVIDER, order.organizationId, paymentOrderId, { status: 'synced', error: `payment not recorded yet: missing ${missing.join(', ')}` });
      return 'skipped';
    }
    await upsertSync(PROVIDER, order.organizationId, paymentOrderId, {
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
      await upsertSync(PROVIDER, order.organizationId, paymentOrderId, {
        status: 'synced', requestId, externalBillPaymentId: paid.billPaymentId, externalBillBalance: paid.billBalance, error: null, syncedAt: new Date(),
      });
      logger.info('accounting_sync.payment_recorded', { organizationId: order.organizationId, paymentOrderId, billPaymentId: paid.billPaymentId });
      return 'synced';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await upsertSync(PROVIDER, order.organizationId, paymentOrderId, { status: 'error', requestId, error: `Recording the payment: ${message}`, incrementAttempts: true });
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
        // The first open day, when one was chosen in review for a closed period (closed-period.ts).
        txnDate: postingDateFor(billHeader.billDate ?? null, postingDateChoiceOf(order.metadataJson)),
      },
      {
        clearingAccountId: map.clearingAccountId,
        // per-payment coded account if the operator set one, else the org default
        defaultExpenseAccountId: order.glCoding?.codedExpenseAccountId ?? map.defaultExpenseAccountId ?? '',
        apAccountId: map.apAccountId,
      },
    );
    await upsertSync(PROVIDER, order.organizationId, paymentOrderId, {
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
    await upsertSync(PROVIDER, order.organizationId, paymentOrderId, {
      status: 'error',
      requestId,
      error: message,
      incrementAttempts: true,
    });
    logger.warn('accounting_sync.failed', { organizationId: order.organizationId, paymentOrderId, error: message });
    return 'error';
  }
}

export type AccountingSweepSummary = { synced: number; skipped: number; error: number; held: number };

/** Find approved bills not in the books yet, and settled payment orders not synced, for connected orgs, and post them. */
export async function sweepUnsyncedSettledOrders(): Promise<AccountingSweepSummary> {
  const summary: AccountingSweepSummary = { synced: 0, skipped: 0, error: 0, held: 0 };

  const connected = await prisma.accountingConnection.findMany({
    where: { status: 'connected', postingEnabledAt: { not: null } },
    select: { organizationId: true, provider: true, postingEnabledAt: true },
  });
  if (connected.length === 0) {
    return summary;
  }

  // Bills approved since posting was turned on and not yet in the books: posted
  // now. Catches a post the approval hook could not make, such as while the
  // connection had lapsed, and retries of one that failed (until MAX_ATTEMPTS; a
  // person can retry). A bill approved before that moment is left alone, and so
  // is one held for an answer: looking again every 30 seconds changes nothing.
  // Per organisation, the books it posts to: the latest yes (postingTarget).
  const targets = new Map<string, { provider: string; since: Date }>();
  for (const c of connected) {
    const seen = targets.get(c.organizationId);
    if (!seen || c.postingEnabledAt! > seen.since) targets.set(c.organizationId, { provider: c.provider, since: c.postingEnabledAt! });
  }
  const approvedFor = new Map<string, string[]>();
  for (const [organizationId, t] of targets) {
    approvedFor.set(t.provider, [...(approvedFor.get(t.provider) ?? []), ...await billsApprovedSince(organizationId, t.since)]);
  }
  for (const [provider, approved] of approvedFor) {
    if (approved.length === 0) continue;
    const due = await prisma.paymentOrder.findMany({
      where: {
        paymentOrderId: { in: approved },
        state: { notIn: ['draft', 'cancelled', 'settled'] },
        // In any books already: one bill goes into one set of books.
        NOT: { accountingSyncs: { some: { OR: [{ externalBillId: { not: null } }, { provider, status: 'error', attempts: { gte: MAX_ATTEMPTS } }, { provider, status: 'held' }] } } },
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

  const orgIds = connected.filter((c) => c.provider === PROVIDER).map((c) => c.organizationId);
  if (orgIds.length === 0) return summary;

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

/** How long a send whose answer never came is replayed with its key. Past it, Decimal looks in the books first. */
const REPLAY_WITHIN_MS = 10 * 60_000;

/** A send to the books whose answer never came, kept on the sync until one does (Books.replaysSends). */
type Sending = { key: string; at: string };

function sendingOf(metadata: unknown): Sending | null {
  const sending = typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>).sending : null;
  if (typeof sending !== 'object' || sending === null) return null;
  const { key, at } = sending as Record<string, unknown>;
  return typeof key === 'string' && typeof at === 'string' ? { key, at } : null;
}

/** The books a team posts to, ready to post: null while there's no live sign-in to post through. */
async function booksFor(organizationId: string, target: PostingTarget): Promise<Books | null> {
  if (target.system === 'quickbooks') {
    const qb = await getQuickBooksForOrg(organizationId);
    if (!qb) return null;
    const map = await prisma.accountingAccountMap.findUnique({
      where: { organizationId_provider: { organizationId, provider: 'quickbooks' } },
      select: { apAccountId: true },
    });
    return quickBooksBooks(qb, map?.apAccountId ?? null);
  }
  if (target.system === 'xero') {
    const client = await xeroWriteClientFor(organizationId);
    return client ? xeroBooks(client) : null;
  }
  return null;
}

/**
 * Post one approved bill to the team's books: QuickBooks as a Bill, Xero as a bill
 * awaiting payment. Idempotent: a bill already posted is skipped, and the system
 * itself dedupes a send made twice.
 *
 * An organisation without books is not an error and leaves no trace, and neither
 * is one that hasn't turned posting on, or a bill approved before it did. One that
 * is connected but cannot take the bill — a category missing from its chart, no
 * categories at all — records the reason as an error, which lands in the inbox of
 * whoever manages accounting.
 */
export async function syncApprovedBill(paymentOrderId: string): Promise<AccountingSyncOutcome> {
  const order = await prisma.paymentOrder.findUnique({
    where: { paymentOrderId },
    include: { counterparty: true, counterpartyWallet: true, accountingSyncs: true, glCoding: true },
  });
  if (!order || order.state === 'draft' || order.state === 'cancelled') return 'skipped';
  const target = await postingTarget(order.organizationId);
  if (!target) return 'skipped';
  const approved = await billsApprovedSince(order.organizationId, target.since);
  if (!approved.includes(paymentOrderId)) return 'skipped';
  // One bill goes into one set of books: a team that moved keeps what it posted where it posted it.
  if (order.accountingSyncs.some((s) => s.provider !== target.system && s.externalBillId)) return 'skipped';
  const existing = order.accountingSyncs.find((s) => s.provider === target.system) ?? null;
  if (existing?.externalBillId && existing.status === 'synced') return 'skipped';
  if (existing?.status === 'error' && existing.attempts >= MAX_ATTEMPTS) return 'skipped';

  const system = target.system;
  const requestId = `decimal_${paymentOrderId}`;
  const save = (fields: SyncFields) => upsertSync(system, order.organizationId, paymentOrderId, fields);
  const fail = async (message: string, metadataJson?: Prisma.InputJsonValue): Promise<AccountingSyncOutcome> => {
    await save({ status: 'error', requestId, error: message, incrementAttempts: true, ...(metadataJson ? { metadataJson } : {}) });
    logger.warn('accounting_sync.bill_failed', { organizationId: order.organizationId, paymentOrderId, system, error: message });
    return 'error';
  };
  const books = await booksFor(order.organizationId, target);
  if (!books) {
    // The bench's made-up Xero organisation has no Xero behind it. Said, rather than left waiting.
    if (system === 'xero' && await xeroIsMadeUp(order.organizationId)) {
      return fail('This team’s Xero is the bench’s made-up organisation, which nothing posts to. Sign in to a real Xero organisation to post.');
    }
    return 'skipped';
  }
  const { label } = books;
  const approvedCents = (order.amountRaw + 5_000n) / 10_000n;

  // In the books already, with a total that didn't match: a retry looks again.
  if (existing?.externalBillId) {
    try {
      const after = await books.readBack(existing.externalBillId);
      if (after.cents !== approvedCents) {
        throw new PostedTotalDiffers(existing.externalVendorId ?? '', existing.externalBillId, after.cents, approvedCents, label, after.shownAs);
      }
      await save({ status: 'synced', requestId, externalBillBalance: after.balance, error: null, syncedAt: new Date() });
      return 'synced';
    } catch (error) {
      // Linked to a bill someone entered there by hand, and since deleted it: unlinked,
      // so the next try looks in the books again (books-check.ts) and posts or asks.
      const linked = isLinkedFromBooks(existing.metadataJson);
      if (linked && error instanceof BillGone) {
        await save({
          status: 'error', requestId, externalBillId: null, externalVendorId: null, metadataJson: {}, incrementAttempts: true,
          error: `The bill in ${label} this was linked to has been ${system === 'xero' ? 'deleted or voided' : 'deleted'} there, so it isn't linked any more. Decimal will look in ${label} again.`,
        });
        logger.warn('accounting_sync.linked_bill_gone', { organizationId: order.organizationId, paymentOrderId, system, billId: existing.externalBillId });
        return 'error';
      }
      return fail(books.plainReason(error));
    }
  }

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
  // Categories recorded against the standard list (before the books were
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
    return fail(`${names.map((n) => `"${n}"`).join(', ')} ${names.length === 1 ? 'is' : 'are'} not in your ${label} chart of accounts. Pick a ${label} category on the bill, then retry.`);
  }

  const billHeader = (coding?.billHeader ?? {}) as { vendorName?: string | null; invoiceNumber?: string | null; billDate?: string | null };
  const vendorLabel = billHeader.vendorName?.trim() || order.counterparty?.displayName || order.counterpartyWallet.label;
  const outcome = await readOutcome(order.organizationId, system, books.companyId);
  // A send whose answer never came, a moment ago: sent again with its key, so a bill
  // that landed comes back rather than a second. The look in the books was made
  // before it, and finding the bill that landed would only hold it as someone else's.
  const sending = books.replaysSends ? sendingOf(existing?.metadataJson) : null;
  const replay = sending !== null && Date.now() - Date.parse(sending.at) < REPLAY_WITHIN_MS;
  let sent: Sending | null = null;
  try {
    // Its figures are that currency's. Posted as they are, they'd read as dollars.
    const { amountsOfBill, currencyOfBill } = await import('../payments/bills.js');
    const currency = currencyOfBill(order.metadataJson);
    if (currency !== 'USD') {
      return await fail(`This bill is in ${currency}, and Decimal posts in USD only. Enter it in ${label} by hand.`);
    }
    // A closed period stays closed, whether or not the books would only have warned. A
    // bill chosen in review to post on the first open day (closed-period.ts) posts dated
    // that day while it still has the date it was chosen for, and keeps its own date.
    const billDate = billHeader.billDate?.trim() || null;
    const postOn = postingDateFor(billDate, postingDateChoiceOf(order.metadataJson));
    const closed = postOn ? await books.closedThrough(outcome) : null;
    if (postOn && closed && postOn <= closed) {
      return await fail(`This bill is dated ${billDate}${postOn !== billDate ? ` (to post on ${postOn})` : ''}, and the books are closed through ${closed}. Send it back to post it in the open period, or reopen the period in ${label}, then retry.`);
    }
    const vendor = await vendorForBill(order.organizationId, system, books.companyId, vendorLabel, outcome) ?? await books.vendorNamed(vendorLabel);
    if (vendor && 'problem' in vendor) return await fail(vendor.problem);

    const docNumber = billHeader.invoiceNumber ?? order.invoiceNumber;
    if (!replay) {
      // Is it in the books already? Neither system minds the same bill twice, so
      // look, live, right before posting (books-check.ts).
      const { checkBeforePosting, knownVendorIds } = await import('./books-check.js');
      const vendorIds = await knownVendorIds(order.organizationId, { system, companyId: books.companyId }, vendorLabel, order.counterpartyId);
      const inBooks = await checkBeforePosting({
        organizationId: order.organizationId,
        paymentOrderId,
        reader: books.reader,
        bill: {
          vendorName: vendorLabel,
          vendorIds: [...new Set([...(vendor?.vendorId ? [vendor.vendorId] : []), ...vendorIds])],
          number: docNumber,
          totalMinor: approvedCents,
          currency,
          date: billDate,
        },
      });
      if (inBooks.kind === 'held') {
        // The vendor found for it is kept, so the look made when the bill is opened looks
        // for this vendor too (knownVendorIds): without it, a contact found only by name
        // here is one that look can't know, so it looks again and can't find what held it.
        await save({ status: 'held', requestId, error: inBooks.message, ...(vendor?.vendorId ? { externalVendorId: vendor.vendorId } : {}) });
        logger.info('accounting_sync.bill_held', { organizationId: order.organizationId, paymentOrderId, system });
        return 'held';
      }
      if (inBooks.kind === 'same') {
        // A person said it is that bill: link to it rather than post, then check it
        // the way a posted bill is checked, its total against the approved one.
        await save({
          status: 'pending', requestId, externalVendorId: inBooks.vendorId, externalBillId: inBooks.recordId, externalBillPaymentId: null,
          error: null, metadataJson: { linkedFromBooks: true, number: inBooks.number },
        });
        logger.info('accounting_sync.bill_linked', { organizationId: order.organizationId, paymentOrderId, system, billId: inBooks.recordId });
        return await syncApprovedBill(paymentOrderId);
      }
    }

    // Kept until an answer comes, for a system that replays a send (above).
    if (books.replaysSends) {
      sent = replay ? sending : { key: `${requestId}_bill_${Date.now().toString(36)}`, at: new Date().toISOString() };
      await save({ status: 'pending', requestId, metadataJson: { sending: sent } });
    }
    const posted = await books.post({
      id: requestId,
      vendorLabel,
      vendorId: vendor?.vendorId ?? null,
      amountUsdc: Number(approvedCents) / 100,
      invoiceNumber: order.invoiceNumber,
      reference: order.externalReference,
      codedLines: lines.map((l) => ({ accountId: l.accountId!, amount: Number(l.amount) || 0, description: l.description ?? null })),
      taxAmount: amountsOfBill(order.metadataJson).tax,
      docNumber,
      txnDate: postOn,
      dueDate: order.dueAt?.toISOString().slice(0, 10) ?? null,
      note: postOn !== billDate ? `Invoice dated ${billDate}. Posted on ${postOn}, the first open day: the books were closed through its date.` : null,
    }, sent?.key ?? `${requestId}_bill`);
    await save({
      status: 'synced', requestId, externalVendorId: posted.vendorId, externalBillId: posted.billId, externalBillPaymentId: null,
      externalBillBalance: posted.billBalance, error: null, syncedAt: new Date(), ...(sent ? { metadataJson: {} } : {}),
    });
    logger.info('accounting_sync.bill_posted', { organizationId: order.organizationId, paymentOrderId, system, billId: posted.billId });
    await attachInvoice(books, order.organizationId, paymentOrderId, order.invoiceDocumentId, posted.billId);
    return 'synced';
  } catch (error) {
    if (error instanceof PostedTotalDiffers || error instanceof PostedUnchecked) {
      // It is in the books, so it must never post again. A person looks at it.
      await save({
        status: 'error', requestId, externalVendorId: error.vendorId, externalBillId: error.billId, externalBillPaymentId: null,
        error: error.message, incrementAttempts: true, ...(sent ? { metadataJson: {} } : {}),
      });
      logger.warn('accounting_sync.posted_total_differs', { organizationId: order.organizationId, paymentOrderId, system, billId: error.billId });
      return 'error';
    }
    // Sent, and no answer came: it may be there, so the next try sends it again with
    // its key. Xero answered, so nothing was made: the next try gets a key of its own.
    if (sent) return fail(books.plainReason(error), books.mayHaveLanded(error) ? { sending: sent } : {});
    return fail(books.plainReason(error));
  }
}

/** What both systems take as an attachment, of the files Decimal reads. QuickBooks has no WebP. */
const ATTACHABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif']);

/**
 * The invoice goes on the bill in the books, the way a bookkeeper staples it on. Only on
 * a bill Decimal posted: one linked from the books is somebody's own entry, with whatever
 * they attached. Best effort, because the bill is in the books already: if the books won't
 * take the file, the reason is kept on the sync and the posting stands. Once only, since a
 * posted bill is never posted again.
 */
async function attachInvoice(books: Books, organizationId: string, paymentOrderId: string, invoiceDocumentId: string | null, billId: string): Promise<void> {
  if (!invoiceDocumentId) return;
  const doc = await prisma.invoiceDocument.findUnique({ where: { invoiceDocumentId }, select: { filename: true, mimeType: true, data: true } });
  if (!doc || !ATTACHABLE.has(doc.mimeType)) return;
  const where = { paymentOrderId_provider: { paymentOrderId, provider: books.system } };
  try {
    const attachmentId = await books.attach(billId, { fileName: doc.filename, contentType: doc.mimeType, bytes: Buffer.from(doc.data) });
    await prisma.accountingSync.update({ where, data: { metadataJson: { attachmentId } } });
    logger.info('accounting_sync.invoice_attached', { organizationId, paymentOrderId, system: books.system, billId, attachmentId });
  } catch (error) {
    const reason = books.plainReason(error);
    await prisma.accountingSync.update({ where, data: { metadataJson: { attachmentFailed: reason } } }).catch(() => null);
    logger.warn('accounting_sync.invoice_not_attached', { organizationId, paymentOrderId, system: books.system, billId, error: reason });
  }
}

/** A person's "Retry": whichever moment the bill is at. */
export async function syncBillNow(paymentOrderId: string): Promise<AccountingSyncOutcome> {
  const order = await prisma.paymentOrder.findUnique({ where: { paymentOrderId }, select: { state: true } });
  if (!order) return 'skipped';
  return order.state === 'settled' ? syncSettledPaymentOrder(paymentOrderId) : syncApprovedBill(paymentOrderId);
}
