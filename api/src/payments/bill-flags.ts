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
// the facts however is cheapest for them (the draft screen queries per bill;
// the workbench batches across all rows) and the verdict cannot diverge
// between them, because there is only one copy of the reasoning.
import type { BooksFlagFacts, BooksMatch } from '../accounting/books-check.js';
import type { PostingDateChoice } from '../accounting/closed-period.js';
import type { DuplicateClearance, DuplicateMatch } from './duplicate-check.js';
import { ceilingExceptionCovers, type CeilingException } from './ceiling-exception.js';
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
  'similar_vendor',
  'in_books',
  'dated_in_closed_period',
  'lines_do_not_sum',
  'total_does_not_reconcile',
  'short_paid',
  'new_vendor',
] as const;

export type BillFlagKind = (typeof BILL_FLAG_KINDS)[number];

/** What a person can do about a flag, offered on the flag itself. */
export type FlagResolution = {
  /** Stable identifier the UI posts back. */
  action: 'this_is_us' | 'not_ours' | 'ask_someone' | 'clear_duplicate' | 'fix_fields' | 'raise_ceiling' | 'release_vendor' | 'pay_the_lines'
    | 'same_vendor' | 'different_vendor' | 'allow_over_ceiling' | 'same_bill' | 'different_bill'
    | 'post_in_open_period' | 'keep_date';
  label: string;
  /**
   * Who may take it. The UI greys what the viewer cannot do and says why.
   * `primary_admin` is strictly narrower than `admin`: it is reserved for the
   * controls that decide how much money may move at all.
   */
  requires: 'anyone' | 'admin' | 'primary_admin';
  /**
   * True when the answer is a determination rather than a judgement, and asking
   * for written justification would only produce "yes it is". Whoever answered
   * is recorded either way.
   */
  noReason?: boolean;
  /** What the answer is ABOUT, when the flag concerns another record. */
  targetId?: string;
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
  /**
   * What Decimal did about it by itself, for the bill's history. `text` reads after
   * its name ("set it to post on 1 Oct 2008, …"); `rule` is the record's. Written when
   * the flag first says it and whenever it changes (recordWhatDecimalDid in bills.ts).
   */
  did?: { rule: string; text: string };
};

const ASK: FlagResolution = {
  action: 'ask_someone',
  label: 'Ask someone',
  requires: 'anyone',
  detail: 'Put a question to a colleague. The bill waits for their answer instead of moving.',
};

