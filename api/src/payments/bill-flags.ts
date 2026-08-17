// Every reason a bill should give a human pause, in one place.
//
// This module exists because the flags used to be built inline inside
// getBillDraft. The workbench, which is the screen you actually use to decide
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
  'looks_like_statement',
  'looks_like_credit_note',
  'approval_weakened',
  'lines_do_not_sum',
  'total_does_not_reconcile',
  'new_vendor',
] as const;

export type BillFlagKind = (typeof BILL_FLAG_KINDS)[number];

/** What a person can do about a flag, offered on the flag itself. */
export type FlagResolution = {
  /** Stable identifier the UI posts back. */
  action: 'this_is_us' | 'not_ours' | 'ask_someone' | 'clear_duplicate' | 'fix_fields' | 'raise_ceiling' | 'release_vendor';
  label: string;
  /** Who may take it. The UI greys what the viewer cannot do and says why. */
  requires: 'anyone' | 'admin';
  /** One line under the button — what happens, and whether it is permanent. */
  detail: string;
};

export type BillFlag = {
  kind: BillFlagKind;
  severity: BillFlagSeverity;
  /** Blocks the bill leaving review. Danger is not automatically blocking. */
  blocking: boolean;
  /** Full sentence, for the review banner where there is room to explain. */
  message: string;
  /** A few words, for a table row where there is not. */
  short: string;
  /**
   * Every blocking flag MUST offer at least one resolution. A flag that stops a
   * bill and offers no way forward is a dead end, and a bill stuck because
   * nobody can resolve it fails as surely as one paid wrongly — just later and
   * more confusingly. Asking is always available: it is never the dangerous act.
   */
  resolutions: FlagResolution[];
};

const ASK: FlagResolution = {
  action: 'ask_someone',
  label: 'Ask someone',
  requires: 'anyone',
  detail: 'Put a question to a colleague. The bill waits for their answer instead of moving.',
};

/**
 * Everything the flag rules need. Assembled by the caller so the rules
 * themselves never touch the database.
 */
export type BillFlagFacts = {
  vendorName: string;
  organizationName: string;
  /**
   * Other names this org answers to — subsidiaries, DBAs, former names. A bill
   * addressed to any of them is addressed to us.
   */
  tradingNames: string[];
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
  /**
   * The figures as read from the document, in dollars. Any may be absent —
   * plenty of real invoices carry no subtotal or tax line, and a missing
   * number is not a mismatch.
   */
  /**
   * Warnings the approval engine raised while compiling this bill's routing —
   * most importantly a quorum it had to lower because too few people were
   * eligible. Free text today, because that is how the engine emits them.
   */
  planAlerts: string[];
  /**
   * What the document calls itself, and the invoice references printed on it.
   * Used to tell an invoice from documents that merely look like one.
   */
  documentType: {
    /** invoiceNumber as extracted — a CN-/CM- series is a credit note's tell. */
    invoiceNumber: string | null;
    /** Distinct invoice references appearing in the line items. */
    lineInvoiceRefs: string[];
  };
  amounts: {
    lineItemsTotal: number | null;
    subtotal: number | null;
    tax: number | null;
    total: number | null;
  };
};

// A cent. Invoices are printed to two decimal places, so anything at or under
// this is rounding, not disagreement.
const MONEY_EPSILON = 0.005;

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const SEVERITY_ORDER: Record<BillFlagSeverity, number> = { danger: 0, warning: 1, info: 2 };

