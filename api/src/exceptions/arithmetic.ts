// The arithmetic investigator: when a bill's figures don't add up, it finds out
// why from the document, and says exactly what to change.
//
// The two arithmetic flags (bill-flags.ts) say THAT the lines, tax and total
// disagree. Code alone can't say why, and the why decides what to pay:
//
//   - a figure printed between the subtotal and the total that the reading left
//     off: freight, a fee, a discount, a deposit already paid;
//   - line items the reading stopped short of, often on a later page;
//   - a figure read wrong, as a scan's 1,836 becomes 1,386;
//   - or a document that really does disagree with itself.
//
// Only in the last is "pay what the lines add up to" a fair answer. In the
// others it pays the wrong amount: a missed discount or deposit is paid over.
// So the agent reads the document beside the bill's figures and names the
// figures that explain the gap.
//
// Code does every sum. Before the model looks, it lists the amounts printed on
// the document that the bill doesn't have, and the bill's amounts the document
// doesn't print. After, it checks that each figure the model names is printed on
// the line it cites, and that together they close the gap to the cent. What
// fails is sent back, twice at most, and otherwise dropped as unsure, which
// leaves the flag's plain finding (findings.ts) in place.
//
// The result is kept on the bill, metadata.arithmeticCheck, against a
// fingerprint of the figures it was made on: change a figure and it is made
// again. Nothing here changes the bill. A person applies the correction with
// one click (correctFiguresFromDocument, bills.ts).
import { createHash } from 'node:crypto';
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';
import { trackBackgroundWork } from '../infra/background.js';
import { extractImageTextLayer, extractPdfLayoutText, type TextPage, type TextWord } from '../payments/doc-provenance.js';
import { billDocumentIdOf } from '../payments/split-pages.js';
import { logSuggestion } from '../payments/suggestion-log.js';
import { isExceptionAgentConfigured, runAgent } from './agent.js';
import type { FigureCorrection, FindingPoint, FlagFinding } from './findings.js';

export type BillFigures = {
  lines: Array<{ description: string; quantity: number | null; unitPrice: number | null; amount: number | null }>;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
};

export type ArithmeticVerdict = 'missed' | 'misread' | 'document_error' | 'unsure';

/** A figure on the document the bill doesn't have. Signed: a discount or a deposit is negative. */
export type MissingFigure = { description: string; amount: number; page: number; printed: string };

/** A figure the document prints differently from the bill. `line` is the bill line's index, from 0. */
export type MisreadFigure = {
  target: 'line' | 'tax' | 'total';
  line: number | null;
  label: string;
  from: number;
  to: number;
  page: number;
  printed: string;
};

export type ArithmeticCheck = {
  fingerprint: string;
  at: string;
  /** failed: the model couldn't be asked. Made again after a while. */
  status: 'ready' | 'failed';
  verdict: ArithmeticVerdict;
  missing: MissingFigure[];
  misread: MisreadFigure[];
  /** The model's one sentence, for the record. The finding's words are code's. */
  reason: string;
  /** Why it came to unsure when it did: what failed the checks, or what couldn't be read. */
  dropped: string | null;
  source: 'text' | 'ocr' | null;
  model: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  suggestionId: string | null;
};

export type DocLine = { ref: string; page: number; text: string; amounts: number[] };

const MAX_PAGES = 8;
const MAX_LINES_PER_PAGE = 120;
const RETRY_FAILED_AFTER_MS = 10 * 60_000;

const cents = (n: number) => Math.round(n * 100);
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const moneyCents = (c: number) => money(c / 100);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ─── The figures ────────────────────────────────────────────────────────────

/** What a check is current for: the bill's document and its figures. */
export function figuresFingerprint(documentId: string | null, f: BillFigures): string {
  const c = (n: number | null) => (n === null ? null : cents(n));
  return createHash('sha256')
    .update(JSON.stringify([documentId, f.lines.map((l) => [l.description.trim(), l.quantity, l.unitPrice, c(l.amount)]), c(f.tax), c(f.total)]))
    .digest('hex')
    .slice(0, 32);
}

/**
 * The total less the lines and tax, in cents: positive when the bill is short
 * of its total, negative when it is over. Null when it can't be judged: no
 * total, no lines, or a line without an amount.
 */
