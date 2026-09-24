// The deterministic half of the duplicate investigator.
//
// Everything here is plain code with no model in it, and that is the point:
// arithmetic, matching and "which action does this verdict mean for THIS bill"
// are not things to ask a language model. The model reads what these return and
// judges; it never computes a difference or names an action.
import { createHash } from 'node:crypto';

// ---- bill facts ------------------------------------------------------------

export type BillLine = { description: string; quantity: number | null; unitPrice: number | null; amount: number | null };

export type BillFacts = {
  id: string;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  poNumber: string | null;
  currency: string;
  subtotal: number | null;
  tax: number | null;
  total: number;
  lines: BillLine[];
  state: string;
  uploadedAt: string;
  /** Whether a person has confirmed the values, as opposed to the raw read. */
  confirmed: boolean;
  documentFilename: string | null;
};

export type BillRow = {
  paymentOrderId: string;
  invoiceNumber: string | null;
  amountRaw: bigint;
  state: string;
  createdAt: Date;
  metadataJson: unknown;
  counterparty?: { displayName: string } | null;
  invoiceDocument?: { filename: string } | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The bill as the draft screen shows it. Same precedence as `getBillDraft`:
 * values a person confirmed (`verification`) win over the raw extraction, and
 * the order's own amount is the total of record.
 */
export function billFactsFrom(row: BillRow): BillFacts {
  const meta = isRecord(row.metadataJson) ? row.metadataJson : {};
  const agent = isRecord(meta.agent) ? meta.agent : {};
  const extracted = isRecord(agent.extracted) ? agent.extracted : {};
  const verification = isRecord(meta.verification) ? meta.verification : null;
  const vf = verification && isRecord(verification.fields) ? verification.fields : null;
  const pick = (key: string, fallback: unknown) => (vf && key in vf ? vf[key] : fallback);

  const verifiedLines = verification && Array.isArray(verification.lines) ? (verification.lines as unknown[]) : null;
  const rawLines = verifiedLines ?? (Array.isArray(extracted.lineItems) ? (extracted.lineItems as unknown[]) : []);
  const lines: BillLine[] = rawLines.filter(isRecord).map((l) => ({
    description: str(l.description) ?? '',
    quantity: num(l.quantity),
    unitPrice: num(l.unitPrice),
    // Confirmed lines call it `amount`, extracted ones `total`.
    amount: num(l.amount) ?? num(l.total),
  }));

  return {
    id: row.paymentOrderId,
    vendorName: str(pick('vendorName', extracted.vendorName)) ?? row.counterparty?.displayName ?? null,
    invoiceNumber: str(pick('invoiceNumber', extracted.invoiceNumber)) ?? row.invoiceNumber,
    invoiceDate: str(pick('invoiceDate', extracted.invoiceDate)),
    dueDate: str(pick('dueDate', extracted.dueDate)),
    poNumber: str(pick('poNumber', extracted.poNumber)),
    currency: (str(pick('currency', extracted.currency)) ?? 'USD').toUpperCase(),
    subtotal: num(extracted.subtotal),
    tax: num(pick('taxAmount', extracted.taxAmount)),
    total: Number(row.amountRaw) / 1_000_000,
    lines,
    state: row.state,
    uploadedAt: row.createdAt.toISOString(),
    confirmed: Boolean(verification && verification.confirmedAt),
    documentFilename: row.invoiceDocument?.filename ?? null,
  };
}

// ---- comparison ------------------------------------------------------------

const cents = (n: number | null) => (n === null ? null : Math.round(n * 100));
const normDesc = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const normNumber = (s: string | null) => (s ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : null);

export type LineMatch = { a: number; b: number; description: string; amountA: number | null; amountB: number | null; delta: number | null };

export type BillComparison = {
  /** Every figure, line and date agrees. The strongest evidence of a duplicate. */
  identical: boolean;
  sameInvoiceNumber: boolean | null;
  sameInvoiceDate: boolean | null;
  samePoNumber: boolean | null;
  totals: { a: number; b: number; delta: number };
  subtotal: { a: number | null; b: number | null; delta: number | null };
  tax: { a: number | null; b: number | null; delta: number | null };
  /** Which component accounts for the whole difference in totals, if any. */
  totalDifferenceExplainedBy: 'no_difference' | 'tax' | 'subtotal' | 'lines' | 'unexplained';
  lines: { matched: LineMatch[]; onlyInA: number[]; onlyInB: number[] };
};

const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : (Math.round(b * 100) - Math.round(a * 100)) / 100);
const sameOrNull = (a: string | null, b: string | null) => (a === null || b === null ? null : a === b);

/**
 * Line-by-line and figure-by-figure diff of two bills.
 *
 * Lines pair up only on the same description (case and punctuation aside).
 * Lines worded differently are left unmatched on purpose: whether "Consulting,
 * phase 1" and "Advisory services" are the same work is a judgement, and
 * guessing a pairing here would hand the model a fact that isn't one.
 */
