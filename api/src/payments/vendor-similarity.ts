/**
 * Is this vendor one we already have, wearing a slightly different name?
 *
 * An invoice arrived from "Brightwave Media Ltd" for an organisation that
 * already pays "Brightwave Media", and nothing said a word. A second vendor
 * record was created in silence.
 *
 * Both automatic answers are wrong, which is why this only ever raises a
 * question:
 *
 *   Merging on our own is dangerous. Attaching the bill to the existing vendor
 *   inherits that vendor's payment details, and a near-identical name is a
 *   known way to redirect payments — the impersonator's whole aim is to be
 *   treated as the record you already trust.
 *
 *   Splitting in silence is what happened, and it costs the other way. Two
 *   records for one company split its history and spend, and duplicate
 *   detection keys on vendor plus invoice number — so the same invoice arriving
 *   under both names is never caught. Duplicate vendors in the master file are
 *   a documented top cause of duplicate payments.
 *
 * So: notice, say so, and let a person decide. Then remember the answer, or the
 * question is asked again every month.
 */
import { prisma } from '../infra/prisma.js';

/**
 * Legal-form suffixes, and ONLY those.
 *
 * bill-flags.ts has a broader NAME_NOISE list that also drops words like
 * "media", "labs" and "group". That list answers a different question — is this
 * bill addressed to us — where matching too eagerly is safe, because the cost
 * of a wrong guess is a flag nobody needed.
 *
 * Here the cost runs the other way. Reusing it would make "Brightwave Media"
 * and "Brightwave Films" the same vendor, which they are not. A company that
 * writes itself with and without its legal suffix is the case worth catching,
 * and it is almost all of the real ones.
 */
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc',
  'corp', 'corporation', 'co', 'company', 'gmbh', 'ag', 'kg', 'ug',
  'bv', 'nv', 'sa', 'sas', 'sarl', 'srl', 'spa', 'ab', 'as', 'oy', 'aps',
  'pty', 'pte', 'pvt', 'private', 'sdn', 'bhd', 'kk', 'gk',
]);

/**
 * A vendor name reduced to the part that identifies the company.
 *
 * Lowercased, punctuation and spacing removed, legal suffixes stripped from the
 * end — where they appear — and repeatedly, because "Acme Co Ltd" carries two.
 *
 *     Brightwave Media Ltd   ->  brightwavemedia
 *     Brightwave Media       ->  brightwavemedia
 *     BRIGHTWAVE MEDIA, LTD. ->  brightwavemedia
 *
 * Returns an empty string for a name that is nothing but suffixes, which is not
 * an identity and must never match another one.
 */
export function normalizeVendorName(name: string | null | undefined): string {
  const tokens = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 0 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join('');
}

