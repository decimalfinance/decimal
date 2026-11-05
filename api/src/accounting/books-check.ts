// Is a bill already in the books it would post to?
//
// Someone may have entered it there by hand. QuickBooks takes a second bill with
// the same number from the same vendor without a word (tried on a sandbox, 5 Nov
// 2026), so posting it as well would put it in the books twice.
//
// Looked for live, through the reader, never in the copy the setup study made: the
// bill that matters is the one keyed in after that. Twice: in the background while
// the bill is open in review, so the people deciding it see it, and again just
// before it posts, because approval can take days. Code decides what could be the
// same bill; a person says whether it is. Until someone does, the bill is reviewed
// and approved as usual and only its posting waits: QuickBooks is never a step in
// the approval chain.

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { trackBackgroundWork } from '../infra/background.js';
import { conflict, notFound } from '../infra/api-errors.js';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import type { BooksBill, BooksReader } from '../integrations/books.js';
import { connectorFor } from '../integrations/connectors.js';
import { readOutcome } from '../integrations/setup/outcome.js';
import { describeBooksBill, namesLookRelated, systemName } from '../payments/bill-flags.js';
import { vendorForBill } from './vendor-match.js';

const SYSTEM = 'quickbooks';
const DAY_MS = 86_400_000;
/** A bill keyed in by hand is dated as the invoice is, give or take a few days. */
export const SAME_AMOUNT_WITHIN_DAYS = 7;
/** How far back a vendor's bills are read, from the bill's date. */
const LOOK_BACK_DAYS = 90;
const MAX_MATCHES = 3;
/** A check is good for an hour while the bill is open; one that failed is tried again sooner. */
const FRESH_MS = 60 * 60_000;
const RETRY_FAILED_MS = 5 * 60_000;
const LEASE_MS = 2 * 60_000;
/** Decimal's own posts: the note names the Decimal bill (sync.ts). */
const POSTED_BY_DECIMAL = /^Decimal decimal_([0-9a-f-]{36})/i;

/** A bill in the books that could be this one. */
export type BooksMatch = {
  recordId: string;
  number: string | null;
  vendorId: string | null;
  vendorName: string | null;
  date: string | null;
  /** Minor units of `currency`, as text: JSON has no bigint. */
  totalMinor: string;
  currency: string;
  /** Still owed, as far as the books say. Null when they don't say. */
  open: boolean | null;
  /** When it went into the books. */
  enteredAt: string | null;
  /** The same number; or, with no number on one side, the same vendor and amount within a week. */
  why: 'number' | 'amount_and_date';
};

/** What a person said about one bill in the books. */
export type BooksAnswer = { recordId: string; same: boolean; byUserId: string; at: string };

/** What one bill says about itself, as its posting would put it. */
export type BillForBooks = {
  vendorName: string;
  /** The vendor's ids in the books, as far as Decimal knows them. */
  vendorIds: string[];
  number: string | null;
  totalMinor: bigint;
  currency: string;
  date: string | null;
};

type Scope = { system: string; companyId: string };

// ─── What counts as the same bill: code, never a model ──────────────────────

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const digitsOf = (s: string) => s.replace(/\D/g, '');

/** One number written two ways: "INV-01042" and "inv 01042"; with four digits or more, "1042" too. */
export function sameNumber(a: string, b: string): boolean {
  const x = alnum(a);
  if (x !== '' && x === alnum(b)) return true;
  const digits = digitsOf(a).replace(/^0+/, '');
  return digits.length >= 4 && digits === digitsOf(b).replace(/^0+/, '');
}

/**
 * What to ask the books for: the number as written, and as it is likely keyed in
 * by hand. QuickBooks matches a number exactly, though not its case, so "INV 1042"
 * is asked for as "INV-1042" too. When the vendor is known, its bills are read
 * whatever their numbers, and `sameNumber` catches any other way of writing it.
 */