export function gapOf(f: BillFigures): number | null {
  if (f.total === null) return null;
  const present = f.lines.filter((l) => l.description.trim() !== '' || l.amount !== null);
  if (present.length === 0 || present.some((l) => l.amount === null)) return null;
  return cents(f.total) - present.reduce((s, l) => s + cents(l.amount!), 0) - cents(f.tax ?? 0);
}

/** Every money-shaped amount in a line of text, in cents, its sign dropped: "1,140.00", "$85.00", "(300.00)". */
export function amountsIn(text: string): number[] {
  return [...text.matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d)/g)]
    .map((m) => Number(m[1]!.replace(/,/g, '')) * 100 + Number(m[2]));
}

/** The bill's amounts in cents, sign dropped: what a printed amount can already be on the bill as. */
function billAmounts(f: BillFigures): Set<number> {
  const on = new Set<number>();
  const add = (n: number | null) => {
    if (n !== null && Number.isFinite(n) && cents(n) !== 0) on.add(Math.abs(cents(n)));
  };
  for (const l of f.lines) {
    add(l.amount);
    add(l.unitPrice);
    if (l.quantity !== null && l.unitPrice !== null) add(l.quantity * l.unitPrice);
  }
  add(f.subtotal);
  add(f.tax);
  add(f.total);
  add(f.lines.reduce((s, l) => s + (l.amount ?? 0), 0));
  return on;
}

export type Unaccounted = {
  /** Lines of the document printing an amount the bill doesn't have. */
  notOnBill: DocLine[];
  /** The bill's figures the document doesn't print anywhere. */
  notPrinted: Array<{ ref: string; label: string; amount: number }>;
};

/** The amounts on one side and not the other: where to look, worked out before the model looks. */
export function unaccounted(doc: DocLine[], f: BillFigures): Unaccounted {
  const on = billAmounts(f);
  const printed = new Set(doc.flatMap((l) => l.amounts));
  const absent = (n: number | null) => n !== null && cents(n) !== 0 && !printed.has(Math.abs(cents(n)));
  return {
    notOnBill: doc.filter((l) => l.amounts.some((a) => a > 0 && !on.has(a))),
    notPrinted: [
      ...f.lines.flatMap((l, i) => (absent(l.amount) ? [{ ref: `line.${i + 1}`, label: l.description || `Line ${i + 1}`, amount: l.amount! }] : [])),
      ...(absent(f.tax) ? [{ ref: 'tax', label: 'Tax', amount: f.tax! }] : []),
      ...(absent(f.total) ? [{ ref: 'total', label: 'Total', amount: f.total! }] : []),
    ],
  };
}

// ─── The document ───────────────────────────────────────────────────────────

/** The document's text line by line, each line with a ref the model cites: p1.L12. */
export function docLines(pages: string[][]): DocLine[] {
  const out: DocLine[] = [];
  for (const [p, rows] of pages.slice(0, MAX_PAGES).entries()) {
    let n = 0;
    for (const row of rows) {
      const text = row.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      n += 1;
      if (n > MAX_LINES_PER_PAGE) break;
      out.push({ ref: `p${p + 1}.L${n}`, page: p + 1, text: text.slice(0, 200), amounts: amountsIn(text) });
    }
  }
  return out;
}

/** OCR words into rows, top to bottom, each left to right. */
function rowsOf(page: TextPage): string[] {
  const words = page.words.filter((w) => w.text.trim()).sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const rows: Array<{ mid: number; height: number; words: TextWord[] }> = [];
  for (const w of words) {
    const mid = (w.y0 + w.y1) / 2;
    const height = w.y1 - w.y0;
    const row = rows.find((r) => Math.abs(r.mid - mid) <= Math.max(r.height, height) * 0.6);
    if (row) row.words.push(w);
    else rows.push({ mid, height, words: [w] });
  }
  return rows.map((r) => {
    const kept: TextWord[] = [];
    for (const w of [...r.words].sort((a, b) => a.x0 - b.x0)) {
      // OCR's passes are merged, so the same word can arrive twice.
      if (kept.some((k) => k.text === w.text && Math.abs(k.x0 - w.x0) < 0.01)) continue;
      kept.push(w);
    }
    return kept.map((w) => w.text).join(' ');
  });
}

