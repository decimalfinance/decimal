// The inbox: what each person has to do, one item per bill.
//
// Familiar ground on purpose — Ramp and Brex both call this the Inbox. An item
// is a bill, and everything wanted of this person on it sits inside that one
// item, so nobody sees the same bill twice:
//
//   - What the SYSTEM needs is derived from state every time, never stored:
//     your approval is waiting, a question was asked of you, a draft needs
//     your review, a bill was sent back. It clears itself when state moves.
//   - What PEOPLE ask ("while you're in there, check the tax line") is stored
//     as a line on the recipient's item (inbox_asks). It closes when they act
//     on the bill, tick it, or the bill is closed.
//
// An item is "new" when anything in it is later than the last time the
// person looked at it (inbox_seen).
import { prisma } from '../infra/prisma.js';
import { badRequest, forbidden, notFound } from '../infra/api-errors.js';
import { getApprovalsInbox, getBillsWorkbench } from '../payments/bills.js';
import { involvedBillIds } from '../payments/bill-visibility.js';
import { getOrgAccess } from '../approvals/permissions.js';

export type InboxLineKind = 'approval' | 'question' | 'review' | 'sign_off' | 'sent_back' | 'unreadable' | 'ask' | 'sync_failed';

export type InboxLine = {
  kind: InboxLineKind;
  text: string;
  at: string;
  /** For an ask: who asked, and the id to tick it off. */
  from?: string | null;
  askId?: string;
};

export type InboxItem = {
  key: string;
  billId: string | null;
  jobId: string | null;
  vendorName: string;
  invoiceNumber: string | null;
  amountUsd: number | null;
  /** Where the bill stands, in the bills list's words. */
  status: string | null;
  dueAt: string | null;
  /** Where to act: the review screen for drafts, the bill for everything else. */
  href: 'draft' | 'bill' | null;
  lines: InboxLine[];
  latestAt: string;
  isNew: boolean;
};

const URGENCY: Record<InboxLineKind, number> = { question: 0, approval: 1, ask: 2, sync_failed: 3, sent_back: 3, review: 4, unreadable: 5, sign_off: 6 };

/**
 * Close asks the recipient has already dealt with: they commented on the bill
 * or did something to it after being asked, or the bill is closed.
 */
async function settleAsks(organizationId: string, userId: string): Promise<void> {
  const open = await prisma.inboxAsk.findMany({
    where: { organizationId, toUserId: userId, status: 'open' },
    select: { askId: true, paymentOrderId: true, createdAt: true },
  });
  if (open.length === 0) return;
  const billIds = [...new Set(open.map((a) => a.paymentOrderId))];
  const [bills, comments, events] = await Promise.all([
    prisma.paymentOrder.findMany({ where: { paymentOrderId: { in: billIds } }, select: { paymentOrderId: true, state: true } }),
    prisma.billComment.findMany({ where: { paymentOrderId: { in: billIds }, authorUserId: userId }, select: { paymentOrderId: true, createdAt: true } }),
    prisma.paymentOrderEvent.findMany({ where: { paymentOrderId: { in: billIds }, actorId: userId }, select: { paymentOrderId: true, createdAt: true } }),
  ]);
  const closedBills = new Set(bills.filter((b) => b.state === 'cancelled' || b.state === 'executed' || b.state === 'settled').map((b) => b.paymentOrderId));
  const lastAct = new Map<string, Date>();
  for (const x of [...comments, ...events]) {
    const was = lastAct.get(x.paymentOrderId);
    if (!was || x.createdAt > was) lastAct.set(x.paymentOrderId, x.createdAt);
  }
  const now = new Date();
  for (const a of open) {
    const reason = closedBills.has(a.paymentOrderId) ? 'bill_closed'
      : (lastAct.get(a.paymentOrderId) ?? new Date(0)) > a.createdAt ? 'acted' : null;
    if (reason) {
      await prisma.inboxAsk.updateMany({ where: { askId: a.askId, status: 'open' }, data: { status: 'done', closedAt: now, closedReason: reason } });
    }
  }
}