export function numberVariants(number: string | null): string[] {
  const written = number?.trim() ?? '';
  if (!written) return [];
  const digits = digitsOf(written);
  const variants = [written, written.replace(/[\s._/-]+/g, '-'), written.replace(/[\s._/-]+/g, ' '), alnum(written)];
  if (digits.replace(/^0+/, '').length >= 4) variants.push(digits, digits.replace(/^0+/, ''));
  return [...new Set(variants.filter((v) => v.length > 0))];
}

const dayOf = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
const daysApart = (a: string, b: string) => Math.abs(dayOf(a) - dayOf(b)) / DAY_MS;

/**
 * The bills in `candidates` that could be `bill`, closest first. Two numbers that
 * differ are two bills, however alike the rest. With a number missing on either
 * side, the same vendor, amount and currency within a week is enough to ask. Bills
 * Decimal posted for another bill are its own, not something already there.
 */
export function matchesInBooks(bill: BillForBooks, candidates: BooksBill[], postedByDecimal: ReadonlySet<string>): BooksMatch[] {
  const number = bill.number?.trim() || null;
  const found = new Map<string, { match: BooksMatch; gap: number }>();
  for (const c of candidates) {
    if (found.has(c.id) || postedByDecimal.has(c.id) || (c.note && POSTED_BY_DECIMAL.test(c.note))) continue;
    const sameVendor = c.vendorId !== null && bill.vendorIds.includes(c.vendorId);
    const related = sameVendor || (c.vendorName !== null && namesLookRelated(c.vendorName, bill.vendorName));
    const theirs = c.number?.trim() || null;
    let why: BooksMatch['why'] | null = null;
    if (number && theirs) {
      if (related && sameNumber(number, theirs)) why = 'number';
    } else if (sameVendor && c.currency === bill.currency && c.totalMinor === bill.totalMinor
      && bill.date && c.date && daysApart(bill.date, c.date) <= SAME_AMOUNT_WITHIN_DAYS) {
      why = 'amount_and_date';
    }
    if (!why) continue;
    found.set(c.id, {
      gap: bill.date && c.date ? daysApart(bill.date, c.date) : 1e9,
      match: {
        recordId: c.id,
        number: theirs,
        vendorId: c.vendorId,
        vendorName: c.vendorName,
        date: c.date,
        totalMinor: c.totalMinor.toString(),
        currency: c.currency,
        open: c.balanceMinor === null ? null : c.balanceMinor > 0n,
        enteredAt: c.createdAt,
        why,
      },
    });
  }
  return [...found.values()]
    .sort((a, b) => (a.match.why === b.match.why ? a.gap - b.gap : a.match.why === 'number' ? -1 : 1))
    .slice(0, MAX_MATCHES)
    .map((f) => f.match);
}

/** What changes the answer: the books, and the vendor, number, amount and date looked for. */
export function fingerprintOf(scope: Scope, bill: BillForBooks): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    scope.system, scope.companyId, bill.vendorName.trim().toLowerCase(), [...bill.vendorIds].sort(),
    bill.number?.trim() ?? '', bill.totalMinor.toString(), bill.currency, bill.date ?? '',
  ])).digest('hex');
}

/** Said when a bill's posting waits on a person. Its first sentence stands alone in the Inbox. */
export function heldMessage(system: string, matches: BooksMatch[]): string {
  const more = matches.length > 1 ? ` It has ${matches.length - 1} more that could be this one.` : '';
  return `${systemName(system)} already has ${describeBooksBill(matches[0]!)}, entered there outside Decimal.${more} Say on the bill whether it's the same one: if it is, Decimal links to it instead of posting it twice.`;
}

// ─── Reading the books ───────────────────────────────────────────────────────

