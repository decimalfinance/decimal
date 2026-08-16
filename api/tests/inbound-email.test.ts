import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';
import { config } from '../src/config.js';
import { prisma } from '../src/infra/prisma.js';
import { resetRateLimitBuckets } from '../src/infra/rate-limit.js';
import { requireTestDatabase } from './helpers/require-test-database.js';
import { runInboundEmailIntakeOnce } from '../src/agents/inbound-email-intake.js';
import { setInvoiceIntakeRuntimeForTests } from '../src/payments/invoice-intake.js';
import {
  clearSimulatedAttachmentBytes,
  setResendInboundRuntimeForTests,
} from '../src/payments/inbound-email/resend-inbound.js';
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
  payment_order_events,
  payment_orders,
  invoice_documents,
  counterparty_wallets,
  counterparties,
  organization_memberships,
  organizations,
  users
RESTART IDENTITY CASCADE
`;

// Matches INBOUND_EMAIL_DOMAIN / RESEND_INBOUND_WEBHOOK_SECRET in the test
// script — the webhook route reads them from config at module load.
const DOMAIN = 'bills.decimal.test';

let baseUrl = '';
let closeServer: (() => Promise<void>) | null = null;

before(async () => {
  await requireTestDatabase();
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
});

beforeEach(async () => {
  // Let the previous test's detached intake finish BEFORE truncating. Without
  // this the suite was not testing the software, it was testing a race: the
  // last test's extraction ran on against tables this one was wiping.
  await drainAsyncIntake();
  resetRateLimitBuckets();
  config.rateLimitEnabled = false;
  setInvoiceIntakeRuntimeForTests(null);
  setResendInboundRuntimeForTests(null);
  clearSimulatedAttachmentBytes();
  await prisma.$executeRawUnsafe(TRUNCATE_SQL);
});

after(async () => {
  if (closeServer) await closeServer();
  await prisma.$disconnect();
});

async function createOrg(organizationName: string) {
  const org = await prisma.organization.create({ data: { organizationName } });
  // Production builds the approval engine in the same transaction that creates
  // the organization, so a bill never triggers it. Fixtures that insert an org
  // directly must do the same, or the first ingested bill builds it lazily —
  // and two sweeps arriving together then deadlock constructing it at once.
  const { setupEngineInTx } = await import('../src/approvals/wiring.js');
  await prisma.$transaction((tx) => setupEngineInTx(tx, org.organizationId));
  return org;
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

// --- the webhook, through the real app ---------------------------------------

const WEBHOOK = '/webhooks/resend/inbound';

async function seedOrgWithMember(orgName: string, memberEmail: string) {
  const org = await createOrg(orgName);
  const slug = await prisma.$transaction((tx) => mintIntakeSlug(tx, org.organizationId, orgName));
  const user = await prisma.user.create({
    data: { email: memberEmail, displayName: 'Priya Sharma', status: 'active', emailVerifiedAt: new Date() },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: org.organizationId, userId: user.userId, role: 'owner' },
  });
  return { org, slug, user };
}

let emailSeq = 0;
function receivedEvent(over: {
  to?: string;
  from?: string;
  attachments?: Array<{ id: string; filename: string; content_type?: string; content_disposition?: string }>;
  emailId?: string;
} = {}) {
  emailSeq += 1;
  return {
    type: 'email.received',
    data: {
      email_id: over.emailId ?? `email_${emailSeq}`,
      from: over.from ?? 'Priya Sharma <priya@acme.test>',
      to: [over.to ?? `acme@${DOMAIN}`],
      cc: [],
      subject: 'FW: Invoice HG-501',
      message_id: `<msg-${emailSeq}@acme.test>`,
      attachments: over.attachments ?? [
        { id: `att_${emailSeq}`, filename: 'invoice.pdf', content_type: 'application/pdf', content_disposition: 'attachment' },
      ],
    },
  };
}

/** POST a signed webhook the way Resend would. */
async function postWebhook(payload: unknown, opts: { id?: string; at?: number } = {}) {
  const body = JSON.stringify(payload);
  const at = opts.at ?? Math.floor(Date.now() / 1000);
  const headers = signSvixPayloadForTests({
    rawBody: Buffer.from(body, 'utf8'),
    secret: config.inboundEmailWebhookSecret,
    id: opts.id ?? `msg_${emailSeq}_${Math.random().toString(16).slice(2)}`,
    timestampSeconds: at,
  });
  return fetch(`${baseUrl}${WEBHOOK}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  });
}

