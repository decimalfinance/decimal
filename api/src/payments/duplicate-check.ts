// Duplicate-bill gate (policy P0 — SYNTHESIS-decimal-policies.md).
// On irreversible rails a duplicate payment is gone, not recalled, so this is
// a BLOCK with a logged override, never a dismissable toast. Checked twice:
// at Review (flag + confirm gate) and again at release (a twin may have been
// paid while this bill sat in approval).
//
// Match rules, scoped to the same vendor (counterparty, falling back to the
// destination wallet for vendor-less orders):
//   1. same_invoice_number — normalized invoice numbers match. The classic.
//   2. same_amount_near_date — same exact amount within a 14-day window.
//      Monthly recurring bills (~30 days apart) clear the window; a true
//      resubmission lands inside it. Overridable when it's legitimate.
import { prisma } from '../infra/prisma.js';

export type DuplicateMatch = {
  paymentOrderId: string;
  invoiceNumber: string | null;
  amountRaw: bigint;
  state: string;
  createdAt: Date;
  matchKind: 'same_invoice_number' | 'same_amount_near_date';
};

export function normalizeInvoiceNumber(value: string | null | undefined): string | null {
  const normalized = (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

const NEAR_DATE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export async function findDuplicateBills(organizationId: string, input: {
  excludePaymentOrderId: string;
  counterpartyId: string | null;
  counterpartyWalletId: string;
  invoiceNumber: string | null;
  /** API/CSV orders carry their reference here — same coalesce the DB's
   *  unique index uses. */
  externalReference?: string | null;
  amountRaw: bigint;
  createdAt?: Date;
}): Promise<DuplicateMatch[]> {
  const candidates = await prisma.paymentOrder.findMany({
    where: {
      organizationId,
      paymentOrderId: { not: input.excludePaymentOrderId },
      state: { not: 'cancelled' },
      ...(input.counterpartyId
        ? { counterpartyId: input.counterpartyId }
        : { counterpartyWalletId: input.counterpartyWalletId }),
    },
    select: { paymentOrderId: true, invoiceNumber: true, externalReference: true, amountRaw: true, state: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return matchDuplicates(candidates, input);
}

/** A row this matcher can consider — the shape findDuplicateBills selects. */
export type DuplicateCandidate = {
  paymentOrderId: string;
  invoiceNumber: string | null;
  externalReference: string | null;
  amountRaw: bigint;
  state: string;
  createdAt: Date;
};

/**
 * The matching itself, with no database access.
 *
 * Split out so the workbench can run the SAME rules over payment orders it has
 * already loaded, instead of issuing one query per row — and, more importantly,
 * instead of growing a second, subtly different notion of "duplicate". The
 * caller is responsible for having filtered candidates to the right vendor and
 * excluded the bill under test.
 */
export function matchDuplicates(candidates: DuplicateCandidate[], input: {
  invoiceNumber: string | null;
  externalReference?: string | null;
  amountRaw: bigint;
  createdAt?: Date;
}): DuplicateMatch[] {
  const inv = normalizeInvoiceNumber(input.invoiceNumber ?? input.externalReference ?? null);
  const at = (input.createdAt ?? new Date()).getTime();
  const matches: DuplicateMatch[] = [];
  for (const c of candidates) {
    const cInv = normalizeInvoiceNumber(c.invoiceNumber ?? c.externalReference);
    if (inv && cInv) {
      // Both sides carry an invoice number: it IS the discriminator. Same
      // number = duplicate; different numbers = two real bills, even at the
      // same amount (weekly identical orders are legitimate).
      if (inv === cInv) matches.push({ ...c, matchKind: 'same_invoice_number' });
      continue;
    }
    if (c.amountRaw === input.amountRaw && Math.abs(c.createdAt.getTime() - at) <= NEAR_DATE_WINDOW_MS) {
      matches.push({ ...c, matchKind: 'same_amount_near_date' });
    }
  }
  return matches;
}

export type DuplicateOverride = {
  byUserId: string;
  byName: string;
  reason: string;
  at: string;
  /**
   * The bills this clearance settles. "Not a duplicate" is a statement about a
   * PAIR, so it names the other side. Null on clearances recorded before that
   * was so; see `covers`.
   */
  against: string[] | null;
};

export function readDuplicateOverride(metadata: unknown): DuplicateOverride | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const o = (metadata as Record<string, unknown>).duplicateOverride;
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.byUserId !== 'string' || typeof r.reason !== 'string') return null;
  return {
    byUserId: r.byUserId,
    byName: typeof r.byName === 'string' ? r.byName : 'an admin',
    reason: r.reason,
    at: typeof r.at === 'string' ? r.at : '',
    against: Array.isArray(r.against) ? r.against.filter((x): x is string => typeof x === 'string') : null,
  };
}

// ---- which duplicate pairs a person has settled ----------------------------
//
// A duplicate flag sits on BOTH bills of a pair, and "not a duplicate" answers
// for the pair. Recorded on one bill only, it left the twin blocked on a
// question somebody had already answered — and every place that checks for
// duplicates asked the per-bill question ("is THIS bill cleared?") instead of
// the real one ("has somebody settled THIS PAIR?").
//
// Every duplicate check now asks the real one, here, so the draft flag, the
// workbench, confirm, release and the exception agent cannot disagree.

/** Does a clearance recorded on one bill settle its pairing with `other`? */
function covers(o: DuplicateOverride, other: { paymentOrderId: string; createdAt: Date }): boolean {
  if (o.against) return o.against.includes(other.paymentOrderId);
  // Given before clearances named their bills. It was meant for the bills in
  // front of the person at the time, so it covers those — and nothing uploaded
  // afterwards, which nobody could have looked at.
  const at = Date.parse(o.at);
  return Number.isFinite(at) ? other.createdAt.getTime() <= at : true;
}

export type DuplicateClearance = {
  byName: string;
  reason: string;
  at: string;
  /** Recorded on the bill being evaluated, or on its twin. */
  onThisBill: boolean;
};

export type SettledDuplicates = {
  /** Pairs nobody has settled. Any of these blocks the bill. */
  open: DuplicateMatch[];
  /** Pairs a person settled, and who, and why. */
  cleared: Array<{ match: DuplicateMatch; clearance: DuplicateClearance }>;
};

/**
 * Sort a bill's matches into settled and unsettled, with the other bills'
 * metadata supplied by the caller. For callers that already hold the rows —
 * the workbench — so it costs no query.
 */
export function settleDuplicatesWith(
  bill: { paymentOrderId: string; createdAt: Date; metadataJson: unknown },
  matches: DuplicateMatch[],
  metadataOf: (paymentOrderId: string) => unknown,
): SettledDuplicates {
  const mine = readDuplicateOverride(bill.metadataJson);
  const out: SettledDuplicates = { open: [], cleared: [] };
  for (const match of matches) {
    if (mine && covers(mine, match)) {
      out.cleared.push({ match, clearance: { byName: mine.byName, reason: mine.reason, at: mine.at, onThisBill: true } });
      continue;
    }
    const theirs = readDuplicateOverride(metadataOf(match.paymentOrderId));
    if (theirs && covers(theirs, bill)) {
      out.cleared.push({ match, clearance: { byName: theirs.byName, reason: theirs.reason, at: theirs.at, onThisBill: false } });
      continue;
    }
    out.open.push(match);
  }
  return out;
}

/** The same, fetching the matched bills' metadata in one query. */
export async function settleDuplicates(
  organizationId: string,
  bill: { paymentOrderId: string; createdAt: Date; metadataJson: unknown },
  matches: DuplicateMatch[],
): Promise<SettledDuplicates> {
  if (matches.length === 0) return { open: [], cleared: [] };
  const rows = await prisma.paymentOrder.findMany({
    where: { organizationId, paymentOrderId: { in: matches.map((m) => m.paymentOrderId) } },
    select: { paymentOrderId: true, metadataJson: true },
  });
  const byId = new Map(rows.map((r) => [r.paymentOrderId, r.metadataJson]));
  return settleDuplicatesWith(bill, matches, (id) => byId.get(id));
}

export function describeDuplicate(match: DuplicateMatch): string {
  const amount = (Number(match.amountRaw) / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const when = match.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const ref = match.invoiceNumber ? `invoice ${match.invoiceNumber}` : 'a bill';
  const how = match.matchKind === 'same_invoice_number' ? 'the same invoice number' : `the same amount ($${amount})`;
  return `This looks like a duplicate of ${ref} from this vendor (${when}, $${amount}) — ${how}.`;
}