/** The text of the bill's own document: its text layer, or what OCR reads off its page images. */
async function readDocument(organizationId: string, documentId: string): Promise<{ lines: DocLine[]; source: 'text' | 'ocr' } | null> {
  const doc = await prisma.invoiceDocument.findFirst({
    where: { invoiceDocumentId: documentId, organizationId },
    select: { data: true, filename: true, mimeType: true },
  });
  if (!doc) return null;
  const layout = await extractPdfLayoutText({ fileBytes: Buffer.from(doc.data), filename: doc.filename, mimeType: doc.mimeType });
  if (layout) return { lines: docLines(layout.split('\f').map((page) => page.split('\n'))), source: 'text' };
  const images = await prisma.invoiceDocumentPage.findMany({
    where: { invoiceDocumentId: documentId },
    orderBy: { pageIndex: 'asc' },
    take: MAX_PAGES,
    select: { data: true },
  });
  const pages = await extractImageTextLayer(images.map((p) => ({ bytes: Buffer.from(p.data) })));
  return pages ? { lines: docLines(pages.map(rowsOf)), source: 'ocr' } : null;
}

// ─── The investigation ──────────────────────────────────────────────────────

const SYSTEM = `You find out why an invoice's figures don't add up, for an accounts-payable team.

A bill was read from a document. Its lines plus its tax should come to its total, and they don't. Read the document beside the bill's figures and find out why. The answers:

- missed: the document prints figures the bill doesn't have. A charge between the subtotal and the total (freight, shipping, delivery, a fee, a surcharge), a discount or a credit, a deposit or an amount already paid, or line items the reading left out (often on another page). For each: its description as printed, its amount, the page, and the ref of the document line it is printed on. A charge or a line item is positive. A discount, a credit, a deposit or anything already paid is negative, however the document prints it.
- misread: a figure on the bill differs from what the document prints for it. For each: which figure (line.N, tax or total), the amount the bill has, the amount the document prints, the page and the ref.
- document_error: every figure was read as printed, and the document's own figures disagree with each other. Nothing is missing or misread.
- unsure: the document doesn't settle it.

One finding can name missing and misread figures together. Together they must close the gap exactly: afterwards the bill's lines plus its tax equal its total, to the cent. A subtotal, a tax figure, a total, an amount due or a balance is never a missing line: if the bill's tax or total differs from the document's, that figure was misread.

Code checks your answer: every amount you name must be printed on the document line you cite, and the figures must close the gap. If they don't, you are told why: put it right, or answer unsure. Never guess a figure.

Finish by calling submit_finding.`;

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'missing', 'misread', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['missed', 'misread', 'document_error', 'unsure'] },
    missing: {
      type: 'array',
      description: 'For missed: each figure the bill lacks. Empty otherwise.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'amount', 'page', 'ref'],
        properties: {
          description: { type: 'string', description: 'As printed on the document.' },
          amount: { type: 'number', description: 'Positive for a charge or a line; negative for a discount, credit, deposit or amount already paid.' },
          page: { type: 'integer' },
          ref: { type: 'string', description: 'The document line it is printed on, like p1.L24.' },
        },
      },
    },
    misread: {
      type: 'array',
      description: 'For misread: each figure the bill has wrong. Empty otherwise.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'billHas', 'printed', 'page', 'ref'],
        properties: {
          target: { type: 'string', description: 'line.N, tax or total.' },
          billHas: { type: 'number' },
          printed: { type: 'number', description: 'What the document prints for it.' },
          page: { type: 'integer' },
          ref: { type: 'string', description: 'The document line it is printed on, like p1.L9.' },
        },
      },
    },
    reason: { type: 'string', description: 'One sentence a person can check against the document.' },
  },
} as const;

export const ARITHMETIC_FINDING_SCHEMA = FINDING_SCHEMA;

export type Context = { f: BillFigures; doc: Map<string, DocLine>; gap: number; found: Unaccounted };

