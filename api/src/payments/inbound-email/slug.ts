// The org's intake address: acme@bills.decimal.finance.
//
// The receiving domain is a catch-all, so the local part is the ONLY thing
// identifying a customer — which makes it both the address book and a security
// boundary. It is minted once, at organization creation, and deliberately never
// re-minted on rename: customers print this address in their vendors' remit-to
// instructions, so a slug that silently moves would break mail already in
// flight. Stability beats prettiness.
//
// The reserved-word list lives here and only here. postgres/init/011 guards
// shape and uniqueness; duplicating the vocabulary in SQL would let the two
// drift.
import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { config } from '../../config.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

/**
 * Local parts we never hand out. Two families: addresses mail infrastructure
 * itself reserves (postmaster, abuse, bounce — RFC 2142 and friends), and
 * addresses a customer would reasonably assume belong to Decimal rather than to
 * their own org (billing, support, sales).
 */
export const RESERVED_INTAKE_SLUGS: ReadonlySet<string> = new Set([
  // mail infrastructure
  'admin', 'administrator', 'abuse', 'postmaster', 'hostmaster', 'webmaster',
  'security', 'root', 'noreply', 'no-reply', 'donotreply', 'mailer-daemon',
  'bounce', 'bounces', 'dmarc', 'spf', 'dkim',
  // would read as "Decimal's own", not "this org's"
  'billing', 'billings', 'invoice', 'invoices', 'bill', 'bills',
  'ap', 'accounts', 'accounting', 'payments', 'payment',
  'support', 'help', 'info', 'hello', 'contact', 'sales', 'team', 'ops',
  'mail', 'email', 'api', 'www', 'app', 'dev', 'test', 'staging',
  'decimal', 'decimalfinance',
]);

// Stripped from the end of a name, repeatedly: "Acme Systems Inc." → "acme systems".
const LEGAL_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'gmbh', 'bv', 'nv', 'ab', 'oy', 'as', 'pty', 'pte', 'plc', 'sarl', 'sa',
  'ag', 'kk', 'pvt', 'private', 'holdings', 'group',
]);

const MAX_SLUG_LENGTH = 40;
const MIN_SLUG_LENGTH = 3;

/**
 * Organization name → candidate local part, or null when the name carries no
 * usable letters (e.g. "株式会社" or "1234"). Callers fall back to a random slug.
 */
export function normalizeIntakeSlug(organizationName: string): string | null {
  let value = organizationName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // drop combining marks: "Ácme" → "Acme"
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ');

  // Strip trailing legal suffixes token-wise, repeatedly — "Acme Inc. Ltd"
  // should still land on "acme".
  let tokens = value.split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) {
    tokens = tokens.slice(0, -1);
  }
  value = tokens.join('-');

  value = value.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  if (value.length > MAX_SLUG_LENGTH) {
    value = value.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
  }

  // All-digit slugs read like an id, not an org, and collide with nothing
  // meaningful — treat them as unusable.
  if (value.length < MIN_SLUG_LENGTH || /^[0-9]+$/.test(value)) {
    return null;
  }
  return value;
}

/** Is this a shape the database CHECK constraint will accept? */
export function isValidIntakeSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(value);
}

