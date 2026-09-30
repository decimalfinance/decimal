// Action cards: what the companion may PROPOSE, never do.
//
// The model names a kind and a bill. Everything else is decided here, in code,
// against the bill as it is right now: whether the action fits at all, what the
// card says, and the exact request its button will send. The request is the
// same endpoint the bill screen uses, called as the person who clicks, so the
// card can never do more than they could do by hand — every permission check
// and every gate runs at the click. A proposal that does not fit is dropped.
import { randomUUID } from 'node:crypto';
import { getOrgAccess } from '../approvals/permissions.js';
import { getApprovalsInbox, getBillsWorkbench } from '../payments/bills.js';
import { logger } from '../infra/logger.js';
import { usd } from './chat-tools.js';
import { getMembersAndRoles } from '../approvals/roles.js';
import { involvedBillIds } from '../payments/bill-visibility.js';
import { classifyAsk } from './ask-classifier.js';
import { getInbox } from './inbox.js';
import { resolveCategory } from './knowledge.js';
import { prisma } from '../infra/prisma.js';

/** Cards in one answer: enough to tidy a batch, few enough to read. */
const MAX_CARDS = 12;

export const ACTION_KINDS = ['send_for_approval', 'close_duplicate', 'clear_duplicate', 'approve', 'ask_person', 'save_habit', 'forget_habit'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/**
 * What a card turns out to be. ask_person becomes a nudge (does not hold the
 * bill), a question (holds it until answered), or already_asked (nothing to
 * send: the person already has it in their inbox).
 */
export type CardKind = Exclude<ActionKind, 'ask_person'> | 'nudge' | 'question' | 'already_asked';

export type ProposedAction = { kind: ActionKind; billId: string; reason: string; toPerson?: string | null; message?: string | null; category?: string | null };

export type ActionCard = {
  actionId: string;
  kind: CardKind;
  billId: string;
  title: string;
  detail: string;
  /** Why, in the companion's words — also what gets recorded with the action. */
  reason: string | null;
  button: string;
  /** The request the button sends, relative to /organizations/:orgId. Built here, never by the model. */
  call: { path: string; body: Record<string, unknown>; method?: 'POST' | 'PUT' | 'DELETE' };
  /** info: nothing to click (already_asked). */
  status: 'proposed' | 'done' | 'failed' | 'info';
  result: string | null;
};

/** How each kind reads on a card. */
const COPY: Record<CardKind, { verb: string; button: string; done: string }> = {
  send_for_approval: { verb: 'Send for approval', button: 'Send for approval', done: 'Sent for approval' },
  close_duplicate: { verb: 'Close as a duplicate', button: 'Close as duplicate', done: 'Closed as a duplicate' },
  clear_duplicate: { verb: 'Clear the duplicate flag', button: 'Clear the flag', done: 'Duplicate flag cleared' },
  approve: { verb: 'Approve', button: 'Approve', done: 'Approved' },
  nudge: { verb: 'Nudge', button: 'Send nudge', done: 'Nudge sent' },
  question: { verb: 'Ask', button: 'Ask (holds the bill)', done: 'Question sent' },
  already_asked: { verb: 'Already asked', button: '', done: '' },
  save_habit: { verb: 'Remember', button: 'Remember this', done: 'Remembered' },
  forget_habit: { verb: 'Forget', button: 'Forget it', done: 'Forgotten' },
};

export function doneText(kind: CardKind): string {
  return COPY[kind].done;
}

/**
 * Turn the model's proposals into cards, keeping only those that fit the bill
 * as it is now and that this person could carry out.
 */
export async function buildActionCards(args: {
  organizationId: string;
  viewerUserId: string;
  proposals: ProposedAction[];
  /** Bills a tool returned in this answer; a card may only be about one of them. */
  seen: Set<string>;
}): Promise<ActionCard[]> {
  // Every proposal is judged; only the cards are capped. Capping proposals
  // first let a model's invalid ones crowd out the valid ones behind them.
  const proposals = args.proposals.filter((p) => args.seen.has(p.billId)).slice(0, 200);
  if (proposals.length === 0) return [];
  const [board, inbox, access] = await Promise.all([
    getBillsWorkbench(args.organizationId, args.viewerUserId),
    getApprovalsInbox(args.organizationId, args.viewerUserId),
    getOrgAccess(args.organizationId, args.viewerUserId),
  ]);
  const isAdmin = access?.isPrimaryOrAdmin ?? false;
  const canEdit = isAdmin || (access?.capabilities.includes('bills.edit') ?? false);
  const rows = new Map(board.bills.map((b) => [b.paymentOrderId, b]));
  const tasks = new Map((inbox.waitingOnYou as Array<{ paymentOrderId: string; taskId: string; blocked?: boolean }>).map((w) => [w.paymentOrderId, w]));
  const cards: ActionCard[] = [];
  const once = new Set<string>();

  for (const p of proposals) {
    let key = `${p.kind}:${p.billId}`;
    if (once.has(key)) continue;
    const row = rows.get(p.billId);
    if (!row) continue;
    const name = `${row.vendorName}${row.invoiceNumber ? ` ${row.invoiceNumber}` : ''}`;
    const reason = p.reason.trim().slice(0, 300) || null;
    const hasDuplicateFlag = row.flags.some((f) => f.kind === 'possible_duplicate');
    let call: ActionCard['call'] | null = null;
    let detail = `${usd(row.amountUsd)} · ${row.subStatus.text}`;
    let cardKind: CardKind = p.kind === 'ask_person' ? 'nudge' : p.kind;
    let title = `${COPY[cardKind].verb}: ${name}`;
    let status: ActionCard['status'] = 'proposed';

    switch (p.kind) {
      case 'save_habit':
      case 'forget_habit': {
        // Habits belong to whoever codes bills: bill clerks and admins.
        if (!canEdit) break;
        const vendor = await prisma.paymentOrder.findUnique({ where: { paymentOrderId: row.paymentOrderId }, select: { counterpartyId: true } });
        if (!vendor?.counterpartyId) break;
        const current = await prisma.vendorCodingRule.findFirst({ where: { organizationId: args.organizationId, counterpartyId: vendor.counterpartyId } });
        key = `${p.kind}:${vendor.counterpartyId}`;
        if (once.has(key)) break;
        if (p.kind === 'forget_habit') {
          if (!current) break;
          title = `Forget: ${row.vendorName} goes to ${current.accountName ?? current.accountId}`;
          detail = 'New bills from this vendor stop being pre-filled; drafts nobody saved are re-coded; confirmed bills keep what was confirmed.';
          call = { method: 'DELETE', path: `/knowledge/habits/${vendor.counterpartyId}`, body: {} };
        } else {
          const account = await resolveCategory(args.organizationId, p.category ?? '');
          if (!account) break;
          if (current && (current.accountName === account.name || current.accountId === account.id)) break;
          title = `Remember: ${row.vendorName} goes to ${account.name}`;
          detail = current
            ? `Replaces ${current.accountName ?? current.accountId}. New bills from this vendor are pre-filled with it.`
            : 'New bills from this vendor are pre-filled with it.';
          call = { method: 'PUT', path: '/knowledge/habits', body: { counterpartyId: vendor.counterpartyId, category: account.name } };
        }
        break;
      }
      case 'ask_person': {
        // Who, whether they can see the bill, and how it lands in their inbox.
        const message = (p.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
        const person = message.length >= 3 ? await resolvePerson(args.organizationId, p.toPerson ?? '') : null;
        if (!person || person.userId === args.viewerUserId) break;
        // One ask per person per bill in an answer, however the name was written.
        key = `ask:${row.paymentOrderId}:${person.userId}`;
        if (once.has(key)) break;
        const visible = await involvedBillIds(args.organizationId, person.userId);
        if (visible !== null && !visible.has(row.paymentOrderId)) break;
        // Read-only: deciding how an ask would land must not tidy their inbox.
        const theirs = (await getInbox(args.organizationId, person.userId, { settle: false })).items.find((i) => i.billId === row.paymentOrderId);
        const existing = (theirs?.lines ?? []).map((l) => (l.kind === 'ask' ? `${l.from ?? 'Someone'} asked: ${l.text}` : l.text));
        const decision = await classifyAsk({ recipientName: person.name, billLabel: name, existing, message });
        if (decision.decision === 'covered') {
          cardKind = 'already_asked';
          title = `${person.name} already has this: ${name}`;
          detail = decision.note;
          status = 'info';
          call = { path: '', body: {} };
        } else if (decision.decision === 'needs_answer') {
          cardKind = 'question';
          title = `Ask ${person.name}: ${name}`;
          detail = `"${message}" · ${decision.note}`;
          call = { path: `/bills/${row.paymentOrderId}/ask`, body: { askedOfUserId: person.userId, question: message } };
        } else {
          cardKind = 'nudge';
          title = `Nudge ${person.name}: ${name}`;
          detail = `"${message}" · doesn't hold the bill`;
          call = { path: '/inbox/nudge', body: { billId: row.paymentOrderId, toUserId: person.userId, text: message } };
        }
        break;
      }
      case 'send_for_approval':
        // Only a draft the companion rates ready: anything that needs a look is
        // looked at on the bill.
        // And only for someone whose job it is: a viewer or an approver would
        // be shown a button the server then refuses.
        if (canEdit && row.state === 'draft' && row.companion?.ready) {
          call = { path: `/bills/${row.paymentOrderId}/confirm-as-read`, body: {} };
          detail = `${usd(row.amountUsd)} · checked and ready, sent exactly as read`;
        }
        break;
      case 'close_duplicate':
        if (isAdmin && row.state === 'draft' && hasDuplicateFlag && reason) {
          call = { path: `/bills/${row.paymentOrderId}/not-a-bill`, body: { reason: 'duplicate', note: reason } };
        }
        break;
      case 'clear_duplicate':
        if (isAdmin && hasDuplicateFlag && reason && reason.length >= 3) {
          call = { path: `/bills/${row.paymentOrderId}/duplicate-override`, body: { reason } };
        }
        break;
      case 'approve': {
        const task = tasks.get(row.paymentOrderId);
        if (task && !task.blocked) {
          // The idempotency key is fixed when the card is made, so a double
          // click, or a retry after a dropped connection, approves once.
          call = { path: `/approvals/tasks/${task.taskId}/command`, body: { command: { kind: 'approve' }, idempotencyKey: randomUUID() } };
        }
        break;
      }
    }
    if (!call) {
      // Worth seeing: a proposal the model made that the bill does not allow.
      logger.info('companion_action.dropped', { kind: p.kind, billId: p.billId, state: row.state, ready: row.companion?.ready ?? null, isAdmin, canEdit });
      continue;
    }
    once.add(key);
    if (cards.length >= MAX_CARDS) break;
    cards.push({
      actionId: randomUUID(),
      kind: cardKind,
      billId: row.paymentOrderId,
      title,
      detail,
      reason,
      button: COPY[cardKind].button,
      call,
      status,
      result: null,
    });
  }
  return cards;
}

/**
 * A teammate named by the model: an exact name, then a unique first name, then
 * a unique email. Ambiguous or unknown names match no one — a card must never
 * go to the wrong person.
 */
async function resolvePerson(organizationId: string, query: string): Promise<{ userId: string; name: string } | null> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return null;
  const { members } = await getMembersAndRoles(organizationId);
  const exact = members.filter((m) => m.name.trim().toLowerCase() === q);
  if (exact.length === 1) return { userId: exact[0]!.userId, name: exact[0]!.name };
  if (exact.length > 1) return null;
  const first = members.filter((m) => m.name.trim().toLowerCase().split(/\s+/)[0] === q);
  if (first.length === 1) return { userId: first[0]!.userId, name: first[0]!.name };
  const email = members.filter((m) => m.email.toLowerCase() === q || m.email.toLowerCase().split('@')[0] === q);
  if (email.length === 1) return { userId: email[0]!.userId, name: email[0]!.name };
  return null;
}
