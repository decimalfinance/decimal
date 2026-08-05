import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { requireTestDatabase } from './helpers/require-test-database.js';
import { signSvixPayloadForTests, verifySvixSignature } from '../src/payments/inbound-email/svix-signature.js';
import {
  RESERVED_INTAKE_SLUGS,
  backfillIntakeSlugs,
  extractEmailAddress,
  intakeAddressFor,
  isValidIntakeSlug,
  mintIntakeSlug,
  normalizeIntakeSlug,
  parseIntakeAddress,
} from '../src/payments/inbound-email/slug.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  inbound_email_attachments,
  inbound_email_messages,
  organization_memberships,
  organizations,
  users
RESTART IDENTITY CASCADE
`;

const DOMAIN = 'bills.decimal.test';

before(async () => {
  await requireTestDatabase();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(TRUNCATE_SQL);
});

after(async () => {
  await prisma.$disconnect();
});

async function createOrg(organizationName: string) {
  return prisma.organization.create({ data: { organizationName } });
}

// --- normalization -----------------------------------------------------------

test('a slug is the organization name lowercased and hyphenated', () => {
  assert.equal(normalizeIntakeSlug('Northwind Trading'), 'northwind-trading');
});

test('accents, punctuation, and legal suffixes are stripped (Ácme Inc. → acme)', () => {
  assert.equal(normalizeIntakeSlug('Ácme Inc.'), 'acme');
  assert.equal(normalizeIntakeSlug('Acme, LLC'), 'acme');
  assert.equal(normalizeIntakeSlug('Acme Systems Pvt Ltd'), 'acme-systems');
  // repeated suffixes peel off one at a time
  assert.equal(normalizeIntakeSlug('Acme Holdings Inc'), 'acme');
});

test('an ampersand becomes a word rather than vanishing', () => {
  assert.equal(normalizeIntakeSlug('Smith & Sons'), 'smith-and-sons');
});

test('a name that normalizes to nothing usable returns null so the caller can fall back', () => {
  assert.equal(normalizeIntakeSlug('株式会社'), null);
  assert.equal(normalizeIntakeSlug('1234'), null);
  assert.equal(normalizeIntakeSlug('  '), null);
  // a bare legal suffix is the whole name: nothing is stripped, but it is too short
  assert.equal(normalizeIntakeSlug('Co'), null);
});

test('an overlong name is truncated without leaving a trailing hyphen', () => {
  const slug = normalizeIntakeSlug(`${'a'.repeat(38)} bcdefgh`)!;
  assert.ok(slug.length <= 40);
  assert.ok(!slug.endsWith('-'));
  assert.ok(isValidIntakeSlug(slug));
});

test('every normalized slug satisfies the database shape constraint', () => {
  for (const name of ['Acme', 'Northwind Trading', 'Smith & Sons', 'Ácme Inc.', 'a'.repeat(80)]) {
    const slug = normalizeIntakeSlug(name);
    if (slug !== null) assert.ok(isValidIntakeSlug(slug), `${name} → ${slug}`);
  }
});

// --- minting -----------------------------------------------------------------

test('two organizations named Acme get acme and acme-2', async () => {
  const first = await createOrg('Acme');
  const second = await createOrg('Acme Inc.');

  const a = await prisma.$transaction((tx) => mintIntakeSlug(tx, first.organizationId, 'Acme'));
  const b = await prisma.$transaction((tx) => mintIntakeSlug(tx, second.organizationId, 'Acme Inc.'));

  assert.equal(a, 'acme');
  assert.equal(b, 'acme-2');
});

test('a slug collision does not poison the transaction that is creating the organization', async () => {
  // Postgres aborts the whole transaction on a constraint violation. Minting
  // happens inside org creation, so a collision must roll back only the failed
  // attempt — otherwise the second Acme could never be created at all.
  await createOrg('Acme').then((org) =>
    prisma.$transaction((tx) => mintIntakeSlug(tx, org.organizationId, 'Acme')),
  );

  const slug = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { organizationName: 'Acme Two' } });
    const minted = await mintIntakeSlug(tx, org.organizationId, 'Acme');
    // The real caller keeps working after minting — this write must succeed.
    const user = await tx.user.create({
      data: { email: 'owner@acme.test', displayName: 'Owner', status: 'active' },
    });
    await tx.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: user.userId, role: 'owner' },
    });
    return minted;
  });

  assert.equal(slug, 'acme-2');
  assert.equal(await prisma.organizationMembership.count(), 1, 'the rest of the transaction committed');
});

test('a reserved local part is never handed out (Billing Ltd → billing-2)', async () => {
  const org = await createOrg('Billing Ltd');
  const slug = await prisma.$transaction((tx) => mintIntakeSlug(tx, org.organizationId, 'Billing Ltd'));

  assert.equal(slug, 'billing-2');
  assert.ok(!RESERVED_INTAKE_SLUGS.has(slug));
});

test('a name that normalizes to nothing falls back to a stable org- slug', async () => {
  const org = await createOrg('株式会社');
  const slug = await prisma.$transaction((tx) => mintIntakeSlug(tx, org.organizationId, '株式会社'));

  assert.match(slug, /^org-[0-9a-f]{8}$/);
  assert.ok(isValidIntakeSlug(slug));
});

test('renaming an organization leaves its intake address alone', async () => {
  const org = await createOrg('Acme');
  const slug = await prisma.$transaction((tx) => mintIntakeSlug(tx, org.organizationId, 'Acme'));

  await prisma.organization.update({
    where: { organizationId: org.organizationId },
    data: { organizationName: 'Completely Different Name' },
  });

  const after = await prisma.organization.findUniqueOrThrow({
    where: { organizationId: org.organizationId },
    select: { intakeSlug: true },
  });
  assert.equal(after.intakeSlug, slug, 'the address is printed in vendor address books — it must not move');
});

// --- backfill ----------------------------------------------------------------

test('the backfill mints a slug for every organization that has none, and is a no-op on the second run', async () => {
  await createOrg('Acme');
  await createOrg('Northwind Trading');

  const first = await backfillIntakeSlugs();
  assert.equal(first.minted, 2);
  assert.equal(first.failed, 0);

  const slugs = await prisma.organization.findMany({ select: { intakeSlug: true }, orderBy: { organizationName: 'asc' } });
  assert.deepEqual(slugs.map((s) => s.intakeSlug), ['acme', 'northwind-trading']);

  const second = await backfillIntakeSlugs();
  assert.equal(second.minted, 0, 'a second boot must not re-mint anything');

  const unchanged = await prisma.organization.findMany({ select: { intakeSlug: true }, orderBy: { organizationName: 'asc' } });
  assert.deepEqual(unchanged.map((s) => s.intakeSlug), ['acme', 'northwind-trading']);
});

// --- addresses ---------------------------------------------------------------

test('an intake address is the slug at the configured receiving domain', () => {
  assert.equal(intakeAddressFor('acme', DOMAIN), `acme@${DOMAIN}`);
  assert.equal(intakeAddressFor(null, DOMAIN), null);
  assert.equal(intakeAddressFor('acme', ''), null, 'no address exists until intake is configured');
});

test('a recipient address resolves back to the organization slug', () => {
  assert.deepEqual(parseIntakeAddress(`acme@${DOMAIN}`, DOMAIN), { slug: 'acme', plusTag: null });
  assert.deepEqual(parseIntakeAddress(`ACME@${DOMAIN.toUpperCase()}`, DOMAIN), { slug: 'acme', plusTag: null });
});

test('plus-addressing keeps the slug and records the tag', () => {
  assert.deepEqual(parseIntakeAddress(`acme+uk@${DOMAIN}`, DOMAIN), { slug: 'acme', plusTag: 'uk' });
});

test('an address on any other domain is not ours', () => {
  assert.equal(parseIntakeAddress('acme@example.com', DOMAIN), null);
  assert.equal(parseIntakeAddress('not-an-address', DOMAIN), null);
  assert.equal(parseIntakeAddress(`acme@${DOMAIN}`, ''), null);
});

test('a display-name header yields the bare address', () => {
  assert.equal(extractEmailAddress('Acme Books <ap@acme.com>'), 'ap@acme.com');
  assert.equal(extractEmailAddress('  AP@Acme.com '), 'ap@acme.com');
});

// --- webhook signature -------------------------------------------------------

const SECRET = `whsec_${Buffer.from('a-test-signing-key-of-decent-length').toString('base64')}`;
const NOW = 1_800_000_000;

function signed(body: string, overrides: { secret?: string; id?: string; at?: number } = {}) {
  return signSvixPayloadForTests({
    rawBody: Buffer.from(body, 'utf8'),
    secret: overrides.secret ?? SECRET,
    id: overrides.id ?? 'msg_2abc',
    timestampSeconds: overrides.at ?? NOW,
  });
}

test('a correctly signed payload verifies', () => {
  const body = '{"type":"email.received"}';
  const result = verifySvixSignature({
    rawBody: Buffer.from(body, 'utf8'),
    headers: signed(body),
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: true });
});

test('a tampered body fails verification', () => {
  const headers = signed('{"type":"email.received","amount":1}');
  const result = verifySvixSignature({
    rawBody: Buffer.from('{"type":"email.received","amount":9999}', 'utf8'),
    headers,
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'no_match' });
});

test('a payload signed with a different secret is rejected', () => {
  const body = '{"type":"email.received"}';
  const headers = signed(body, { secret: `whsec_${Buffer.from('some-other-key-entirely').toString('base64')}` });
  const result = verifySvixSignature({
    rawBody: Buffer.from(body, 'utf8'),
    headers,
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'no_match' });
});

test('a timestamp outside the tolerance window is rejected as a replay', () => {
  const body = '{"type":"email.received"}';
  const headers = signed(body, { at: NOW - 3600 });
  const result = verifySvixSignature({
    rawBody: Buffer.from(body, 'utf8'),
    headers,
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'stale_timestamp' });
  // ...and a future timestamp is equally suspicious
  assert.deepEqual(
    verifySvixSignature({
      rawBody: Buffer.from(body, 'utf8'),
      headers: signed(body, { at: NOW + 3600 }),
      secret: SECRET,
      nowSeconds: NOW,
    }),
    { ok: false, reason: 'stale_timestamp' },
  );
});

test('a header carrying several signatures verifies when any one matches', () => {
  // What a secret rotation looks like on the wire.
  const body = '{"type":"email.received"}';
  const valid = signed(body)['svix-signature'];
  const headers = { ...signed(body), 'svix-signature': `v1,ZmFrZXNpZ25hdHVyZQ== ${valid}` };
  assert.deepEqual(
    verifySvixSignature({ rawBody: Buffer.from(body, 'utf8'), headers, secret: SECRET, nowSeconds: NOW }),
    { ok: true },
  );
});

test('an unknown signature version is ignored rather than trusted', () => {
  const body = '{"type":"email.received"}';
  const valid = signed(body)['svix-signature']!.slice('v1,'.length);
  const headers = { ...signed(body), 'svix-signature': `v2,${valid}` };
  assert.deepEqual(
    verifySvixSignature({ rawBody: Buffer.from(body, 'utf8'), headers, secret: SECRET, nowSeconds: NOW }),
    { ok: false, reason: 'no_match' },
  );
});

test('a malformed signature header is rejected, never thrown on', () => {
  const body = '{"type":"email.received"}';
  for (const bad of ['', 'garbage', 'v1', 'v1,', '!!!not base64!!!']) {
    const headers = { ...signed(body), 'svix-signature': bad };
    const result = verifySvixSignature({
      rawBody: Buffer.from(body, 'utf8'),
      headers,
      secret: SECRET,
      nowSeconds: NOW,
    });
    assert.equal(result.ok, false, `should not verify: ${JSON.stringify(bad)}`);
  }
});

test('missing headers are reported distinctly from a signature mismatch', () => {
  const body = '{"type":"email.received"}';
  assert.deepEqual(
    verifySvixSignature({ rawBody: Buffer.from(body, 'utf8'), headers: {}, secret: SECRET, nowSeconds: NOW }),
    { ok: false, reason: 'missing_headers' },
  );
});

test('the webhook-* header spelling is accepted as well as svix-*', () => {
  const body = '{"type":"email.received"}';
  const svix = signed(body);
  const headers = {
    'webhook-id': svix['svix-id']!,
    'webhook-timestamp': svix['svix-timestamp']!,
    'webhook-signature': svix['svix-signature']!,
  };
  assert.deepEqual(
    verifySvixSignature({ rawBody: Buffer.from(body, 'utf8'), headers, secret: SECRET, nowSeconds: NOW }),
    { ok: true },
  );
});

test('the signature covers the raw bytes, so re-serialized JSON does not verify', () => {
  // The reason the route mounts express.raw() instead of reusing express.json():
  // parsing and re-serializing changes the bytes (here, whitespace) even though
  // the JSON value is identical, and the signature would silently stop matching.
  const body = '{"type":"email.received","a":1}';
  const reserialized = JSON.stringify(JSON.parse(body), null, 1);
  assert.notEqual(reserialized, body, 'same value, different bytes');

  const result = verifySvixSignature({
    rawBody: Buffer.from(reserialized, 'utf8'),
    headers: signed(body),
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'no_match' });
});