/** What the judge holds an answer to: the figures, the document by ref, the gap and where to look. */
export function figuresContext(doc: DocLine[], f: BillFigures): Context | null {
  const gap = gapOf(f);
  return gap === null ? null : { f, doc: new Map(doc.map((l) => [l.ref, l])), gap, found: unaccounted(doc, f) };
}

function describeLine(l: BillFigures['lines'][number], i: number): string {
  const parts = l.quantity !== null && l.unitPrice !== null ? `${l.quantity} × ${money(l.unitPrice)} = ` : '';
  return `line.${i + 1}  "${l.description || '(no description)'}"  ${parts}${l.amount === null ? 'no amount' : money(l.amount)}`;
}

function promptFor(args: { f: BillFigures; doc: DocLine[]; source: 'text' | 'ocr'; vendorName: string; invoiceNumber: string | null }, ctx: Context): string {
  const { f } = args;
  const linesSum = f.lines.reduce((s, l) => s + cents(l.amount ?? 0), 0);
  const tax = cents(f.tax ?? 0);
  const out: string[] = [];
  out.push(`The bill from ${args.vendorName}${args.invoiceNumber ? `, invoice ${args.invoiceNumber}` : ''}.`, '', 'Its figures:');
  out.push(...f.lines.map(describeLine));
  out.push(`The lines add up to ${moneyCents(linesSum)}. Tax ${f.tax === null ? 'none' : money(f.tax)}. Total ${f.total === null ? 'none' : money(f.total)}.`
    + (f.subtotal !== null && cents(f.subtotal) !== linesSum ? ` The subtotal was read as ${money(f.subtotal)}.` : ''));
  out.push(`The gap: the lines plus tax come to ${moneyCents(linesSum + tax)}, ${moneyCents(Math.abs(ctx.gap))} ${ctx.gap > 0 ? 'short of' : 'over'} the total.`, '');
  out.push('Amounts printed on the document that are not on the bill:');
  out.push(...(ctx.found.notOnBill.length > 0 ? ctx.found.notOnBill.slice(0, 40).map((l) => `${l.ref}  ${l.text}`) : ['none']), '');
  out.push("The bill's figures that the document doesn't print:");
  out.push(...(ctx.found.notPrinted.length > 0 ? ctx.found.notPrinted.map((n) => `${n.ref}  "${n.label}"  ${money(n.amount)}`) : ['none']), '');
  out.push(args.source === 'ocr' ? 'The document, read by OCR from its scanned pages, so a character can be wrong:' : 'The document:');
  out.push(...args.doc.map((l) => `${l.ref}  ${l.text}`));
  return out.join('\n');
}

type Judged =
  | { ok: true; verdict: ArithmeticVerdict; missing: MissingFigure[]; misread: MisreadFigure[]; reason: string }
  | { ok: false; problem: string };

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The bill's lines plus tax against its total, in cents, once the figures named are put right. */
function closure(f: BillFigures, missing: MissingFigure[], misread: MisreadFigure[]) {
  const lineAmounts = f.lines.map((l) => cents(l.amount ?? 0));
  let tax = cents(f.tax ?? 0);
  let total = cents(f.total ?? 0);
  for (const m of misread) {
    if (m.target === 'line' && m.line !== null) lineAmounts[m.line] = cents(m.to);
    else if (m.target === 'tax') tax = cents(m.to);
    else if (m.target === 'total') total = cents(m.to);
  }
  const lines = lineAmounts.reduce((s, a) => s + a, 0) + missing.reduce((s, m) => s + cents(m.amount), 0);
  return { lines, tax, total, diff: total - lines - tax };
}

/**
 * What the model answered, held to what code can check. `hints` adds the
 * checks that only steer: a gap the document prints in full, or a bill figure
 * the document doesn't print, makes "the document disagrees with itself"
 * doubtful but not impossible. Sent back during the run; not held against the
 * final answer.
 */
