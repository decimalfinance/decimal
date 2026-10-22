// What a bill's page works from, with no React in it: the fields and lines as
// the person edits them, the body that saving and sending carry, what still
// stands between the bill and approval, and the words the header uses.
import type { BillDetail, BillDetailStepNode, BillDraft, BillDraftField, BillDraftLine, ConfirmBillBody, DocSource } from '../../api';
import { calendarDay, firstName, usd } from '../../kit/format';

export type Flag = BillDraft['flags'][number];
export type Question = BillDraft['questions'][number];
export type BillComment = BillDraft['comments'][number];
export type Face = { name: string; avatarUrl: string | null };
export type FieldState = BillDraftField['state'];

/** How a field is drawn: read by Decimal, wanting a look, settled by a person, empty, wrong, being read, never read. */
export type Look = 'read' | 'look' | 'confirmed' | 'none' | 'wrong' | 'reading' | 'unread';
export type FieldKind = 'text' | 'code' | 'date' | 'money';
export type FieldDef = { key: string; label: string; kind: FieldKind };

export const VENDOR_FIELDS: FieldDef[] = [
  { key: 'vendor.name', label: 'Vendor name', kind: 'text' },
  { key: 'vendor.email', label: 'Email', kind: 'text' },
  { key: 'remitTo.street', label: 'Street', kind: 'text' },
  { key: 'remitTo.city', label: 'City', kind: 'text' },
  { key: 'remitTo.state', label: 'State', kind: 'text' },
  { key: 'remitTo.zip', label: 'ZIP code', kind: 'code' },
  { key: 'remitTo.country', label: 'Country', kind: 'text' },
];

export const DETAIL_FIELDS: FieldDef[] = [
  { key: 'invoiceNumber', label: 'Invoice number', kind: 'code' },
  { key: 'invoiceDate', label: 'Invoice date', kind: 'date' },
  { key: 'dueDate', label: 'Due date', kind: 'date' },
  { key: 'terms', label: 'Terms', kind: 'text' },
  { key: 'poNumber', label: 'PO number', kind: 'code' },
  { key: 'currency', label: 'Currency', kind: 'code' },
  { key: 'taxAmount', label: 'Tax', kind: 'money' },
  { key: 'total', label: 'Total due', kind: 'money' },
];

/** Shown only on the bills that print one. */
export const DISCOUNT_FIELD: FieldDef = { key: 'discount', label: 'Discount', kind: 'text' };

export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  [...VENDOR_FIELDS, ...DETAIL_FIELDS, DISCOUNT_FIELD].map((f) => [f.key, f.label]),
);

export type FieldEntry = { value: string; state: FieldState; reason: string | null; inferred: boolean; source: DocSource };
export type Fields = Record<string, FieldEntry>;

export function fieldsFrom(draft: BillDraft): Fields {
  const out: Fields = {};
  for (const f of [...draft.fields, ...draft.remitFields]) {
    out[f.key] = {
      value: f.value == null ? '' : String(f.value),
      state: f.state,
      reason: f.reason,
      inferred: Boolean(f.inferred),
      source: f.source ?? null,
    };
  }
  out['vendor.name'] = { value: draft.vendor.name ?? '', state: draft.vendor.nameState, reason: null, inferred: false, source: draft.vendor.nameSource ?? null };
  out['vendor.email'] = { value: draft.vendor.email ?? '', state: draft.vendor.emailState, reason: null, inferred: false, source: draft.vendor.emailSource ?? null };
  // Tax has no state of its own on the draft: read when the page shows one,
  // settled once someone has confirmed or typed it.
  const tax = draft.taxAmount;
  out.taxAmount = {
    value: tax == null ? '' : String(tax),
    state: draft.confirmedBy?.taxAmount ? 'confirmed' : tax == null ? 'not_on_document' : 'read',
    reason: null,
    inferred: false,
    source: draft.totalsSources?.tax ?? null,
  };
  // A document nothing could be read from carries placeholders ("Unreadable
  // document", a cent): they are not what the bill says, so the page shows
  // nothing there until someone types it. Empty saves as null, so the server
  // keeps its own record meanwhile.
  if (draft.unreadable) {
    for (const [key, entry] of Object.entries(out)) {
      if (entry.state !== 'confirmed') out[key] = { ...entry, value: '', state: 'not_on_document', reason: null, inferred: false };
    }
  }
  return out;
}