export function compareBills(a: BillFacts, b: BillFacts): BillComparison {
  const usedB = new Set<number>();
  const matched: LineMatch[] = [];
  const onlyInA: number[] = [];
  a.lines.forEach((la, i) => {
    const key = normDesc(la.description);
    const j = b.lines.findIndex((lb, idx) => !usedB.has(idx) && key !== '' && normDesc(lb.description) === key);
    if (j === -1) { onlyInA.push(i); return; }
    usedB.add(j);
    matched.push({ a: i, b: j, description: la.description, amountA: la.amount, amountB: b.lines[j]!.amount, delta: delta(la.amount, b.lines[j]!.amount) });
  });
  const onlyInB = b.lines.map((_, j) => j).filter((j) => !usedB.has(j));

  const totalDelta = delta(a.total, b.total) ?? 0;
  const taxDelta = delta(a.tax ?? 0, b.tax ?? 0) ?? 0;
  const subtotalDelta = delta(a.subtotal, b.subtotal);
  const lineDeltaSum = matched.reduce((s, m) => s + (m.delta ?? 0), 0);

  let explainedBy: BillComparison['totalDifferenceExplainedBy'];
  if (totalDelta === 0) explainedBy = 'no_difference';
  else if (cents(taxDelta) === cents(totalDelta) && (subtotalDelta === null || subtotalDelta === 0)) explainedBy = 'tax';
  else if (subtotalDelta !== null && cents(subtotalDelta) === cents(totalDelta) && taxDelta === 0) explainedBy = 'subtotal';
  else if (onlyInA.length === 0 && onlyInB.length === 0 && cents(lineDeltaSum) === cents(totalDelta)) explainedBy = 'lines';
  else explainedBy = 'unexplained';

  const sameInvoiceNumber = (() => {
    const na = normNumber(a.invoiceNumber); const nb = normNumber(b.invoiceNumber);
    return na === null || nb === null ? null : na === nb;
  })();
  const sameInvoiceDate = sameOrNull(a.invoiceDate, b.invoiceDate);
  const samePoNumber = sameOrNull(normNumber(a.poNumber), normNumber(b.poNumber));

  const identical = totalDelta === 0
    && (taxDelta === 0)
    && onlyInA.length === 0 && onlyInB.length === 0
    && matched.every((m) => m.delta === 0 || m.delta === null)
    && a.lines.length === b.lines.length
    && sameInvoiceNumber !== false
    && sameInvoiceDate !== false;

  return {
    identical,
    sameInvoiceNumber,
    sameInvoiceDate,
    samePoNumber,
    totals: { a: a.total, b: b.total, delta: totalDelta },
    subtotal: { a: a.subtotal, b: b.subtotal, delta: subtotalDelta },
    tax: { a: a.tax, b: b.tax, delta: delta(a.tax, b.tax) },
    totalDifferenceExplainedBy: explainedBy,
    lines: { matched, onlyInA, onlyInB },
  };
}

// ---- pair identity and staleness -------------------------------------------

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The same key from either bill: the two ids, sorted. */
export function pairKey(idA: string, idB: string): string {
  return sha256([idA, idB].sort().join('|'));
}

export type FingerprintSide = {
  id: string;
  invoiceNumber: string | null;
  amountRaw: bigint;
  counterpartyId: string | null;
  state: string;
  hasOverride: boolean;
};

/**
 * What the investigation depended on. Duplicates are recomputed live on every
 * read, so a brief can go stale with neither bill edited: a twin changes state,
 * or one side is cleared. Whether each side is overridden is in here because
 * clearing one bill is exactly the kind of change that should refresh the brief
 * its twin shows.
 */
export function pairFingerprint(a: FingerprintSide, b: FingerprintSide): string {
  const side = (s: FingerprintSide) => [s.id, normNumber(s.invoiceNumber) ?? '', s.amountRaw.toString(), s.counterpartyId ?? '', s.state, s.hasOverride ? '1' : '0'].join(':');
  return sha256([a, b].sort((x, y) => (x.id < y.id ? -1 : 1)).map(side).join('|'));
}

/** Older and newer by upload time; the id breaks an exact tie so it is stable. */
export function sideOf(thisBill: { id: string; createdAt: Date }, other: { id: string; createdAt: Date }): 'older' | 'newer' {
  const t = thisBill.createdAt.getTime(); const o = other.createdAt.getTime();
  if (t !== o) return t < o ? 'older' : 'newer';
  return thisBill.id < other.id ? 'older' : 'newer';
}

// ---- verdict → action ------------------------------------------------------

export const VERDICTS = ['duplicate', 'replacement', 'not_duplicate', 'unsure'] as const;
export type Verdict = (typeof VERDICTS)[number];
export type RecommendedAction = 'clear_duplicate' | 'not_ours' | 'ask_someone';