export function judgeFinding(raw: Record<string, unknown>, ctx: Context, hints: boolean): Judged {
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 300) : '';
  const verdict = raw.verdict;
  const missingRaw = Array.isArray(raw.missing) ? raw.missing.filter(isObject) : [];
  const misreadRaw = Array.isArray(raw.misread) ? raw.misread.filter(isObject) : [];
  const no = (problem: string): Judged => ({ ok: false, problem });

  if (verdict === 'unsure') return { ok: true, verdict, missing: [], misread: [], reason };
  if (verdict === 'document_error') {
    if (missingRaw.length > 0 || misreadRaw.length > 0) {
      return no('document_error means nothing is missing or misread, but you named figures. Answer missed or misread, or name none.');
    }
    if (hints) {
      const gap = Math.abs(ctx.gap);
      const exact = ctx.found.notOnBill.find((l) => l.amounts.includes(gap));
      if (exact) return no(`The document prints ${moneyCents(gap)} on ${exact.ref} ("${exact.text}"), exactly the gap. Is it a figure the bill is missing? If it is, answer missed. If it isn't, say why in reason.`);
      const absent = ctx.found.notPrinted[0];
      if (absent) return no(`The bill's ${absent.ref} ("${absent.label}", ${money(absent.amount)}) isn't printed anywhere on the document. Was it misread? If it was, answer misread. If it wasn't, say why in reason.`);
    }
    return { ok: true, verdict, missing: [], misread: [], reason };
  }
  if (verdict !== 'missed' && verdict !== 'misread') return no('verdict must be missed, misread, document_error or unsure.');

  const missing: MissingFigure[] = [];
  for (const m of missingRaw) {
    const line = ctx.doc.get(String(m.ref));
    const amount = Number(m.amount);
    const description = typeof m.description === 'string' ? m.description.trim().slice(0, 120) : '';
    if (!line) return no(`${String(m.ref)} isn't a line of the document. Cite the ref of the line the amount is printed on, like p1.L12.`);
    if (!Number.isFinite(amount) || cents(amount) === 0) return no(`The amount on ${line.ref} must be a number other than zero.`);
    if (!line.amounts.includes(Math.abs(cents(amount)))) return no(`${money(Math.abs(amount))} isn't printed on ${line.ref} ("${line.text}"). Cite the line it is printed on.`);
    if (!description) return no(`Give the description of the figure on ${line.ref}, as printed.`);
    missing.push({ description, amount: cents(amount) / 100, page: line.page, printed: line.text });
  }

  const misread: MisreadFigure[] = [];
  for (const m of misreadRaw) {
    const target = String(m.target).trim();
    const lineIndex = /^line\.(\d+)$/.exec(target) ? Number(target.slice(5)) - 1 : -1;
    const billLine = lineIndex >= 0 ? ctx.f.lines[lineIndex] : undefined;
    const what = target === 'tax' ? { target: 'tax' as const, line: null, label: 'Tax', has: ctx.f.tax ?? 0 }
      : target === 'total' && ctx.f.total !== null ? { target: 'total' as const, line: null, label: 'Total', has: ctx.f.total }
      : billLine && billLine.amount !== null ? { target: 'line' as const, line: lineIndex, label: billLine.description || `Line ${lineIndex + 1}`, has: billLine.amount }
      : null;
    if (!what) return no(`${target} isn't a figure on the bill. Use line.N, tax or total.`);
    if (misread.some((x) => x.target === what.target && x.line === what.line)) return no(`${target} is named twice.`);
    const from = Number(m.billHas);
    const to = Number(m.printed);
    if (!Number.isFinite(from) || Math.abs(cents(from) - cents(what.has)) > 1) return no(`The bill has ${money(what.has)} for ${target}, not ${Number.isFinite(from) ? money(from) : String(m.billHas)}.`);
    const line = ctx.doc.get(String(m.ref));
    if (!line) return no(`${String(m.ref)} isn't a line of the document. Cite the ref of the line the amount is printed on, like p1.L12.`);
    if (!Number.isFinite(to) || !line.amounts.includes(Math.abs(cents(to)))) return no(`${Number.isFinite(to) ? money(Math.abs(to)) : String(m.printed)} isn't printed on ${line.ref} ("${line.text}"). Cite the line it is printed on.`);
    if (cents(to) === cents(what.has)) return no(`The document prints the ${money(to)} the bill has for ${target}: that isn't a misread.`);
    misread.push({ target: what.target, line: what.line, label: what.label, from: cents(what.has) / 100, to: cents(to) / 100, page: line.page, printed: line.text });
  }

  if (missing.length + misread.length === 0) return no(`${verdict} needs at least one figure. Name them, or answer unsure.`);
  const after = closure(ctx.f, missing, misread);
  if (Math.abs(after.diff) > 1) {
    return no(`With those, the lines (${moneyCents(after.lines)}) plus tax (${moneyCents(after.tax)}) come to ${moneyCents(after.lines + after.tax)}, but the total is ${moneyCents(after.total)}: still ${moneyCents(Math.abs(after.diff))} ${after.diff > 0 ? 'short' : 'over'}. Find what else explains it, or answer unsure.`);
  }
  if (after.total <= 0) return no('That leaves nothing to pay, which is not a correction.');
  return { ok: true, verdict: missing.length > 0 ? 'missed' : 'misread', missing, misread, reason };
}

