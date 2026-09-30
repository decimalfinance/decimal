// Line memory: a line's category comes from what the team did with lines like
// it, not from who sent the bill.
//
// A vendor can sell you stock photography and an analytics retainer on the
// same invoice; "this vendor goes to Marketing" is wrong about one of them. So
// the unit of learning is the LINE: its description, and the category a person
// settled on for it. Nobody teaches anything explicitly (Zaid, 2026-10-01):
//
//   - every line on a CONFIRMED bill is a precedent (confirming is agreeing);
//   - on a SAVED draft, a line whose category a person CHANGED from what the
//     screen proposed is a precedent too (a deliberate correction, before the
//     bill is finished).
//
// A new line takes the category of the closest precedent when the two read as
// the same thing (same words once quantities, dates and months are dropped).
// Deterministic and explainable: the screen can say which bill it is like.
import { prisma } from '../infra/prisma.js';

export type Precedent = {
  key: string;
  description: string;
  tokens: Set<string>;
  category: string;
  paymentOrderId: string;
  invoiceNumber: string | null;
  byUserId: string | null;
  at: number;
  confirmed: boolean;
};

export type LineMatch = {
  category: string;
  /** The precedent's own description, as a person saw it. */
  like: string;
  paymentOrderId: string;
  invoiceNumber: string | null;
  byUserId: string | null;
  score: number;
};

/** Two lines at or above this similarity read as the same thing. */
export const SAME_LINE = 0.6;
const PRECEDENT_BILLS = 500;

const MONTHS = new Set(['jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july',
  'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december']);
const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'to', 'in', 'on', 'with', 'per', 'x', 'at', 'by', 'from', 'qty', 'ea', 'each']);

/** The words that say what a line is: lower-cased, singular, without quantities, dates or months. */
export function lineTokens(description: string): Set<string> {
  const words = description.toLowerCase()
    .replace(/\([^)]*\d[^)]*\)/g, ' ')          // "(8)", "(4 assets)"
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !/\d/.test(w) && !MONTHS.has(w) && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return new Set(words);
}

/** One key per kind of line: its words, sorted. */
export function lineKey(description: string): string {
  return [...lineTokens(description)].sort().join(' ');
}

export function lineSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Every line a person settled in this organisation, newest first. */
export async function loadPrecedents(organizationId: string, opts: { excludeBillId?: string } = {}): Promise<Precedent[]> {
  const forgotten = new Map((await prisma.forgottenLine.findMany({ where: { organizationId }, select: { lineKey: true, forgottenAt: true } }))
    .map((f) => [f.lineKey, f.forgottenAt.getTime()]));
  const orders = await prisma.paymentOrder.findMany({
    where: { organizationId, state: { not: 'cancelled' }, ...(opts.excludeBillId ? { paymentOrderId: { not: opts.excludeBillId } } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: PRECEDENT_BILLS,
    select: { paymentOrderId: true, invoiceNumber: true, metadataJson: true, updatedAt: true },
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
      // Told to forget this kind of line: only what was settled after counts.
      const forgottenAt = forgotten.get(key);
      if (forgottenAt !== undefined && at <= forgottenAt) continue;
      out.push({ key, description, tokens, category, paymentOrderId: o.paymentOrderId, invoiceNumber: o.invoiceNumber, byUserId: by, at, confirmed });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * The precedent for a line, if one reads as the same thing. The closest wins;
 * among equally close ones, the most recent — the team's latest decision.
 */
export function matchLine(description: string, precedents: Precedent[]): LineMatch | null {
  const tokens = lineTokens(description);
  if (tokens.size === 0) return null;
  let best: { p: Precedent; score: number } | null = null;
  for (const p of precedents) {
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
  };
}