// While Decimal reads a bill (5r) its parts land one tick apart, in this
// order: the vendor, the invoice, its figures, the lines, their categories.
// The reading arrives all at once; the landing is how the page shows it.
export const READ_TICK_MS = 220;
const LANDS_AT: Record<string, number> = {
  'vendor.name': 1,
  'vendor.email': 2,
  'remitTo.street': 2,
  'remitTo.city': 2,
  'remitTo.state': 2,
  'remitTo.zip': 2,
  'remitTo.country': 2,
  invoiceNumber: 3,
  invoiceDate: 3,
  dueDate: 4,
  terms: 4,
};
const FIGURES_AT = 5;
const LINES_AT = 6;
export const CATEGORIES_AT = 11;
export const READ_DONE = 12;
export const landsAt = (key: string) => LANDS_AT[key] ?? FIGURES_AT;
/** The lines share five ticks, so a long bill lands as fast as a short one. */
export const lineLandsAt = (i: number, n: number) => LINES_AT + Math.min(4, Math.floor((i * 5) / Math.max(n, 1)));

export type LineEntry = {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  category: string | null;
  from: BillDraftLine['categoryFrom'] | null;
  settledBy: Face | null;
  source: DocSource;
};

let lineSeq = 0;
export function newLineId() {
  lineSeq += 1;
  return `line-${lineSeq}`;
}

const numText = (n: number | null | undefined) => (n == null ? '' : String(n));

export function linesFrom(draft: BillDraft): LineEntry[] {
  return draft.lines.map((l) => ({
    id: newLineId(),
    description: l.description ?? '',
    quantity: numText(l.quantity),
    unitPrice: numText(l.unitPrice),
    amount: numText(l.amount),
    category: l.category,
    from: l.categoryFrom ?? null,
    settledBy: l.categoryConfirmedBy ?? null,
    source: l.source ?? null,
  }));
}