export async function getInbox(organizationId: string, viewerUserId: string, opts: { settle?: boolean } = {}) {
  // Tidying closes asks the person already dealt with. A read on someone
  // else's behalf (the companion deciding how an ask would land) must not.
  if (opts.settle !== false) await settleAsks(organizationId, viewerUserId);
  const access = await getOrgAccess(organizationId, viewerUserId);
  const isAdmin = access?.isPrimaryOrAdmin ?? false;
  const canReview = isAdmin || (access?.capabilities.includes('bills.edit') ?? false);

  const [board, approvals, asks, seen] = await Promise.all([
    getBillsWorkbench(organizationId, viewerUserId),
    getApprovalsInbox(organizationId, viewerUserId),
    prisma.inboxAsk.findMany({
      where: { organizationId, toUserId: viewerUserId, status: 'open' },
      orderBy: { createdAt: 'asc' },
      select: { askId: true, paymentOrderId: true, text: true, createdAt: true, fromUserId: true },
    }),
    prisma.inboxSeen.findMany({ where: { organizationId, userId: viewerUserId }, select: { paymentOrderId: true, seenAt: true } }),
  ]);
  const rows = new Map(board.bills.map((b) => [b.paymentOrderId, b]));
  const seenAt = new Map(seen.map((s) => [s.paymentOrderId, s.seenAt]));
  const items = new Map<string, InboxItem>();

  const itemFor = (billId: string, fallback?: { vendor: string; invoice: string | null; amountUsd: number | null }): InboxItem | null => {
    const existing = items.get(billId);
    if (existing) return existing;
    const row = rows.get(billId);
    if (!row && !fallback) return null;
    const item: InboxItem = {
      key: billId,
      billId,
      jobId: row?.invoiceDocumentId ?? null,
      vendorName: row?.vendorName ?? fallback!.vendor,
      invoiceNumber: row?.invoiceNumber ?? fallback!.invoice,
      amountUsd: row?.amountUsd ?? fallback!.amountUsd,
      status: row?.subStatus.text ?? null,
      dueAt: row?.dueAt ? row.dueAt.toISOString() : null,
      href: row?.state === 'draft' ? 'draft' : 'bill',
      lines: [],
      latestAt: new Date(0).toISOString(),
      isNew: false,
    };
    items.set(billId, item);
    return item;
  };
  const add = (item: InboxItem | null, line: InboxLine) => {
    if (!item) return;
    item.lines.push(line);
  };

  // What the approval engine is waiting on this person for.
  for (const w of approvals.waitingOnYou as Array<{ paymentOrderId: string; vendor: string; invoice: string | null; amountUsd: number; overdueDays: number | null; blocked: boolean }>) {
    const row = rows.get(w.paymentOrderId);
    add(itemFor(w.paymentOrderId, { vendor: w.vendor, invoice: w.invoice, amountUsd: w.amountUsd }), {
      kind: 'approval',
      text: w.blocked ? 'Your approval, once the open question is answered' : w.overdueDays ? `Your approval, ${w.overdueDays} ${w.overdueDays === 1 ? 'day' : 'days'} overdue` : 'Your approval',
      at: (row?.createdAt ?? new Date()).toISOString(),
    });
  }
  // Questions asked of this person, which hold the bill until answered.
  for (const q of (approvals.questionsForYou ?? []) as Array<{ paymentOrderId: string; question: string; askedByName: string | null; askedAt: string | Date; vendorName: string; invoiceNumber: string | null; amountUsd: number }>) {
    add(itemFor(q.paymentOrderId, { vendor: q.vendorName, invoice: q.invoiceNumber, amountUsd: q.amountUsd }), {
      kind: 'question',
      text: `${q.askedByName ?? 'Someone'} asked: "${q.question}"`,
      at: new Date(q.askedAt).toISOString(),
      from: q.askedByName,
    });
  }
  // The review pile, for whoever reviews bills.
  if (canReview) {
    for (const b of board.bills) {
      if (b.state === 'draft' && b.companion) {
        add(itemFor(b.paymentOrderId), b.companion.ready
          ? { kind: 'sign_off', text: 'Checked and ready: confirm to send it for approval', at: b.createdAt.toISOString() }
          : { kind: 'review', text: b.companion.reason ?? 'Needs a check', at: b.createdAt.toISOString() });
      } else if (b.bucket === 'needs_attention' && b.subStatus.kind === 'loud') {
        add(itemFor(b.paymentOrderId), { kind: 'sent_back', text: b.subStatus.text, at: b.createdAt.toISOString() });
      }
    }
  }
  // A bill QuickBooks would not take, for whoever manages accounting. It
  // clears itself the moment a retry (or the sweep) gets it through.
  const managesAccounting = isAdmin || (access?.capabilities.includes('accounting.manage') ?? false);
  if (managesAccounting) {
    const failed = await prisma.accountingSync.findMany({
      where: { organizationId, provider: 'quickbooks', status: 'error', paymentOrder: { state: { not: 'cancelled' } } },
      select: { paymentOrderId: true, error: true, updatedAt: true },
    });
    for (const f of failed) {
      add(itemFor(f.paymentOrderId), { kind: 'sync_failed', text: `Couldn't post to QuickBooks: ${f.error ?? 'unknown error'}`, at: f.updatedAt.toISOString() });
    }
  }

  // What people asked, layered onto the same item.
  const names = new Map((await prisma.user.findMany({
    where: { userId: { in: [...new Set(asks.map((a) => a.fromUserId))] } },
    select: { userId: true, displayName: true, email: true },
  })).map((u) => [u.userId, u.displayName?.trim() || u.email]));
  for (const a of asks) {
    const row = rows.get(a.paymentOrderId);
    if (!row) continue; // a bill this person can no longer see
    const from = names.get(a.fromUserId) ?? 'Someone';
    add(itemFor(a.paymentOrderId), { kind: 'ask', text: a.text, at: a.createdAt.toISOString(), from, askId: a.askId });
  }
  // Documents that could not be read have no bill, and still need someone.
  if (canReview) {
    for (const d of board.pending.filter((p) => p.status === 'failed')) {
      items.set(`doc:${d.invoiceDocumentId}`, {
        key: `doc:${d.invoiceDocumentId}`, billId: null, jobId: d.invoiceDocumentId, vendorName: d.filename, invoiceNumber: null, amountUsd: null, status: 'Could not be read', dueAt: null, href: null,
        lines: [{ kind: 'unreadable', text: d.error ?? 'Could not make a bill from this document', at: d.createdAt.toISOString() }],
        latestAt: d.createdAt.toISOString(), isNew: false,
      });
    }
  }

  const list = [...items.values()].map((item) => {
    item.lines.sort((x, y) => URGENCY[x.kind] - URGENCY[y.kind] || x.at.localeCompare(y.at));
    item.latestAt = item.lines.reduce((m, l) => (l.at > m ? l.at : m), item.latestAt);
    const seen = item.billId ? seenAt.get(item.billId) : undefined;
    item.isNew = !seen || item.latestAt > seen.toISOString();
    return item;
  });
  // New first; then what blocks other people (questions, approvals); then the longest wait.
  list.sort((a, b) => Number(b.isNew) - Number(a.isNew)
    || URGENCY[a.lines[0]!.kind] - URGENCY[b.lines[0]!.kind]
    || a.lines[0]!.at.localeCompare(b.lines[0]!.at));
  return { items: list, count: list.length, newCount: list.filter((i) => i.isNew).length };
}