// The other honest answer to an invoice that disagrees with itself.
//
// "Correct the figures" assumes the reading was wrong. Often it wasn't: the
// document genuinely does not add up, and the ordinary AP move is to pay what
// it itemises and tell the vendor. That decision had no way to be expressed —
// the only route to it was quietly retyping the total, which reaches an
// approver looking exactly like a typo. Requiring a reason is the whole point:
// it turns a changed number into a decision somebody made and signed.
//
// Not admin-gated. The bill still has its whole approval chain ahead of it, and
// the reason travels with it; the chain is the control, not this button.
const PAY_THE_LINES: FlagResolution = {
  action: 'pay_the_lines',
  label: 'Pay the itemised total',
  requires: 'anyone',
  detail: 'Pay what the lines add up to instead of the printed total, with a reason the approvers will see.',
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
  /**
   * A decision to let THIS bill past the ceiling. Read raw, not pre-validated:
   * a grant that no longer matches the amount still has something to say, so
   * the rules decide what it means rather than the caller.
   */
  ceilingException: CeilingException | null;
  duplicates: DuplicateMatch[];
  /**
   * Pairs a person already settled as "not a duplicate", on this bill or on
   * its twin. `duplicates` holds only the pairs nobody has settled.
   */
  duplicateClearances: Array<{ match: DuplicateMatch; clearance: DuplicateClearance }>;
  /** Vendors already on file whose identifying name matches this one's. */
  similarVendors: Array<{ counterpartyId: string; displayName: string; billCount: number }>;
  /**
   * Bills already in the books this one could be, from the last live look
   * (accounting/books-check.ts), and what people said about them. Absent when
   * nothing was looked for: no books to post to, or posting not turned on.
   */
  inBooks?: BooksFlagFacts | null;
  /**
   * The date the books this team posts to are closed through, and this bill's own
   * date as reviewed (accounting/closed-period.ts). Absent when it posts nowhere, the
   * books keep no closing date, or the bill is past posting.
   */
  closedPeriod?: {
    system: string;
    closedThrough: string;
    billDate: string | null;
    /** Still in review, where its posting date can be chosen. */
    inReview: boolean;
    choice: PostingDateChoice | null;
  } | null;
  /**
   * Bills this org has had from this vendor BEFORE this one — counted now,
   * not when the document was uploaded.
   */
  priorBillsFromVendor: number;
  /**
   * A recorded decision to pay what the bill itemises rather than the figure
   * printed on it. Present only once somebody has made it.
   */
  shortPay: {
    byName: string;
    reason: string;
    itemisedTotal: number;
    documentTotal: number | null;
  } | null;
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
    /**
     * What the document says it is, when it says something other than
     * "invoice". Believed over the inference below: a page headed STATEMENT OF
     * ACCOUNT is a statement whether or not its rows parse.
     */
    declaredKind?: string | null;
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

/** The books' system, as people call it. */
export function systemName(system: string): string {
  return system === 'quickbooks' ? 'QuickBooks' : system === 'xero' ? 'Xero' : system;
}

/** The day after the books' closing date. Kept here, not imported, so the rules stay free of the database. */
function firstOpenDayOf(closedThrough: string): string {
  return new Date(Date.parse(`${closedThrough}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "8 Oct 2026" from "2026-10-08". Spelled out by hand, as the pages do: en-GB now prints "Sept". */
export function dayText(date: string): string {
  const at = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(at)) return date;
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A bill in the books, in words: "bill CT-41822 from Cal Telephone for $193.60, dated 8 Oct 2026". */
export function describeBooksBill(m: BooksMatch): string {
  const units = Number(BigInt(m.totalMinor)) / 100;
  const amount = m.currency === 'USD' ? money(units) : `${units.toFixed(2)} ${m.currency}`;
  const from = m.vendorName ? ` from ${m.vendorName}` : '';
  const dated = m.date ? `, dated ${dayText(m.date)}` : '';
  const paid = m.open === false ? ', already paid' : '';
  return m.number
    ? `bill ${m.number}${from} for ${amount}${dated}${paid}`
    : `a bill${from} for the same ${amount}${dated}, with no number${paid}`;
}

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

  // Org bill ceiling (policy P1): a hard cap no bill crosses.
  //
  // Raising the ceiling clears this for every bill over the line, which is the
  // wrong instrument when one genuine invoice is large and the rest of the
  // queue is not. So there are two doors: raise the standing rule, or allow
  // this one bill past it. The second is the primary admin's alone.
  if (facts.ceilingMinor !== null && facts.amountRaw > facts.ceilingMinor) {
    const granted = facts.ceilingException;
    const covers = granted !== null && ceilingExceptionCovers(granted, facts.amountRaw);
    if (covers) {
      flags.push({
        kind: 'over_ceiling',
        severity: 'info',
        blocking: false,
        short: 'Ceiling exception',
        resolutions: [],
        message: `Over the ${usdText(facts.ceilingMinor)} ceiling — allowed for this bill by ${granted.byName}: “${granted.reason}”. The ceiling itself is unchanged.`,
      });
    } else {
      // A grant that no longer fits the bill it was granted for. Say so, rather
      // than re-blocking with the generic message and leaving somebody to
      // wonder where their exception went.
      const stale = granted
        ? ` An exception was allowed for ${usdText(BigInt(granted.amountRaw))}, but the bill has changed since, so it no longer applies.`
        : '';
      flags.push({
        kind: 'over_ceiling',
        severity: 'danger',
        blocking: true,
        short: 'Over bill ceiling',
        resolutions: [
          { action: 'allow_over_ceiling', label: 'Allow this bill', requires: 'primary_admin', detail: 'Let this one bill past the ceiling, with a reason. The ceiling stays where it is, and the decision becomes the audit record.' },
          { action: 'raise_ceiling', label: 'Review the ceiling', requires: 'primary_admin', detail: 'Raise the ceiling itself, on Organisation. This affects every bill.' },
          ASK,
        ],
        message: `This bill (${usdText(facts.amountRaw)}) is over your organization's bill ceiling of ${usdText(facts.ceilingMinor)}.${stale} The primary admin can allow this one bill, or raise the ceiling on Organisation.`,
      });
    }
  }

  // Duplicate gate (policy P0): on irreversible rails a duplicate payment is
  // unrecoverable, so this BLOCKS confirm unless an admin explicitly clears
  // it — and the clearance itself becomes the audit record.
  // Only pairs nobody has settled block. A pair settled on EITHER bill reads
  // as settled on both: "not a duplicate" answers for the pair, and asking it
  // again on the twin was asking a question somebody had already answered.
  if (facts.duplicates.length > 0) {
    flags.push({
      kind: 'possible_duplicate',
      severity: 'danger',
      blocking: true,
      short: 'Possible duplicate',
      // Both answers live on the flag. Closing used to be a separate button
      // off to the side, so "yes, it is a duplicate" had no place here — and
      // the exception agent, which recommends one of these, had nowhere to
      // point when that was its answer.
      resolutions: [
        // Both answers are about the bill this one copies, which a closed copy's page links to.
        { action: 'clear_duplicate', label: 'Not a duplicate', requires: 'admin', targetId: facts.duplicates[0]!.paymentOrderId, detail: 'Clear the flag with a reason. It clears the other bill too, and the clearance itself becomes the audit record.' },
        { action: 'not_ours', label: 'Close as duplicate', requires: 'admin', targetId: facts.duplicates[0]!.paymentOrderId, detail: 'Close this bill as a duplicate so it is never paid. The other bill is unaffected.' },
        ASK,
      ],
      message: `${describeDuplicate(facts.duplicates[0]!)} If it's genuinely a new bill, an admin can clear this flag.`,
    });
  } else if (facts.duplicateClearances.length > 0) {
    // Settled, and still said: whoever reads this bill next should see that it
    // looked like a duplicate, who decided otherwise, and why.
    const { match, clearance } = facts.duplicateClearances[0]!;
    const other = match.invoiceNumber ? `invoice ${match.invoiceNumber}` : 'another bill';
    flags.push({
      kind: 'possible_duplicate',
      severity: 'info',
      blocking: false,
      short: 'Duplicate cleared',
      resolutions: [],
      message: clearance.onThisBill
        ? `Looked like a duplicate of ${other} — cleared by ${clearance.byName}: “${clearance.reason}”.`
        : `Looked like a duplicate of ${other} — cleared on that bill by ${clearance.byName}: “${clearance.reason}”.`,
    });
  }

  // Already in the books it would post to (accounting/books-check.ts). Someone may
  // have keyed it in by hand, and QuickBooks takes the same bill twice without a
  // word.
  //
  // Not blocking, ever: QuickBooks is not a step in the approval chain. The bill
  // is reviewed and approved as usual; its posting is what waits for an answer.
  // Both answers are determinations about two records a person can compare, so
  // neither asks for a reason, and both are recorded under their name.
  if (facts.inBooks) {
    const { matches, answers } = facts.inBooks;
    const system = systemName(facts.inBooks.system);
    // An answer about a bill no longer among the matches (deleted there, or this
    // bill has changed) is about something that isn't so any more: posting ignores
    // it too (books-check.ts).
    const linked = answers.find((a) => a.same && matches.some((m) => m.recordId === a.recordId)) ?? null;
    const open = matches.filter((m) => !answers.some((a) => a.recordId === m.recordId));
    if (linked) {
      const m = matches.find((x) => x.recordId === linked.recordId)!;
      flags.push({
        kind: 'in_books',
        severity: 'info',
        blocking: false,
        short: `Linked in ${system}`,
        resolutions: [],
        message: `${linked.byName} said this is the bill already in ${system}: ${describeBooksBill(m)}. Decimal links to it rather than posting it again.`,
      });
    } else if (open.length > 0) {
      const m = open[0]!;
      const more = open.length > 1 ? ` It has ${open.length - 1} more that could be this one.` : '';
      flags.push({
        kind: 'in_books',
        severity: 'warning',
        blocking: false,
        short: `Already in ${system}?`,
        resolutions: [
          { action: 'same_bill', label: 'Same bill', requires: 'anyone', noReason: true, targetId: m.recordId, detail: `Decimal links this bill to that one, and doesn't post it to ${system} again.` },
          { action: 'different_bill', label: 'Different bill', requires: 'anyone', noReason: true, targetId: m.recordId, detail: 'Decimal posts this one as its own bill, and stops asking about that one.' },
          ASK,
        ],
        message: `${system} already has ${describeBooksBill(m)}, entered there outside Decimal.${more} If it's this bill, Decimal links to it instead of posting it twice.`,
      });
    } else if (matches.length > 0) {
      const m = matches[0]!;
      const said = answers.find((a) => a.recordId === m.recordId);
      flags.push({
        kind: 'in_books',
        severity: 'info',
        blocking: false,
        short: `Checked in ${system}`,
        resolutions: [],
        message: `${system} also has ${describeBooksBill(m)}. ${said?.byName ?? 'Someone'} said it's a different bill, so this one posts as its own.`,
      });
    }
  }

  // Dated in a period the books have closed.
  //
  // QuickBooks and Xero both refuse a bill dated on or before the date the books are
  // closed through. Decimal doesn't ask: it posts it on the first open day, the
  // ordinary fix for a late bill (closed-period.ts), and says so, with why, as a note
  // that holds nothing. The bill keeps its own date for when it is due. Keeping that
  // date instead waits on someone reopening the period, the books' owner's call, so
  // it is an admin's, and it stands while the bill keeps the date it was made for and
  // the books stay closed where they were. Past review, the approvers read the same,
  // and its one answer is a question: the date is changed by sending it back.
  const cp = facts.closedPeriod;
  if (cp?.billDate && cp.billDate <= cp.closedThrough) {
    const system = systemName(cp.system);
    const open = firstOpenDayOf(cp.closedThrough);
    const choice = cp.choice;
    const kept = choice?.kind === 'keep' && choice.billDate === cp.billDate && choice.closedThrough === cp.closedThrough;
    if (kept) {
      flags.push({
        kind: 'dated_in_closed_period',
        severity: 'warning',
        blocking: false,
        short: 'Kept a closed date',
        resolutions: cp.inReview
          ? [{ action: 'post_in_open_period', label: `Post it on ${dayText(open)}`, requires: 'anyone', noReason: true, detail: `${system} gets it dated ${dayText(open)}, the first open day. The bill keeps its own date for when it's due.` }, ASK]
          : [ASK],
        message: `Dated ${dayText(cp.billDate)}, and ${system} is closed through ${dayText(cp.closedThrough)}. ${choice.byName} kept its date${choice.reason ? `: "${choice.reason}"` : ''}. ${system} won't take it until the period is reopened there.`,
      });
    } else {
      flags.push({
        kind: 'dated_in_closed_period',
        severity: 'info',
        blocking: false,
        short: `Posts on ${dayText(open)}`,
        resolutions: cp.inReview
          ? [{ action: 'keep_date', label: 'Keep its date', requires: 'admin', detail: `${system} won't take it until someone reopens the period there. Only when that's planned.` }, ASK]
          : [ASK],
        // The first sentence is read back by the page's card for keeping the date.
        message: `This bill is dated ${dayText(cp.billDate)}, and ${system} is closed through ${dayText(cp.closedThrough)}. ${system} won't take a bill dated in a closed period, so Decimal will post it there on ${dayText(open)}, the first open day. The bill keeps its own date for when it's due.`,
        did: { rule: 'posting_date', text: `set it to post on ${dayText(open)}, the first open day, because ${system} is closed through ${dayText(cp.closedThrough)}` },
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
  const declaredStatement = facts.documentType.declaredKind === 'statement';
  if (declaredStatement || refs.length > 1) {
    flags.push({
      kind: 'looks_like_statement',
      severity: 'danger',
      blocking: true,
      short: 'Looks like a statement',
      resolutions: [
        { action: 'not_ours', label: 'Close it', requires: 'admin', detail: 'A statement is not a payable. Close it and pay the individual invoices.' },
        ASK,
      ],
      // Two ways to get here, and the sentence has to be true for both: the
      // document named itself, or we inferred it from the references. Saying
      // "lists 0 invoice numbers" when the heading said STATEMENT OF ACCOUNT
      // would be worse than saying nothing about the count.
      message: refs.length > 0
        ? `This lists ${refs.length} invoice number${refs.length === 1 ? '' : 's'} (${refs.slice(0, 3).join(', ')}${refs.length > 3 ? '…' : ''}), so it looks like a statement of account rather than one invoice. Paying a statement pays every invoice on it again — settle the individual invoices instead.`
        : 'This document presents itself as a statement of account rather than one invoice. Paying a statement pays every invoice on it again — settle the individual invoices instead.',
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
  //
  // Only for documents that are invoices, though. A credit note's figures are
  // negative and the extraction prompt asks for a positive amount, so its line
  // of -$240 was being compared against a sign-stripped $240 and reported as a
  // document that disagrees with itself. It does not: we stripped the sign.
  //
  // The deeper reason to skip it holds even without that bug. These flags exist
  // to stop a wrong figure being PAID, and they offer "correct the figures" and
  // "pay the itemised total" to get there. On a document that is not payable at
  // all, both are answers to a question nobody asked — and the second one, on a
  // credit note, invites somebody to pay negative four hundred and eighty
  // dollars.
  const isPayableDocument = !facts.documentType.declaredKind
    || facts.documentType.declaredKind === 'invoice';
  const { lineItemsTotal, subtotal, tax, total } = isPayableDocument
    ? facts.amounts
    : { lineItemsTotal: null, subtotal: null, tax: null, total: null };
  // What the lines are meant to add up to. The printed subtotal when there is
  // one; otherwise the total with tax taken back off — because tax is not a
  // line item, and comparing lines against a tax-inclusive total marks every
  // ordinary taxed invoice that omits a subtotal line as broken. The screen
  // has always checked `lines + tax` against the total; this is the same
  // question asked from the other side, so the two can no longer disagree.
  const against = subtotal ?? (total !== null ? total - (tax ?? 0) : null);
  if (lineItemsTotal !== null && against !== null
      && Math.abs(lineItemsTotal - against) > MONEY_EPSILON) {
    flags.push({
      kind: 'lines_do_not_sum',
      severity: 'danger',
      blocking: true,
      short: 'Lines do not add up',
      resolutions: [{ action: 'fix_fields', label: 'Correct the figures', requires: 'anyone', detail: 'Fix the lines or the total so they agree with the document.' }, PAY_THE_LINES, ASK],
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
      resolutions: [{ action: 'fix_fields', label: 'Correct the figures', requires: 'anyone', detail: 'Fix the subtotal, tax or total so they agree with the document.' }, PAY_THE_LINES, ASK],
      message: `${money(subtotal)} plus ${money(tax ?? 0)} tax comes to ${money(subtotal + (tax ?? 0))}, not the ${money(total)} this bill asks for. Check the figures against the document before paying.`,
    });
  }

  // The decision, once made, is louder than the discrepancy was. An approver
  // looking at a bill for $4,000 against a document printed at $4,820 needs to
  // see that somebody chose that and why — otherwise the safest reading is
  // that a figure got fat-fingered. Same shape as a cleared duplicate: the
  // record of the judgement replaces the flag that prompted it.
  if (facts.shortPay) {
    flags.push({
      kind: 'short_paid',
      severity: 'info',
      blocking: false,
      short: 'Paying the itemised total',
      resolutions: [],
      message: facts.shortPay.documentTotal !== null
        ? `Paying the ${money(facts.shortPay.itemisedTotal)} this bill itemises rather than the ${money(facts.shortPay.documentTotal)} printed on it — decided by ${facts.shortPay.byName}: “${facts.shortPay.reason}”.`
        : `Paying the ${money(facts.shortPay.itemisedTotal)} this bill itemises — decided by ${facts.shortPay.byName}: “${facts.shortPay.reason}”.`,
    });
  }

  // A vendor we may already have, under a slightly different name.
  //
  // Not blocking: a company written with and without its legal suffix is the
  // overwhelmingly common case and stopping every one of those would be noise
  // that gets dismissed by reflex. But it goes in front of an approver, because
  // they are the person positioned to think "why are we paying someone new
  // whose name looks like someone we already pay" — which is exactly what a
  // vendor impersonation is banking on nobody thinking.
  if (facts.similarVendors.length > 0) {
    const match = facts.similarVendors[0]!;
    const seen = match.billCount === 1 ? '1 bill' : `${match.billCount} bills`;
    flags.push({
      kind: 'similar_vendor',
      severity: 'warning',
      blocking: false,
      short: 'Similar to an existing vendor',
      resolutions: [
        { action: 'same_vendor', label: 'Same company', requires: 'anyone', noReason: true, targetId: match.counterpartyId, detail: `Move this bill onto ${match.displayName} and remember "${facts.vendorName}" as a name they also use.` },
        { action: 'different_vendor', label: 'Different company', requires: 'anyone', noReason: true, targetId: match.counterpartyId, detail: 'Keep them as separate vendors, and stop asking about this pair.' },
        ASK,
      ],
      message: `This bill names "${facts.vendorName}", and you already pay "${match.displayName}" (${seen}). If they are one company, keeping two records splits their history and lets the same invoice through twice.`,
    });
  }

  // Informational, and deliberately last: it is context, not a problem.
  //
  // The rule behind it is a SNAPSHOT, written at upload from the state of the
  // vendor's wallet at that moment. That is fine until the bill changes vendor:
  // answering "same company" on a near-match moves it onto a record with years
  // of history, and this went on announcing "first bill from vendor" about a
  // company with four. The stored rule was describing a vendor record the bill
  // no longer belongs to.
  //
  // So the snapshot proposes and the present decides. Anything counted now
  // outranks anything recorded then.
  if ((rules.has('unreviewed_counterparty') || rules.has('new_counterparty_threshold'))
    && facts.priorBillsFromVendor === 0) {
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
