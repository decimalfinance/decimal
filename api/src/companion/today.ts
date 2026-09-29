// The companion's briefing: what happened since you last looked, and what is
// left that genuinely needs you.
//
// Each person sees their own work. A bill clerk sees what came in and what is
// ready or not; an approver sees what is waiting on them; an admin also sees
// who is holding approvals up. Nothing here decides anything — it reads what
// the bills list, the approvals inbox and the learned vendor habits already
// know, and puts it in the order a person should act on it.
import { prisma } from '../infra/prisma.js';
import { getOrgAccess } from '../approvals/permissions.js';
import { openTasksByPerson } from '../approvals/store.js';
import { getApprovalsInbox, getBillsWorkbench } from '../payments/bills.js';

/** A gap longer than this starts a new visit; a refresh within it does not. */
const NEW_VISIT_MS = 30 * 60_000;
/** On a first visit there is no "since", so learned habits go back this far. */
const FIRST_VISIT_LOOKBACK_MS = 14 * 24 * 60 * 60_000;

/**
 * Open (or continue) this person's visit, returning the moment the briefing
 * reports from. Null on a first visit. Refreshing within half an hour keeps
 * the same window, so what someone is reading does not vanish when they reload.
 */
export async function openVisit(organizationId: string, userId: string, now = new Date()): Promise<Date | null> {
  const key = { organizationId_userId: { organizationId, userId } };
  const row = await prisma.companionView.findUnique({ where: key });
  if (!row) {
    await prisma.companionView.upsert({
      where: key,
      create: { organizationId, userId, previousSeenAt: null, lastSeenAt: now },
      update: { lastSeenAt: now },
    });
    return null;
  }
  if (now.getTime() - row.lastSeenAt.getTime() > NEW_VISIT_MS) {
    await prisma.companionView.update({ where: key, data: { previousSeenAt: row.lastSeenAt, lastSeenAt: now } });
    return row.lastSeenAt;
  }
  await prisma.companionView.update({ where: key, data: { lastSeenAt: now } });
  return row.previousSeenAt;
}

type BriefBill = {
  paymentOrderId: string;
  vendorName: string;
  invoiceNumber: string | null;
  amountUsd: number;
  dueAt: Date | null;
  reason: string | null;
};

export async function getCompanionToday(organizationId: string, viewerUserId: string, now = new Date()) {
  const [access, since, viewer] = await Promise.all([
    getOrgAccess(organizationId, viewerUserId),
    openVisit(organizationId, viewerUserId, now),
    prisma.user.findUnique({ where: { userId: viewerUserId }, select: { displayName: true } }),
  ]);
  const isAdmin = access?.isPrimaryOrAdmin ?? false;
  const canReview = isAdmin || (access?.capabilities.includes('bills.edit') ?? false);

  const [board, inbox, holding, learnedRules] = await Promise.all([
    canReview ? getBillsWorkbench(organizationId, viewerUserId) : null,
    getApprovalsInbox(organizationId, viewerUserId),
    isAdmin ? openTasksByPerson(prisma, organizationId) : Promise.resolve([]),
    canReview
      ? prisma.vendorCodingRule.findMany({
        where: {
          organizationId,
          source: 'learned',
          updatedAt: { gt: since ?? new Date(now.getTime() - FIRST_VISIT_LOOKBACK_MS) },
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: { vendorCodingRuleId: true, accountName: true, accountId: true, learnedFromCount: true, updatedAt: true, counterparty: { select: { displayName: true } } },
      })
      : Promise.resolve([]),
  ]);

  const drafts = (board?.bills ?? []).filter((b) => b.state === 'draft' && b.companion);
  const brief = (b: (typeof drafts)[number]): BriefBill => ({
    paymentOrderId: b.paymentOrderId,
    vendorName: b.vendorName,
    invoiceNumber: b.invoiceNumber,
    amountUsd: b.amountUsd,
    dueAt: b.dueAt,
    reason: b.companion?.reason ?? null,
  });
  const ready = drafts.filter((b) => b.companion!.ready);
  // What needs a person: anything blocked first (it cannot move at all), then
  // the largest amounts, since that is where a mistake costs most.
  const needsYou = drafts
    .filter((b) => !b.companion!.ready)
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.amountUsd - a.amountUsd);
  const arrived = (board?.bills ?? []).filter((b) => !since || b.createdAt > since);

  return {
    since: since?.toISOString() ?? null,
    viewer: { name: viewer?.displayName ?? null, canReview, isAdmin },
    arrived: {
      count: arrived.length,
      ready: arrived.filter((b) => b.companion?.ready).length,
      stillReading: board?.pending.length ?? 0,
    },
    ready: ready.map(brief),
    needsYou: needsYou.map(brief),
    waitingOnYou: (inbox.waitingOnYou as Array<{ paymentOrderId: string; vendor: string; invoice: string | null; amountUsd: number; overdueDays: number | null; blocked: boolean }>)
      .map((w) => ({ paymentOrderId: w.paymentOrderId, vendorName: w.vendor, invoiceNumber: w.invoice, amountUsd: w.amountUsd, overdueDays: w.overdueDays, blocked: w.blocked })),
    // Who is holding approvals, oldest wait first. Admins only: it is about
    // other people's queues.
    holding: holding.map((h) => ({ name: h.name, openCount: h.openCount, waitingSince: h.waitingSince.toISOString(), isYou: h.userId === viewerUserId })),
    learned: learnedRules.map((r) => ({
      id: r.vendorCodingRuleId,
      vendorName: r.counterparty.displayName,
      category: r.accountName ?? r.accountId,
      fromBills: r.learnedFromCount,
      at: r.updatedAt.toISOString(),
    })),
  };
}
