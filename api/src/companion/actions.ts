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

/** Cards in one answer: enough to tidy a batch, few enough to read. */
const MAX_CARDS = 12;

export const ACTION_KINDS = ['send_for_approval', 'close_duplicate', 'clear_duplicate', 'approve'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type ProposedAction = { kind: ActionKind; billId: string; reason: string };

export type ActionCard = {
  actionId: string;
  kind: ActionKind;
  billId: string;
  title: string;
  detail: string;
  /** Why, in the companion's words — also what gets recorded with the action. */
  reason: string | null;
  button: string;
  /** The request the button sends, relative to /organizations/:orgId. Built here, never by the model. */
  call: { path: string; body: Record<string, unknown> };
  status: 'proposed' | 'done' | 'failed';
  result: string | null;
};

/** How each kind reads on a card. */
const COPY: Record<ActionKind, { verb: string; button: string; done: string }> = {
  send_for_approval: { verb: 'Send for approval', button: 'Send for approval', done: 'Sent for approval' },
  close_duplicate: { verb: 'Close as a duplicate', button: 'Close as duplicate', done: 'Closed as a duplicate' },
  clear_duplicate: { verb: 'Clear the duplicate flag', button: 'Clear the flag', done: 'Duplicate flag cleared' },
  approve: { verb: 'Approve', button: 'Approve', done: 'Approved' },
};

export function doneText(kind: ActionKind): string {
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
    const key = `${p.kind}:${p.billId}`;
    if (once.has(key)) continue;
    const row = rows.get(p.billId);
    if (!row) continue;
    const name = `${row.vendorName}${row.invoiceNumber ? ` ${row.invoiceNumber}` : ''}`;
    const reason = p.reason.trim().slice(0, 300) || null;
    const hasDuplicateFlag = row.flags.some((f) => f.kind === 'possible_duplicate');
    let call: ActionCard['call'] | null = null;
    let detail = `${usd(row.amountUsd)} · ${row.subStatus.text}`;

    switch (p.kind) {
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
      kind: p.kind,
      billId: row.paymentOrderId,
      title: `${COPY[p.kind].verb}: ${name}`,
      detail,
      reason,
      button: COPY[p.kind].button,
      call,
      status: 'proposed',
      result: null,
    });
  }
  return cards;
}