/** Names this vendor has already been seen under, plus its own. */
function knownNamesOf(displayName: string, metadata: unknown): string[] {
  const meta = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
  const aliases = Array.isArray(meta.nameAliases)
    ? (meta.nameAliases as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  return [displayName, ...aliases];
}

/** Vendors this one has been declared NOT to be, so we stop asking. */
function notSameAs(metadata: unknown): string[] {
  const meta = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
  return Array.isArray(meta.notSameAs)
    ? (meta.notSameAs as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
}

export type SimilarVendor = {
  counterpartyId: string;
  displayName: string;
  /** How many bills this org has already had from them. */
  billCount: number;
};

export type VendorDirectoryEntry = {
  counterpartyId: string;
  displayName: string;
  billCount: number;
  /** Every spelling this vendor is known by, normalised. */
  keys: string[];
  /** Vendors somebody has already said this one is not. */
  notSameAs: string[];
};

/**
 * Every vendor in the org, in the shape the comparison needs.
 *
 * Loaded separately from the comparison so the bills workbench can fetch it
 * ONCE and match every row against it. Asking per bill would be a query per row
 * on a screen whose whole job is showing many rows.
 */
export async function loadVendorDirectory(organizationId: string): Promise<VendorDirectoryEntry[]> {
  const rows = await prisma.counterparty.findMany({
    where: { organizationId, status: 'active' },
    select: {
      counterpartyId: true, displayName: true, metadataJson: true,
      _count: { select: { paymentOrders: true } },
    },
  });
  return rows.map((c) => ({
    counterpartyId: c.counterpartyId,
    displayName: c.displayName,
    billCount: c._count.paymentOrders,
    keys: knownNamesOf(c.displayName, c.metadataJson).map(normalizeVendorName).filter(Boolean),
    notSameAs: notSameAs(c.metadataJson),
  }));
}

/**
 * Other vendors whose identifying name is the same as this one's.
 *
 * Excludes the vendor the bill is already attached to — a bill always matches
 * its own vendor, and saying so would be noise — and any pair somebody has
 * already told us are different companies.
 */
export function similarVendorsIn(
  directory: VendorDirectoryEntry[],
  vendorName: string,
  selfCounterpartyId: string | null,
): SimilarVendor[] {
  const target = normalizeVendorName(vendorName);
  if (!target) return [];
  const self = directory.find((c) => c.counterpartyId === selfCounterpartyId);
  const selfSaysDifferent = new Set(self?.notSameAs ?? []);

  return directory
    .filter((c) => c.counterpartyId !== selfCounterpartyId)
    .filter((c) => !selfSaysDifferent.has(c.counterpartyId))
    .filter((c) => !c.notSameAs.includes(selfCounterpartyId ?? ''))
    .filter((c) => c.keys.includes(target))
    .map(({ counterpartyId, displayName, billCount }) => ({ counterpartyId, displayName, billCount }))
    // The most-used record first: if one of these is the real vendor, it is
    // almost always the one with the history.
    .sort((a, b) => b.billCount - a.billCount);
}

/** Load and compare in one go, for callers looking at a single bill. */
export async function findSimilarVendors(args: {
  organizationId: string;
  vendorName: string;
  selfCounterpartyId: string | null;
}): Promise<SimilarVendor[]> {
  const directory = await loadVendorDirectory(args.organizationId);
  return similarVendorsIn(directory, args.vendorName, args.selfCounterpartyId);
}

/**
 * Record that two vendor records are the same company.
 *
 * The alias goes on the SURVIVING vendor so the next invoice under that
 * spelling matches it directly and never raises the question again.
 */
export async function recordVendorAlias(counterpartyId: string, alias: string): Promise<void> {
  const row = await prisma.counterparty.findUniqueOrThrow({
    where: { counterpartyId }, select: { metadataJson: true },
  });
  const meta = (row.metadataJson && typeof row.metadataJson === 'object' ? row.metadataJson : {}) as Record<string, unknown>;
  const existing = Array.isArray(meta.nameAliases)
    ? (meta.nameAliases as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  if (existing.some((a) => a.toLowerCase() === alias.toLowerCase())) return;
  await prisma.counterparty.update({
    where: { counterpartyId },
    data: { metadataJson: { ...meta, nameAliases: [...existing, alias] } as never },
  });
}

/**
 * Record that two vendor records are NOT the same company.
 *
 * Written on both sides, because the question can be asked from either
 * direction and an answer given once should hold whichever way round the next
 * invoice arrives.
 */
export async function recordVendorsDiffer(a: string, b: string): Promise<void> {
  for (const [self, other] of [[a, b], [b, a]] as const) {
    const row = await prisma.counterparty.findUnique({
      where: { counterpartyId: self }, select: { metadataJson: true },
    });
    if (!row) continue;
    const meta = (row.metadataJson && typeof row.metadataJson === 'object' ? row.metadataJson : {}) as Record<string, unknown>;
    const existing = notSameAs(meta);
    if (existing.includes(other)) continue;
    await prisma.counterparty.update({
      where: { counterpartyId: self },
      data: { metadataJson: { ...meta, notSameAs: [...existing, other] } as never },
    });
  }
}