export type Investigation = Omit<ArithmeticCheck, 'fingerprint' | 'at' | 'suggestionId'>;

/** Read the document beside the figures and name what explains the gap. Never throws. */
export async function investigateFigures(args: {
  f: BillFigures;
  doc: { lines: DocLine[]; source: 'text' | 'ocr' } | null;
  gap: number;
  vendorName: string;
  invoiceNumber: string | null;
}): Promise<Investigation> {
  const empty = { missing: [], misread: [], reason: '' };
  if (!args.doc || args.doc.lines.length === 0) {
    return { status: 'ready', verdict: 'unsure', ...empty, dropped: 'No text could be read from the document.', source: args.doc?.source ?? null, model: null, latencyMs: null, costUsd: null };
  }
  const ctx: Context = figuresContext(args.doc.lines, args.f) ?? { f: args.f, doc: new Map(), gap: args.gap, found: { notOnBill: [], notPrinted: [] } };
  const run = await runAgent({
    label: 'arithmetic',
    system: SYSTEM,
    user: promptFor({ ...args, doc: args.doc.lines, source: args.doc.source }, ctx),
    tools: [{
      name: 'submit_finding',
      description: "Finish: why the bill's figures don't add up, with every figure that explains the gap.",
      terminal: true,
      parameters: FINDING_SCHEMA as unknown as Record<string, unknown>,
    }],
    maxTurns: 4,
    maxOutputTokens: 1200,
    checkTerminal: async (a) => {
      const judged = judgeFinding(a, ctx, true);
      return judged.ok ? null : judged.problem;
    },
  });
  const spent = { source: args.doc.source, model: run.model, latencyMs: run.latencyMs, costUsd: run.costUsd };
  if (!run.ok) return { status: 'failed', verdict: 'unsure', ...empty, dropped: run.error, ...spent };
  const judged = judgeFinding(run.terminal.args, ctx, false);
  if (!judged.ok) return { status: 'ready', verdict: 'unsure', ...empty, dropped: judged.problem, ...spent };
  return { status: 'ready', verdict: judged.verdict, missing: judged.missing, misread: judged.misread, reason: judged.reason, dropped: null, ...spent };
}

// ─── Kept on the bill ───────────────────────────────────────────────────────

export function readArithmeticCheck(metadataJson: unknown): ArithmeticCheck | null {
  if (!isObject(metadataJson)) return null;
  const c = metadataJson.arithmeticCheck;
  if (!isObject(c) || typeof c.fingerprint !== 'string' || typeof c.verdict !== 'string') return null;
  return {
    ...(c as unknown as ArithmeticCheck),
    missing: Array.isArray(c.missing) ? (c.missing as MissingFigure[]) : [],
    misread: Array.isArray(c.misread) ? (c.misread as MisreadFigure[]) : [],
  };
}

/** Whether the figures need checking: none made on them, or the last one failed a while ago. */
export function needsCheck(check: ArithmeticCheck | null, fingerprint: string, now = Date.now()): boolean {
  if (!check || check.fingerprint !== fingerprint) return true;
  return check.status === 'failed' && now - Date.parse(check.at) > RETRY_FAILED_AFTER_MS;
}

/** Bills being checked now. One at a time per bill. */
const running = new Set<string>();

export function isCheckingFigures(billId: string): boolean {
  return running.has(billId);
}

/** No key, no check: the flag keeps its plain finding. */
export function canCheckFigures(): boolean {
  return isExceptionAgentConfigured();
}

