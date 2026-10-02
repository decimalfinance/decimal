// Action cards: what the companion may PROPOSE, never do.
//
// Two kinds of card (Zaid, 2026-10-02):
//
//   - GO THERE: anything that judges or moves a bill — its fields, its lines,
//     approving it, sending it on, closing or clearing a duplicate — opens the
//     bill at the right place, with the whole bill and its document in view.
//     A card never changes a bill: deciding about a bill from a narrowed
//     summary is how the wrong answer gets through, and the bill page is where
//     the whole picture is.
//   - DO IT HERE: what is not a judgement about a bill's contents — asking or
//     nudging a colleague, setting or removing a vendor default. The button
//     sends a request, built here, to the same endpoint a person would use,
//     as the person who clicks, so every permission and gate runs at the click.
//
// The model names a kind and a bill. Everything else is decided here, in code,
// against the bill as it is right now: whether the card fits at all, what it
// says, and where it goes or what it sends. A proposal that does not fit is
// dropped.
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

export const ACTION_KINDS = ['look_at', 'send_for_approval', 'close_duplicate', 'clear_duplicate', 'approve', 'ask_person', 'save_habit', 'forget_habit'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
/**
 * What a card turns out to be. ask_person becomes a nudge (does not hold the
 * bill), a question (holds it until answered), or already_asked (nothing to
 * send: the person already has it in their inbox).
 */
export type CardKind = Exclude<ActionKind, 'ask_person'> | 'nudge' | 'question' | 'already_asked';

export type ProposedAction = { kind: ActionKind; billId: string; reason: string; toPerson?: string | null; message?: string | null; category?: string | null; focus?: string | null };

export type ActionCard = {
  actionId: string;
  kind: CardKind;
  billId: string;
  title: string;
  detail: string;
  /** Why, in the companion's words — also what gets recorded with the action. */
  reason: string | null;
  button: string;
  /** Do-it-here cards: the request the button sends, relative to /organizations/:orgId. Built here, never by the model. */
  call: { path: string; body: Record<string, unknown>; method?: 'POST' | 'PUT' | 'DELETE' };
  /** Go-there cards: the bill page to open, relative to /organizations/:orgId, and where on it to land (data-focus on the page). */
  open?: { path: string; focus: string | null } | null;
  /** info: nothing to click (already_asked). */
  status: 'proposed' | 'done' | 'failed' | 'info';
  result: string | null;
};

/** How each kind reads on a card. */
const COPY: Record<CardKind, { verb: string; button: string; done: string }> = {
  look_at: { verb: 'Look at', button: 'Open the bill', done: 'Opened' },
  send_for_approval: { verb: 'Send for approval', button: 'Open it to send', done: 'Opened' },
  close_duplicate: { verb: 'Close as a duplicate', button: 'Open the duplicate check', done: 'Opened' },
  clear_duplicate: { verb: 'Not a duplicate', button: 'Open the duplicate check', done: 'Opened' },
  approve: { verb: 'Approve', button: 'Open it to approve', done: 'Opened' },
  nudge: { verb: 'Nudge', button: 'Send nudge', done: 'Nudge sent' },
  question: { verb: 'Ask', button: 'Ask (holds the bill)', done: 'Question sent' },
  already_asked: { verb: 'Already asked', button: '', done: '' },
  save_habit: { verb: 'Set a default', button: 'Set the default', done: 'Default set' },
  forget_habit: { verb: 'Remove the default', button: 'Remove it', done: 'Default removed' },
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
    let open: ActionCard['open'] = null;
    // The bill's own page: the draft screen while it is in review, the bill otherwise.
    const page = row.state === 'draft' ? `/bills/${row.paymentOrderId}/draft` : `/bills/${row.paymentOrderId}`;
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
          title = `Remove the default: ${row.vendorName} → ${current.accountName ?? current.accountId}`;
          detail = "This vendor's lines stop falling back to it. Lines like ones your team settled keep their categories; confirmed bills keep what was confirmed.";
          call = { method: 'DELETE', path: `/knowledge/habits/${vendor.counterpartyId}`, body: {} };
        } else {
          const account = await resolveCategory(args.organizationId, p.category ?? '');
          if (!account) break;
          if (current && (current.accountName === account.name || current.accountId === account.id)) break;
          title = `Set a default: ${row.vendorName} → ${account.name}`;
          detail = current
            ? `Replaces ${current.accountName ?? current.accountId}. Used for this vendor's lines when nothing else says what they are.`
            : "Used for this vendor's lines when nothing else says what they are.";
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
      // ── Go there ──────────────────────────────────────────────────────────
      // The same fit as when these cards acted — only someone who could do it,
      // only when the bill allows it — but the card opens the bill and the
      // person does it there, with everything in view.
      case 'send_for_approval':
        if (canEdit && row.state === 'draft' && row.companion?.ready) {
          open = { path: page, focus: null };
          detail = `${usd(row.amountUsd)} · checked and ready: look it over and send it from the bill`;
        }
        break;
      case 'close_duplicate':
        if (isAdmin && row.state === 'draft' && hasDuplicateFlag && reason) {
          open = { path: page, focus: 'flag:possible_duplicate' };
          detail = `${usd(row.amountUsd)} · the duplicate check and the two bills side by side are on the bill`;
        }
        break;
      case 'clear_duplicate':
        if (isAdmin && hasDuplicateFlag && reason && reason.length >= 3) {
          open = { path: page, focus: row.state === 'draft' ? 'flag:possible_duplicate' : null };
          detail = `${usd(row.amountUsd)} · the duplicate check and the two bills side by side are on the bill`;
        }
        break;
      case 'approve': {
        const task = tasks.get(row.paymentOrderId);
        if (task && !task.blocked) {
          open = { path: `/bills/${row.paymentOrderId}`, focus: null };
          detail = `${usd(row.amountUsd)} · waiting on your approval`;
        }
        break;
      }
      case 'look_at': {
        // Anything about the bill itself that needs a person: a figure, a
        // line, a flag. Open it where to look.
        const spot = row.state === 'draft' ? await focusOn(row, p.focus ?? null) : null;
        open = { path: page, focus: spot?.key ?? null };
        title = `Look at ${name}`;
        detail = spot ? `At ${spot.label}` : `${usd(row.amountUsd)} · ${row.subStatus.text}`;
        break;
      }
    }
    if (!call && !open) {
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
      call: call ?? { path: '', body: {} },
      open,
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

// Where on a draft a "look at" card lands: a field, a line, the totals, or a
// flag, named the way the model sees the bill. Anything unknown opens the bill
// at the top — a card is never refused for aiming badly, only for having no
// bill to open.
const FIELD_SPOTS: Record<string, { key: string; label: string }> = {
  vendor: { key: 'field:vendor.name', label: 'the vendor name' },
  vendor_email: { key: 'field:vendor.email', label: "the vendor's email" },
  address: { key: 'field:remitTo.street', label: "the vendor's address" },
  invoice_number: { key: 'field:invoiceNumber', label: 'the invoice number' },
  invoice_date: { key: 'field:invoiceDate', label: 'the invoice date' },
  due_date: { key: 'field:dueDate', label: 'the due date' },
  terms: { key: 'field:terms', label: 'the terms' },
  po_number: { key: 'field:poNumber', label: 'the PO number' },
  discount: { key: 'field:discount', label: 'the discount' },
  currency: { key: 'field:currency', label: 'the currency' },
  total: { key: 'field:total', label: 'the total' },
  tax: { key: 'totals', label: 'the totals' },
  totals: { key: 'totals', label: 'the totals' },
};

async function focusOn(
  row: { paymentOrderId: string; flags: Array<{ kind: string; short: string }> },
  raw: string | null,
): Promise<{ key: string; label: string } | null> {
  const q = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!q) return null;
  const field = FIELD_SPOTS[q];
  if (field) return field;
  const flag = /^flag:(\w+)$/.exec(q);
  if (flag) {
    const f = row.flags.find((x) => x.kind === flag[1]);
    return f ? { key: `flag:${f.kind}`, label: `the "${f.short}" flag` } : null;
  }
  const line = /^line_?(\d+)$/.exec(q);
  if (line) {
    const n = Number(line[1]);
    const order = await prisma.paymentOrder.findUnique({ where: { paymentOrderId: row.paymentOrderId }, select: { metadataJson: true } });
    const meta = (order?.metadataJson ?? {}) as Record<string, any>;
    const lines: unknown[] = Array.isArray(meta.verification?.lines) ? meta.verification.lines : Array.isArray(meta.agent?.extracted?.lineItems) ? meta.agent.extracted.lineItems : [];
    if (n < 1 || n > lines.length) return null;
    const desc = (lines[n - 1] as Record<string, unknown> | null)?.description;
    return { key: `line:${n - 1}`, label: `line ${n}${typeof desc === 'string' && desc.trim() ? `: ${desc.trim()}` : ''}` };
  }
  return null;
}