/**
 * What the verdict means for THIS bill. Decided here, never by the model.
 *
 *   duplicate    keep the older, close the newer copy
 *   replacement  keep the newer (it corrects the original), close the older
 *   not_duplicate  clear both
 *   unsure       ask on both
 *
 * Safe even if only one side is ever acted on: a clearance is per bill, so the
 * twin stays blocked until someone deals with it, and nothing is paid twice.
 */
export function recommendationFor(verdict: Verdict, side: 'older' | 'newer'): RecommendedAction {
  switch (verdict) {
    case 'duplicate': return side === 'older' ? 'clear_duplicate' : 'not_ours';
    case 'replacement': return side === 'newer' ? 'clear_duplicate' : 'not_ours';
    case 'not_duplicate': return 'clear_duplicate';
    case 'unsure': return 'ask_someone';
  }
}

// ---- the model's finding, checked ------------------------------------------

export type Confidence = 'high' | 'medium' | 'low';
export type Finding = { claim: string; refs: string[] };

export type ValidatedFinding = {
  verdict: Verdict;
  headline: string;
  reason: string;
  findings: Finding[];
  checked: string[];
  couldNotCheck: string[];
  confidence: Confidence;
  /** What the validator changed, and why. Kept so a downgrade is explainable. */
  adjustments: string[];
};

const clampText = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const textList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => clampText(x, maxLen)).filter(Boolean).slice(0, maxItems);

/**
 * Refs belong in the refs list, not the sentence. A model that writes
 * "(refs: this.total, compare.lines)" into a claim has put internal ids on a
 * screen a finance person reads; the prompt asks it not to, and this makes
 * sure — a prompt is a request, this is the guarantee.
 */
export function stripInlineRefs(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\s*[([]\s*(?:refs?|sources?|see|evidence)\s*:[^)\]]*[)\]]/gi, '')
    .replace(/\b(?:this|other|compare|history)\.[A-Za-z0-9_.]+/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Trust nothing the model says (the same rule as `sanitizeFlow`).
 *
 *  - A finding survives only if it cites evidence a tool actually returned in
 *    this run. Invented references are dropped, not believed.
 *  - No surviving evidence means no verdict worth acting on: `unsure`.
 *  - Figures that contradict the verdict cap its confidence. Identical bills
 *    called anything but a duplicate, or a "duplicate" whose totals differ, are
 *    shown as low confidence however sure the model sounded.
 */
export function validateFinding(
  raw: Record<string, unknown>,
  seenRefs: ReadonlySet<string>,
  comparison: BillComparison | null,
  fallbackHeadline: string,
): ValidatedFinding {
  const adjustments: string[] = [];
  let verdict: Verdict = (VERDICTS as readonly string[]).includes(raw.verdict as string) ? (raw.verdict as Verdict) : 'unsure';
  if (verdict !== raw.verdict) adjustments.push('unknown verdict read as unsure');
  let confidence: Confidence = raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low' ? raw.confidence : 'low';

  const rawFindings = Array.isArray(raw.findings) ? raw.findings : [];
  let dropped = 0;
  const findings: Finding[] = [];
  for (const f of rawFindings) {
    if (!isRecord(f)) { dropped += 1; continue; }
    const claim = clampText(stripInlineRefs(f.claim), 240);
    const refs = (Array.isArray(f.refs) ? f.refs : []).filter((r): r is string => typeof r === 'string' && seenRefs.has(r));
    if (!claim || refs.length === 0) { dropped += 1; continue; }
    findings.push({ claim, refs: [...new Set(refs)] });
  }
  if (dropped > 0) adjustments.push(`${dropped} finding(s) dropped for citing evidence no tool returned`);
  findings.splice(6);

  if (findings.length === 0 && verdict !== 'unsure') {
    verdict = 'unsure';
    confidence = 'low';
    adjustments.push('no finding cited real evidence, so the verdict is unsure');
  }
  if (comparison?.identical && verdict !== 'duplicate' && confidence !== 'low') {
    confidence = 'low';
    adjustments.push('the bills are identical line for line, which contradicts this verdict');
  }
  if (verdict === 'duplicate' && comparison && comparison.totals.delta !== 0 && confidence !== 'low') {
    confidence = 'low';
    adjustments.push('the totals differ, which a true duplicate would not');
  }

  const headline = clampText(raw.headline, 120) || fallbackHeadline.slice(0, 120);
  let reason = clampText(raw.reason, 300);
  if (reason.length < 3) reason = headline;

  return {
    verdict,
    headline,
    reason,
    findings,
    checked: textList(raw.checked, 8, 160),
    couldNotCheck: textList(raw.couldNotCheck, 8, 160),
    confidence,
    adjustments,
  };
}