/**
 * Check a bill's figures against its document, in the background, once per
 * set of figures. Started after intake and when the bill is opened with an
 * arithmetic flag up (getBillDraft); never from the board.
 */
export function startFiguresCheck(organizationId: string, billId: string): void {
  if (running.has(billId) || !canCheckFigures()) return;
  running.add(billId);
  trackBackgroundWork((async () => {
    try {
      await checkBill(organizationId, billId);
    } catch (error) {
      logger.warn('arithmetic_check.failed', { billId, ...(error instanceof Error ? { message: error.message } : {}) });
    } finally {
      running.delete(billId);
    }
  })());
}

async function checkBill(organizationId: string, billId: string): Promise<void> {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId: billId },
    select: {
      state: true, invoiceNumber: true, invoiceDocumentId: true, metadataJson: true,
      counterparty: { select: { displayName: true } },
      counterpartyWallet: { select: { label: true } },
    },
  });
  if (!order || order.state !== 'draft') return;
  const { billFiguresOf } = await import('../payments/bills.js');
  const f = billFiguresOf(order.metadataJson);
  const documentId = billDocumentIdOf(order);
  const fingerprint = figuresFingerprint(documentId, f);
  const gap = gapOf(f);
  if (!documentId || gap === null || Math.abs(gap) < 1) return;
  if (!needsCheck(readArithmeticCheck(order.metadataJson), fingerprint)) return;

  const vendorName = order.counterparty?.displayName ?? order.counterpartyWallet.label;
  const doc = await readDocument(organizationId, documentId).catch(() => null);
  const found = await investigateFigures({ f, doc, gap, vendorName, invoiceNumber: order.invoiceNumber });
  const suggestionId = found.status === 'ready' && found.verdict !== 'unsure'
    ? await logSuggestion({
      organizationId,
      stage: 'exception_brief',
      subjectType: 'bill',
      subjectId: billId,
      suggested: { flag: 'arithmetic', verdict: found.verdict, missing: found.missing, misread: found.misread, reason: found.reason },
      producer: `arithmetic@${found.model ?? 'unknown'}`,
      inputs: { fingerprint, gapCents: gap, figures: f, source: found.source },
    })
    : null;
  const check: ArithmeticCheck = { fingerprint, at: new Date().toISOString(), ...found, suggestionId };
  // Merged into the bill in place, never read and written back: a person
  // saving the bill while the document was read must not lose their save.
  await prisma.$executeRaw`
    UPDATE payment_orders
       SET metadata_json = jsonb_set(metadata_json, '{arithmeticCheck}', ${JSON.stringify(check)}::jsonb, true)
     WHERE organization_id = ${organizationId}::uuid AND payment_order_id = ${billId}::uuid`;
}

// ─── What the bill's page shows ─────────────────────────────────────────────

/** The correction a check found, if it still closes the gap on these figures. Null otherwise. */
export function correctionOf(check: ArithmeticCheck, f: BillFigures): FigureCorrection | null {
  if (check.status !== 'ready' || (check.verdict !== 'missed' && check.verdict !== 'misread')) return null;
  if (check.missing.length + check.misread.length === 0) return null;
  const after = closure(f, check.missing, check.misread);
  if (Math.abs(after.diff) > 1 || after.total <= 0) return null;
  return {
    fingerprint: check.fingerprint,
    add: check.missing.map((m) => ({ description: m.description, amount: m.amount, page: m.page })),
    change: check.misread.map((m) => ({ what: m.target, line: m.line, label: m.label, from: m.from, to: m.to, page: m.page })),
    total: after.total / 100,
  };
}

