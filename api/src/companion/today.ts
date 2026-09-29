// The companion's console: what it is working on, what is waiting on you, and
// what is done.
//
// Three columns, because those are the three questions a person has when they
// sit down: is anything still happening, what do I need to do, and what got
// finished without me. Each person sees their own work — a bill clerk the
// review piles, an approver what waits on them, an admin also who is holding
// approvals up. Nothing here decides anything; it reads what the bills list,
// the approvals inbox, the learned habits and the companion's own steps
// already know, and sorts it.
import { prisma } from '../infra/prisma.js';
import { getOrgAccess } from '../approvals/permissions.js';
import { openTasksByPerson } from '../approvals/store.js';
import { getApprovalsInbox, getBillsWorkbench } from '../payments/bills.js';
import { involvedBillIds } from '../payments/bill-visibility.js';
import { closeAbandonedSteps } from './steps.js';

/** A gap longer than this starts a new visit; a refresh within it does not. */
const NEW_VISIT_MS = 30 * 60_000;
/** With no "since" (a first visit), Done and learned habits go back this far. */
const FIRST_VISIT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** A document still "processing" after this long is not running; it is stuck. */
const RUNNING_WINDOW_MS = 15 * 60_000;

/**
 * Open (or continue) this person's visit, returning the moment the console
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

/** The window a visit would report from, without starting or extending one. */
async function peekVisit(organizationId: string, userId: string): Promise<Date | null> {
  const row = await prisma.companionView.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
  return row?.previousSeenAt ?? null;
}

export type RunningCard = {
  jobId: string;
  title: string;
  /** What the companion is doing right now, in its words. */
  step: string;
  startedAt: string;
};

export type WaitingKind = 'approval' | 'input' | 'sent_back' | 'unreadable' | 'sign_off';

export type WaitingCard = {
  key: string;
  kind: WaitingKind;
  jobId: string | null;
  paymentOrderId: string | null;
  title: string;
  invoiceNumber: string | null;
  amountUsd: number | null;
  /** Why it is waiting on this person, in one line. */
  reason: string;
};

export type DoneCard = {
  key: string;
  kind: 'bill' | 'learned';
  jobId: string | null;
  paymentOrderId: string | null;
  title: string;
  invoiceNumber: string | null;
  amountUsd: number | null;
  outcome: string;
  at: string;
};

