// The inbox: what each person has to do, one item per bill.
//
// Familiar ground on purpose — Ramp and Brex both call this the Inbox. An item
// is a bill, and everything wanted of this person on it sits inside that one
// item, so nobody sees the same bill twice:
//
//   - What the SYSTEM needs is derived from state every time, never stored:
//     your approval is waiting, a draft needs your review, a bill was sent
//     back. It clears itself when state moves.
//   - What PEOPLE ask is a question on the bill (bill_questions): one asked of
//     you, until anyone answers it, and the reply to one you asked, until you
//     open the bill after it or act on it. There is no other kind of ask, and
//     nothing to tick off. Nudges were removed on 2026-10-14: once a question
//     stopped holding the bill, the two no longer worked differently, and two
//     kinds of ask only confused people.
//
// Each line says who it comes from (none for what Decimal raises itself),
// what they did, and their own words apart, so a screen can quote them. A
// line is "new" when it is later than the last time the person opened the
// bill (inbox_seen).
import { prisma } from '../infra/prisma.js';
import { notFound } from '../infra/api-errors.js';
import { getApprovalsInbox, getBillsWorkbench } from '../payments/bills.js';
import { involvedBillIds } from '../payments/bill-visibility.js';
import { getOrgAccess } from '../approvals/permissions.js';

export type InboxLineKind = 'approval' | 'question' | 'reply' | 'review' | 'sign_off' | 'sent_back' | 'unreadable' | 'sync_failed';

export type InboxPerson = { name: string; avatarUrl: string | null };

export type InboxLine = {
  kind: InboxLineKind;
  /** The whole line as one sentence, for whatever reads it as text. */
  text: string;
  /** What the line says before any quote: "Zara Okafor asked". */
  lead: string;
  /** Someone's own words, quoted after the lead: a question, an answer, a reason. */
  quote: string | null;
  /** Who it comes from. None for what Decimal raises itself. */
  who: InboxPerson | null;
  at: string;
  /** Later than the last time this person opened the bill. */
  isNew: boolean;
  /** Who asked, for a question; who answered, for a reply. */
  from?: string | null;
  /** For a reply to your question: the question it answers. */
  questionId?: string;
};