test('an unsigned request is rejected with 401 and writes no message row', async () => {
  const response = await fetch(`${baseUrl}${WEBHOOK}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(receivedEvent()),
  });

  assert.equal(response.status, 401);
  assert.equal(await prisma.inboundEmailMessage.count(), 0, 'an unverified caller must not be able to write rows');
});

test('a valid signature verifies through the real app (raw body survives the middleware stack)', async () => {
  // Guards the express.raw()-before-express.json() ordering in app.ts: if the
  // JSON parser ever moves above it, req.body stops being the signed bytes and
  // this is the test that notices.
  await seedOrgWithMember('Acme', 'priya@acme.test');

  const response = await postWebhook(receivedEvent());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'queued');
});

test('mail to an unknown address is recorded as rejected for unknown_org and still returns 200', async () => {
  const response = await postWebhook(receivedEvent({ to: `nobody@${DOMAIN}` }));

  assert.equal(response.status, 200, 'retrying will never make the organization appear');
  assert.equal((await response.json()).reason, 'unknown_org');

  const row = await prisma.inboundEmailMessage.findFirstOrThrow();
  assert.equal(row.disposition, 'rejected');
  assert.equal(row.dispositionReason, 'unknown_org');
  assert.equal(row.organizationId, null);
});

test('mail from someone outside the organization is recorded as rejected and creates no bill', async () => {
  const { org } = await seedOrgWithMember('Acme', 'priya@acme.test');

  const response = await postWebhook(receivedEvent({ from: 'stranger@elsewhere.test' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reason, 'sender_not_member');

  const row = await prisma.inboundEmailMessage.findFirstOrThrow();
  assert.equal(row.disposition, 'rejected');
  assert.equal(row.organizationId, org.organizationId, 'we know which org it was aimed at');
  assert.equal(row.senderUserId, null);
  assert.equal(await prisma.paymentOrder.count(), 0);
  // Recorded, not silently dropped: this is what makes the rejection rate measurable.
  assert.equal(await prisma.inboundEmailAttachment.count({ where: { status: 'pending' } }), 0);
});

test('mail from an active member queues its PDF and returns 200', async () => {
  const { org, user } = await seedOrgWithMember('Acme', 'priya@acme.test');

  const response = await postWebhook(receivedEvent());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'queued');
  assert.equal(body.queuedAttachments, 1);

  const row = await prisma.inboundEmailMessage.findFirstOrThrow({ include: { attachments: true } });
  assert.equal(row.disposition, 'pending');
  assert.equal(row.organizationId, org.organizationId);
  assert.equal(row.senderUserId, user.userId);
  assert.equal(row.fromDisplay, 'Priya Sharma');
  assert.equal(row.attachments[0]!.status, 'pending');
});

test('a redelivered event with the same email_id is deduped and queues nothing twice', async () => {
  await seedOrgWithMember('Acme', 'priya@acme.test');
  const event = receivedEvent({ emailId: 'email_stable' });

  const first = await postWebhook(event, { id: 'msg_a' });
  assert.equal((await first.json()).status, 'queued');

  // A different delivery id, the same message — exactly what a provider retry
  // looks like.
  const second = await postWebhook(event, { id: 'msg_b' });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).status, 'deduped');

  assert.equal(await prisma.inboundEmailMessage.count(), 1);
  assert.equal(await prisma.inboundEmailAttachment.count(), 1);
});

test('an event type we do not handle is acknowledged, not retried', async () => {
  const response = await postWebhook({ type: 'email.delivered', data: { from: 'x@y.test', to: [] } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ignored');
  assert.equal(await prisma.inboundEmailMessage.count(), 0);
});

test('a stale signature is refused even though the body is otherwise valid', async () => {
  await seedOrgWithMember('Acme', 'priya@acme.test');
  const response = await postWebhook(receivedEvent(), { at: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(response.status, 401);
  assert.equal(await prisma.inboundEmailMessage.count(), 0);
});

test('mail with no attachments is rejected — there is no bill in it', async () => {
  await seedOrgWithMember('Acme', 'priya@acme.test');
  const response = await postWebhook(receivedEvent({ attachments: [] }));
  assert.equal((await response.json()).reason, 'no_attachments');
});

test('an inline signature logo is skipped and a real PDF alongside it is queued', async () => {
  await seedOrgWithMember('Acme', 'priya@acme.test');

  await postWebhook(
    receivedEvent({
      attachments: [
        { id: 'att_logo', filename: 'logo.png', content_type: 'image/png', content_disposition: 'inline' },
        { id: 'att_bill', filename: 'invoice.pdf', content_type: 'application/pdf', content_disposition: 'attachment' },
      ],
    }),
  );

  const attachments = await prisma.inboundEmailAttachment.findMany({ orderBy: { filename: 'asc' } });
  assert.deepEqual(
    attachments.map((a) => [a.filename, a.status, a.statusReason]),
    [
      ['invoice.pdf', 'pending', null],
      ['logo.png', 'skipped', 'inline_attachment'],
    ],
  );
});

test('a message whose attachments are all unsupported is rejected for no_supported_attachments', async () => {
  await seedOrgWithMember('Acme', 'priya@acme.test');

  const response = await postWebhook(
    receivedEvent({
      attachments: [
        { id: 'att_doc', filename: 'contract.docx', content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content_disposition: 'attachment' },
      ],
    }),
  );
  assert.equal((await response.json()).reason, 'no_supported_attachments');
});

// --- ingestion sweep ---------------------------------------------------------

const PDF_BYTES = Buffer.from('%PDF-1.4 fake invoice bytes for the test suite', 'utf8');

/** Stub extraction so the sweep never calls OpenAI. */
function stubExtraction(vendor = 'Helios Group') {
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      pageCount: 1,
      modelLatencyMs: 1,
      rows: [
        {
          counterparty: vendor,
          amount: 501,
          currency: 'USD',
          reference: 'HG-501',
          due_date: null,
          wallet_address: null,
          notes: 'Forwarded invoice',
          source_invoice: null,
        },
      ],
    }) as never,
  });
}

/**
 * Wait until no attachment is still queued. The webhook nudges the sweep
 * inline, so either that nudge or our explicit call may drain the row — the
 * test must not care which one won the race.
 */
async function waitForQueueDrain(timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stuck = await prisma.inboundEmailAttachment.findMany({ where: { status: 'pending' } });
    if (stuck.length === 0) return;
    if (Date.now() > deadline) {
      // Surface why rather than leaving a bare "expected ingested, got pending".
      assert.fail(
        `attachments still pending after ${timeoutMs}ms: ` +
          stuck.map((a) => `${a.filename} attempts=${a.attempts} lastError=${a.lastError}`).join('; '),
      );
    }
    // Clear any backoff so the retry actually runs inside the test window.
    await prisma.inboundEmailAttachment.updateMany({ where: { status: 'pending' }, data: { nextAttemptAt: new Date(0) } });
    await runInboundEmailIntakeOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function queueAndSweep(attachmentId = 'att_1') {
  setResendInboundRuntimeForTests({
    fetchAttachment: async () => ({ bytes: PDF_BYTES, contentType: 'application/pdf', filename: 'invoice.pdf' }),
  });
  await postWebhook(
    receivedEvent({
      attachments: [{ id: attachmentId, filename: 'invoice.pdf', content_type: 'application/pdf', content_disposition: 'attachment' }],
    }),
  );
  await waitForQueueDrain();
}

/** The async intake path extracts in a detached promise; wait for the bill. */
async function waitForPaymentOrders(expected = 1, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const orders = await prisma.paymentOrder.findMany({ include: { createdByUser: true } });
    if (orders.length >= expected) return orders;
    if (Date.now() > deadline) return orders;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('the sweep fetches a queued attachment and lands a bill in needs_review', async () => {
  await seedOrgWithMember('Acme', 'priya@acme.test');
  stubExtraction();

  await queueAndSweep();

  const orders = await waitForPaymentOrders(1);
  assert.equal(orders.length, 1, 'the email produced a bill');
  assert.equal(orders[0]!.state, 'needs_review', 'email never skips the review gate');

  const attachment = await prisma.inboundEmailAttachment.findFirstOrThrow();
  assert.equal(attachment.status, 'ingested');
  assert.ok(attachment.invoiceDocumentId, 'the stored document is linked back to the attachment');
});

test('the bill is attributed to the member who sent the email', async () => {
  const { user } = await seedOrgWithMember('Acme', 'priya@acme.test');
  stubExtraction();

  await queueAndSweep();
  const orders = await waitForPaymentOrders(1);

  assert.equal(orders[0]!.createdByUserId, user.userId, 'not a system actor — a real person forwarded this');
  const metadata = orders[0]!.metadataJson as Record<string, unknown>;
  assert.equal((metadata.intakeChannel as Record<string, unknown>).kind, 'email');
  assert.equal(metadata.inputSource, 'invoice_upload', 'the door changed, not the input source');
});

test('the same invoice forwarded twice reuses the stored document and creates no second bill', async () => {
  await seedOrgWithMember('Acme', 'priya@acme.test');
  stubExtraction();

  await queueAndSweep('att_first');
  await waitForPaymentOrders(1);
  await queueAndSweep('att_second');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(await prisma.invoiceDocument.count(), 1, 'identical bytes reuse the stored document');
  assert.equal(await prisma.paymentOrder.count(), 1, 'and do not produce a duplicate bill');
});

test('a transient fetch failure is retried with backoff and the attachment stays pending', async () => {
  await seedOrgWithMember('Acme', 'priya@acme.test');
  setResendInboundRuntimeForTests({
    fetchAttachment: async () => {
      throw new Error('Resend attachment fetch failed (503).');
    },
  });

  await postWebhook(receivedEvent({ attachments: [{ id: 'att_flaky', filename: 'invoice.pdf', content_type: 'application/pdf', content_disposition: 'attachment' }] }));
  // The webhook's inline nudge already ran one attempt; give it a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const attachment = await prisma.inboundEmailAttachment.findFirstOrThrow();
  assert.equal(attachment.status, 'pending', 'still queued — the mail is not lost');
  assert.equal(attachment.attempts, 1);
  assert.ok(attachment.nextAttemptAt.getTime() > Date.now(), 'backed off rather than hot-looping');
  assert.match(attachment.lastError ?? '', /503/);
});

test('an attachment that keeps failing is marked failed after the attempt budget', async () => {
  await seedOrgWithMember('Acme', 'priya@acme.test');
  setResendInboundRuntimeForTests({
    fetchAttachment: async () => {
      throw new Error('Resend attachment fetch failed (500).');
    },
  });
  await postWebhook(receivedEvent({ attachments: [{ id: 'att_doomed', filename: 'invoice.pdf', content_type: 'application/pdf', content_disposition: 'attachment' }] }));
  // Posting the webhook also fires the latency nudge — a seventh sweep sharing
  // the same six-attempt budget. Left in flight it could consume the attempt
  // between a reset and the sweep below, so the loop would land fewer than six
  // real attempts and the row would still be pending at the end. Let it finish
  // first, so the budget is spent only by the sweeps this test controls.
  await drainAsyncIntake();

  // Drive it past the budget, ignoring backoff by resetting the due time.
  for (let i = 0; i < 6; i += 1) {
    await prisma.inboundEmailAttachment.updateMany({ where: { status: 'pending' }, data: { nextAttemptAt: new Date(0) } });
    await runInboundEmailIntakeOnce();
  }

  const attachment = await prisma.inboundEmailAttachment.findFirstOrThrow();
  assert.equal(attachment.status, 'failed');
  assert.equal(attachment.statusReason, 'attachment_fetch_exhausted');

  const message = await prisma.inboundEmailMessage.findFirstOrThrow();
  assert.equal(message.disposition, 'failed', 'the message rolls up once every attachment is terminal');
});

test('an oversized attachment is skipped while its siblings still ingest', async () => {
  await seedOrgWithMember('Acme', 'priya@acme.test');
  stubExtraction();
  setResendInboundRuntimeForTests({
    fetchAttachment: async ({ attachmentId }) => ({
      bytes: attachmentId === 'att_big' ? Buffer.alloc(11 * 1024 * 1024, 1) : PDF_BYTES,
      contentType: 'application/pdf',
      filename: 'invoice.pdf',
    }),
  });

  await postWebhook(
    receivedEvent({
      attachments: [
        { id: 'att_big', filename: 'huge.pdf', content_type: 'application/pdf', content_disposition: 'attachment' },
        { id: 'att_ok', filename: 'invoice.pdf', content_type: 'application/pdf', content_disposition: 'attachment' },
      ],
    }),
  );
  await waitForQueueDrain();

  const attachments = await prisma.inboundEmailAttachment.findMany({ orderBy: { filename: 'asc' } });
  assert.deepEqual(
    attachments.map((a) => [a.filename, a.status, a.statusReason]),
    [
      ['huge.pdf', 'skipped', 'attachment_too_large'],
      ['invoice.pdf', 'ingested', null],
    ],
    'one bad file must not sink the whole message',
  );

  const message = await prisma.inboundEmailMessage.findFirstOrThrow();
  assert.equal(message.disposition, 'partially_accepted');
});

test('the workbench labels an emailed bill with who sent it', async () => {
  const { org, user } = await seedOrgWithMember('Acme', 'priya@acme.test');
  stubExtraction();

  await queueAndSweep();
  await waitForPaymentOrders(1);

  const { getBillsWorkbench } = await import('../src/payments/bills.js');
  const workbench = await getBillsWorkbench(org.organizationId, user.userId);

  assert.equal(workbench.bills.length, 1);
  assert.equal(workbench.bills[0]!.source, 'email');
  assert.equal(workbench.bills[0]!.sourceLabel, 'Emailed by Priya Sharma');
});

test('two sweeps racing the same attachment fetch it once', async () => {
  // The webhook nudges a sweep inline while the interval sweep may already be
  // running, so this race is the normal case, not a corner case.
  await seedOrgWithMember('Acme', 'priya@acme.test');
  stubExtraction();

  let fetches = 0;
  setResendInboundRuntimeForTests({
    fetchAttachment: async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { bytes: PDF_BYTES, contentType: 'application/pdf', filename: 'invoice.pdf' };
    },
  });

  await postWebhook(
    receivedEvent({ attachments: [{ id: 'att_race', filename: 'invoice.pdf', content_type: 'application/pdf', content_disposition: 'attachment' }] }),
  );
  await Promise.all([runInboundEmailIntakeOnce(), runInboundEmailIntakeOnce(), runInboundEmailIntakeOnce()]);
  // Four sweeps race here, not three: posting the webhook also fires the
  // latency nudge. Awaiting only the explicit three left the nudge in flight
  // while the assertions ran, which is what made this test fail about one run
  // in four. The lease is what this test is really about, and it holds against
  // all four — but the test has to wait for all four to find out.
  await drainAsyncIntake();

  assert.equal(fetches, 1, 'the lease makes the claim exclusive');
  const attachment = await prisma.inboundEmailAttachment.findFirstOrThrow();
  assert.equal(attachment.status, 'ingested');
  assert.equal(attachment.statusReason, null, 'a single clean ingestion, not a reused-document retry');
});

test('the dev simulate endpoint drives the same path with no provider account', async () => {
  const { org } = await seedOrgWithMember('Acme', 'priya@acme.test');
  stubExtraction();
  config.devAuthSecret = 'test-dev-secret';

  const response = await fetch(`${baseUrl}${WEBHOOK}/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      secret: 'test-dev-secret',
      payload: receivedEvent({ attachments: [{ id: 'att_sim', filename: 'invoice.pdf', content_type: 'application/pdf', content_disposition: 'attachment' }] }),
      attachmentBytes: { att_sim: PDF_BYTES.toString('base64') },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'queued');

  await waitForQueueDrain();
  const orders = await waitForPaymentOrders(1);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.organizationId, org.organizationId);
});

test('the simulate endpoint refuses a wrong developer secret', async () => {
  config.devAuthSecret = 'test-dev-secret';
  const response = await fetch(`${baseUrl}${WEBHOOK}/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: 'wrong-secret-x', payload: receivedEvent() }),
  });
  assert.equal(response.status, 401);
});