function lookBackFrom(date: string | null): string {
  const from = date && /^\d{4}-\d{2}-\d{2}/.test(date) ? dayOf(date) : Date.now();
  return new Date(from - LOOK_BACK_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/** The bills Decimal itself put in these books for other bills. */
async function postedForOthers(organizationId: string, system: string, paymentOrderId: string): Promise<Set<string>> {
  const rows = await prisma.accountingSync.findMany({
    where: { organizationId, provider: system, externalBillId: { not: null }, paymentOrderId: { not: paymentOrderId } },
    select: { externalBillId: true },
  });
  return new Set(rows.map((r) => r.externalBillId!));
}

/** The bills in the books this one could be, read now. A read that fails throws: it never looks like "none". */
export async function lookInBooks(reader: BooksReader, organizationId: string, paymentOrderId: string, bill: BillForBooks): Promise<BooksMatch[]> {
  const candidates = await reader.billsLike({ numbers: numberVariants(bill.number), vendorIds: bill.vendorIds, since: lookBackFrom(bill.date) });
  return matchesInBooks(bill, candidates, await postedForOthers(organizationId, reader.system, paymentOrderId));
}

/**
 * The vendor's ids in the books, as far as Decimal knows them without asking: what
 * setup read and linked, and the vendor this vendor's earlier bills posted to.
 */
export async function knownVendorIds(organizationId: string, scope: Scope, vendorName: string, counterpartyId: string | null): Promise<string[]> {
  const ids = new Set<string>();
  const outcome = await readOutcome(organizationId, scope.system, scope.companyId).catch(() => null);
  const match = await vendorForBill(organizationId, scope.system, scope.companyId, vendorName, outcome).catch(() => null);
  if (match && 'vendorId' in match) ids.add(match.vendorId);
  if (counterpartyId) {
    const earlier = await prisma.accountingSync.findMany({
      where: { organizationId, provider: scope.system, externalVendorId: { not: null }, paymentOrder: { counterpartyId } },
      select: { externalVendorId: true },
      distinct: ['externalVendorId'],
      take: 5,
    });
    for (const e of earlier) ids.add(e.externalVendorId!);
  }
  return [...ids];
}

// ─── Stored, so every screen says the same ──────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const asJson = (value: unknown) => value as Prisma.InputJsonValue;

export function matchesOf(value: unknown): BooksMatch[] {
  return Array.isArray(value) ? value.filter((m): m is BooksMatch => isRecord(m) && typeof m.recordId === 'string') : [];
}

export function answersOf(value: unknown): BooksAnswer[] {
  return Array.isArray(value)
    ? value.filter((a): a is BooksAnswer => isRecord(a) && typeof a.recordId === 'string' && typeof a.same === 'boolean')
    : [];
}

/** The books a bill would post to, once posting is on. A lapsed sign-in still counts: it posts after. */
async function postingScope(organizationId: string): Promise<(Scope & { live: boolean }) | null> {
  const connection = await prisma.accountingConnection.findUnique({
    where: { organizationId_provider: { organizationId, provider: SYSTEM } },
    select: { realmId: true, status: true, postingEnabledAt: true },
  });
  if (!connection?.postingEnabledAt || connection.status === 'disconnected') return null;
  return { system: SYSTEM, companyId: connection.realmId, live: connection.status === 'connected' };
}

/** The bill as it stands in review: what the posting would send if it were approved now. */
async function billUnderReview(organizationId: string, paymentOrderId: string, scope: Scope): Promise<BillForBooks | null> {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    include: { counterparty: true, counterpartyWallet: true },
  });
  if (!order || order.state === 'cancelled') return null;
  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const verification = isRecord(metadata.verification) ? metadata.verification : {};
  const fields = isRecord(verification.fields) ? verification.fields : {};
  const agent = isRecord(metadata.agent) ? metadata.agent : {};
  const extracted = isRecord(agent.extracted) ? agent.extracted : {};
  const { currencyOfBill } = await import('../payments/bills.js');
  const vendorName = order.counterparty?.displayName ?? order.counterpartyWallet.label;
  return {
    vendorName,
    vendorIds: await knownVendorIds(organizationId, scope, vendorName, order.counterpartyId),
    number: textOf(fields.invoiceNumber) ?? textOf(extracted.invoiceNumber) ?? order.invoiceNumber,
    totalMinor: (order.amountRaw + 5_000n) / 10_000n,
    currency: currencyOfBill(order.metadataJson),
    date: textOf(fields.invoiceDate) ?? textOf(extracted.invoiceDate),
  };
}

