// Prebuilt roles end to end: the fixed role set is listed and assignable, a
// member's access is the union of their role bundles (viewer bundle when they
// hold none), and the capability middleware actually blocks/permits the HTTP
// surface per role — bill clerk can enter bills but never sees the payments
// surface; nobody edits what their role doesn't include.
import assert from 'node:assert/strict';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { prisma } from '../src/infra/prisma.js';
import { requireTestDatabase } from './helpers/require-test-database.js';
import { setInvoiceIntakeRuntimeForTests } from '../src/payments/invoice-intake.js';

let baseUrl = '';
let close: (() => Promise<void>) | undefined;

before(async () => {
  await prisma.$connect();
  await requireTestDatabase();
  const server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(async () => {
  // Drain detached intake before truncating: the previous test's extraction
  // must not still be running against tables this one is wiping.
  await drainAsyncIntake();
  setInvoiceIntakeRuntimeForTests(null);
  await prisma.$executeRawUnsafe(`TRUNCATE approval.person_roles, approval.approval_events, approval.tasks, approval.approval_plans,
    approval.policy_sets, approval.policies, approval.approvable_lines, approval.approvables, approval.rule_relaxations,
    approval.constraint_rules, approval.seat_assignments, approval.authority_grants, approval.seats,
    approval.node_edges, approval.nodes, approval.hierarchies, approval.people, approval.org_settings CASCADE`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE payment_order_events, decimal_proposals, payment_orders,
    transfer_requests, invoice_documents, counterparty_wallets, counterparties, treasury_wallets,
    organization_memberships, organizations, users RESTART IDENTITY CASCADE`);
});

after(async () => {
  if (close) await close();
  await prisma.$disconnect();
});

async function makeOrg() {
  const owner = await register('owner');
  const org = await post('/organizations', { organizationName: 'Halcyon Labs, Inc.' }, owner.token);
  const member = await register('teammate');
  await prisma.organizationMembership.create({
    data: { organizationId: org.organizationId, userId: member.userId, role: 'member', status: 'active' },
  });
  return { orgId: org.organizationId as string, owner, member };
}

test('prebuilt roles: fixed set, assignment, my-access, and HTTP enforcement per role', async () => {
  const { orgId, owner, member } = await makeOrg();

  // The role set is fixed and self-describing.
  const list = await get(`/organizations/${orgId}/roles`, owner.token);
  assert.deepEqual(list.roles.map((r: { key: string }) => r.key), ['bill_clerk', 'approver', 'payer', 'viewer']);
  assert.ok(list.roles.every((r: { summary: string }) => r.summary.length > 10), 'each role carries a plain-English summary');

  // A member with NO roles = viewer bundle: sees everything, changes nothing.
  await get(`/organizations/${orgId}/bills/workbench`, member.token);
  await get(`/organizations/${orgId}/payment-orders`, member.token);
  await get(`/organizations/${orgId}/treasury-wallets`, member.token);
  assert.equal(await status('POST', `/organizations/${orgId}/invoices/upload`, member.token, {}), 403, 'viewer cannot enter bills');
  assert.equal(await status('POST', `/organizations/${orgId}/counterparties`, member.token, {}), 403, 'viewer cannot edit vendors');
  assert.equal(await status('POST', `/organizations/${orgId}/automation-agents`, member.token, {}), 403, 'viewer cannot manage treasury');
  const before = await get(`/organizations/${orgId}/my-access`, member.token);
  assert.deepEqual(before.roles, []);
  assert.ok(before.capabilities.includes('payments.view') && !before.capabilities.includes('bills.edit'));

  // Assign Reviewer (admin-only action; the member cannot self-assign).
  assert.equal(await status('POST', `/organizations/${orgId}/roles/bill_clerk/holders`, member.token, { userId: member.userId }), 403);
  await post(`/organizations/${orgId}/roles/bill_clerk/holders`, { userId: member.userId }, owner.token);

  const afterList = await get(`/organizations/${orgId}/roles`, owner.token);
  const clerkRole = afterList.roles.find((r: { key: string }) => r.key === 'bill_clerk');
  assert.equal(clerkRole.holders.length, 1);
  const me = afterList.members.find((m: { userId: string }) => m.userId === member.userId);
  assert.deepEqual(me.roles, ['bill_clerk']);

  const access = await get(`/organizations/${orgId}/my-access`, member.token);
  assert.deepEqual(access.roles, ['bill_clerk']);
  assert.ok(access.capabilities.includes('bills.edit'), 'bill clerk can enter bills');
  assert.ok(!access.capabilities.includes('payments.view'), 'bill clerk has NO payments surface');
  assert.ok(!access.capabilities.includes('approvals.act'), 'bill clerk cannot approve');

  // Reviewer can now actually enter a bill over HTTP…
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [{
        counterparty: 'Acme', amount: 900, currency: 'USD', reference: 'INV-9', due_date: '2026-08-30',
        wallet_address: null, notes: null,
        source_invoice: {
          vendorName: 'Acme', vendorAddress: null, vendorEmail: 'ap@acme.example', amount: 900, currency: 'USD',
          invoiceNumber: 'INV-9', invoiceDate: '2026-08-02', dueDate: '2026-08-30', terms: 'Net 30', poNumber: null,
          earlyPayDiscount: null, subtotal: 900, taxAmount: 0, billToName: 'Halcyon Labs, Inc.', remitTo: null,
          paymentDetails: { method: 'ACH', bankName: 'First Interstate Bank', accountLast4: '6621', routingNumber: '125000105' },
          walletAddress: null, lineItems: [{ description: 'Hosting', quantity: 1, unitPrice: 900, total: 900 }],
          categoryHint: 'Cloud hosting', confidence: { vendor: 1, amount: 1, overall: 1 }, fieldConfidence: null,
        },
      }],
      modelLatencyMs: 1, pageCount: 1,
    }),
  });
  await post(`/organizations/${orgId}/invoices/upload`, {
    filename: 'b.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from(`%PDF ${crypto.randomUUID()}`).toString('base64'), autoAdvance: false,
  }, member.token);

  // …but the payments/treasury surface stays closed — the role NARROWS reads too.
  assert.equal(await status('GET', `/organizations/${orgId}/payment-orders`, member.token), 403, 'bill clerk has no payment queue');
  assert.equal(await status('POST', `/organizations/${orgId}/automation-agents`, member.token, {}), 403);

  // Unassign → back to the viewer default.
  await del(`/organizations/${orgId}/roles/bill_clerk/holders/${me.personId}`, owner.token);
  const reverted = await get(`/organizations/${orgId}/my-access`, member.token);
  assert.deepEqual(reverted.roles, []);
  await get(`/organizations/${orgId}/payment-orders`, member.token); // viewer sees the queue again
  assert.equal(await status('POST', `/organizations/${orgId}/invoices/upload`, member.token, {}), 403, 'and cannot enter bills anymore');
});

test('payer role opens payment surface without granting bill entry', async () => {
  const { orgId, owner, member } = await makeOrg();
  await post(`/organizations/${orgId}/roles/payer/holders`, { userId: member.userId }, owner.token);
  const access = await get(`/organizations/${orgId}/my-access`, member.token);
  assert.ok(access.capabilities.includes('payments.sign'));
  assert.ok(access.capabilities.includes('treasury.view'));
  assert.ok(!access.capabilities.includes('bills.edit'));
  await get(`/organizations/${orgId}/payment-orders`, member.token);
  assert.equal(await status('POST', `/organizations/${orgId}/invoices/upload`, member.token, {}), 403, 'payer cannot enter bills');
  assert.equal(await status('POST', `/organizations/${orgId}/approvals/separation`, member.token, { clerkCanApprove: true, submitterCanApprove: true, approverCanRelease: true }), 403, 'payer cannot edit governance');
});

test('primary-admin tier: only the seat holder manages admins, and the seat transfers atomically', async () => {
  const { orgId, owner, member } = await makeOrg();
  const third = await register('third');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: third.userId, role: 'member', status: 'active' },
  });

  // Primary admin promotes member → admin; the admin STILL can't mint admins.
  await fetchOk('PATCH', `/organizations/${orgId}/members/${member.userId}/access`, owner.token, { access: 'admin' });
  assert.equal(await status('PATCH', `/organizations/${orgId}/members/${third.userId}/access`, member.token, { access: 'admin' }), 403, 'admins cannot promote admins');
  assert.equal(await status('POST', `/organizations/${orgId}/invites`, member.token, { email: 'x@example.com', role: 'admin' }), 403, 'admins cannot invite admins');
  // Owner invites cannot be created at all — the seat only transfers.
  assert.equal(await status('POST', `/organizations/${orgId}/invites`, owner.token, { email: 'y@example.com', role: 'owner' }), 400);
  // The primary admin cannot be demoted.
  assert.equal(await status('PATCH', `/organizations/${orgId}/members/${owner.userId}/access`, member.token, { access: 'member' }), 403);

  // Admins take no pipeline roles (full access already) — assignment refuses,
  // and promotion sheds any roles held before.
  assert.equal(await status('POST', `/organizations/${orgId}/roles/bill_clerk/holders`, owner.token, { userId: member.userId }), 400, 'cannot assign a role to an admin');
  await post(`/organizations/${orgId}/roles/bill_clerk/holders`, { userId: third.userId }, owner.token);
  await fetchOk('PATCH', `/organizations/${orgId}/members/${third.userId}/access`, owner.token, { access: 'admin' });
  const listAfterPromo = await get(`/organizations/${orgId}/roles`, owner.token);
  const thirdRow = listAfterPromo.members.find((m: { userId: string }) => m.userId === third.userId);
  assert.deepEqual(thirdRow.roles, [], 'promotion to admin sheds pipeline roles');
  await fetchOk('PATCH', `/organizations/${orgId}/members/${third.userId}/access`, owner.token, { access: 'member' });

  // Transfer: member (admin) takes the seat; previous holder becomes an admin.
  assert.equal(await status('POST', `/organizations/${orgId}/primary-admin/transfer`, member.token, { userId: member.userId }), 403, 'only the seat holder transfers it');
  await fetchOk('POST', `/organizations/${orgId}/primary-admin/transfer`, owner.token, { userId: member.userId });
  const rows = await prisma.organizationMembership.findMany({ where: { organizationId: orgId }, select: { userId: true, role: true } });
  const roleOf = new Map(rows.map((r) => [r.userId, r.role]));
  assert.equal(roleOf.get(member.userId), 'owner');
  assert.equal(roleOf.get(owner.userId), 'admin');
  // Never vacant, never doubled.
  assert.equal(rows.filter((r) => r.role === 'owner').length, 1);
});

async function fetchOk(method: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.ok(res.status === 200 || res.status === 201, `${method} ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function register(tag: string) {
  const r = await post('/auth/register', { email: `${tag}-${crypto.randomUUID()}@example.com`, password: 'DemoPass123!', displayName: tag });
  const code = r.devEmailVerificationCode;
  await post('/auth/verify-email', { code }, r.sessionToken);
  return { token: r.sessionToken as string, userId: r.user.userId as string };
}
async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.ok(res.status === 200 || res.status === 201, `POST ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}
async function get(path: string, token: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  assert.equal(res.status, 200, `GET ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}
async function del(path: string, token: string) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200, `DELETE ${path} → ${res.status}`);
  return res.json();
}
async function status(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  await res.text();
  return res.status;
}

// --- record scope --------------------------------------------------------------
//
// Roles say which SCREENS you get. This says which BILLS belong on them. Seven
// of ten AP products scope an approver to the bills routed to them; we were the
// documented outlier that showed everyone everything (access-research §2).

function stubOneBill(vendor: string, invoiceNo: string) {
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [{
        counterparty: vendor, amount: 900, currency: 'USD', reference: invoiceNo, due_date: '2026-08-30',
        wallet_address: null, notes: null, source_invoice: null,
      }],
      modelLatencyMs: 1, pageCount: 1,
    }) as never,
  });
}