export async function getCompanionConsole(
  organizationId: string,
  viewerUserId: string,
  now = new Date(),
  /** False when the companion reads the console for a chat: that is not the person looking. */
  opts: { recordVisit?: boolean } = {},
) {
  const [access, since, viewer] = await Promise.all([
    getOrgAccess(organizationId, viewerUserId),
    opts.recordVisit === false ? peekVisit(organizationId, viewerUserId) : openVisit(organizationId, viewerUserId, now),
    prisma.user.findUnique({ where: { userId: viewerUserId }, select: { displayName: true } }),
    closeAbandonedSteps(organizationId),
  ]);
  const isAdmin = access?.isPrimaryOrAdmin ?? false;
  const canReview = isAdmin || (access?.capabilities.includes('bills.edit') ?? false);
  const windowStart = since ?? new Date(now.getTime() - FIRST_VISIT_LOOKBACK_MS);

  const [board, inbox, holding, learnedRules, runningSteps] = await Promise.all([
    canReview ? getBillsWorkbench(organizationId, viewerUserId) : null,
    getApprovalsInbox(organizationId, viewerUserId),
    isAdmin ? openTasksByPerson(prisma, organizationId) : Promise.resolve([]),
    canReview
      ? prisma.vendorCodingRule.findMany({
        where: { organizationId, source: 'learned', updatedAt: { gt: windowStart } },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: { vendorCodingRuleId: true, accountName: true, accountId: true, learnedFromCount: true, updatedAt: true, counterparty: { select: { displayName: true } } },
      })
      : Promise.resolve([]),
    canReview
      ? prisma.companionStep.findMany({
        where: { organizationId, status: 'running' },
        orderBy: { startedAt: 'desc' },
        select: { invoiceDocumentId: true, text: true, startedAt: true },
      })
      : Promise.resolve([]),
  ]);
  const bills = board?.bills ?? [];

  // ── Running: documents being read, and bills being investigated ──────────
  const running = new Map<string, RunningCard>();
  const titleOfJob = new Map<string, string>();
  for (const b of bills) if (b.invoiceDocumentId) titleOfJob.set(b.invoiceDocumentId, b.vendorName);
  for (const s of runningSteps) {
    if (running.has(s.invoiceDocumentId)) continue; // newest step first: that is what it is doing now
    running.set(s.invoiceDocumentId, { jobId: s.invoiceDocumentId, title: titleOfJob.get(s.invoiceDocumentId) ?? 'A new document', step: `${s.text}…`, startedAt: s.startedAt.toISOString() });
  }
  for (const d of board?.pending ?? []) {
    if (d.status !== 'processing' || now.getTime() - d.createdAt.getTime() > RUNNING_WINDOW_MS) continue;
    const card = running.get(d.invoiceDocumentId);
    if (card) card.title = d.filename;
    else running.set(d.invoiceDocumentId, { jobId: d.invoiceDocumentId, title: d.filename, step: 'Starting…', startedAt: d.createdAt.toISOString() });
  }
  const runningJobs = new Set(running.keys());

  // ── Waiting on you ────────────────────────────────────────────────────────
  const waiting: WaitingCard[] = [];
  const inboxRows = inbox.waitingOnYou as Array<{ paymentOrderId: string; vendor: string; invoice: string | null; amountUsd: number; overdueDays: number | null; blocked: boolean }>;
  const jobOfBill = new Map<string, string | null>(bills.map((b) => [b.paymentOrderId, b.invoiceDocumentId]));
  const approvalIds = inboxRows.map((w) => w.paymentOrderId).filter((id) => !jobOfBill.has(id));
  if (approvalIds.length > 0) {
    for (const o of await prisma.paymentOrder.findMany({ where: { organizationId, paymentOrderId: { in: approvalIds } }, select: { paymentOrderId: true, invoiceDocumentId: true } })) {
      jobOfBill.set(o.paymentOrderId, o.invoiceDocumentId);
    }
  }
  for (const w of inboxRows) {
    waiting.push({
      key: `approval:${w.paymentOrderId}`,
      kind: 'approval',
      jobId: jobOfBill.get(w.paymentOrderId) ?? null,
      paymentOrderId: w.paymentOrderId,
      title: w.vendor,
      invoiceNumber: w.invoice,
      amountUsd: w.amountUsd,
      reason: w.blocked ? 'Waiting on an answer to a question' : w.overdueDays ? `Your approval, ${w.overdueDays} ${w.overdueDays === 1 ? 'day' : 'days'} overdue` : 'Your approval',
    });
  }
  // Drafts still being worked on are Running, not waiting: a person should not
  // be asked to judge a bill the companion has not finished looking at.
  const drafts = bills.filter((b) => b.state === 'draft' && b.companion && !(b.invoiceDocumentId && runningJobs.has(b.invoiceDocumentId)));
  const card = (b: (typeof bills)[number], kind: WaitingKind, reason: string): WaitingCard => ({
    key: `${kind}:${b.paymentOrderId}`,
    kind,
    jobId: b.invoiceDocumentId,
    paymentOrderId: b.paymentOrderId,
    title: b.vendorName,
    invoiceNumber: b.invoiceNumber,
    amountUsd: b.amountUsd,
    reason,
  });
  // What needs a person: anything blocked first (it cannot move at all), then
  // the largest amounts, since that is where a mistake costs most.
  const needsInput = drafts
    .filter((b) => !b.companion!.ready)
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.amountUsd - a.amountUsd);
  for (const b of needsInput) waiting.push(card(b, 'input', b.companion!.reason ?? 'Needs a look'));
  for (const b of bills.filter((x) => x.bucket === 'needs_attention')) waiting.push(card(b, 'sent_back', b.subStatus.text));
  for (const d of board?.pending ?? []) {
    if (d.status !== 'failed') continue;
    waiting.push({
      key: `unreadable:${d.invoiceDocumentId}`, kind: 'unreadable', jobId: d.invoiceDocumentId, paymentOrderId: null,
      title: d.filename, invoiceNumber: null, amountUsd: null, reason: d.error ?? 'Could not make a bill from this document',
    });
  }
  for (const b of drafts.filter((x) => x.companion!.ready)) waiting.push(card(b, 'sign_off', 'Checked and ready: confirm to send it for approval'));

  // ── Done: what finished in this window ───────────────────────────────────
  // A bill that came in during the window and has moved past review. Learned
  // habits are the companion's own finished work, so they sit here too.
  const done: DoneCard[] = [];
  const movedOn = canReview
    ? await prisma.paymentOrder.findMany({
      where: { organizationId, updatedAt: { gt: windowStart }, paymentOrderId: { in: bills.filter((b) => b.bucket === 'in_approval' || b.bucket === 'to_pay' || b.bucket === 'done').map((b) => b.paymentOrderId) } },
      select: { paymentOrderId: true, updatedAt: true },
    })
    : [];
  const movedAt = new Map(movedOn.map((o) => [o.paymentOrderId, o.updatedAt]));
  // A bill waiting on this person is theirs to act on, not done — even if
  // someone else's part of it is.
  const stillWaiting = new Set(waiting.map((w) => w.paymentOrderId));
  for (const b of bills) {
    const at = movedAt.get(b.paymentOrderId);
    if (!at || stillWaiting.has(b.paymentOrderId)) continue;
    done.push({
      key: `bill:${b.paymentOrderId}`, kind: 'bill', jobId: b.invoiceDocumentId, paymentOrderId: b.paymentOrderId,
      title: b.vendorName, invoiceNumber: b.invoiceNumber, amountUsd: b.amountUsd,
      outcome: b.bucket === 'in_approval' ? `In approval: ${b.subStatus.text.toLowerCase()}` : b.subStatus.text,
      at: at.toISOString(),
    });
  }
  for (const r of learnedRules) {
    done.push({
      key: `learned:${r.vendorCodingRuleId}`, kind: 'learned', jobId: null, paymentOrderId: null,
      title: r.counterparty.displayName, invoiceNumber: null, amountUsd: null,
      outcome: `Learned: ${r.counterparty.displayName} goes to ${r.accountName ?? r.accountId}, from ${r.learnedFromCount} ${r.learnedFromCount === 1 ? 'bill' : 'bills'}`,
      at: r.updatedAt.toISOString(),
    });
  }
  done.sort((a, b) => b.at.localeCompare(a.at));

  return {
    since: since?.toISOString() ?? null,
    viewer: { name: viewer?.displayName ?? null, canReview, isAdmin },
    running: [...running.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    waiting,
    done: done.slice(0, 30),
    // Who is holding approvals, oldest wait first. Admins only: it is about
    // other people's queues.
    holding: holding.map((h) => ({ name: h.name, openCount: h.openCount, waitingSince: h.waitingSince.toISOString(), isYou: h.userId === viewerUserId })),
  };
}