/** Take the check for this bill, or find someone already has. Atomic: two reads start one check. */
async function claim(organizationId: string, paymentOrderId: string, scope: Scope, fingerprint: string): Promise<boolean> {
  const now = new Date();
  const lease = new Date(now.getTime() + LEASE_MS);
  const rows = await prisma.$queryRaw<Array<{ payment_order_id: string }>>`
    INSERT INTO bill_books_checks (payment_order_id, organization_id, system, company_id, status, fingerprint, lease_until)
    VALUES (${paymentOrderId}::uuid, ${organizationId}::uuid, ${scope.system}, ${scope.companyId}, 'running', ${fingerprint}, ${lease}::timestamptz)
    ON CONFLICT (payment_order_id) DO UPDATE SET
      status = 'running',
      lease_until = EXCLUDED.lease_until,
      matches = CASE WHEN bill_books_checks.fingerprint = EXCLUDED.fingerprint THEN bill_books_checks.matches ELSE '[]'::jsonb END,
      answers = CASE WHEN bill_books_checks.system = EXCLUDED.system AND bill_books_checks.company_id = EXCLUDED.company_id
        THEN bill_books_checks.answers ELSE '[]'::jsonb END,
      fingerprint = EXCLUDED.fingerprint,
      system = EXCLUDED.system,
      company_id = EXCLUDED.company_id,
      updated_at = ${now}::timestamptz
    WHERE bill_books_checks.status <> 'running' OR bill_books_checks.lease_until IS NULL OR bill_books_checks.lease_until < ${now}::timestamptz
    RETURNING payment_order_id`;
  return rows.length > 0;
}

