// Organisation and Your account, over HTTP: renaming the organisation, its
// other names, No self-approval and the bill ceiling behind the password with
// who changed them last, a bill allowed over the ceiling in Exceptions, and a
// person's own name and password.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/infra/prisma.js';
import { drainAsyncIntake, setInvoiceIntakeRuntimeForTests } from '../src/payments/invoice-intake.js';
import { requireTestDatabase } from './helpers/require-test-database.js';

const PASSWORD = 'DemoPass123!';
let baseUrl = '';
let close: (() => Promise<void>) | undefined;

before(async () => {
  await prisma.$connect();
  await requireTestDatabase();
  config.publicRateLimitMax = 1_000_000;
  const { registerPaymentApprovalBridge } = await import('../src/payments/approval-bridge.js');
  registerPaymentApprovalBridge();
  const server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(async () => {
  await drainAsyncIntake();
  setInvoiceIntakeRuntimeForTests(null);
  await prisma.$executeRawUnsafe(`TRUNCATE approval.approval_events, approval.tasks, approval.approval_plans,
    approval.policy_sets, approval.policies, approval.approvable_lines, approval.approvables, approval.rule_relaxations,
    approval.constraint_rules, approval.seat_assignments, approval.authority_grants, approval.seats,
    approval.node_edges, approval.nodes, approval.hierarchies, approval.people, approval.org_settings CASCADE`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE payment_order_events, decimal_proposals, payment_orders,
    transfer_requests, invoice_documents, counterparty_wallets, counterparties, treasury_wallets,
    auth_sessions, organization_memberships, organizations, users RESTART IDENTITY CASCADE`);
});

after(async () => {
  if (close) await close();
  await prisma.$disconnect();
});

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function ok(method: string, path: string, token: string | null, body?: unknown) {
  const r = await call(method, path, token, body);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} → ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function register(name: string) {
  const r = await ok('POST', '/auth/register', null, { email: `${name.toLowerCase().replace(/\s+/g, '.')}-${crypto.randomUUID()}@example.com`, password: PASSWORD, displayName: name });
  await ok('POST', '/auth/verify-email', r.sessionToken, { code: r.devEmailVerificationCode });
  return { token: r.sessionToken as string, userId: r.user.userId as string, email: r.user.email as string };
}

async function signIn(email: string, password: string) {
  return call('POST', '/auth/login', null, { email, password });
}

async function makeOrg(name = 'Testing Labs') {
  const owner = await register('Nadia Haddad');
  const org = await ok('POST', '/organizations', owner.token, { organizationName: name });
  const admin = await register('Priya Raman');
  const clerk = await register('Zara Okafor');
  await prisma.organizationMembership.createMany({
    data: [
      { organizationId: org.organizationId, userId: admin.userId, role: 'admin', status: 'active' },
      { organizationId: org.organizationId, userId: clerk.userId, role: 'member', status: 'active' },
    ],
  });
  return { orgId: org.organizationId as string, owner, admin, clerk };
}

test('rename: an admin renames, a name in use elsewhere is refused whatever the capitals, its own capitals may change', async () => {
  const { orgId, admin, clerk } = await makeOrg();
  await makeOrg('Larkspur Analytical Group');

  const refused = await call('PATCH', `/organizations/${orgId}`, clerk.token, { organizationName: 'Clerk Co' });
  assert.equal(refused.status, 403, 'a member who is not an admin cannot rename');

  const empty = await call('PATCH', `/organizations/${orgId}`, admin.token, { organizationName: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.message, 'Enter a name for the organisation.');

  const taken = await call('PATCH', `/organizations/${orgId}`, admin.token, { organizationName: 'larkspur   analytical group' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, 'organization_name_taken');

  const capitals = await ok('PATCH', `/organizations/${orgId}`, admin.token, { organizationName: 'TESTING LABS' });
  assert.equal(capitals.organizationName, 'TESTING LABS');

  const renamed = await ok('PATCH', `/organizations/${orgId}`, admin.token, { organizationName: '  Testing   Labs Group ' });
  assert.equal(renamed.organizationName, 'Testing Labs Group', 'trimmed, with runs of spaces made one');
  const session = await ok('GET', '/auth/session', admin.token);
  assert.equal(session.organizations.find((o: { organizationId: string }) => o.organizationId === orgId).organizationName, 'Testing Labs Group');
});

test('other names: listed newest first with their bill, taken off by an admin only, and Undo puts back the same entry', async () => {
  const { orgId, owner, admin, clerk } = await makeOrg();
  await prisma.organization.update({
    where: { organizationId: orgId },
    data: {
      tradingNames: [
        'TL Legacy',
        { name: 'Testing Labs Inc.', addedByUserId: owner.userId, addedByName: 'Nadia Haddad', addedAt: '2026-09-14T10:00:00.000Z', fromPaymentOrderId: null },
        { name: 'TL Analytical Services', addedByUserId: admin.userId, addedByName: 'Priya Raman', addedAt: '2026-10-02T09:00:00.000Z', fromPaymentOrderId: null },
      ],
    },
  });

  const listed = await ok('GET', `/organizations/${orgId}/trading-names`, clerk.token);
  assert.deepEqual(listed.items.map((i: { name: string }) => i.name), ['TL Analytical Services', 'Testing Labs Inc.', 'TL Legacy']);
  assert.equal(listed.items[0].addedByName, 'Priya Raman');

  const refused = await call('POST', `/organizations/${orgId}/trading-names/remove`, clerk.token, { name: 'Testing Labs Inc.' });
  assert.equal(refused.status, 403);

  assert.deepEqual(await ok('POST', `/organizations/${orgId}/trading-names/remove`, admin.token, { name: 'testing labs inc.' }), { removed: true });
  const after = await ok('GET', `/organizations/${orgId}/trading-names`, admin.token);
  assert.deepEqual(after.items.map((i: { name: string }) => i.name), ['TL Analytical Services', 'TL Legacy']);
  const stored = await prisma.organization.findUniqueOrThrow({ where: { organizationId: orgId }, select: { tradingNames: true } });
  const kept = (stored.tradingNames as { name?: string; removedByName?: string }[]).find((e) => e.name === 'Testing Labs Inc.');
  assert.equal(kept?.removedByName, 'Priya Raman', 'the entry stays on record, marked with who took it off');

  assert.deepEqual(await ok('POST', `/organizations/${orgId}/trading-names/restore`, admin.token, { name: 'Testing Labs Inc.' }), { restored: true });
  const back = await ok('GET', `/organizations/${orgId}/trading-names`, admin.token);
  const restored = back.items.find((i: { name: string }) => i.name === 'Testing Labs Inc.');
  assert.equal(restored.addedByName, 'Nadia Haddad', 'the same entry, still added by the person who added it');
  assert.equal(restored.addedAt, '2026-09-14T10:00:00.000Z');

  assert.deepEqual(await ok('POST', `/organizations/${orgId}/trading-names/restore`, admin.token, { name: 'Testing Labs Inc.' }), { restored: false }, 'already in use: nothing changes');
});

test('No self-approval: back on asks for the password, ends the old flow page’s switch, and says who changed it', async () => {
  const { orgId, owner, admin } = await makeOrg();
  const personOf = async (userId: string) =>
    (await prisma.$queryRaw<{ id: string }[]>`SELECT id::text FROM approval.people WHERE organization_id = ${orgId}::uuid AND user_id = ${userId}::uuid`)[0]?.id;

  const before = await ok('GET', `/organizations/${orgId}/protections`, admin.token);
  assert.equal(before.protections.find((p: { code: string }) => p.code === 'R1').lastChange, null, 'nothing changed yet');

  const wrongOff = await call('POST', `/organizations/${orgId}/protections/R1/relax`, owner.token, { password: 'not-it-at-all', sheetContent: {} });
  assert.equal(wrongOff.status, 403, 'a wrong password is a 403, never a 401');
  assert.equal(wrongOff.body.message, 'That password isn’t right.');
  await ok('POST', `/organizations/${orgId}/protections/R1/relax`, owner.token, { password: PASSWORD, sheetContent: { scope: 'everyone' } });

  const off = await ok('GET', `/organizations/${orgId}/protections`, admin.token);
  const r1 = off.protections.find((p: { code: string }) => p.code === 'R1');
  assert.equal(r1.relaxed, true);
  assert.equal(r1.lastChange.name, 'Nadia Haddad');
  assert.equal(r1.lastChange.personId, await personOf(owner.userId));

  // The old Approval flow page's switch, set on as that page used to.
  await ok('POST', `/organizations/${orgId}/approvals/separation`, owner.token, { clerkCanApprove: false, submitterCanApprove: true, approverCanRelease: false });

  const adminTry = await call('POST', `/organizations/${orgId}/protections/R1/retighten`, admin.token, { password: PASSWORD });
  assert.equal(adminTry.status, 403, 'only the primary admin changes policies');
  const missing = await call('POST', `/organizations/${orgId}/protections/R1/retighten`, owner.token, {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.message, 'Enter your password.');
  const wrong = await call('POST', `/organizations/${orgId}/protections/R1/retighten`, owner.token, { password: 'not-it-at-all' });
  assert.equal(wrong.status, 403);
  await ok('POST', `/organizations/${orgId}/protections/R1/retighten`, owner.token, { password: PASSWORD });

  const on = await ok('GET', `/organizations/${orgId}/protections`, admin.token);
  assert.equal(on.protections.find((p: { code: string }) => p.code === 'R1').relaxed, false);
  const separation = await ok('GET', `/organizations/${orgId}/approvals/separation`, admin.token);
  assert.equal(separation.submitterCanApprove, false, 'back on means on, whichever way it was off');
});

test('bill ceiling: changed only behind the password, on the record, and a bill allowed over it shows in Exceptions', async () => {
  const { orgId, owner, admin } = await makeOrg('Solo Ceiling Works');

  const adminTry = await call('PUT', `/organizations/${orgId}/policies/ceiling`, admin.token, { amountUsd: 1000, password: PASSWORD });
  assert.equal(adminTry.status, 403);
  const missing = await call('PUT', `/organizations/${orgId}/policies/ceiling`, owner.token, { amountUsd: 1000 });
  assert.equal(missing.status, 400);
  const wrong = await call('PUT', `/organizations/${orgId}/policies/ceiling`, owner.token, { amountUsd: 1000, password: 'not-it-at-all' });
  assert.equal(wrong.status, 403);
  assert.equal((await ok('GET', `/organizations/${orgId}/policies`, admin.token)).ceilingUsd, null, 'nothing changed');

  await ok('PUT', `/organizations/${orgId}/policies/ceiling`, owner.token, { amountUsd: 1000, password: PASSWORD });
  const policies = await ok('GET', `/organizations/${orgId}/policies`, admin.token);
  assert.equal(policies.ceilingUsd, 1000);
  assert.equal(policies.ceilingChange.name, 'Nadia Haddad');

  // A bill over the ceiling, allowed by the primary admin, then approved by
  // the admin it went to.
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [{
        counterparty: 'Anvil Works', amount: 2500, currency: 'USD', reference: 'INV-2399',
        due_date: '2026-11-30', wallet_address: null, notes: null,
        source_invoice: {
          vendorName: 'Anvil Works', vendorAddress: null, vendorEmail: 'ap@anvil.example', amount: 2500, currency: 'USD',
          invoiceNumber: 'INV-2399', invoiceDate: '2026-10-02', dueDate: '2026-11-30', terms: 'Net 30',
          poNumber: null, earlyPayDiscount: null, subtotal: 2500, taxAmount: 0, billToName: 'Solo Ceiling Works',
          remitTo: null, paymentDetails: { method: 'ACH', bankName: 'First Interstate Bank', accountLast4: '6621', routingNumber: '125000105' },
          walletAddress: null, lineItems: [{ description: 'Steel', quantity: 1, unitPrice: 2500, total: 2500 }],
          categoryHint: 'Materials', confidence: { vendor: 1, amount: 1, overall: 1 }, fieldConfidence: null,
        },
      }],
      modelLatencyMs: 1, pageCount: 1,
    }),
  });
  const up = await ok('POST', `/organizations/${orgId}/invoices/upload`, owner.token, {
    filename: 'anvil.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from(`%PDF ${crypto.randomUUID()}`).toString('base64'), autoAdvance: false,
  });
  const billId = up.paymentOrders[0].paymentOrder.paymentOrderId as string;
  await ok('POST', `/organizations/${orgId}/bills/${billId}/ceiling-exception`, owner.token, { reason: 'Annual steel order' });
  await ok('POST', `/organizations/${orgId}/bills/${billId}/confirm`, owner.token, {
    fields: { invoiceNumber: 'INV-2399', invoiceDate: '2026-10-02', dueDate: '2026-11-30', terms: 'Net 30', currency: 'USD', total: 2500, taxAmount: 0 },
    lines: [{ description: 'Steel', quantity: 1, unitPrice: 2500, amount: 2500, category: 'Cloud hosting & infrastructure' }],
    confirmedFieldKeys: [],
  });
  const inbox = await ok('GET', `/organizations/${orgId}/bills/approvals-inbox`, admin.token);
  const task = inbox.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === billId);
  assert.ok(task, 'the admin holds the approval');
  await ok('POST', `/organizations/${orgId}/approvals/tasks/${task.taskId}/command`, admin.token, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() });

  const { items } = await ok('GET', `/organizations/${orgId}/policies/exceptions`, admin.token);
  const over = items.find((i: { kind: string }) => i.kind === 'over_ceiling');
  assert.ok(over, `an over-ceiling row: ${JSON.stringify(items)}`);
  assert.equal(over.vendorName, 'Anvil Works');
  assert.equal(over.invoiceNumber, 'INV-2399');
  assert.equal(over.amountRaw, '2500000000');
  assert.equal(over.allowedByName, 'Nadia Haddad');
  assert.equal(over.approvedBy.name, 'Priya Raman', 'who approved it, not who allowed it');
  assert.ok(!items.some((i: { kind: string }) => i.kind === 'self_approval'), 'its sender did not approve it');
});

test('your account: your name everywhere you are, and a new password that signs out every other browser', async () => {
  const { orgId, owner } = await makeOrg();

  const empty = await call('PATCH', '/auth/me', owner.token, { displayName: '  ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.message, 'Enter your name.');
  const me = await ok('PATCH', '/auth/me', owner.token, { displayName: ' Nadia   Haddad-Lowe ' });
  assert.equal(me.user.displayName, 'Nadia Haddad-Lowe');
  const roster = await ok('GET', `/organizations/${orgId}/roles`, owner.token);
  assert.equal(roster.members.find((m: { userId: string }) => m.userId === owner.userId).name, 'Nadia Haddad-Lowe', 'the engine’s copy follows');

  const session = await ok('GET', '/auth/session', owner.token);
  assert.equal(session.user.hasPassword, true);

  const elsewhere = await signIn(owner.email, PASSWORD);
  assert.equal(elsewhere.status, 200);
  const otherToken = elsewhere.body.sessionToken as string;

  const wrong = await call('POST', '/auth/change-password', owner.token, { currentPassword: 'not-it-at-all', newPassword: 'NewPass456!' });
  assert.equal(wrong.status, 403, 'a wrong password is a 403, never a 401');
  assert.equal(wrong.body.code, 'wrong_password');
  const short = await call('POST', '/auth/change-password', owner.token, { currentPassword: PASSWORD, newPassword: 'short' });
  assert.equal(short.body.code, 'password_too_short');
  const same = await call('POST', '/auth/change-password', owner.token, { currentPassword: PASSWORD, newPassword: PASSWORD });
  assert.equal(same.body.code, 'password_unchanged');

  const changed = await call('POST', '/auth/change-password', owner.token, { currentPassword: PASSWORD, newPassword: 'NewPass456!' });
  assert.equal(changed.status, 204);
  assert.equal((await call('GET', '/auth/session', owner.token)).status, 200, 'still signed in here');
  assert.equal((await call('GET', '/auth/session', otherToken)).status, 401, 'signed out everywhere else');
  assert.notEqual((await signIn(owner.email, PASSWORD)).status, 200, 'the old password no longer works');
  assert.equal((await signIn(owner.email, 'NewPass456!')).status, 200);
});
