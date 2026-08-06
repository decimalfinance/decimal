// Every reason a bill should give a human pause, in one place.
//
// This module exists because the flags used to be built inline inside
// getBillReview. The workbench, which is the screen you actually use to decide
// what to open, computed its own unrelated notion of "ready" and never
// consulted them — so a bill addressed to another company sat in the list
// reading "Ready for approval". The check existed. It just had no path to that
// screen.
//
// The rule this module enforces: a flag is DEFINED once, here, and every
// surface renders the same set. Adding a flag means adding it in one place and
// having it appear everywhere, rather than remembering all the call sites.
//
// evaluateBillFlags is deliberately PURE — no Prisma, no I/O. Callers gather
// the facts however is cheapest for them (the review screen queries per bill;
// the workbench batches across all rows) and the verdict cannot diverge
// between them, because there is only one copy of the reasoning.
import type { DuplicateMatch, DuplicateOverride } from './duplicate-check.js';
import { describeDuplicate } from './duplicate-check.js';
import type { PayableHold } from './vendor-payable.js';
import { describePayableHold } from './vendor-payable.js';

export type BillFlagSeverity = 'danger' | 'warning' | 'info';

export const BILL_FLAG_KINDS = [
  'payee_mismatch',
  'unreadable_payment_details',
  'addressed_elsewhere',
  'vendor_blocked',
  'vendor_held',
  'over_ceiling',
  'possible_duplicate',
  'new_vendor',
] as const;

export type BillFlagKind = (typeof BILL_FLAG_KINDS)[number];

export type BillFlag = {
  kind: BillFlagKind;
  severity: BillFlagSeverity;
  /** Blocks the bill leaving review. Danger is not automatically blocking. */
  blocking: boolean;
  /** Full sentence, for the review banner where there is room to explain. */
  message: string;
  /** A few words, for a table row where there is not. */
  short: string;
};

/**
 * Everything the flag rules need. Assembled by the caller so the rules
 * themselves never touch the database.
 */
export type BillFlagFacts = {
  vendorName: string;
  organizationName: string;
  amountRaw: bigint;
  /** The entity the invoice is made out to, as extracted. */
  billToName: string | null;
  /** Rule names raised by the intake agent. */
  triggeredRules: string[];
  vendorHold: PayableHold | null;
  /** Org bill ceiling in minor units; null when unset. */
  ceilingMinor: bigint | null;
  duplicates: DuplicateMatch[];
  duplicateOverride: DuplicateOverride | null;
};

const SEVERITY_ORDER: Record<BillFlagSeverity, number> = { danger: 0, warning: 1, info: 2 };

function usdText(amountRaw: bigint): string {
  const usd = Number(amountRaw) / 1_000_000;
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// Legal wrappers, plus the industry words that half of B2B shares. Both are
// stripped before comparing: matching on "labs" made "Decimal Labs" look
// related to "Halcyon Labs, Inc." and silently passed a bill addressed to
// someone else. A shared generic word is not evidence of the same company;
// only the distinctive part of the name is.
const NAME_NOISE = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'the',
  'gmbh', 'bv', 'nv', 'plc', 'sa', 'ag', 'pvt', 'private', 'pte', 'pty',
  'labs', 'lab', 'technologies', 'technology', 'tech', 'systems', 'system',
  'solutions', 'services', 'group', 'holdings', 'partners', 'ventures',
  'global', 'international', 'digital', 'capital', 'studio', 'studios',
  'agency', 'media', 'consulting', 'software', 'industries', 'enterprises',
]);