test('an approver sees the bills they are involved in, not the whole queue', async () => {
  const { orgId, owner, member } = await makeOrg();
  // A second admin, so the bill routes to somebody who is not our approver.
  const other = await register('other-admin');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: other.userId, role: 'admin', status: 'active' },
  });

  stubOneBill('Acme', 'INV-SCOPE-1');
  const upload = await post(`/organizations/${orgId}/invoices/upload`, {
    filename: 'scope.pdf', mimeType: 'application/pdf',
    dataBase64: Buffer.from(`%PDF ${crypto.randomUUID()}`).toString('base64'), autoAdvance: false,
  }, owner.token);
  const billId = upload.paymentOrders[0].paymentOrder.paymentOrderId;

  // Before the role: the viewer default, which is the whole queue. This is the
  // behaviour everyone had, and it is why assigning the role is what turns
  // scoping on rather than a migration.
  const asViewer = await get(`/organizations/${orgId}/bills/workbench`, member.token);
  assert.equal(asViewer.bills.length, 1, 'no roles means the viewer bundle: sees everything');

  // Granting Approver AFTER the bill was routed leaves them genuinely
  // uninvolved — the plan is pinned, so they are on no step of it.
  await post(`/organizations/${orgId}/roles/approver/holders`, { userId: member.userId }, owner.token);

  const scoped = await get(`/organizations/${orgId}/bills/workbench`, member.token);
  assert.equal(scoped.bills.length, 0, "an approver's queue is their bills, not the company's");
  assert.equal(
    await status('GET', `/organizations/${orgId}/bills/${billId}/detail`, member.token),
    404,
    'and a bill they cannot see reads as absent, not as forbidden — a 403 would confirm it exists',
  );

  // Being asked about a bill is involvement. Otherwise the question is a riddle:
  // "what do you think of the bill you are not allowed to open?"
  await post(`/organizations/${orgId}/bills/${billId}/ask`, {
    askedOfUserId: member.userId, question: 'Is this the right vendor for hosting?',
  }, owner.token);

  const afterAsk = await get(`/organizations/${orgId}/bills/workbench`, member.token);
  assert.equal(afterAsk.bills.length, 1, 'asked about it, so now they can open it');
  await get(`/organizations/${orgId}/bills/${billId}/detail`, member.token);

  // The owner is unaffected: administering the workspace still means seeing it.
  const asOwner = await get(`/organizations/${orgId}/bills/workbench`, owner.token);
  assert.equal(asOwner.bills.length, 1);
});