export type InboxItem = {
  key: string;
  billId: string | null;
  jobId: string | null;
  vendorName: string;
  /** What the bill is for: its first line, or its memo. */
  description: string | null;
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

const URGENCY: Record<InboxLineKind, number> = { question: 0, reply: 0, approval: 1, sync_failed: 3, sent_back: 3, review: 4, unreadable: 5, sign_off: 6 };

/** A line's own words and the quote apart, and the whole sentence they make. */
function said(lead: string, quote: string | null): { lead: string; quote: string | null; text: string } {
  const words = quote?.trim() || null;
  return { lead, quote: words, text: words ? `${lead}: “${words}”` : lead };
}

/** The first sentence of a message, without its full stop: what fits on a line. */
function firstSentence(text: string): string {
  return text.trim().split(/(?<=[.!?])\s+(?=[A-Z"“])/)[0]!.replace(/[.!]\s*$/, '');
}

/** A file no bill came out of, as one line: whose fault it was, in the Inbox's words. */
export function failedFileLine(error: string | null | undefined): string {
  const words = error?.trim() ?? '';
  if (!words || /fault on our side/.test(words)) return 'Something went wrong while reading it';
  if (/^(No bill could be made from this document|Invoice upload did not create any payment orders)/.test(words)) return 'No bill came out of it';
  return firstSentence(words);
}

/**
 * Mark replies to this person's questions as dealt with once they open the
 * bill after the reply, act on it (a comment or anything they do to it), or
 * the bill is closed. Done does the same by hand.
 */
async function settleReplies(organizationId: string, userId: string): Promise<void> {
  const open = await prisma.billQuestion.findMany({
    where: { organizationId, askedByUserId: userId, answeredAt: { not: null }, askerDoneAt: null },
    select: { billQuestionId: true, paymentOrderId: true, answeredAt: true },
  });
  if (open.length === 0) return;
  const billIds = [...new Set(open.map((q) => q.paymentOrderId))];
  const [bills, comments, events, opened] = await Promise.all([
    prisma.paymentOrder.findMany({ where: { paymentOrderId: { in: billIds } }, select: { paymentOrderId: true, state: true } }),
    prisma.billComment.findMany({ where: { paymentOrderId: { in: billIds }, authorUserId: userId }, select: { paymentOrderId: true, createdAt: true } }),
    prisma.paymentOrderEvent.findMany({ where: { paymentOrderId: { in: billIds }, actorId: userId }, select: { paymentOrderId: true, createdAt: true } }),
    // Opening the bill shows the answer in its thread: that is reading it.
    prisma.inboxSeen.findMany({ where: { organizationId, userId, paymentOrderId: { in: billIds } }, select: { paymentOrderId: true, seenAt: true } }),
  ]);
  const closedBills = new Set(bills.filter((b) => b.state === 'cancelled' || b.state === 'executed' || b.state === 'settled').map((b) => b.paymentOrderId));
  const lastAct = new Map<string, Date>();
  for (const x of [...comments, ...events, ...opened.map((o) => ({ paymentOrderId: o.paymentOrderId, createdAt: o.seenAt }))]) {
    const was = lastAct.get(x.paymentOrderId);
    if (!was || x.createdAt > was) lastAct.set(x.paymentOrderId, x.createdAt);
  }
  const now = new Date();
  for (const q of open) {
    if (closedBills.has(q.paymentOrderId) || (lastAct.get(q.paymentOrderId) ?? new Date(0)) > q.answeredAt!) {
      await prisma.billQuestion.updateMany({ where: { billQuestionId: q.billQuestionId, askerDoneAt: null }, data: { askerDoneAt: now } });
    }
  }
}

export async function getInbox(organizationId: string, viewerUserId: string, opts: { settle?: boolean } = {}) {
  // Tidying closes replies the person already dealt with. A read on someone
  // else's behalf (the companion deciding how an ask would land) must not.
  if (opts.settle !== false) {
    await settleReplies(organizationId, viewerUserId);
  }
  const access = await getOrgAccess(organizationId, viewerUserId);
  const isAdmin = access?.isPrimaryOrAdmin ?? false;
  const canReview = isAdmin || (access?.capabilities.includes('bills.edit') ?? false);

  const [board, approvals, seen, members] = await Promise.all([
    getBillsWorkbench(organizationId, viewerUserId),
    getApprovalsInbox(organizationId, viewerUserId),
    prisma.inboxSeen.findMany({ where: { organizationId, userId: viewerUserId }, select: { paymentOrderId: true, seenAt: true } }),
    prisma.organizationMembership.findMany({
      where: { organizationId },
      select: { user: { select: { userId: true, displayName: true, email: true, avatarUrl: true } } },
    }),
  ]);
  const rows = new Map(board.bills.map((b) => [b.paymentOrderId, b]));
  const seenAt = new Map(seen.map((s) => [s.paymentOrderId, s.seenAt]));
  const items = new Map<string, InboxItem>();

  // A face for whoever a line comes from: by their account where we know it,
  // else by the name the bill recorded (a send-back keeps only the name).
  const people = members.map((m) => ({ userId: m.user.userId, name: m.user.displayName?.trim() || m.user.email, avatarUrl: m.user.avatarUrl }));
  const byUser = new Map(people.map((p) => [p.userId, p]));
  const byName = new Map(people.map((p) => [p.name, p]));
  const personOf = (userId: string | null | undefined, name: string | null | undefined): InboxPerson | null => {
    const known = (userId ? byUser.get(userId) : undefined) ?? (name ? byName.get(name) : undefined);
    if (known) return { name: known.name, avatarUrl: known.avatarUrl };
    return name ? { name, avatarUrl: null } : null;
  };

  const itemFor = (billId: string, fallback?: { vendor: string; invoice: string | null; amountUsd: number | null }): InboxItem | null => {
    const existing = items.get(billId);
    if (existing) return existing;
    const row = rows.get(billId);
    if (!row && !fallback) return null;
    const item: InboxItem = {
      key: billId,
      billId,
      jobId: row?.invoiceDocumentId ?? null,
      // The bill's own row when there is one, even where it is empty: a
      // statement has no invoice number, and falling back to a fallback that
      // was never given crashed the inbox (and every bill note) for it.
      // A bill nothing could be read from is its file until someone types it in.
      vendorName: row ? (row.unreadable ? row.filename ?? row.vendorName : row.vendorName) : fallback!.vendor,
      description: row?.unreadable ? null : row?.description ?? null,
      invoiceNumber: row ? row.invoiceNumber : fallback!.invoice,
      // Nor has it an amount or a due date: the amount it carries holds a place.
      amountUsd: row ? (row.unreadable ? null : row.amountUsd) : fallback!.amountUsd,
      status: row?.subStatus.text ?? null,
      dueAt: row?.dueAt && !row.unreadable ? row.dueAt.toISOString() : null,
      href: row?.state === 'draft' ? 'draft' : 'bill',
      lines: [],
      latestAt: new Date(0).toISOString(),
      isNew: false,
    };
    items.set(billId, item);
    return item;
  };
  const add = (item: InboxItem | null, line: Omit<InboxLine, 'isNew'>) => {
    if (!item) return;
    item.lines.push({ ...line, isNew: false });
  };

  // What the approval engine is waiting on this person for, and who handed
  // it to them: the one who sent it, or the approver just before them.
  type Waiting = { paymentOrderId: string; vendor: string; invoice: string | null; amountUsd: number; handedBy: { kind: 'sent' | 'approved'; name: string; userId: string | null } | null; arrivedAt: string | null };
  for (const w of approvals.waitingOnYou as Waiting[]) {
    const row = rows.get(w.paymentOrderId);
    const by = w.handedBy;
    add(itemFor(w.paymentOrderId, { vendor: w.vendor, invoice: w.invoice, amountUsd: w.amountUsd }), {
      kind: 'approval',
      ...said(!by ? 'Waiting on your approval' : by.kind === 'approved' ? `${by.name} approved it; your step is next` : `${by.name} sent it for your approval`, null),
      who: by ? personOf(by.userId, by.name) : null,
      at: w.arrivedAt ?? (row?.createdAt ?? new Date()).toISOString(),
    });
  }
  // Questions asked of this person, until anyone answers them. A question
  // holds nothing; it waits on them only in the sense that they were asked.
  type Asked = { paymentOrderId: string; question: string; askedByUserId?: string; askedByName: string | null; askedAt: string | Date; vendorName: string; invoiceNumber: string | null; amountUsd: number };
  for (const q of (approvals.questionsForYou ?? []) as Asked[]) {
    const asker = personOf(q.askedByUserId, q.askedByName);
    add(itemFor(q.paymentOrderId, { vendor: q.vendorName, invoice: q.invoiceNumber, amountUsd: q.amountUsd }), {
      kind: 'question',
      ...said(`${asker?.name ?? 'Someone'} asked`, q.question),
      who: asker,
      at: new Date(q.askedAt).toISOString(),
      from: q.askedByName,
    });
  }
  // The team's pile, for whoever reviews bills: what to look at, what was
  // sent back, what is ready to send, what couldn't be read.
  if (canReview) {
    for (const b of board.bills) {
      const at = b.createdAt.toISOString();
      if (b.state === 'draft') {
        if (b.unreadable) {
          add(itemFor(b.paymentOrderId), { kind: 'unreadable', ...said('Nothing could be read off the document', null), who: null, at });
        } else if (b.sentBack) {
          const by = personOf(null, b.sentBackBy?.name);
          add(itemFor(b.paymentOrderId), { kind: 'sent_back', ...said(by ? `${by.name} sent it back` : 'Sent back to review', b.sentBackBy?.reason ?? null), who: by, at });
        } else if (b.companion?.ready) {
          add(itemFor(b.paymentOrderId), { kind: 'sign_off', ...said('Checked and ready to send for approval', null), who: null, at });
        } else {
          add(itemFor(b.paymentOrderId), { kind: 'review', ...said(firstSentence(b.companion?.reason ?? 'Needs a check'), null), who: null, at });
        }
      } else if (b.bucket === 'needs_attention' && b.subStatus.kind === 'loud') {
        // Past review and stuck: a flow with no one to act, a danger flag.
        add(itemFor(b.paymentOrderId), { kind: 'review', ...said(firstSentence(b.subStatus.text), null), who: null, at });
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
      const why = f.error?.trim() ? firstSentence(f.error).replace(/"([^"]*)"/g, '“$1”') : null;
      add(itemFor(f.paymentOrderId), { kind: 'sync_failed', ...said(why ? `QuickBooks refused it: ${why}` : 'QuickBooks refused it', null), who: null, at: f.updatedAt.toISOString() });
    }
  }

  // Replies to what this person asked, until they deal with them. A reply
  // closes the question; this is how the asker hears it.
  const replies = await prisma.billQuestion.findMany({
    where: { organizationId, askedByUserId: viewerUserId, answeredAt: { not: null }, askerDoneAt: null, outcome: { in: ['answered', 'handed_back', 'partial'] } },
    orderBy: { answeredAt: 'asc' },
  });
  if (replies.length > 0) {
    for (const r of replies) {
      if (!rows.get(r.paymentOrderId)) continue; // a bill this person can no longer see
      const person = personOf(r.answeredByUserId ?? r.askedOfUserId, null);
      const by = person?.name ?? 'Someone';
      const answer = (r.answer ?? '').trim();
      // A question settled by something someone did already says who did it.
      const words = r.outcome === 'handed_back' ? said(`${by} couldn’t answer`, answer)
        : answer.startsWith(by) ? said(answer, null)
        : said(`${by} answered`, answer);
      add(itemFor(r.paymentOrderId), { kind: 'reply', ...words, who: person, at: r.answeredAt!.toISOString(), from: by, questionId: r.billQuestionId });
    }
  }
  // Documents that could not be read have no bill, and still need someone.
  if (canReview) {
    for (const d of board.pending.filter((p) => p.status === 'failed')) {
      // A file has no bill to open, so nothing marks it seen: it is never new.
      items.set(`doc:${d.invoiceDocumentId}`, {
        key: `doc:${d.invoiceDocumentId}`, billId: null, jobId: d.invoiceDocumentId, vendorName: d.filename, description: null, invoiceNumber: null, amountUsd: null, status: 'Could not be read', dueAt: null, href: null,
        lines: [{ kind: 'unreadable', ...said(failedFileLine(d.error), null), who: null, at: d.createdAt.toISOString(), isNew: false }],
        latestAt: d.createdAt.toISOString(), isNew: false,
      });
    }
  }

  const list = [...items.values()].map((item) => {
    item.lines.sort((x, y) => URGENCY[x.kind] - URGENCY[y.kind] || x.at.localeCompare(y.at));
    item.latestAt = item.lines.reduce((m, l) => (l.at > m ? l.at : m), item.latestAt);
    const seen = item.billId ? seenAt.get(item.billId) : undefined;
    if (item.billId) {
      for (const line of item.lines) line.isNew = !seen || line.at > seen.toISOString();
    }
    item.isNew = item.lines.some((l) => l.isNew);
    return item;
  });
  // New first; then what blocks other people (questions, approvals); then the longest wait.
  list.sort((a, b) => Number(b.isNew) - Number(a.isNew)
    || URGENCY[a.lines[0]!.kind] - URGENCY[b.lines[0]!.kind]
    || a.lines[0]!.at.localeCompare(b.lines[0]!.at));
  // Counted by line, as the Inbox shows them: one bill can want two things.
  const lines = list.flatMap((i) => i.lines);
  return { items: list, count: lines.length, newCount: lines.filter((l) => l.isNew).length };
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

/** The asker ticks a reply to their question off. Nobody else can. */
export async function tickReply(organizationId: string, userId: string, billQuestionId: string) {
  const question = await prisma.billQuestion.findFirst({ where: { billQuestionId, organizationId, askedByUserId: userId } });
  if (!question) throw notFound('No such reply.');
  if (!question.askerDoneAt) {
    await prisma.billQuestion.update({ where: { billQuestionId }, data: { askerDoneAt: new Date() } });
  }
  return { ok: true };
}