/** Mark this person's item for a bill as seen now. */
export async function markInboxSeen(organizationId: string, userId: string, billId: string) {
  const visible = await involvedBillIds(organizationId, userId);
  const bill = await prisma.paymentOrder.findFirst({ where: { organizationId, paymentOrderId: billId }, select: { paymentOrderId: true } });
  if (!bill || (visible !== null && !visible.has(billId))) throw notFound('No such bill.');
  await prisma.inboxSeen.upsert({
    where: { organizationId_userId_paymentOrderId: { organizationId, userId, paymentOrderId: billId } },
    create: { organizationId, userId, paymentOrderId: billId, seenAt: new Date() },
    update: { seenAt: new Date() },
  });
  return { ok: true };
}

/** Mark every item in this person's inbox as seen. */
export async function markAllInboxSeen(organizationId: string, userId: string) {
  const { items } = await getInbox(organizationId, userId, { settle: false });
  const now = new Date();
  for (const i of items) {
    if (!i.billId) continue;
    await prisma.inboxSeen.upsert({
      where: { organizationId_userId_paymentOrderId: { organizationId, userId, paymentOrderId: i.billId } },
      create: { organizationId, userId, paymentOrderId: i.billId, seenAt: now },
      update: { seenAt: now },
    });
  }
  return { ok: true, marked: items.filter((i) => i.billId).length };
}

/** The recipient ticks an ask off. Nobody else can. */
export async function tickAsk(organizationId: string, userId: string, askId: string) {
  const ask = await prisma.inboxAsk.findFirst({ where: { askId, organizationId, toUserId: userId } });
  if (!ask) throw notFound('No such ask.');
  if (ask.status === 'open') {
    await prisma.inboxAsk.update({ where: { askId }, data: { status: 'done', closedAt: new Date(), closedReason: 'ticked' } });
  }
  return { ok: true };
}

/**
 * Ask a colleague to do something on a bill, without holding it (a question
 * holds it; this does not). Lands as a line on their item for the bill. The
 * same open ask twice is one ask.
 */
export async function nudgeAboutBill(args: {
  organizationId: string;
  fromUserId: string;
  toUserId: string;
  billId: string;
  text: string;
  via: 'person' | 'companion';
}) {
  const text = args.text.replace(/\s+/g, ' ').trim();
  if (text.length < 3) throw badRequest('Say what you are asking for.');
  if (args.toUserId === args.fromUserId) throw badRequest('You cannot nudge yourself.');
  const [bill, member] = await Promise.all([
    prisma.paymentOrder.findFirst({ where: { organizationId: args.organizationId, paymentOrderId: args.billId }, select: { paymentOrderId: true, state: true } }),
    prisma.organizationMembership.findFirst({ where: { organizationId: args.organizationId, userId: args.toUserId, status: 'active' }, select: { userId: true } }),
  ]);
  if (!bill) throw notFound('No such bill.');
  if (!member) throw badRequest('That person is not on this team.');
  if (bill.state === 'cancelled') throw badRequest('This bill is closed.');
  for (const who of [args.fromUserId, args.toUserId]) {
    const visible = await involvedBillIds(args.organizationId, who);
    if (visible !== null && !visible.has(args.billId)) throw forbidden(who === args.fromUserId ? 'You cannot see this bill.' : 'They cannot see this bill.');
  }
  const same = await prisma.inboxAsk.findFirst({
    where: { organizationId: args.organizationId, paymentOrderId: args.billId, toUserId: args.toUserId, status: 'open', text },
  });
  if (same) return { askId: same.askId, created: false };
  const ask = await prisma.inboxAsk.create({
    data: { organizationId: args.organizationId, paymentOrderId: args.billId, toUserId: args.toUserId, fromUserId: args.fromUserId, via: args.via, text: text.slice(0, 500) },
  });
  return { askId: ask.askId, created: true };
}
