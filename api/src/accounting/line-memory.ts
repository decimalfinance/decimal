// Line memory: a line's category comes from what the team did with the same
// line from the same vendor.
//
// The unit of learning is the VENDOR + LINE: a line's description, on a bill
// from that vendor, and the category a person settled on for it (Zaid,
// 2026-10-19). Per line, because a vendor sells different things: stock
// photography and an analytics retainer on one invoice go to different
// categories. Per vendor, because the same words are different purchases from
// different vendors: an "Annual license" from a software company is a
// subscription, from the city a permit. Nobody teaches anything explicitly
// (Zaid, 2026-10-01):
//
//   - every line on a CONFIRMED bill is a precedent (confirming is agreeing);
//   - on a SAVED draft, a line whose category a person CHANGED from what the
//     screen proposed is a precedent too (a deliberate correction, before the
//     bill is finished);
//   - what a finished setup learned from the company's own books is too
//     (books-lines.ts), so a vendor's first bill here is known. A person's later
//     decision outranks it by being newer.
//
// A new line takes the category of the closest precedent from the same vendor
// when the two read as the same thing (same words once quantities, dates and
// months are dropped). Deterministic and explainable: the screen can say which
// bill it is like. Other vendors' lines are only ever shown to the model, as a
// hint for its guess (relevantPrecedents), and a guess stays a guess.
import { errorToLogFields, logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { linesFromTheBooks } from './books-lines.js';
import { lineKey, lineSimilarity, lineTokens, vendorLine } from './line-words.js';

export { lineKey, lineSimilarity, lineTokens };

export type Precedent = {
  key: string;
  description: string;
  tokens: Set<string>;
  category: string;
  /** The vendor of the bill it was settled on. A line is learned per vendor. */
  counterpartyId: string | null;
  vendorName: string | null;
  /** The bill it was settled on. Null when it came from the books. */
  paymentOrderId: string | null;
  invoiceNumber: string | null;
  byUserId: string | null;
  at: number;
  confirmed: boolean;
  /** How many lines it stands for, when it isn't one. */
  lines?: number;
  /** The system it was learned from, when it came from the books. */
  books?: string;
};

export type LineMatch = {
  category: string;
  /** The precedent's own description, as a person saw it. */
  like: string;
  paymentOrderId: string | null;
  invoiceNumber: string | null;
  byUserId: string | null;
  score: number;
  books: string | null;
};

/** Two lines at or above this similarity read as the same thing. */
export const SAME_LINE = 0.6;
const PRECEDENT_BILLS = 500;

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Every line a person settled in this organisation, and what its books taught, newest first. */
export async function loadPrecedents(organizationId: string, opts: { excludeBillId?: string } = {}): Promise<Precedent[]> {
  const forgotten = new Map((await prisma.forgottenLine.findMany({ where: { organizationId }, select: { counterpartyId: true, lineKey: true, forgottenAt: true } }))
    .map((f) => [vendorLine(f.counterpartyId, f.lineKey), f.forgottenAt.getTime()]));
  const orders = await prisma.paymentOrder.findMany({
    where: { organizationId, state: { not: 'cancelled' }, ...(opts.excludeBillId ? { paymentOrderId: { not: opts.excludeBillId } } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: PRECEDENT_BILLS,
    select: {
      paymentOrderId: true, invoiceNumber: true, metadataJson: true, updatedAt: true,
      counterpartyId: true, counterparty: { select: { displayName: true } },
    },
  });
  const out: Precedent[] = [];
  for (const o of orders) {
    const meta = rec(o.metadataJson);
    const v = rec(meta?.verification);
    if (!v || !Array.isArray(v.lines)) continue;
    const confirmed = Boolean(v.confirmedAt);
    const proposed = Array.isArray(meta?.proposedLineCategories) ? meta!.proposedLineCategories as Array<Record<string, unknown>> : [];
    const at = Date.parse(String(v.confirmedAt ?? v.savedAt ?? '')) || o.updatedAt.getTime();
    const by = text(v.confirmedByUserId) ?? text(v.savedByUserId);
    for (const [i, raw] of (v.lines as unknown[]).entries()) {
      const line = rec(raw);
      const description = text(line?.description);
      const category = text(line?.category);
      if (!description || !category) continue;
      if (!confirmed) {
        // A saved draft teaches only what a person deliberately changed.
        const was = proposed.find((p) => Number(p.index) === i);
        if (!was || text(was.category) === category) continue;
      }
      const tokens = lineTokens(description);
      if (tokens.size === 0) continue;
      const key = [...tokens].sort().join(' ');
      // Told to forget this vendor's kind of line: only what was settled after counts.
      const forgottenAt = forgotten.get(vendorLine(o.counterpartyId, key));
      if (forgottenAt !== undefined && at <= forgottenAt) continue;
      out.push({
        key, description, tokens, category,
        counterpartyId: o.counterpartyId, vendorName: o.counterparty?.displayName ?? null,
        paymentOrderId: o.paymentOrderId, invoiceNumber: o.invoiceNumber, byUserId: by, at, confirmed,
      });
    }
  }
  const books = await linesFromTheBooks(organizationId).catch((error) => {
    logger.warn('line_memory.books_lines_failed', { organizationId, ...errorToLogFields(error) });
    return { precedents: [] as Precedent[], askEachTime: new Set<string>() };
  });
  const remembered = books.precedents.filter((p) => {
    const forgottenAt = forgotten.get(vendorLine(p.counterpartyId, p.key));
    return forgottenAt === undefined || p.at > forgottenAt;
  });
  return [...out, ...remembered]
    .filter((p) => !books.askEachTime.has(vendorLine(p.counterpartyId, p.key)))
    .sort((a, b) => b.at - a.at);
}

/**
 * The precedent for a line on a bill from this vendor, if one of the vendor's
 * settled lines reads as the same thing. Never another vendor's: the same
 * words can be a different purchase. The closest wins; among equally close
 * ones, the most recent — the team's latest decision. A bill with no vendor
 * has nothing to match.
 */
export function matchLine(description: string, precedents: Precedent[], counterpartyId: string | null): LineMatch | null {
  if (!counterpartyId) return null;
  const tokens = lineTokens(description);
  if (tokens.size === 0) return null;
  let best: { p: Precedent; score: number } | null = null;
  for (const p of precedents) {
    if (p.counterpartyId !== counterpartyId) continue;
    const score = lineSimilarity(tokens, p.tokens);
    if (score < SAME_LINE) continue;
    if (!best || score > best.score) best = { p, score }; // newest first, so ties keep the newer
  }
  if (!best) return null;
  return {
    category: best.p.category,
    like: best.p.description,
    paymentOrderId: best.p.paymentOrderId,
    invoiceNumber: best.p.invoiceNumber,
    byUserId: best.p.byUserId,
    score: Math.round(best.score * 100) / 100,
    books: best.p.books ?? null,
  };
}

/**
 * The precedents worth showing the model for a new bill's lines, from any
 * vendor: a hint for its guess, never a known category (that is matchLine,
 * within one vendor). One per kind of line (the newest decision). Those sharing words with a new line come
 * first (most shared, then newest); the rest of the room goes to the newest
 * others, because "Typeface licence" and "Font license" share no word and are
 * the same purchase — word overlap finds candidates, the model judges them. These are for lines that
 * are SIMILAR but not the same — the model judges whether a "Font license —
 * web use" is the same kind of purchase as a "Font license — campaign use";
 * lines that read the same are matched in code (matchLine) and never asked.
 */
export function relevantPrecedents(lines: string[], precedents: Precedent[], max = 25): Array<{ description: string; category: string }> {
  const wanted = lines.map(lineTokens).filter((t) => t.size > 0);
  if (wanted.length === 0) return [];
  const seen = new Set<string>();
  const scored: Array<{ p: Precedent; shared: number }> = [];
  for (const p of precedents) {             // newest first
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    let shared = 0;
    for (const t of wanted) {
      let n = 0;
      for (const w of p.tokens) if (t.has(w)) n += 1;
      shared = Math.max(shared, n);
    }
    scored.push({ p, shared });
  }
  return scored
    .sort((a, b) => b.shared - a.shared || b.p.at - a.p.at)
    .slice(0, max)
    .map(({ p }) => ({ description: p.description, category: p.category }));
}