/**
 * One job, step by step: everything the companion did with a document, in
 * order, and the bills that came out of it.
 *
 * Whoever may see the bills may see the work. A reviewer sees every job; an
 * approver only the jobs behind bills they are involved in.
 */
export async function getCompanionJob(organizationId: string, viewerUserId: string, invoiceDocumentId: string) {
  const doc = await prisma.invoiceDocument.findFirst({
    where: { organizationId, invoiceDocumentId },
    select: { invoiceDocumentId: true, filename: true, status: true, processingError: true, createdAt: true, paymentOrders: { select: { paymentOrderId: true } } },
  });
  if (!doc) return null;
  const visible = await involvedBillIds(organizationId, viewerUserId);
  if (visible !== null && !doc.paymentOrders.some((o) => visible.has(o.paymentOrderId))) return null;

  const steps = await prisma.companionStep.findMany({
    where: { organizationId, invoiceDocumentId },
    orderBy: { startedAt: 'asc' },
    select: { stepId: true, kind: true, status: true, text: true, detail: true, startedAt: true, finishedAt: true, paymentOrderId: true },
  });
  return {
    jobId: doc.invoiceDocumentId,
    filename: doc.filename,
    receivedAt: doc.createdAt.toISOString(),
    running: steps.some((s) => s.status === 'running') || doc.status === 'processing',
    billIds: doc.paymentOrders.map((o) => o.paymentOrderId),
    steps: steps.map((s) => ({
      id: s.stepId,
      kind: s.kind,
      status: s.status as 'running' | 'done' | 'noted' | 'failed',
      text: s.text,
      detail: s.detail,
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt?.toISOString() ?? null,
      paymentOrderId: s.paymentOrderId,
    })),
  };
}