function randomSuffix(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Candidates in preference order: the bare name, then readable numeric
 * suffixes, then random hex. Numeric first because a customer reads this
 * address aloud to a vendor — "acme dash two" beats "acme dash 7f3k".
 */
function* candidates(base: string): Generator<string> {
  if (!RESERVED_INTAKE_SLUGS.has(base)) {
    yield base;
  }
  for (let n = 2; n <= 9; n += 1) {
    yield `${base}-${n}`;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    yield `${base}-${randomSuffix(2)}`;
  }
  yield `org-${randomSuffix(4)}`;
}

// Postgres aborts the entire transaction on a constraint violation, so a bare
// try/catch retry loop would poison the org-creation transaction this runs
// inside. Each attempt is wrapped in a savepoint: a collision rolls back only
// that attempt, leaving the caller's transaction healthy.
const SAVEPOINT = 'intake_slug_attempt';

/**
 * Mint a unique slug for a new organization. Runs inside the caller's
 * transaction.
 *
 * A pre-flight SELECT picks the first free candidate — that is the common path
 * and costs one query. It is not the uniqueness authority though: two orgs
 * named "Acme" created concurrently would both see "acme" free. The database's
 * partial unique index settles that race, and the savepoint loop absorbs the
 * loser's collision and moves it to the next candidate.
 */
export async function mintIntakeSlug(
  tx: Prisma.TransactionClient,
  organizationId: string,
  organizationName: string,
): Promise<string> {
  const base = normalizeIntakeSlug(organizationName) ?? `org-${randomSuffix(4)}`;
  const options = [...candidates(base)].filter(isValidIntakeSlug);

  const taken = new Set(
    (
      await tx.organization.findMany({
        where: { intakeSlug: { in: options } },
        select: { intakeSlug: true },
      })
    ).map((row) => row.intakeSlug),
  );

  // Free candidates first, then the rest as race fallbacks.
  const ordered = [...options.filter((o) => !taken.has(o)), ...options.filter((o) => taken.has(o))];

  for (const candidate of ordered) {
    await tx.$executeRawUnsafe(`SAVEPOINT ${SAVEPOINT}`);
    try {
      await tx.organization.update({
        where: { organizationId },
        data: { intakeSlug: candidate },
      });
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return candidate;
    } catch (error) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }

  // Every candidate collided, including five random ones — effectively
  // impossible, but never leave the org without an address silently.
  throw new Error(`Could not mint an intake slug for organization ${organizationId}`);
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'P2002');
}

/**
 * Give every organization that predates this feature an address. Runs once at
 * boot, is a no-op on the second run, and never touches an org that already has
 * a slug. A failure for one org is logged and skipped rather than blocking
 * startup — an org without an intake address still works everywhere else.
 */
export async function backfillIntakeSlugs(): Promise<{ minted: number; failed: number }> {
  const pending = await prisma.organization.findMany({
    where: { intakeSlug: null },
    select: { organizationId: true, organizationName: true },
  });
  if (pending.length === 0) return { minted: 0, failed: 0 };

  let minted = 0;
  let failed = 0;
  for (const org of pending) {
    try {
      await prisma.$transaction((tx) => mintIntakeSlug(tx, org.organizationId, org.organizationName));
      minted += 1;
    } catch (error) {
      failed += 1;
      logger.warn('inbound_email.slug_backfill_failed', {
        organizationId: org.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info('inbound_email.slug_backfill', { minted, failed });
  return { minted, failed };
}

// The domain defaults from config but is injectable: config is read once at
// module load, so a test can only exercise these by passing it explicitly.

/** The address a customer forwards bills to. Null when intake isn't configured. */
export function intakeAddressFor(
  slug: string | null | undefined,
  domain: string = config.inboundEmailDomain,
): string | null {
  if (!slug || !domain) return null;
  return `${slug}@${domain}`;
}

/**
 * Pull an org's slug back out of a recipient address, if it is one of ours.
 * Handles plus-addressing (acme+uk@…) — the tag is recorded but unused in v1,
 * so multi-entity routing has its data the day it's asked for.
 */
export function parseIntakeAddress(
  address: string,
  inboundDomain: string = config.inboundEmailDomain,
): { slug: string; plusTag: string | null } | null {
  if (!inboundDomain) return null;
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;

  const domain = address.slice(at + 1).trim().toLowerCase();
  if (domain !== inboundDomain.toLowerCase()) return null;

  const localPart = address.slice(0, at).trim().toLowerCase();
  const plus = localPart.indexOf('+');
  const slug = plus === -1 ? localPart : localPart.slice(0, plus);
  const plusTag = plus === -1 ? null : localPart.slice(plus + 1) || null;

  if (!isValidIntakeSlug(slug)) return null;
  return { slug, plusTag };
}

/**
 * "Acme Books <ap@acme.com>" → "ap@acme.com". Inbound `from`/`to` fields arrive
 * as display-name headers about as often as bare addresses.
 */
export function extractEmailAddress(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  return (angled ? angled[1]! : value).trim().toLowerCase();
}