/** "$1,200.50", "1200.5" or "1,200" → 1200.5; empty or nonsense → null. */
export function parseMoney(text: string | null | undefined): number | null {
  if (text == null) return null;
  const clean = text.replace(/[$,\s]/g, '');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function parseNumber(text: string | null | undefined): number | null {
  if (text == null) return null;
  const clean = text.replace(/[,\s]/g, '');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** A typed date ("5 Aug 2026", "2026-08-05", "08/05/2026") as yyyy-mm-dd, or null. */
export function parseDay(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const ms = Date.parse(`${t} 12:00 UTC`);
  const d = Number.isFinite(ms) ? new Date(ms) : new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** A field's value as the page shows it when nobody is typing in it. */
export function shown(kind: FieldKind, value: string) {
  if (!value) return '';
  if (kind === 'money') {
    const n = parseMoney(value);
    return n == null ? value : usd(n);
  }
  if (kind === 'date') return /^\d{4}-\d{2}-\d{2}/.test(value) ? calendarDay(value) : value;
  return value;
}

export const linesSum = (lines: LineEntry[]) =>
  Math.round(lines.reduce((sum, l) => sum + (parseMoney(l.amount) ?? 0), 0) * 100) / 100;

/** What saving and sending carry: the page exactly as it stands. */
export function bodyOf(fields: Fields, lines: LineEntry[], note: string | null): ConfirmBillBody {
  const v = (key: string) => fields[key]?.value.trim() || null;
  const total = parseMoney(fields.total?.value);
  return {
    fields: {
      vendorName: v('vendor.name'),
      vendorEmail: v('vendor.email'),
      invoiceNumber: v('invoiceNumber'),
      invoiceDate: v('invoiceDate'),
      dueDate: v('dueDate'),
      terms: v('terms'),
      poNumber: v('poNumber'),
      discount: v('discount'),
      currency: v('currency') ?? 'USD',
      ...(total != null && total > 0 ? { total } : {}),
      // Empty stays empty: a document with no tax line keeps saying so.
      taxAmount: parseMoney(fields.taxAmount?.value),
      remitTo: {
        street: v('remitTo.street'),
        city: v('remitTo.city'),
        state: v('remitTo.state'),
        zip: v('remitTo.zip'),
        country: v('remitTo.country'),
      },
    },
    lines: lines
      .filter((l) => l.description.trim())
      .map((l) => ({
        description: l.description.trim(),
        quantity: parseNumber(l.quantity),
        unitPrice: parseMoney(l.unitPrice),
        amount: parseMoney(l.amount),
        category: l.category ?? null,
        ...(l.settledBy ? { categoryConfirmed: true } : {}),
      })),
    confirmedFieldKeys: Object.entries(fields).filter(([, f]) => f.state === 'confirmed').map(([key]) => key),
    noteForApprovers: note,
  };
}

/**
 * The order to settle findings in: what the document is, then whether it may
 * go ahead, then its figures; warnings after everything that blocks.
 */
const FINDING_ORDER = [
  'looks_like_statement', 'looks_like_credit_note', 'possible_duplicate', 'addressed_elsewhere',
  'vendor_blocked', 'vendor_held', 'over_ceiling', 'lines_do_not_sum', 'total_does_not_reconcile',
  'payee_mismatch', 'unreadable_payment_details', 'similar_vendor', 'approval_weakened',
];
const orderOf = (kind: string) => {
  const i = FINDING_ORDER.indexOf(kind);
  return i < 0 ? FINDING_ORDER.length : i;
};

/** The flags a person has to deal with, in the order to settle them. Settled overrides and notes are not findings. */
export function findingsOf(draft: BillDraft): Flag[] {
  const live = draft.flags.filter((f) => f.blocking || (f.severity !== 'info' && f.resolutions.length > 0));
  return [...live].sort((a, b) => Number(b.blocking) - Number(a.blocking) || orderOf(a.kind) - orderOf(b.kind));
}

/**
 * What Decimal says when nothing needs settling: the one thing still worth a
 * look, or that there is nothing to flag. Worked out from the page as it
 * stands, so confirming a field changes it at once.
 */
export function restingMessage(draft: BillDraft, fields: Fields, lines: LineEntry[]): string {
  const missing: string[] = [];
  if ((parseMoney(fields.total?.value) ?? 0) <= 0) missing.push('a total');
  if (!fields.invoiceNumber?.value.trim()) missing.push('an invoice number');
  if (!lines.some((l) => l.description.trim())) missing.push('a line');
  if (missing.length > 0) return `Nothing to flag, but the bill still needs ${missing.join(' and ')} before it can go for approval.`;
  const look = Object.entries(fields).find(([key, f]) => f.state === 'needs_look' && f.value.trim() && !key.startsWith('remitTo.'));
  if (look) return `Nothing to flag. The ${(FIELD_LABELS[look[0]] ?? 'marked field').toLowerCase()} is worth a second look: ${look[1].reason ?? 'check it against the document'}.`;
  const firstBill = draft.flags.some((f) => f.kind === 'new_vendor');
  const guessed = lines.some((l) => l.category && !l.settledBy && l.from && l.from.kind !== 'memory');
  const uncategorised = lines.some((l) => l.description.trim() && !l.category);
  if (uncategorised) return 'Nothing to flag. Some lines still need a category.';
  if (firstBill && guessed) return `Nothing to flag. This is the first bill from ${draft.vendor.name}, so its categories are a first guess. Check them.`;
  if (guessed) return 'Nothing to flag. Some categories are a first guess. Check them.';
  if (firstBill) return `Nothing to flag. This is the first bill from ${draft.vendor.name}.`;
  return 'Nothing to flag. Every figure is on the page, the lines add up to the total, and each line has a category.';
}

/**
 * A decision a person already made, kept on the bill as a flag ("Duplicate
 * cleared", "Ceiling exception", "Paying the itemised total"). The page shows
 * it as that person's message, from the work log, not as a finding.
 */
export const isSettledRecord = (f: Flag) =>
  f.severity === 'info' && f.resolutions.length === 0 && ['possible_duplicate', 'over_ceiling', 'short_paid'].includes(f.kind);

/** Information worth a sentence, with nothing to do about it ("First bill from vendor"). */
export function notesOf(draft: BillDraft): string[] {
  return draft.flags
    .filter((f) => !f.blocking && f.severity === 'info' && f.resolutions.length === 0 && !isSettledRecord(f))
    .map((f) => (f.kind === 'new_vendor' ? `First bill from ${draft.vendor.name}.` : f.message));
}

/**
 * Why the bill can't be sent yet, in the bar's words, or null when it can.
 * The same gates the server keeps: settled findings, a total, a line, a
 * reference, an amount on every line, and every field marked for a look.
 */
export function sendGap(draft: BillDraft, fields: Fields, lines: LineEntry[]): string | null {
  if (draft.flags.some((f) => f.blocking)) return 'Settle the finding to send it on';
  if (!fields['vendor.name']?.value.trim()) return 'Add the vendor name to send it on';
  const total = parseMoney(fields.total?.value) ?? 0;
  if (total <= 0) return 'Add the total to send it on';
  const real = lines.filter((l) => l.description.trim());
  if (real.length === 0) return 'Add a line to send it on';
  if (!fields.invoiceNumber?.value.trim()) return 'Add an invoice number to send it on';
  const noAmount = real.findIndex((l) => parseMoney(l.amount) == null);
  if (noAmount >= 0) return `Add an amount to line ${noAmount + 1} to send it on`;
  // The address parts stay out, as on the server, which judges them as one.
  const unchecked = Object.entries(fields).filter(([key, f]) => f.state === 'needs_look' && !key.startsWith('remitTo.'));
  if (unchecked.length === 1) return `Confirm the ${(FIELD_LABELS[unchecked[0]![0]] ?? 'marked field').toLowerCase()} to send it on`;
  if (unchecked.length > 1) return `Confirm the ${unchecked.length} marked fields to send it on`;
  return null;
}

export const CLOSE_REASONS: Array<{ key: 'duplicate' | 'statement' | 'credit_note' | 'not_ours' | 'unreadable' | 'other'; label: string; short: string }> = [
  { key: 'duplicate', label: 'A duplicate of a bill we already have', short: 'duplicate' },
  { key: 'statement', label: 'A statement, not a bill', short: 'statement' },
  { key: 'credit_note', label: 'A credit note, not a bill', short: 'credit note' },
  { key: 'not_ours', label: 'Not ours to pay', short: 'not ours' },
  { key: 'unreadable', label: 'It can’t be read', short: 'unreadable' },
  { key: 'other', label: 'Something else', short: 'closed' },
];
export type CloseReason = (typeof CLOSE_REASONS)[number]['key'];

/** The reason a finding implies when its way to settle it is closing the bill. */
export function closeReasonFor(flagKind: string): CloseReason {
  if (flagKind === 'looks_like_statement') return 'statement';
  if (flagKind === 'looks_like_credit_note') return 'credit_note';
  if (flagKind === 'possible_duplicate') return 'duplicate';
  return 'not_ours';
}

export type Stage = 'reading' | 'review' | 'approval' | 'done';
export type ChipTone = 'yours' | 'checked' | 'blocking' | 'warning' | 'waiting' | 'finished';

/** Who an approval is waiting on now: the open step's people. */
export function waitingOn(detail: BillDetail): Face[] {
  const now = (detail.approval?.steps ?? []).filter((s) => s.state === 'current' && s.person);
  return now.map((s) => ({ name: s.person!.name, avatarUrl: s.person!.avatarUrl }));
}

/** The approval's steps in order, each with the people on it. */
export function stepGroups(detail: BillDetail): Array<{ index: number; steps: BillDetailStepNode[] }> {
  const groups = new Map<number, BillDetailStepNode[]>();
  for (const s of detail.approval?.steps ?? []) {
    if (!s.person) continue;
    const g = groups.get(s.stepIndex);
    if (g) g.push(s);
    else groups.set(s.stepIndex, [s]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([index, steps]) => ({ index, steps }));
}

/**
 * What QuickBooks objected to, as one clause: the first sentence of the
 * sync's error, names in curly quotes. The rest is the old screens' remedy,
 * which this page gives in its own words.
 */
export function syncProblem(error: string | null): string | null {
  if (!error?.trim()) return null;
  return firstSentence(error).replace(/[.!]\s*$/, '').replace(/"([^"]*)"/g, '“$1”');
}

/** A message's first sentence: what was found, without the advice that follows it. */
export function firstSentence(text: string): string {
  return text.trim().split(/(?<=[.!?])\s+(?=[A-Z"“])/)[0]!;
}

/** The bill a duplicate copies: from the exception agent's brief, else from the flag. */
export function duplicateOf(detail: BillDetail): { paymentOrderId: string | null; invoiceNumber: string | null } | null {
  const flag = detail.draft.flags.find((f) => f.kind === 'possible_duplicate');
  if (!flag) return null;
  const other = flag.brief?.otherBill ?? null;
  const paymentOrderId = other?.paymentOrderId ?? flag.resolutions.find((r) => r.targetId)?.targetId ?? null;
  const invoiceNumber = other?.invoiceNumber ?? /duplicate of (?:invoice )?([A-Z0-9][\w-]*)/i.exec(flag.message)?.[1] ?? null;
  return paymentOrderId || invoiceNumber ? { paymentOrderId, invoiceNumber } : null;
}

/** The approval states a bill is still in approval for. */
const OPEN_APPROVAL = ['pending_approval', 'returned_for_info', 'on_hold'];

/** Still with its approvers: someone's step is open, or the approval hasn't finished. */
export function inApproval(detail: BillDetail): boolean {
  if (detail.draft.state === 'draft' || detail.draft.state === 'cancelled') return false;
  return waitingOn(detail).length > 0 || OPEN_APPROVAL.includes(detail.approval?.macroState ?? '');
}

/** The sender asked to take it back and an admin hasn't answered. */
export const takeBackAsked = (detail: BillDetail) => (detail.recall.open?.state === 'pending' ? detail.recall.open : null);

/** The stage word and the chip after it, as the Bills list would show this bill. */
export function headerOf(detail: BillDetail, fields: Fields): { stage: Stage; stageText: string; chip: { text: string; tone: ChipTone } | null } {
  const draft = detail.draft;
  if (draft.state === 'draft') {
    const blocking = draft.flags.find((f) => f.blocking);
    const warning = draft.flags.find((f) => !f.blocking && f.severity === 'warning' && f.resolutions.length > 0);
    const forYou = draft.questions.some((q) => q.youWereAsked && q.stillOpen);
    const chip = blocking ? { text: blocking.short, tone: 'blocking' as const }
      : forYou ? { text: 'Question for you', tone: 'yours' as const }
      : draft.sentBack ? { text: 'Sent back', tone: 'yours' as const }
      : warning ? { text: warning.short, tone: 'warning' as const }
      : Object.values(fields).some((f) => f.state === 'needs_look') ? { text: 'Needs a check', tone: 'yours' as const }
      : { text: 'Checked', tone: 'checked' as const };
    return { stage: 'review', stageText: 'In review', chip };
  }
  // Closed is finished: the reason is in the closed box, not the chip.
  if (draft.state === 'cancelled') return { stage: 'done', stageText: 'Done', chip: { text: 'Closed', tone: 'finished' } };
  if (inApproval(detail)) {
    const people = waitingOn(detail);
    const approval = (text: string, tone: ChipTone) => ({ stage: 'approval' as const, stageText: 'In approval', chip: { text, tone } });
    if (takeBackAsked(detail)) return approval('On hold', 'waiting');
    if (detail.viewer.openTaskId) return approval('Waiting on you', 'yours');
    if (draft.questions.some((q) => q.youWereAsked && q.stillOpen)) return approval('Question for you', 'yours');
    // Past two people the chip stops naming them; the route below shows who.
    if (people.length > 2) return approval('Waiting on others', 'waiting');
    if (people.length > 0) return approval(`Waiting on ${people.map((p) => (people.length > 1 ? firstName(p.name) : p.name)).join(' or ')}`, 'waiting');
    return approval(detail.status.subStatus.text, 'finished');
  }
  // QuickBooks says how far it got in a tag of its own, not a chip.
  if (detail.posting) return { stage: 'done', stageText: 'Done', chip: null };
  if (draft.state === 'executed' || draft.state === 'settled') return { stage: 'done', stageText: 'Done', chip: { text: 'Paid', tone: 'finished' } };
  return { stage: 'done', stageText: 'Done', chip: { text: 'Approved', tone: 'finished' } };
}

/** Text with "$4,820.00" and "NW-3320"-like figures marked, so they set in mono. */
export function figureParts(text: string): Array<{ t: string; mono: boolean }> {
  const out: Array<{ t: string; mono: boolean }> = [];
  const re = /(-?[$€£]\s?[\d,]+(?:\.\d+)?|\b\d{1,2} [A-Z][a-z]{2} \d{4}\b|\b[A-Z]{1,6}-\d[\w-]*\b)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push({ t: text.slice(at, m.index), mono: false });
    out.push({ t: m[0], mono: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ t: text.slice(at), mono: false });
  return out;
}

export const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