export function namesLookRelated(a: string, b: string): boolean {
  const tokens = (s: string) =>
    new Set(
      s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter((t) => t.length > 1 && !NAME_NOISE.has(t)),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  // Nothing distinctive left on either side (e.g. "Labs Inc" vs "Labs LLC") —
  // we genuinely can't tell, so don't cry wolf.
  if (ta.size === 0 || tb.size === 0) return true;
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

/**
 * The single source of truth for what is wrong with a bill.
 *
 * Returned most-severe first, so a surface with room for only one flag can
 * take the first and be showing the worst thing.
 */
export function evaluateBillFlags(facts: BillFlagFacts): BillFlag[] {
  const flags: BillFlag[] = [];
  const rules = new Set(facts.triggeredRules);

  if (rules.has('known_counterparty_wallet_changed') || rules.has('near_duplicate_address')) {
    flags.push({
      kind: 'payee_mismatch',
      severity: 'danger',
      blocking: true,
      short: 'Payment details changed',
      message: `The payment details on this document don't match what's verified for ${facts.vendorName}. This is how payment fraud usually starts.`,
    });
  }

  if (rules.has('invalid_extracted_wallet_address')) {
    flags.push({
      kind: 'unreadable_payment_details',
      severity: 'danger',
      blocking: true,
      short: 'Payment details unreadable',
      message: 'The payment details on this document could not be read reliably. Check them against the document before sending.',
    });
  }

  // Is this bill even ours? Cheap, and the failure it catches is paying a
  // stranger's invoice in full.
  if (facts.billToName && !namesLookRelated(facts.billToName, facts.organizationName)) {
    flags.push({
      kind: 'addressed_elsewhere',
      severity: 'danger',
      blocking: true,
      short: `Addressed to ${facts.billToName}`,
      message: `This bill is addressed to "${facts.billToName}", not ${facts.organizationName}. Make sure it's actually yours to pay.`,
    });
  }

  // Vendor payable gate (policy P0): a held/blocked vendor's bills can't leave
  // Review — policy sits UNDER approvals and always wins. Not overridable
  // per-bill: the hold is released on the VENDOR, where it was set.
  if (facts.vendorHold) {
    flags.push({
      kind: facts.vendorHold.status === 'blocked' ? 'vendor_blocked' : 'vendor_held',
      severity: 'danger',
      blocking: true,
      short: facts.vendorHold.status === 'blocked' ? 'Vendor blocked' : 'Vendor on hold',
      message: describePayableHold(facts.vendorName, facts.vendorHold),
    });
  }

  // Org bill ceiling (policy P1): a hard cap no bill crosses. Not overridable
  // per-bill — the primary admin raises the ceiling itself (Policies page).
  if (facts.ceilingMinor !== null && facts.amountRaw > facts.ceilingMinor) {
    flags.push({
      kind: 'over_ceiling',
      severity: 'danger',
      blocking: true,
      short: 'Over bill ceiling',
      message: `This bill (${usdText(facts.amountRaw)}) is over your organization's bill ceiling of ${usdText(facts.ceilingMinor)}. The primary admin can raise the ceiling on the Policies page.`,
    });
  }

  // Duplicate gate (policy P0): on irreversible rails a duplicate payment is
  // unrecoverable, so this BLOCKS confirm unless an admin explicitly clears
  // it — and the clearance itself becomes the audit record.
  if (facts.duplicates.length > 0) {
    if (facts.duplicateOverride) {
      flags.push({
        kind: 'possible_duplicate',
        severity: 'info',
        blocking: false,
        short: 'Duplicate cleared',
        message: `Looked like a duplicate — cleared by ${facts.duplicateOverride.byName}: “${facts.duplicateOverride.reason}”.`,
      });
    } else {
      flags.push({
        kind: 'possible_duplicate',
        severity: 'danger',
        blocking: true,
        short: 'Possible duplicate',
        message: `${describeDuplicate(facts.duplicates[0]!)} If it's genuinely a new bill, an admin can clear this flag.`,
      });
    }
  }

  // Informational, and deliberately last: it is context, not a problem.
  if (rules.has('unreviewed_counterparty') || rules.has('new_counterparty_threshold')) {
    flags.push({
      kind: 'new_vendor',
      severity: 'info',
      blocking: false,
      short: 'First bill from vendor',
      message: `First bill from ${facts.vendorName}. Their payment details will be verified before anything is sent.`,
    });
  }

  return flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export type BillFlagSummary = {
  /** Anything preventing this bill leaving review. */
  blocking: boolean;
  /** The most severe flag, or null. Already first in evaluateBillFlags order. */
  worst: BillFlag | null;
  dangerCount: number;
};

/** What a list row needs to know, without re-deriving severity rules itself. */
export function summarizeBillFlags(flags: BillFlag[]): BillFlagSummary {
  return {
    blocking: flags.some((f) => f.blocking),
    worst: flags[0] ?? null,
    dangerCount: flags.filter((f) => f.severity === 'danger').length,
  };
}