/** The correction in a few words: "add Freight, $85.00, from page 1", or once made, "added …". */
export function correctionWords(c: FigureCorrection, made = false): string {
  const parts = [
    ...c.add.map((a) => `${made ? 'added' : 'add'} “${a.description}”, ${money(a.amount)}, from page ${a.page}`),
    ...c.change.map((m) => `${made ? 'changed' : 'change'} ${m.what === 'line' ? `“${m.label}”` : `the ${m.label.toLowerCase()}`} from ${money(m.from)} to ${money(m.to)}, as page ${m.page} prints it`),
  ];
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1]}`;
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The finding for an arithmetic flag, from the check made on these figures.
 * While it is being made, says so. When it found nothing, or failed, the
 * flag's plain finding stands.
 */
export function figuresFinding(args: {
  check: ArithmeticCheck | null;
  checking: boolean;
  f: BillFigures;
  vendorName: string;
  plain: FlagFinding | null;
}): FlagFinding | null {
  const { check, f, plain } = args;
  const gap = gapOf(f);
  if (!check) {
    if (!args.checking || gap === null) return plain;
    return {
      status: 'running',
      headline: `The lines and tax are ${moneyCents(Math.abs(gap))} ${gap > 0 ? 'short of' : 'over'} the total. Reading the document to find out why…`,
      points: [],
      recommended: null,
    };
  }
  const tax = f.tax ?? 0;
  const withTax = tax !== 0 ? ' and tax' : '';
  if (check.status === 'ready' && check.verdict === 'document_error' && gap !== null && f.total !== null) {
    const added = f.total - gap / 100;
    return {
      status: 'ready',
      headline: `Every figure was read as printed: the document disagrees with itself. Its lines${withTax} come to ${money(added)}, but its total says ${money(f.total)}. Ask ${args.vendorName} which is right.`,
      points: [
        { text: `Decimal read the whole document: no charge, discount or line on it explains the ${moneyCents(Math.abs(gap))}.`, tone: 'ok' },
        ...(plain?.points ?? []),
      ],
      recommended: { action: 'ask_someone', reason: `On the bill from ${args.vendorName}, the lines${withTax} come to ${money(added)}, but the total says ${money(f.total)}. Which is right?` },
    };
  }
  const correction = correctionOf(check, f);
  if (!correction) {
    if (check.status !== 'ready' || !plain) return plain;
    return {
      ...plain,
      points: [...plain.points, { text: 'Decimal read the document and found nothing on it that explains the gap.', tone: 'warn' }],
    };
  }

  const total = money(correction.total);
  const points: FindingPoint[] = [
    ...check.missing.map((m) => ({ text: `Page ${m.page} prints “${m.printed}”, and the bill doesn’t have it.`, tone: 'warn' as const })),
    ...check.misread.map((m) => ({ text: `Page ${m.page} prints “${m.printed}”. The bill has ${money(m.from)} for ${m.target === 'line' ? `“${m.label}”` : m.label.toLowerCase()}.`, tone: 'bad' as const })),
    { text: `Once corrected, the lines${withTax} come to ${total}, the total on the document.`, tone: 'ok' },
  ];
  const n = check.missing.length;
  const pages = [...new Set(check.missing.map((m) => m.page))];
  const headline = check.misread.length === 0
    ? n === 1
      ? `“${check.missing[0]!.description}”, ${money(check.missing[0]!.amount)}, is on the document (page ${check.missing[0]!.page}) but not on the bill. With it, the bill comes to ${total}, the document’s total.`
      : `${plural(n, 'figure')} on the document (${pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(', ')}`}) aren’t on the bill, ${money(check.missing.reduce((s, m) => s + m.amount, 0))} in all. With them, the bill comes to ${total}, the document’s total.`
    : n === 0 && check.misread.length === 1
      ? `${check.misread[0]!.target === 'line' ? `“${check.misread[0]!.label}”` : `The ${check.misread[0]!.label.toLowerCase()}`} is ${money(check.misread[0]!.from)} on the bill, but the document prints ${money(check.misread[0]!.to)} (page ${check.misread[0]!.page}). With that, the bill comes to ${total}, the document’s total.`
      : `${n > 0 ? `${plural(n, 'figure')} on the document ${n === 1 ? 'isn’t' : 'aren’t'} on the bill, and ${plural(check.misread.length, 'figure')} on the bill ${check.misread.length === 1 ? 'differs' : 'differ'} from it` : `${plural(check.misread.length, 'figure')} on the bill differ from the document`}. Once corrected, the bill comes to ${total}, the document’s total.`;
  return {
    status: 'ready',
    headline,
    points,
    recommended: { action: 'fix_fields', reason: `${upperFirst(correctionWords(correction))}.` },
    correction,
  };
}