// Organization names are stored as typed. "decimal labs" reads as a typo in the
// middle of a sentence about a company. Only touched when the name is entirely
// lowercase — capitalising unconditionally would turn "IBM" into "Ibm" and
// "eBay" into "Ebay", which is worse than the problem.
export function displayOrgName(name: string): string {
  if (name !== name.toLowerCase()) return name;
  return name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

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
      resolutions: [{ action: 'fix_fields', label: 'Check the details', requires: 'anyone', detail: 'Compare the payment details against the document and correct them.' }, ASK],
      message: `The payment details on this document don't match what's verified for ${facts.vendorName}. This is how payment fraud usually starts.`,
    });
  }

  if (rules.has('invalid_extracted_wallet_address')) {
    flags.push({
      kind: 'unreadable_payment_details',
      severity: 'danger',
      blocking: true,
      short: 'Payment details unreadable',
      resolutions: [{ action: 'fix_fields', label: 'Enter them by hand', requires: 'anyone', detail: 'Read the details off the document and type them in.' }, ASK],
      message: 'The payment details on this document could not be read reliably. Check them against the document before sending.',
    });
  }

  // Is this bill even ours? Cheap, and the failure it catches is paying a
  // stranger's invoice in full.
  const ourNames = [facts.organizationName, ...facts.tradingNames];
  if (facts.billToName && !ourNames.some((ours) => namesLookRelated(facts.billToName!, ours))) {
    flags.push({
      kind: 'addressed_elsewhere',
      severity: 'danger',
      blocking: true,
      short: `Addressed to ${facts.billToName}`,
      resolutions: [{ action: 'this_is_us', label: 'This is us', requires: 'admin', detail: `Record "${facts.billToName}" as a name your organization trades under. Permanent, and it stops this being asked again.` }, { action: 'not_ours', label: 'Not ours', requires: 'admin', detail: 'Close this bill as addressed to another company.' }, ASK],
      message: `This bill is addressed to "${facts.billToName}", not ${displayOrgName(facts.organizationName)}. Make sure it's actually yours to pay.`,
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
      resolutions: [{ action: 'release_vendor', label: 'Review the vendor', requires: 'admin', detail: 'The hold is released on the vendor, where it was set — not here.' }, ASK],
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
      resolutions: [{ action: 'raise_ceiling', label: 'Review the ceiling', requires: 'admin', detail: 'Only the primary admin can raise the organization ceiling, on the Policies page.' }, ASK],
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
        resolutions: [],
        message: `Looked like a duplicate — cleared by ${facts.duplicateOverride.byName}: “${facts.duplicateOverride.reason}”.`,
      });
    } else {
      flags.push({
        kind: 'possible_duplicate',
        severity: 'danger',
        blocking: true,
        short: 'Possible duplicate',
        resolutions: [{ action: 'clear_duplicate', label: 'Not a duplicate', requires: 'admin', detail: 'Clear the flag with a reason. The clearance itself becomes the audit record.' }, ASK],
        message: `${describeDuplicate(facts.duplicates[0]!)} If it's genuinely a new bill, an admin can clear this flag.`,
      });
    }
  }

  // Is this an invoice at all?
  //
  // Two documents look like invoices to a model asked to extract invoice
  // fields, because it is never asked whether it IS one — and both are
  // expensive in a way nothing else here is.
  //
  // A STATEMENT OF ACCOUNT lists invoices already in the system. Paying it pays
  // every one of them a second time. A real invoice carries exactly one invoice
  // number, referring to itself; several distinct references in the line items
  // is the structural tell, and it needs no model to see.
  //
  // A CREDIT NOTE means the vendor owes US. Paying it sends money the wrong
  // way, and unlike an overpayment nobody is expecting a refund. Its series is
  // deliberately distinct from the invoice series — CN-, CM- — and a negative
  // total is unambiguous.
  //
  // Both block. Deterministic, cheap, and refusing to pay a document we cannot
  // confidently call an invoice is the right default on a rail with no recall.
  const refs = [...new Set(facts.documentType.lineInvoiceRefs.map((r) => r.toUpperCase()))];
  if (refs.length > 1) {
    flags.push({
      kind: 'looks_like_statement',
      severity: 'danger',
      blocking: true,
      short: 'Looks like a statement',
      resolutions: [
        { action: 'not_ours', label: 'Close it', requires: 'admin', detail: 'A statement is not a payable. Close it and pay the individual invoices.' },
        ASK,
      ],
      message: `This lists ${refs.length} invoice numbers (${refs.slice(0, 3).join(', ')}${refs.length > 3 ? '…' : ''}), so it looks like a statement of account rather than one invoice. Paying a statement pays every invoice on it again — settle the individual invoices instead.`,
    });
  }

  const creditSeries = facts.documentType.invoiceNumber
    ? /^(CN|CM)[-\s_]?\d/i.test(facts.documentType.invoiceNumber.trim())
    : false;
  const negativeTotal = facts.amounts.total !== null && facts.amounts.total < 0;
  if (creditSeries || negativeTotal) {
    flags.push({
      kind: 'looks_like_credit_note',
      severity: 'danger',
      blocking: true,
      short: 'Looks like a credit note',
      resolutions: [
        { action: 'not_ours', label: 'Close it', requires: 'admin', detail: 'A credit note reduces what you owe. Close it here and apply it against the vendor instead.' },
        ASK,
      ],
      message: negativeTotal
        ? `The total on this document is negative, which makes it a credit note — money the vendor owes you, not money to send. Apply it against their balance rather than paying it.`
        : `"${facts.documentType.invoiceNumber}" is a credit-note series, not an invoice series. A credit note reduces what you owe — paying it sends money the wrong way.`,
    });
  }

  // The routing the org configured is not always the routing that ran. When
  // separation-of-duties removes the submitter and too few eligible approvers
  // remain, the engine lowers the quorum so the bill can still move — the
  // alternative is a bill nobody can ever approve. That is the right call, but
  // it silently weakens a control the organization deliberately set, and until
  // now it was recorded in the event log and shown to nobody. Someone checking
  // "did two people sign this?" would find one signature and no explanation.
  //
  // Deliberately NOT blocking: the quorum was lowered precisely because nobody
  // else can approve, so blocking would recreate the deadlock it avoided. It
  // is loud, not obstructive.
  const weakened = facts.planAlerts.filter((a) => /quorum lowered|no approvers/i.test(a));
  if (weakened.length > 0) {
    // Say the NUMBER, not the mechanism. The raw alerts are compiler output —
    // "step 0 had no approvers after SoD/resolution" is true, unreadable, and
    // useless to the person deciding whether to trust the signatures. What an
    // operator needs is how many signed against how many the policy wanted. The
    // internals stay in the event log, where anyone debugging routing will look.
    const lowered = /quorum lowered (\d+) . (\d+)/.exec(weakened.join(' '));
    flags.push({
      kind: 'approval_weakened',
      severity: 'warning',
      blocking: false,
      short: 'Fewer approvers than your policy',
      resolutions: [],
      message: lowered
        ? `Signed by ${lowered[2]} instead of the ${lowered[1]} your policy asks for — there weren't enough people eligible to sign this one.`
        : `Fewer people signed this than your policy asks for — there weren't enough eligible approvers.`,
    });
  }

  // Arithmetic. Cheap, deterministic, no model involved — and it catches the
  // failure mode nothing else does: extraction that is confidently wrong.
  // A total we cannot reconcile against the document's own parts is a total we
  // should not pay on a rail with no recourse, so these block.
  const { lineItemsTotal, subtotal, tax, total } = facts.amounts;
  const against = subtotal ?? total;
  if (lineItemsTotal !== null && against !== null
      && Math.abs(lineItemsTotal - against) > MONEY_EPSILON) {
    flags.push({
      kind: 'lines_do_not_sum',
      severity: 'danger',
      blocking: true,
      short: 'Lines do not add up',
      resolutions: [{ action: 'fix_fields', label: 'Correct the figures', requires: 'anyone', detail: 'Fix the lines or the total so they agree with the document.' }, ASK],
      message: `The line items add up to ${money(lineItemsTotal)}, but the document says ${money(against)}. Something was read wrong, or the document disagrees with itself — check it against the original before paying.`,
    });
  }
  if (subtotal !== null && total !== null
      && Math.abs(subtotal + (tax ?? 0) - total) > MONEY_EPSILON) {
    flags.push({
      kind: 'total_does_not_reconcile',
      severity: 'danger',
      blocking: true,
      short: 'Total does not reconcile',
      resolutions: [{ action: 'fix_fields', label: 'Correct the figures', requires: 'anyone', detail: 'Fix the subtotal, tax or total so they agree with the document.' }, ASK],
      message: `${money(subtotal)} plus ${money(tax ?? 0)} tax comes to ${money(subtotal + (tax ?? 0))}, not the ${money(total)} this bill asks for. Check the figures against the document before paying.`,
    });
  }

  // Informational, and deliberately last: it is context, not a problem.
  if (rules.has('unreviewed_counterparty') || rules.has('new_counterparty_threshold')) {
    flags.push({
      kind: 'new_vendor',
      severity: 'info',
      blocking: false,
      short: 'First bill from vendor',
      resolutions: [],
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