async function runCheck(organizationId: string, paymentOrderId: string, scope: Scope, bill: BillForBooks, fingerprint: string): Promise<void> {
  try {
    const reader = await connectorFor(scope.system).reader(organizationId);
    if (!reader) throw new Error('The connection to the books is gone.');
    const matches = await lookInBooks(reader, organizationId, paymentOrderId, bill);
    // Only the check that still owns the row writes: a newer one may have taken it.
    await prisma.billBooksCheck.updateMany({
      where: { paymentOrderId, fingerprint, status: 'running' },
      data: { status: 'ready', matches: asJson(matches), error: null, checkedAt: new Date(), leaseUntil: null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.billBooksCheck.updateMany({
      where: { paymentOrderId, fingerprint, status: 'running' },
      data: { status: 'failed', error: message.slice(0, 500), checkedAt: new Date(), leaseUntil: null },
    }).catch(() => null);
    logger.warn('books_check.failed', { organizationId, paymentOrderId, message });
  }
}

/**
 * Look in the books again, in the background, when what's on file is missing,
 * about something else, or stale. Never waits for the read and never throws: a
 * check that can't run leaves the bill exactly as it was.
 *
 * Called on reading a bill's draft only, never from the workbench, which reads
 * every bill on the board at once.
 */
export async function ensureBooksCheck(organizationId: string, paymentOrderId: string): Promise<void> {
  try {
    const scope = await postingScope(organizationId);
    if (!scope?.live) return;
    // In the books already, through Decimal: there's nothing left to protect.
    const sync = await prisma.accountingSync.findUnique({
      where: { paymentOrderId_provider: { paymentOrderId, provider: scope.system } },
      select: { externalBillId: true },
    });
    if (sync?.externalBillId) return;
    const bill = await billUnderReview(organizationId, paymentOrderId, scope);
    if (!bill || bill.currency !== 'USD') return; // Decimal posts in USD only
    const fingerprint = fingerprintOf(scope, bill);
    const row = await prisma.billBooksCheck.findUnique({ where: { paymentOrderId } });
    const now = Date.now();
    if (row && row.fingerprint === fingerprint) {
      if (row.status === 'running' && row.leaseUntil && row.leaseUntil.getTime() > now) return;
      const freshFor = row.status === 'failed' ? RETRY_FAILED_MS : FRESH_MS;
      if (row.status !== 'running' && row.checkedAt && now - row.checkedAt.getTime() < freshFor) return;
    }
    if (!(await claim(organizationId, paymentOrderId, scope, fingerprint))) return;
    trackBackgroundWork(runCheck(organizationId, paymentOrderId, scope, bill, fingerprint));
  } catch (error) {
    logger.warn('books_check.not_started', { organizationId, paymentOrderId, ...(error instanceof Error ? { message: error.message } : {}) });
  }
}

/** What the flag rules need about a bill and the books (bill-flags.ts). */
export type BooksFlagFacts = {
  system: string;
  status: string;
  matches: BooksMatch[];
  answers: Array<{ recordId: string; same: boolean; byName: string; at: string }>;
};

/**
 * What was found in the books for these bills, and who said what about it. Only
 * for the books bills would post to now: another company's answers mean nothing.
 * Best-effort: on any failure a bill reads as never checked.
 */
export async function booksFactsFor(organizationId: string, paymentOrderIds: string[]): Promise<Map<string, BooksFlagFacts>> {
  const out = new Map<string, BooksFlagFacts>();
  if (paymentOrderIds.length === 0) return out;
  try {
    const scope = await postingScope(organizationId);
    if (!scope) return out;
    const rows = await prisma.billBooksCheck.findMany({
      where: { organizationId, paymentOrderId: { in: paymentOrderIds }, system: scope.system, companyId: scope.companyId },
    });
    const userIds = [...new Set(rows.flatMap((r) => answersOf(r.answers).map((a) => a.byUserId)))];
    const users = userIds.length > 0
      ? await prisma.user.findMany({ where: { userId: { in: userIds } }, select: { userId: true, displayName: true, email: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.userId, u.displayName?.trim() || u.email]));
    for (const r of rows) {
      out.set(r.paymentOrderId, {
        system: r.system,
        status: r.status,
        matches: matchesOf(r.matches),
        answers: answersOf(r.answers).map((a) => ({ recordId: a.recordId, same: a.same, byName: nameOf.get(a.byUserId) ?? 'Someone', at: a.at })),
      });
    }
  } catch (error) {
    logger.warn('books_check.facts_failed', { organizationId, ...(error instanceof Error ? { message: error.message } : {}) });
  }
  return out;
}

// ─── Just before posting ─────────────────────────────────────────────────────

export type BeforePosting =
  | { kind: 'clear' }
  /** A person said it's this bill in the books: link to it, don't post. */
  | { kind: 'same'; recordId: string; vendorId: string | null; number: string | null }
  /** It could be there, and nobody has said: don't post, ask. */
  | { kind: 'held'; message: string };

/**
 * Look again, live, right before the bill posts. A person's "same bill" links it,
 * while that bill is still there and still looks like this one; a bill in the books
 * nobody has answered about holds the posting; anything else lets it post. A read
 * that fails throws, and the posting fails with it.
 */
export async function checkBeforePosting(args: {
  organizationId: string;
  paymentOrderId: string;
  reader: BooksReader;
  bill: BillForBooks;
}): Promise<BeforePosting> {
  const { organizationId, paymentOrderId, reader, bill } = args;
  const scope: Scope = { system: reader.system, companyId: reader.companyId };
  const row = await prisma.billBooksCheck.findUnique({ where: { paymentOrderId } }).catch(() => null);
  const sameBooks = row !== null && row.system === scope.system && row.companyId === scope.companyId;
  const answers = sameBooks ? answersOf(row.answers) : [];

  const matches = await lookInBooks(reader, organizationId, paymentOrderId, bill);
  const fingerprint = fingerprintOf(scope, bill);
  const seen = { status: 'ready', fingerprint, matches: asJson(matches), error: null, checkedAt: new Date(), leaseUntil: null };
  // What was seen, so the bill's page shows it. The decision below stands without it.
  await prisma.billBooksCheck.upsert({
    where: { paymentOrderId },
    create: { paymentOrderId, organizationId, system: scope.system, companyId: scope.companyId, ...seen },
    update: { system: scope.system, companyId: scope.companyId, ...seen, ...(sameBooks ? {} : { answers: asJson([]) }) },
  }).catch((error) => logger.warn('books_check.not_saved', { paymentOrderId, ...(error instanceof Error ? { message: error.message } : {}) }));

  // Deleted there since, or the bill here has changed so it no longer looks like
  // that one: the answer was about something that isn't so any more.
  const linked = matches.find((m) => answers.some((a) => a.same && a.recordId === m.recordId));
  if (linked) return { kind: 'same', recordId: linked.recordId, vendorId: linked.vendorId, number: linked.number };
  const unanswered = matches.filter((m) => !answers.some((a) => a.recordId === m.recordId));
  return unanswered.length > 0 ? { kind: 'held', message: heldMessage(scope.system, unanswered) } : { kind: 'clear' };
}

// ─── A person's answer ───────────────────────────────────────────────────────

/**
 * "Same bill" or "different bill", about one bill in the books. Kept across
 * checks. A second "same" moves the link: a bill is one bill in the books. If the
 * bill's posting was waiting on this, it goes now, and what happened comes back.
 */
export async function answerBooksMatch(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  recordId: string;
  same: boolean;
}): Promise<{ posting: 'synced' | 'skipped' | 'error' | 'held' | null; linked: boolean }> {
  const { organizationId, paymentOrderId, actorUserId, recordId, same } = args;
  const row = await prisma.billBooksCheck.findUnique({ where: { paymentOrderId } });
  if (!row || row.organizationId !== organizationId) throw notFound('Nothing in the books was found for this bill. Open it again to look.');
  const match = matchesOf(row.matches).find((m) => m.recordId === recordId);
  if (!match) throw conflict('That bill in the books is no longer one this could be. Open the bill again to see what is there now.');
  const sync = await prisma.accountingSync.findUnique({
    where: { paymentOrderId_provider: { paymentOrderId, provider: row.system } },
    select: { status: true, externalBillId: true },
  });
  // Posted or linked already: an answer now would only make the record say something that didn't happen.
  if (sync?.externalBillId) throw conflict(`This bill is in ${systemName(row.system)} already, so there's nothing left to decide.`);

  const answers = answersOf(row.answers).filter((a) => a.recordId !== recordId && !(same && a.same));
  answers.push({ recordId, same, byUserId: actorUserId, at: new Date().toISOString() });
  await prisma.billBooksCheck.update({ where: { paymentOrderId }, data: { answers: asJson(answers) } });

  // On the record, as the other answers to a flag are.
  const [order, actor] = await Promise.all([
    prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId }, select: { state: true } }),
    prisma.user.findUnique({ where: { userId: actorUserId }, select: { displayName: true, email: true } }),
  ]);
  const byName = actor?.displayName?.trim() || actor?.email || 'Someone';
  const system = systemName(row.system);
  await prisma.paymentOrderEvent.create({
    data: {
      organizationId,
      paymentOrderId,
      eventType: 'policy_overridden',
      actorType: 'user',
      actorId: actorUserId,
      beforeState: order.state,
      afterState: order.state,
      payloadJson: {
        rule: 'in_books',
        recordId,
        same,
        reason: same
          ? `${byName} said this is the bill already in ${system}: ${describeBooksBill(match)}. Decimal links to it instead of posting it again.`
          : `${byName} said the bill in ${system}, ${describeBooksBill(match)}, is a different one, so this one posts as its own.`,
      },
    },
  });

  if (sync?.status !== 'held') return { posting: null, linked: false };
  const { syncApprovedBill } = await import('./account-sync.js');
  const posting = await syncApprovedBill(paymentOrderId);
  // "Same", and the bill there has gone since: it posted as its own. Which one happened, so nobody is told it linked.
  const after = await prisma.accountingSync.findUnique({
    where: { paymentOrderId_provider: { paymentOrderId, provider: row.system } },
    select: { metadataJson: true },
  });
  return { posting, linked: isRecord(after?.metadataJson) && after.metadataJson.linkedFromBooks === true };
}
