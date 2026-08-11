// End-to-end approvals integration: multi-member org → published laddered flow
// → bank-only upload (pending method) → tier-1 gate → confirm → routed chain →
// approvals inbox signals → approve / request-info / reject. Drives the real
// HTTP API + engine the way the product does, so integration bugs surface here.
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
  // The product wires this at boot (index.ts): approve clears review + spawns
  // the release run; reject sends the bill back to review. The loop tests here
  // exercise exactly those bridge behaviors.
  const { registerPaymentApprovalBridge } = await import('../src/payments/approval-bridge.js');
  registerPaymentApprovalBridge();
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
  await prisma.$executeRawUnsafe(`TRUNCATE approval.approval_events, approval.tasks, approval.approval_plans,
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

// ---- 3-member org: owner (requester) + two approvers ------------------------
async function makeOrg() {
  const owner = await register('owner');
  const org = await post('/organizations', { organizationName: 'Halcyon Labs, Inc.' }, owner.token);
  const a2 = await register('approver-a');
  const a3 = await register('approver-b');
  for (const u of [a2, a3]) {
    await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: u.userId, role: 'member', status: 'active' },
    });
  }
  return { orgId: org.organizationId as string, owner, a2, a3 };
}

// A bank-only extracted invoice (no wallet address — the new normal).
function bankInvoice(over: Partial<{ vendor: string; amount: number; invoiceNo: string; billTo: string }>) {
  const vendor = over.vendor ?? 'Acme Cloud Services';
  const amount = over.amount ?? 15000;
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [{
        counterparty: vendor, amount, currency: 'USD', reference: over.invoiceNo ?? 'INV-1',
        due_date: '2026-08-30', wallet_address: null, notes: null,
        source_invoice: {
          vendorName: vendor, vendorAddress: null, vendorEmail: 'ap@acme.example', amount, currency: 'USD',
          invoiceNumber: over.invoiceNo ?? 'INV-1', invoiceDate: '2026-08-02', dueDate: '2026-08-30', terms: 'Net 30',
          poNumber: null, earlyPayDiscount: null, subtotal: amount, taxAmount: 0, billToName: over.billTo ?? 'Halcyon Labs, Inc.',
          remitTo: null, paymentDetails: { method: 'ACH', bankName: 'First Interstate Bank', accountLast4: '6621', routingNumber: '125000105' },
          walletAddress: null, lineItems: [{ description: 'Cloud hosting', quantity: 1, unitPrice: amount, total: amount }],
          categoryHint: 'Cloud hosting', confidence: { vendor: 1, amount: 1, overall: 1 }, fieldConfidence: null,
        },
      }],
      modelLatencyMs: 1, pageCount: 1,
    }),
  });
}

async function uploadAndConfirm(orgId: string, token: string, over: Parameters<typeof bankInvoice>[0], opts?: { skipCategory?: boolean }) {
  bankInvoice(over);
  const up = await post(`/organizations/${orgId}/invoices/upload`, {
    filename: 'b.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from(`%PDF ${crypto.randomUUID()}`).toString('base64'), autoAdvance: false,
  }, token);
  const billId = up.paymentOrders[0].paymentOrder.paymentOrderId as string;
  const total = over.amount ?? 15000;
  const body = {
    fields: { invoiceNumber: over.invoiceNo ?? 'INV-1', invoiceDate: '2026-08-02', dueDate: '2026-08-30', terms: 'Net 30', currency: 'USD', total, taxAmount: 0 },
    lines: [{ description: 'Cloud hosting', quantity: 1, unitPrice: total, amount: total, category: opts?.skipCategory ? null : 'Cloud hosting & infrastructure' }],
    confirmedFieldKeys: [],
  };
  return { billId, confirm: () => post(`/organizations/${orgId}/bills/${billId}/confirm`, body, token) };
}

// ---- Flow builder: simulate + publish a laddered flow -----------------------
async function publishLadder(orgId: string, token: string, financeIds: string[], ownerStepId: string) {
  const flow = [
    { id: 'n1', type: 'step', title: 'Finance review', approvers: financeIds, quorum: 'any' },
    { id: 'n2', type: 'if', amountGteUsd: 10000,
      then: [{ id: 'n3', type: 'step', title: 'Owner sign-off', approvers: [ownerStepId], quorum: 'any' }],
      otherwise: [{ id: 'n4', type: 'auto' }] },
  ];
  return post(`/organizations/${orgId}/approvals/flow/publish`, { flow }, token);
}

test('duplicate gate: same invoice number blocks confirm until an admin clears it', async () => {
  const { orgId, owner, a2 } = await makeOrg();
  const first = await uploadAndConfirm(orgId, owner.token, { vendor: 'Dupe Systems', amount: 1200, invoiceNo: 'DS-100' });
  await first.confirm();

  // Same vendor + same invoice number (normalization eats case/punctuation)
  // → blocking review flag, and confirm refuses.
  const second = await uploadAndConfirm(orgId, owner.token, { vendor: 'Dupe Systems', amount: 900, invoiceNo: 'ds 100' });
  const review = await get(`/organizations/${orgId}/bills/${second.billId}/review`, owner.token);
  const dupFlag = review.flags.find((f: { kind: string; blocking: boolean }) => f.kind === 'possible_duplicate');
  assert.ok(dupFlag?.blocking, 'duplicate flag is a hard block');
  let confirmFailed = false;
  try { await second.confirm(); } catch { confirmFailed = true; }
  assert.ok(confirmFailed, 'confirm is refused while the flag stands');

  // A plain member cannot clear the flag — overriding a policy gate is an escalation.
  const memberTry = await fetch(`${baseUrl}/organizations/${orgId}/bills/${second.billId}/duplicate-override`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a2.token}` },
    body: JSON.stringify({ reason: 'looks fine to me' }),
  });
  assert.equal(memberTry.status, 403);

  // The admin clears it with a logged reason → flag softens, confirm passes.
  const cleared = await post(`/organizations/${orgId}/bills/${second.billId}/duplicate-override`,
    { reason: 'Vendor reissued the corrected invoice under the same number' }, owner.token);
  const clearedFlag = cleared.flags.find((f: { kind: string; blocking: boolean }) => f.kind === 'possible_duplicate');
  assert.equal(clearedFlag?.blocking, false, 'override softens the flag');
  await second.confirm();

  // Different invoice numbers at the same amount are two real bills, not duplicates.
  const third = await uploadAndConfirm(orgId, owner.token, { vendor: 'Dupe Systems', amount: 900, invoiceNo: 'DS-101' });
  await third.confirm();

  // An EXACT twin (same reference, same amount) used to be rejected at upload
  // by the old intake check — invisible, no override path (testbench 001).
  // Review-bound bills now flow through and get the visible flag instead.
  const exactTwin = await uploadAndConfirm(orgId, owner.token, { vendor: 'Dupe Systems', amount: 1200, invoiceNo: 'DS-100' });
  const twinReview = await get(`/organizations/${orgId}/bills/${exactTwin.billId}/review`, owner.token);
  const twinFlag = twinReview.flags.find((f: { kind: string; blocking: boolean }) => f.kind === 'possible_duplicate');
  assert.ok(twinFlag?.blocking, 'exact twin lands in review, flagged — not rejected at upload');
});

test('fail closed: a pending bill is never ready-to-pay — solo owner approves as last resort', async () => {
  // Solo org: the owner submits their own bill; R1 empties the only approval
  // step. The old behavior dropped the bill straight into To-pay
  // (BUG-approval-not-enforced-failopen). Now: the owner gets an explicit
  // last-resort task, the bill waits in approval, and release is refused
  // until the approval lands.
  const owner = await register('solo-owner');
  const org = await post('/organizations', { organizationName: 'Solo Works LLC' }, owner.token);
  const orgId = org.organizationId as string;

  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Solo Vendor', amount: 400, invoiceNo: 'SV-1', billTo: 'Solo Works LLC' });
  await bill.confirm();

  // Not To-pay. Waiting on the owner, explicitly.
  const wb = await get(`/organizations/${orgId}/bills/workbench`, owner.token);
  const row = wb.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === bill.billId);
  assert.equal(row.bucket, 'in_approval', `pending bill must wait for approval, got ${row.bucket}`);

  // The owner has a real task in their inbox…
  const inbox = await get(`/organizations/${orgId}/bills/approvals-inbox`, owner.token);
  const task = inbox.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === bill.billId);
  assert.ok(task, 'owner holds the last-resort approval task');

  // …but self-approval is still R1-vetoed until the owner explicitly opts in.
  const vetoed = await fetch(`${baseUrl}/organizations/${orgId}/approvals/tasks/${task.taskId}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(vetoed.status, 409, 'self-approval is vetoed by R1 by default');

  // The opt-in is the Protections relaxation ceremony — an owner decision on
  // the record, not a silent default.
  await post(`/organizations/${orgId}/protections/R1/relax`, {
    password: 'DemoPass123!',
    sheetContent: { reason: 'solo org — I approve my own bills' },
  }, owner.token);
  await post(`/organizations/${orgId}/approvals/tasks/${task.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, owner.token);

  const after = await get(`/organizations/${orgId}/bills/workbench`, owner.token);
  const afterRow = after.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === bill.billId);
  assert.equal(afterRow.bucket, 'to_pay', 'approved by the owner → now genuinely ready to pay');
});

test('release gate: a vendor hold set after approval still blocks release', async () => {
  const { orgId, owner } = await makeOrg();
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Held Late Co', amount: 300, invoiceNo: 'HL-1' });
  await bill.confirm();
  await prisma.$executeRaw`
    UPDATE approval.approvables SET macro_state = 'approved'
    WHERE organization_id = ${orgId}::uuid AND attributes->>'paymentOrderId' = ${bill.billId}`;
  const { assertBillApprovedForRelease } = await import('../src/payments/release-gate.js');
  await assertBillApprovedForRelease(orgId, bill.billId); // payable vendor: fine

  const vendor = await prisma.counterparty.findFirstOrThrow({ where: { organizationId: orgId, displayName: 'Held Late Co' } });
  const { setVendorPayableStatus } = await import('../src/payments/vendor-payable.js');
  await setVendorPayableStatus({
    organizationId: orgId, counterpartyId: vendor.counterpartyId,
    status: 'held', reason: 'bank change under review', actorUserId: owner.userId, actorName: 'Owner',
  });
  await assert.rejects(() => assertBillApprovedForRelease(orgId, bill.billId), /on hold/);
});

test('agent preconditions: autonomy is earned per vendor and vetoed by holds/duplicates', async () => {
  const { orgId, owner } = await makeOrg();
  // A trusted-rail bill from a NEW vendor: the agent must decline (no track
  // record), routing it to people instead of paying.
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Fresh Agent Vendor', amount: 200, invoiceNo: 'FA-1' });
  await prisma.paymentOrder.update({
    where: { paymentOrderId: bill.billId },
    data: { state: 'draft' }, // past review, so the review-state reason doesn't mask the autonomy one
  });
  await prisma.counterpartyWallet.updateMany({
    where: { organizationId: orgId },
    data: { trustState: 'trusted' },
  });
  const { tryAdvancePaymentOrderWithAgent } = await import('../src/agents/payment-automation.js');
  const first = await tryAdvancePaymentOrderWithAgent({ organizationId: orgId, paymentOrderId: bill.billId, actorUserId: owner.userId });
  assert.equal(first.status, 'needs_review');
  assert.match(first.reason ?? '', /agent pays a vendor on its own only after/i);

  // Give the vendor a settled human track record → the autonomy reason clears
  // (the agent then fails later on missing treasury, which is fine — the
  // preconditions are what's under test).
  const vendor = await prisma.counterparty.findFirstOrThrow({ where: { organizationId: orgId, displayName: 'Fresh Agent Vendor' } });
  for (const n of [2, 3]) {
    const b = await uploadAndConfirm(orgId, owner.token, { vendor: 'Fresh Agent Vendor', amount: 200 + n, invoiceNo: `FA-${n}` });
    await prisma.paymentOrder.update({ where: { paymentOrderId: b.billId }, data: { state: 'settled' } });
  }
  const second = await tryAdvancePaymentOrderWithAgent({ organizationId: orgId, paymentOrderId: bill.billId, actorUserId: owner.userId });
  assert.ok(!/agent pays a vendor on its own/i.test(second.reason ?? ''), 'earned-autonomy reason cleared after 2 settled bills');

  // A vendor hold vetoes the agent no matter the track record.
  const { setVendorPayableStatus } = await import('../src/payments/vendor-payable.js');
  await setVendorPayableStatus({
    organizationId: orgId, counterpartyId: vendor.counterpartyId,
    status: 'held', reason: 'under review', actorUserId: owner.userId, actorName: 'Owner',
  });
  const third = await tryAdvancePaymentOrderWithAgent({ organizationId: orgId, paymentOrderId: bill.billId, actorUserId: owner.userId });
  assert.equal(third.status, 'needs_review');
  assert.match(third.reason ?? '', /never pays a held or blocked vendor/i);
});

test('vendor coding rules: agreeing history promotes a default; manual rules never auto-change', async () => {
  const { orgId, owner } = await makeOrg();
  const mk = async (n: number) => (await uploadAndConfirm(orgId, owner.token, { vendor: 'Rule Vendor', amount: 100 + n, invoiceNo: `RV-${n}` })).billId;
  const gl = await import('../src/accounting/gl-coding.js');
  const code = (paymentOrderId: string, account: string) =>
    gl.setPaymentOrderGlCoding(orgId, paymentOrderId, { codedExpenseAccountId: account, codedExpenseAccountName: account }, owner.userId);

  const vendorOf = async () => (await prisma.counterparty.findFirstOrThrow({ where: { organizationId: orgId, displayName: 'Rule Vendor' } })).counterpartyId;

  // Two agreeing codings: no rule yet. The third promotes it.
  const b1 = await mk(1); const b2 = await mk(2); const b3 = await mk(3);
  await code(b1, 'ACC-CLOUD'); await code(b2, 'ACC-CLOUD');
  const counterpartyId = await vendorOf();
  assert.equal(await gl.getVendorCodingRule(orgId, counterpartyId), null, 'two agreeing codings are not enough');
  await code(b3, 'ACC-CLOUD');
  let rule = await gl.getVendorCodingRule(orgId, counterpartyId);
  assert.equal(rule?.accountId, 'ACC-CLOUD');
  assert.equal(rule?.source, 'learned');
  assert.equal(rule?.learnedFromCount, 3);

  // The rule tops the candidate list for the vendor's next bill.
  const b4 = await mk(4);
  const { candidates } = await gl.predictGlCandidates(orgId, b4);
  assert.equal(candidates[0]?.reason, 'rule');
  assert.equal(candidates[0]?.accountId, 'ACC-CLOUD');

  // Drift: three agreeing codings on a NEW account retrain the learned rule —
  // current behavior wins, not six months ago.
  const b5 = await mk(5); const b6 = await mk(6);
  await code(b4, 'ACC-SOFTWARE'); await code(b5, 'ACC-SOFTWARE'); await code(b6, 'ACC-SOFTWARE');
  rule = await gl.getVendorCodingRule(orgId, counterpartyId);
  assert.equal(rule?.accountId, 'ACC-SOFTWARE', 'learned rule follows current behavior');

  // Manual rules are a person's word: later agreeing history never overrides.
  await gl.setVendorCodingRule({ organizationId: orgId, counterpartyId, accountId: 'ACC-MANUAL', accountName: 'Manual pick', actorUserId: owner.userId });
  const b7 = await mk(7); const b8 = await mk(8); const b9 = await mk(9);
  await code(b7, 'ACC-CLOUD'); await code(b8, 'ACC-CLOUD'); await code(b9, 'ACC-CLOUD');
  rule = await gl.getVendorCodingRule(orgId, counterpartyId);
  assert.equal(rule?.accountId, 'ACC-MANUAL');
  assert.equal(rule?.source, 'manual');

  // Clearing a manual rule reopens learning.
  await gl.clearVendorCodingRule(orgId, counterpartyId);
  const b10 = await mk(10);
  await code(b10, 'ACC-CLOUD');
  rule = await gl.getVendorCodingRule(orgId, counterpartyId);
  assert.equal(rule?.accountId, 'ACC-CLOUD', 'learning resumes after the manual rule is removed');

  // Pre-QBO review pre-fill (testbench 007): the rule must validate against
  // the PICKER's vocabulary — with no QBO chart, that's the builtin
  // categories. A rule the picker knows pre-fills; the ACC-CLOUD learned
  // rule above (not a picker option) correctly does not.
  const before = await get(`/organizations/${orgId}/bills/${await mk(11)}/review`, owner.token);
  assert.notEqual(before.codingSuggestionSource?.kind, 'rule', 'non-picker rule falls through to the document signal');
  await gl.setVendorCodingRule({ organizationId: orgId, counterpartyId, accountId: 'builtin:cloud-hosting', accountName: 'Cloud hosting & infrastructure', actorUserId: owner.userId });
  const b12 = await mk(12);
  const review = await get(`/organizations/${orgId}/bills/${b12}/review`, owner.token);
  assert.equal(review.codingSuggestionSource?.kind, 'rule', 'builtin-account rule pre-fills without QuickBooks');
  assert.match(review.codingSuggestionSource?.detail ?? '', /coding default/);
});

test('2-person org: the default flow routes to the approver, never the vetoed submitter', async () => {
  // BUG-default-flow-deadlock: owner + one approver, NO published flow. The
  // owner submits — the bill must wait on the APPROVER (quorum clamped to the
  // eligible count), never on the R1-vetoed submitter.
  const owner = await register('duo-owner');
  const org = await post('/organizations', { organizationName: 'Duo Partners LLC' }, owner.token);
  const orgId = org.organizationId as string;
  const amy = await register('duo-approver');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: amy.userId, role: 'member', status: 'active' },
  });
  const { assignRole } = await import('../src/approvals/roles.js');
  await assignRole(orgId, 'approver', amy.userId);

  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Duo Vendor', amount: 900, invoiceNo: 'DV-1', billTo: 'Duo Partners LLC' });
  await bill.confirm();

  const wb = await get(`/organizations/${orgId}/bills/workbench`, owner.token);
  const row = wb.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === bill.billId);
  assert.equal(row.bucket, 'in_approval', `bill waits for approval, got ${row.bucket}`);

  // The approver holds the task; the submitter holds none.
  const amyInbox = await get(`/organizations/${orgId}/bills/approvals-inbox`, amy.token);
  const task = amyInbox.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === bill.billId);
  assert.ok(task, 'the approver holds the task');
  const ownerInbox = await get(`/organizations/${orgId}/bills/approvals-inbox`, owner.token);
  assert.ok(
    !ownerInbox.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === bill.billId),
    'the submitter never holds their own approval task',
  );

  // The approver's single sign-off settles it (quorum clamped 2 → 1).
  await post(`/organizations/${orgId}/approvals/tasks/${task.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, amy.token);
  const after = await get(`/organizations/${orgId}/bills/workbench`, owner.token);
  const afterRow = after.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === bill.billId);
  assert.equal(afterRow.bucket, 'to_pay', 'approved by the approver → ready to pay');
});

test('owner+admin org: with no approver-role holders, the admin is the second pair of eyes', async () => {
  const owner = await register('oa-owner');
  const org = await post('/organizations', { organizationName: 'Owner Admin GmbH' }, owner.token);
  const orgId = org.organizationId as string;
  const admin = await register('oa-admin');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: admin.userId, role: 'admin', status: 'active' },
  });

  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'OA Vendor', amount: 600, invoiceNo: 'OA-1', billTo: 'Owner Admin GmbH' });
  await bill.confirm();

  // The ADMIN (non-requester) holds the task — never the owner-submitter.
  const adminInbox = await get(`/organizations/${orgId}/bills/approvals-inbox`, admin.token);
  const task = adminInbox.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === bill.billId);
  assert.ok(task, 'the admin holds the last-resort approval task');
  await post(`/organizations/${orgId}/approvals/tasks/${task.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, admin.token);
  const wb = await get(`/organizations/${orgId}/bills/workbench`, owner.token);
  const row = wb.bills.find((b: { paymentOrderId: string }) => b.paymentOrderId === bill.billId);
  assert.equal(row.bucket, 'to_pay');
});

test('org bill ceiling: over-ceiling bills are blocked in review and unblocked when raised', async () => {
  const { orgId, owner, a2 } = await makeOrg();

  // Only the primary admin touches the ceiling.
  const memberTry = await fetch(`${baseUrl}/organizations/${orgId}/policies/ceiling`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a2.token}` },
    body: JSON.stringify({ amountUsd: 1000 }),
  });
  assert.ok(!memberTry.ok, 'member cannot set the ceiling');

  const put = await fetch(`${baseUrl}/organizations/${orgId}/policies/ceiling`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ amountUsd: 1000 }),
  });
  assert.ok(put.ok);

  // A $15k bill is blocked at review and at confirm.
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Ceiling Vendor', amount: 15000, invoiceNo: 'CV-1' });
  const review = await get(`/organizations/${orgId}/bills/${bill.billId}/review`, owner.token);
  const flag = review.flags.find((f: { kind: string; blocking: boolean }) => f.kind === 'over_ceiling');
  assert.ok(flag?.blocking, 'over-ceiling flag blocks');
  let failed = false;
  try { await bill.confirm(); } catch { failed = true; }
  assert.ok(failed, 'confirm refuses over the ceiling');

  // The overview reports the ceiling; raising it unblocks the bill.
  const overview = await get(`/organizations/${orgId}/policies`, owner.token);
  assert.equal(overview.ceilingUsd, 1000);
  await fetch(`${baseUrl}/organizations/${orgId}/policies/ceiling`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ amountUsd: null }),
  });
  await bill.confirm();
});

test('pinned destination: a rail change after approval blocks release until re-approval', async () => {
  const { orgId, owner } = await makeOrg();
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Pin Vendor', amount: 800, invoiceNo: 'PV-1' });
  await bill.confirm();
  // Force-approve the approvable directly — approval mechanics are covered by
  // other tests; this one is about what the RELEASE gate does afterwards.
  await prisma.$executeRaw`
    UPDATE approval.approvables SET macro_state = 'approved'
    WHERE organization_id = ${orgId}::uuid AND attributes->>'paymentOrderId' = ${bill.billId}`;

  const { assertBillApprovedForRelease } = await import('../src/payments/release-gate.js');
  // Destination still matches what the approvers saw → release may proceed.
  await assertBillApprovedForRelease(orgId, bill.billId);

  // The vendor's rail changes after approval — approvers authorized a
  // different address, so release must refuse.
  const order = await prisma.paymentOrder.findUniqueOrThrow({
    where: { paymentOrderId: bill.billId },
    select: { counterpartyId: true },
  });
  const changed = await prisma.counterpartyWallet.create({
    data: {
      organizationId: orgId,
      counterpartyId: order.counterpartyId,
      walletAddress: 'ChangedRail1111111111111111111111111111111111',
      label: 'Changed rail',
      trustState: 'trusted',
    },
  });
  await prisma.paymentOrder.update({
    where: { paymentOrderId: bill.billId },
    data: { counterpartyWalletId: changed.counterpartyWalletId },
  });
  await assert.rejects(
    () => assertBillApprovedForRelease(orgId, bill.billId),
    /destination changed after this bill was approved/,
  );
});

test('vendor payable gate: held and blocked vendors cannot leave review', async () => {
  const { orgId, owner, a2 } = await makeOrg();
  const first = await uploadAndConfirm(orgId, owner.token, { vendor: 'Gate Vendor Co', amount: 500, invoiceNo: 'GV-1' });
  await first.confirm();

  const vendors = await get(`/organizations/${orgId}/counterparties`, owner.token);
  const vendor = vendors.items.find((v: { displayName: string }) => v.displayName === 'Gate Vendor Co');
  assert.ok(vendor, 'intake created the vendor');
  assert.equal(vendor.payableStatus, 'payable');

  const setStatus = (token: string, body: unknown) => fetch(
    `${baseUrl}/organizations/${orgId}/counterparties/${vendor.counterpartyId}/payable-status`,
    { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) },
  );

  // A plain member cannot touch the gate.
  const memberTry = await setStatus(a2.token, { status: 'held', reason: 'looks shady' });
  assert.ok(!memberTry.ok, 'member is refused');

  // Reason is mandatory — the change IS the audit record.
  const noReason = await setStatus(owner.token, { status: 'held' });
  assert.ok(!noReason.ok, 'a hold without a reason is refused');

  // Admin holds → new bills from this vendor are stuck in review.
  const held = await setStatus(owner.token, { status: 'held', reason: 'Bank details under investigation' });
  assert.ok(held.ok);
  const second = await uploadAndConfirm(orgId, owner.token, { vendor: 'Gate Vendor Co', amount: 700, invoiceNo: 'GV-2' });
  const review = await get(`/organizations/${orgId}/bills/${second.billId}/review`, owner.token);
  const flag = review.flags.find((f: { kind: string; blocking: boolean }) => f.kind === 'vendor_held');
  assert.ok(flag?.blocking, 'held vendor puts a blocking flag on the bill');
  let confirmFailed = false;
  try { await second.confirm(); } catch { confirmFailed = true; }
  assert.ok(confirmFailed, 'confirm refuses while the vendor is held');

  // Release the hold → the same bill confirms.
  const released = await setStatus(owner.token, { status: 'payable' });
  assert.ok(released.ok);
  await second.confirm();

  // Blocked is the terminal severity; only the primary admin can set it.
  const blocked = await setStatus(owner.token, { status: 'blocked', reason: 'Confirmed fraudulent invoices' });
  assert.ok(blocked.ok);
  const third = await uploadAndConfirm(orgId, owner.token, { vendor: 'Gate Vendor Co', amount: 900, invoiceNo: 'GV-3' });
  const thirdReview = await get(`/organizations/${orgId}/bills/${third.billId}/review`, owner.token);
  assert.ok(
    thirdReview.flags.find((f: { kind: string; blocking: boolean }) => f.kind === 'vendor_blocked')?.blocking,
    'blocked vendor flag',
  );
  // The vendor record carries the status change history.
  const after = await get(`/organizations/${orgId}/counterparties`, owner.token);
  const vAfter = after.items.find((v: { counterpartyId: string }) => v.counterpartyId === vendor.counterpartyId);
  assert.equal(vAfter.payableStatus, 'blocked');
  assert.equal(vAfter.payableHold.reason, 'Confirmed fraudulent invoices');
});

test('published forwards round-trip: auto markers survive publish → reload', async () => {
  const { orgId, owner, a2 } = await makeOrg();
  const flow0 = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const byUser = new Map(flow0.people.map((p: { user_id: string; id: string }) => [p.user_id, p.id]));
  const p2 = byUser.get(a2.userId) as string;

  // Forwards at a branch tail, as a branch's ONLY content, and at the lane tail
  // — all must survive the publish → engine-body → reload round trip (they used
  // to compile to nothing, so every publish looked reverted after refresh).
  await post(`/organizations/${orgId}/approvals/flow/publish`, { flow: [
    { id: 'n1', type: 'step', title: 'Finance review', approvers: [p2], quorum: 'any' },
    { id: 'n2', type: 'if', amountGteUsd: 1000,
      then: [
        { id: 'n3', type: 'step', title: 'Second look', approvers: [p2], quorum: 'any' },
        { id: 'n5', type: 'auto' },
      ],
      otherwise: [{ id: 'n4', type: 'auto' }] },
    { id: 'n6', type: 'auto' },
  ] }, owner.token);

  const reloaded = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const nodes = reloaded.flow as Array<{ type: string; then?: Array<{ type: string }>; otherwise?: Array<{ type: string }> }>;
  assert.equal(nodes.at(-1)?.type, 'auto', 'lane-tail forward survives');
  const split = nodes.find((n) => n.type === 'if')!;
  assert.equal(split.then!.at(-1)?.type, 'auto', 'branch-tail forward survives');
  assert.equal(split.otherwise![0]?.type, 'auto', 'forward-only branch survives');

  // And the forward still means "path done", NOT "auto-approve the bill":
  // an over-threshold sample still resolves both steps.
  const sim = await post(`/organizations/${orgId}/approvals/flow/simulate`, {
    flow: reloaded.flow, sample: { amountUsd: 1500, requesterPersonId: null },
  }, owner.token);
  assert.equal(sim.chain.length, 2);
});

test('flow simulate resolves the chain, skips by amount, and applies R1', async () => {
  const { orgId, owner, a2, a3 } = await makeOrg();
  const flow = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const byUser = new Map(flow.people.map((p: { user_id: string; id: string }) => [p.user_id, p.id]));
  const p2 = byUser.get(a2.userId) as string;
  const p3 = byUser.get(a3.userId) as string;

  const draft = [
    { id: 'n1', type: 'step', title: 'Finance review', approvers: [p2, p3], quorum: 'any' },
    { id: 'n2', type: 'if', amountGteUsd: 10000,
      then: [{ id: 'n3', type: 'step', title: 'Owner sign-off', approvers: [p3], quorum: 'any' }],
      otherwise: [{ id: 'n4', type: 'auto' }] },
  ];
  // Under threshold → the finance step only. The chain shows the WHOLE pool
  // (both eligible people) with the quorum spelled out — not a sliced subset.
  const small = await post(`/organizations/${orgId}/approvals/flow/simulate`, { flow: draft, sample: { amountUsd: 5000, requesterPersonId: byUser.get(owner.userId) } }, owner.token);
  assert.equal(small.stuck, null);
  assert.equal(small.chain.length, 2);
  assert.ok(small.chain[0].why.includes('any one'), 'quorum is spelled out');
  // Over threshold → finance pool (2) + owner step (1).
  const big = await post(`/organizations/${orgId}/approvals/flow/simulate`, { flow: draft, sample: { amountUsd: 15000, requesterPersonId: byUser.get(owner.userId) } }, owner.token);
  assert.equal(big.chain.length, 3);
  // Requester is an approver → R1 removes them, the other stands in (note present).
  const r1 = await post(`/organizations/${orgId}/approvals/flow/simulate`, { flow: draft, sample: { amountUsd: 5000, requesterPersonId: p2 } }, owner.token);
  assert.equal(r1.stuck, null);
  assert.equal(r1.chain[0].personId, p3);
  assert.ok(r1.notes.length > 0, 'R1 substitution note present');
});

test('bank-only upload creates a pending-method vendor and a needs-review bill', async () => {
  const { orgId, owner } = await makeOrg();
  bankInvoice({ vendor: 'Brightwave Media', amount: 9500 });
  const up = await post(`/organizations/${orgId}/invoices/upload`, {
    filename: 'b.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('%PDF x').toString('base64'), autoAdvance: false,
  }, owner.token);
  assert.equal(up.createdCount, 1);
  assert.equal(up.paymentOrders[0].paymentOrder.state, 'needs_review');
  const wallet = await prisma.counterpartyWallet.findFirstOrThrow({ where: { organizationId: orgId } });
  assert.equal(wallet.walletType, 'pending_method');
  assert.equal(wallet.trustState, 'unreviewed');
  assert.ok(wallet.walletAddress.startsWith('pending:'));
});

test('coding uncertainty never blocks: uncoded lines park in Uncategorized expense', async () => {
  // The old tier-1 gate rejected confirm on a missing category. GL synthesis:
  // bookkeeping uncertainty parks in the accountant's catch-all, it never
  // stops a bill. Amounts still gate — approval routes on them.
  const { orgId, owner, a2, a3 } = await makeOrg();
  const flow = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const byUser = new Map(flow.people.map((p: { user_id: string; id: string }) => [p.user_id, p.id]));
  await publishLadder(orgId, owner.token, [byUser.get(a2.userId) as string], byUser.get(a3.userId) as string);

  const uncoded = await uploadAndConfirm(orgId, owner.token, { amount: 15000 }, { skipCategory: true });
  const res = await uncoded.confirm();
  assert.equal(res.detail.state, 'draft', 'uncoded bill confirms and enters approval');
  // The line landed in the catch-all, visible on the approvable's attributes.
  const rows = await prisma.$queryRaw<{ attributes: { categories?: string[] } }[]>`
    SELECT attributes FROM approval.approvables
    WHERE organization_id = ${orgId}::uuid AND attributes->>'paymentOrderId' = ${uncoded.billId}`;
  assert.ok(rows[0]?.attributes.categories?.includes('Uncategorized expense'), 'line parked in the catch-all');

  const coded = await uploadAndConfirm(orgId, owner.token, { amount: 15000, invoiceNo: 'INV-2' });
  const res2 = await coded.confirm();
  assert.equal(res2.detail.state, 'draft');
});

test('confirm routes the bill; the chain, inbox signal, approve/reject all work', async () => {
  const { orgId, owner, a2, a3 } = await makeOrg();
  const flow = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const byUser = new Map(flow.people.map((p: { user_id: string; id: string }) => [p.user_id, p.id]));
  const p2 = byUser.get(a2.userId) as string;
  const p3 = byUser.get(a3.userId) as string;
  await publishLadder(orgId, owner.token, [p2], p3); // Finance=a2, Owner-step=a3 (over $10k)

  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Zephyr Analytics', amount: 15000, invoiceNo: 'ZA-1' });
  await bill.confirm();

  // Bill detail: chain is a2 → a3; owner (requester) is not in it.
  const detail = await get(`/organizations/${orgId}/bills/${bill.billId}/detail`, owner.token);
  assert.ok(detail.approval, 'has an approvable');
  const chainPeople = detail.approval.steps.map((s: { person: { personId: string } | null }) => s.person?.personId);
  assert.deepEqual(chainPeople, [p2, p3]);

  // Approver a2's inbox: bill waiting, flagged as a first-time vendor.
  const inboxA2 = await get(`/organizations/${orgId}/bills/approvals-inbox`, a2.token);
  const row = inboxA2.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === bill.billId);
  assert.ok(row, 'bill is waiting on a2');
  assert.equal(row.signal.clean, false);
  assert.match(row.signal.label, /first bill/i);

  // a2 approves → a3 becomes current.
  await post(`/organizations/${orgId}/approvals/tasks/${row.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, a2.token);
  const afterA2 = await get(`/organizations/${orgId}/bills/${bill.billId}/detail`, a3.token);
  const a3Node = afterA2.approval.steps.find((s: { person: { personId: string } | null }) => s.person?.personId === p3);
  assert.equal(a3Node.state, 'current');

  // a3 approves → fully approved.
  const inboxA3 = await get(`/organizations/${orgId}/bills/approvals-inbox`, a3.token);
  const rowA3 = inboxA3.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === bill.billId);
  await post(`/organizations/${orgId}/approvals/tasks/${rowA3.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, a3.token);
  const done = await get(`/organizations/${orgId}/bills/${bill.billId}/detail`, owner.token);
  assert.match(done.approval.macroState, /approved/);
});

test('request-info blocks approval until answered; reject stops the route', async () => {
  const { orgId, owner, a2, a3 } = await makeOrg();
  const flow = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const byUser = new Map(flow.people.map((p: { user_id: string; id: string }) => [p.user_id, p.id]));
  const p2 = byUser.get(a2.userId) as string;
  const ownerP = byUser.get(owner.userId) as string;
  await publishLadder(orgId, owner.token, [p2], byUser.get(a3.userId) as string);

  // request-info thread
  const b1 = await uploadAndConfirm(orgId, owner.token, { vendor: 'Kepler Legal', amount: 6000, invoiceNo: 'KL-1' });
  await b1.confirm();
  const inbox = await get(`/organizations/${orgId}/bills/approvals-inbox`, a2.token);
  const r1 = inbox.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === b1.billId);
  await post(`/organizations/${orgId}/approvals/tasks/${r1.taskId}/command`, { command: { kind: 'request_info', question: 'Is this the annual renewal?', from: ownerP }, idempotencyKey: crypto.randomUUID() }, a2.token);
  const withThread = await get(`/organizations/${orgId}/bills/${b1.billId}/detail`, a2.token);
  const threadNode = withThread.approval.steps.find((s: { thread: unknown }) => s.thread);
  assert.ok(threadNode?.thread?.open, 'open info request');
  // owner answers
  await post(`/organizations/${orgId}/approvals/tasks/${r1.taskId}/command`, { command: { kind: 'provide_info', answer: 'Yes, annual.' }, idempotencyKey: crypto.randomUUID() }, owner.token);
  const resolved = await get(`/organizations/${orgId}/bills/${b1.billId}/detail`, a2.token);
  const resolvedNode = resolved.approval.steps.find((s: { thread: unknown }) => s.thread);
  assert.equal(resolvedNode.thread.open, false);

  // reject sends the bill BACK TO REVIEW with the reason (never a dead end)
  const b2 = await uploadAndConfirm(orgId, owner.token, { vendor: 'Vantage Print', amount: 1200, invoiceNo: 'VP-1' });
  await b2.confirm();
  const inbox2 = await get(`/organizations/${orgId}/bills/approvals-inbox`, a2.token);
  const r2 = inbox2.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === b2.billId);
  await post(`/organizations/${orgId}/approvals/tasks/${r2.taskId}/command`, { command: { kind: 'reject', reason: 'Needs its own PO first.' }, idempotencyKey: crypto.randomUUID() }, a2.token);
  const rejected = await get(`/organizations/${orgId}/bills/${b2.billId}/detail`, owner.token);
  assert.equal(rejected.approval.macroState, 'rejected');

  // …the order is back in review, carrying the approver's homework
  const sentBack = await get(`/organizations/${orgId}/bills/${b2.billId}/review`, owner.token);
  assert.equal(sentBack.state, 'needs_review');
  assert.equal(sentBack.sentBack.reason, 'Needs its own PO first.');
  assert.ok(sentBack.sentBack.byName, 'send-back names the approver');

  // …the reviewer fixes and re-confirms → a FRESH approval run (fresh consents)
  await b2.confirm();
  const resubmitted = await get(`/organizations/${orgId}/bills/${b2.billId}/detail`, owner.token);
  assert.equal(resubmitted.approval.macroState, 'pending_approval', 'resubmit starts a fresh run');
  assert.ok(resubmitted.approval.flowVersion >= 1, 'provenance: the flow version that routed this bill');
  const cleared = await get(`/organizations/${orgId}/bills/${b2.billId}/review`, owner.token);
  assert.equal(cleared.sentBack, null, 'the sent-back note clears on re-confirm');

  // …and the fresh run is decidable end to end
  const inbox3 = await get(`/organizations/${orgId}/bills/approvals-inbox`, a2.token);
  const r3 = inbox3.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === b2.billId);
  assert.ok(r3, 'the resubmitted bill is back in the approver inbox');
  await post(`/organizations/${orgId}/approvals/tasks/${r3.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, a2.token);
  const approved = await get(`/organizations/${orgId}/bills/${b2.billId}/detail`, owner.token);
  assert.ok(['approved', 'auto_approved'].includes(approved.approval.macroState));
});

test('a stalled approval escalates to the primary admin — it never auto-denies', async () => {
  const { orgId, owner, a2, a3 } = await makeOrg();
  const flow = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const byUser = new Map(flow.people.map((p: { user_id: string; id: string }) => [p.user_id, p.id]));
  await publishLadder(orgId, owner.token, [byUser.get(a2.userId) as string], byUser.get(a3.userId) as string);

  // a3 enters the bill (Reviewer role) so the owner is NOT the requester —
  // the stand-in rule allows the owner to take the stalled step.
  await post(`/organizations/${orgId}/roles/reviewer/holders`, { userId: a3.userId }, owner.token);
  const bill = await uploadAndConfirm(orgId, a3.token, { vendor: 'Meridian Networks', amount: 700, invoiceNo: 'MN-1' });
  await bill.confirm();

  // Age the open task past its deadline and sweep.
  await prisma.$executeRaw`
    UPDATE approval.tasks SET sla_deadline = now() - interval '1 hour'
    WHERE state = 'open' AND plan_id IN (
      SELECT p.id FROM approval.approval_plans p
      JOIN approval.approvables a ON a.id = p.approvable_id
      WHERE a.organization_id = ${orgId}::uuid)`;
  const { sweepTimers } = await import('../src/approvals/lifecycle.js');
  const swept = await sweepTimers();
  assert.ok(swept.escalated >= 1, 'the aged task escalated');

  // The primary admin now holds an open fill-in task — the bill shows in their inbox.
  const ownerInbox = await get(`/organizations/${orgId}/bills/approvals-inbox`, owner.token);
  assert.ok(
    ownerInbox.waitingOnYou.some((r: { paymentOrderId: string }) => r.paymentOrderId === bill.billId),
    'escalated bill lands in the primary admin inbox',
  );
  // And the bill is still alive — approvable pending, order untouched.
  const detail = await get(`/organizations/${orgId}/bills/${bill.billId}/detail`, owner.token);
  assert.equal(detail.approval.macroState, 'pending_approval');
});

test('payment stage is a full flow: an amount split adds a second release signer', async () => {
  const { orgId, owner, a2, a3 } = await makeOrg();
  const flow = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const byUser = new Map(flow.people.map((p: { user_id: string; id: string }) => [p.user_id, p.id]));
  const p2 = byUser.get(a2.userId) as string;
  const p3 = byUser.get(a3.userId) as string;
  const ownerP = byUser.get(owner.userId) as string;

  // Approval: a2 approves everything. Payment: a3 signs; over $10k the owner ALSO signs.
  await post(`/organizations/${orgId}/approvals/flow/publish`, { flow: [
    { id: 'a1', type: 'step', title: 'Approval step', approvers: [p2], quorum: 'any' },
  ] }, owner.token);
  await post(`/organizations/${orgId}/approvals/payment-flow/publish`, { flow: [
    { id: 'r1', type: 'step', title: 'Payment step', approvers: [p3], quorum: 'any' },
    { id: 'r2', type: 'if', amountGteUsd: 10000,
      then: [{ id: 'r3', type: 'step', title: 'Big payment sign-off', approvers: [ownerP], quorum: 'any' }], otherwise: [] },
  ] }, owner.token);

  const runRelease = async (amount: number, invoiceNo: string) => {
    const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Quasar Metals', amount, invoiceNo });
    await bill.confirm();
    const inbox = await get(`/organizations/${orgId}/bills/approvals-inbox`, a2.token);
    const row = inbox.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === bill.billId);
    await post(`/organizations/${orgId}/approvals/tasks/${row.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, a2.token);
    // Approval spawned the release run — count its distinct signer steps.
    const steps = await prisma.$queryRaw<{ step_index: number }[]>`
      SELECT DISTINCT t.step_index FROM approval.tasks t
      JOIN approval.approval_plans p ON p.id = t.plan_id AND p.superseded_by IS NULL
      JOIN approval.approvables a ON a.id = p.approvable_id
      WHERE a.type = 'payment_run' AND a.organization_id = ${orgId}::uuid
        AND a.attributes->>'sourceApprovableId' IN (
          SELECT id::text FROM approval.approvables WHERE attributes->>'paymentOrderId' = ${bill.billId})`;
    return steps.length;
  };

  assert.equal(await runRelease(2_000, 'QM-1'), 1, 'small payment: one signer step');
  assert.equal(await runRelease(15_000, 'QM-2'), 2, 'big payment: the split adds the second signer');
});

test('out-of-office: a fill-in covers waiting bills and new ones, and can act', async () => {
  const { orgId, owner, a2, a3 } = await makeOrg();
  const flow = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const byUser = new Map(flow.people.map((p: { user_id: string; id: string }) => [p.user_id, p.id]));
  const ownerP = byUser.get(owner.userId) as string;
  await publishLadder(orgId, owner.token, [byUser.get(a2.userId) as string], byUser.get(a3.userId) as string);
  await post(`/organizations/${orgId}/roles/reviewer/holders`, { userId: a3.userId }, owner.token);

  // A bill already waiting on a2…
  const b1 = await uploadAndConfirm(orgId, a3.token, { vendor: 'Northwind Data', amount: 800, invoiceNo: 'ND-1' });
  await b1.confirm();
  const before = await get(`/organizations/${orgId}/bills/approvals-inbox`, owner.token);
  assert.ok(!before.waitingOnYou.some((r: { paymentOrderId: string }) => r.paymentOrderId === b1.billId), 'owner not involved yet');

  // …a2 goes away and picks the owner as their fill-in → mirrored immediately.
  const until = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
  const set = await put(`/organizations/${orgId}/approvals/out-of-office`, { substitutePersonId: ownerP, endsAt: until }, a2.token);
  assert.ok(set.mirrored >= 1, 'waiting bill mirrored to the fill-in');
  const mine = await get(`/organizations/${orgId}/approvals/out-of-office`, a2.token);
  assert.equal(mine.outOfOffice.substitutePersonId, ownerP);

  // A NEW bill arriving while away reaches the fill-in at activation.
  const b2 = await uploadAndConfirm(orgId, a3.token, { vendor: 'Northwind Data', amount: 850, invoiceNo: 'ND-2' });
  await b2.confirm();
  const inbox = await get(`/organizations/${orgId}/bills/approvals-inbox`, owner.token);
  for (const billId of [b1.billId, b2.billId]) {
    assert.ok(inbox.waitingOnYou.some((r: { paymentOrderId: string }) => r.paymentOrderId === billId), `fill-in sees ${billId}`);
  }

  // The fill-in's approval completes the step.
  const row = inbox.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === b1.billId);
  await post(`/organizations/${orgId}/approvals/tasks/${row.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, owner.token);
  const detail = await get(`/organizations/${orgId}/bills/${b1.billId}/detail`, owner.token);
  assert.ok(['approved', 'auto_approved'].includes(detail.approval.macroState));

  // Back home: clearing stops future mirroring.
  const res = await fetch(`${baseUrl}/organizations/${orgId}/approvals/out-of-office`, { method: 'DELETE', headers: { authorization: `Bearer ${a2.token}` } });
  assert.equal(res.status, 200);
  const cleared = await get(`/organizations/${orgId}/approvals/out-of-office`, a2.token);
  assert.equal(cleared.outOfOffice, null);
});

async function put(path: string, body: unknown, token: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.ok(res.status === 200 || res.status === 201, `PUT ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

test('vendor and category splits route real bills, and the simulator honors samples', async () => {
  const { orgId, owner, a2, a3 } = await makeOrg();
  const flow = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const byUser = new Map(flow.people.map((p: { user_id: string; id: string }) => [p.user_id, p.id]));
  const p2 = byUser.get(a2.userId) as string;
  const p3 = byUser.get(a3.userId) as string;

  // Seed a vendor by uploading one bill, then find its counterparty id.
  const seed = await uploadAndConfirm(orgId, owner.token, { vendor: 'Helios Grid', amount: 500, invoiceNo: 'HG-0' });
  await seed.confirm();
  const flowWithVendors = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const helios = flowWithVendors.vendors.find((v: { name: string }) => v.name === 'Helios Grid');
  assert.ok(helios, 'builder offers real vendors as split options');

  // Publish: everyone through a2; Helios Grid bills ALSO need a3; anything coded
  // to cloud hosting ALSO needs the owner-step person (a3 reused? use p3 for vendor, p2... keep distinct people per step).
  const published = await post(`/organizations/${orgId}/approvals/flow/publish`, { flow: [
    { id: 'n1', type: 'step', title: 'Finance review', approvers: [p2], quorum: 'any' },
    { id: 'n2', type: 'if', amountGteUsd: 0, split: { kind: 'vendor', vendorIds: [helios.id], vendorNames: ['Helios Grid'] },
      then: [{ id: 'n3', type: 'step', title: 'Vendor owner sign-off', approvers: [p3], quorum: 'any' }], otherwise: [] },
  ] }, owner.token);
  assert.ok(published.version >= 1);

  // A Helios bill routes through BOTH steps…
  const hit = await uploadAndConfirm(orgId, owner.token, { vendor: 'Helios Grid', amount: 900, invoiceNo: 'HG-1' });
  await hit.confirm();
  const hitDetail = await get(`/organizations/${orgId}/bills/${hit.billId}/detail`, owner.token);
  assert.equal(hitDetail.approval.steps.length, 2, 'vendor-split branch taken');

  // …a different vendor takes only the first.
  const miss = await uploadAndConfirm(orgId, owner.token, { vendor: 'Borealis Print', amount: 900, invoiceNo: 'BP-1' });
  await miss.confirm();
  const missDetail = await get(`/organizations/${orgId}/bills/${miss.billId}/detail`, owner.token);
  assert.equal(missDetail.approval.steps.length, 1, 'other vendors skip the branch');

  // Category split routes on real line coding (uploadAndConfirm codes lines).
  await post(`/organizations/${orgId}/approvals/flow/publish`, { flow: [
    { id: 'c1', type: 'step', title: 'Finance review', approvers: [p2], quorum: 'any' },
    { id: 'c2', type: 'if', amountGteUsd: 0, split: { kind: 'category', categories: ['Cloud hosting & infrastructure'] },
      then: [{ id: 'c3', type: 'step', title: 'IT sign-off', approvers: [p3], quorum: 'any' }], otherwise: [] },
  ] }, owner.token);
  const coded = await uploadAndConfirm(orgId, owner.token, { vendor: 'Borealis Print', amount: 400, invoiceNo: 'BP-2' });
  await coded.confirm();
  const codedDetail = await get(`/organizations/${orgId}/bills/${coded.billId}/detail`, owner.token);
  assert.equal(codedDetail.approval.steps.length, 2, 'category-split branch taken from line coding');

  // First-bill split: a brand-new vendor takes the extra step; their second bill doesn't.
  await post(`/organizations/${orgId}/approvals/flow/publish`, { flow: [
    { id: 'f1', type: 'step', title: 'Finance review', approvers: [p2], quorum: 'any' },
    { id: 'f2', type: 'if', amountGteUsd: 0, split: { kind: 'firstBill' },
      then: [{ id: 'f3', type: 'step', title: 'New vendor check', approvers: [p3], quorum: 'any' }], otherwise: [] },
  ] }, owner.token);
  const newVendor = await uploadAndConfirm(orgId, owner.token, { vendor: 'Zephyr Logistics', amount: 300, invoiceNo: 'ZL-1' });
  await newVendor.confirm();
  const firstDetail = await get(`/organizations/${orgId}/bills/${newVendor.billId}/detail`, owner.token);
  assert.equal(firstDetail.approval.steps.length, 2, 'first bill from a vendor takes the extra step');
  const secondBill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Zephyr Logistics', amount: 350, invoiceNo: 'ZL-2' });
  await secondBill.confirm();
  const secondDetail = await get(`/organizations/${orgId}/bills/${secondBill.billId}/detail`, owner.token);
  assert.equal(secondDetail.approval.steps.length, 1, 'their second bill moves straight on');

  // The simulator honors vendor samples the same way.
  const simFlow = [
    { id: 's1', type: 'step', title: 'Finance review', approvers: [p2], quorum: 'any' },
    { id: 's2', type: 'if', amountGteUsd: 0, split: { kind: 'vendor', vendorIds: [helios.id], vendorNames: ['Helios Grid'] },
      then: [{ id: 's3', type: 'step', title: 'Vendor owner sign-off', approvers: [p3], quorum: 'any' }], otherwise: [] },
  ];
  const simHit = await post(`/organizations/${orgId}/approvals/flow/simulate`, { flow: simFlow, sample: { amountUsd: 500, requesterPersonId: null, vendorId: helios.id } }, owner.token);
  assert.equal(simHit.chain.length, 2);
  const simMiss = await post(`/organizations/${orgId}/approvals/flow/simulate`, { flow: simFlow, sample: { amountUsd: 500, requesterPersonId: null, vendorId: null } }, owner.token);
  assert.equal(simMiss.chain.length, 1);
});

test('approvals signal flags a bill well above the vendor history', async () => {
  const { orgId, owner, a2, a3 } = await makeOrg();
  const flow = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const byUser = new Map(flow.people.map((p: { user_id: string; id: string }) => [p.user_id, p.id]));
  const p2 = byUser.get(a2.userId) as string;
  await publishLadder(orgId, owner.token, [p2], byUser.get(a3.userId) as string);

  // First bill establishes the vendor + a ~$5k baseline point.
  const first = await uploadAndConfirm(orgId, owner.token, { vendor: 'Northwind Supplies', amount: 5000, invoiceNo: 'NW-1' });
  await first.confirm();
  const firstOrder = await prisma.paymentOrder.findFirstOrThrow({ where: { organizationId: orgId, invoiceNumber: 'NW-1' } });
  // Seed two more historical bills for the same vendor at ~$5k.
  for (const [n, ref] of [[4800, 'NW-h1'], [5200, 'NW-h2']] as const) {
    await prisma.paymentOrder.create({
      data: {
        organizationId: orgId, counterpartyId: firstOrder.counterpartyId, counterpartyWalletId: firstOrder.counterpartyWalletId,
        amountRaw: BigInt(n) * 1000000n, asset: 'usdc', invoiceNumber: ref, state: 'executed', metadataJson: {},
      },
    });
  }
  // A $20k spike → flagged "above usual".
  const spike = await uploadAndConfirm(orgId, owner.token, { vendor: 'Northwind Supplies', amount: 20000, invoiceNo: 'NW-2' });
  await spike.confirm();
  const inbox = await get(`/organizations/${orgId}/bills/approvals-inbox`, a2.token);
  const row = inbox.waitingOnYou.find((r: { paymentOrderId: string }) => r.paymentOrderId === spike.billId);
  assert.ok(row, 'spike waiting on a2');
  assert.equal(row.signal.clean, false);
  assert.match(row.signal.label, /above/i);
});

// ---- http helpers -----------------------------------------------------------
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

// --- a flagged bill must be actionable before anyone confirms it -------------
//
// The whole reason bills now enter the engine at intake. A reviewer who sees
// something wrong needs somewhere to go other than "approve it" or "bin it" —
// and the moment they need that is BEFORE confirming, which is exactly when
// the bill used to have no task at all.

test('a bill has an owner and an open task from the moment it is ingested', async () => {
  const owner = await register('ask-owner');
  const org = await post('/organizations', { organizationName: 'Ask Co' }, owner.token);
  const orgId = org.organizationId as string;

  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Ask Vendor', amount: 900, invoiceNo: 'ASK-1', billTo: 'Ask Co' });
  // Deliberately NOT confirmed — this is the pre-confirm state.

  const detail = await get(`/organizations/${orgId}/bills/${bill.billId}/detail`, owner.token);
  assert.ok(detail.approval, 'an ingested bill is already in the engine, not waiting for confirm');
  assert.ok(detail.viewer.openTaskId, 'and somebody holds a task on it');
});

test('a reviewer can ask a question on a bill nobody has confirmed yet', async () => {
  const owner = await register('ask2-owner');
  const org = await post('/organizations', { organizationName: 'Ask Two' }, owner.token);
  const orgId = org.organizationId as string;
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'Ask2 Vendor', amount: 700, invoiceNo: 'ASK-2', billTo: 'Ask Two' });

  const before = await get(`/organizations/${orgId}/bills/${bill.billId}/detail`, owner.token);
  const taskId = before.viewer.openTaskId as string;
  const me = before.viewer.personId as string;

  await post(`/organizations/${orgId}/approvals/tasks/${taskId}/command`, {
    command: { kind: 'request_info', question: 'Is this bill actually ours?', from: me },
    idempotencyKey: crypto.randomUUID(),
  }, owner.token);

  const after = await get(`/organizations/${orgId}/bills/${bill.billId}/detail`, owner.token);
  assert.equal(after.approval.macroState, 'returned_for_info', 'the bill parks on the question rather than dying');
});

// --- recording a name the organization trades under ---------------------------
//
// An identity claim about the organization, not a judgement about one invoice —
// so an approver may ask for it and an admin decides it.

test('an owner can record a trading name, and the flag stops firing for it', async () => {
  const owner = await register('tn-owner');
  const org = await post('/organizations', { organizationName: 'Decimal Labs' }, owner.token);
  const orgId = org.organizationId as string;

  const { addOrganizationTradingName } = await import('../src/payments/bills.js');
  const first = await addOrganizationTradingName({
    organizationId: orgId, name: 'Halcyon Labs',
    actorUserId: owner.userId, actorName: 'Owner',
  });
  assert.equal(first.added, true);
  assert.deepEqual(first.tradingNames, ['Halcyon Labs']);

  // Idempotent: clicking twice must not corrupt the list.
  const again = await addOrganizationTradingName({
    organizationId: orgId, name: 'halcyon labs',
    actorUserId: owner.userId, actorName: 'Owner',
  });
  assert.equal(again.added, false, 'the same name in different case is the same name');
  assert.deepEqual(again.tradingNames, ['Halcyon Labs']);
});

test('a member who is not an admin cannot decide that another company is us', async () => {
  const owner = await register('tn2-owner');
  const org = await post('/organizations', { organizationName: 'Decimal Two' }, owner.token);
  const orgId = org.organizationId as string;
  const member = await register('tn2-member');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: member.userId, role: 'member', status: 'active' },
  });

  const { addOrganizationTradingName } = await import('../src/payments/bills.js');
  await assert.rejects(
    () => addOrganizationTradingName({
      organizationId: orgId, name: 'Halcyon Labs',
      actorUserId: member.userId, actorName: 'Member',
    }),
    /owner or admin/,
    'a regular member must not be able to widen what the org answers to',
  );
});

test('"this is us" clears the flag through the API, and a member is refused', async () => {
  const owner = await register('tiu-owner');
  const org = await post('/organizations', { organizationName: 'Decimal Labs' }, owner.token);
  const orgId = org.organizationId as string;
  const bill = await uploadAndConfirm(orgId, owner.token, {
    vendor: 'Acme Cloud', amount: 4820, invoiceNo: 'TIU-1', billTo: 'Halcyon Labs, Inc.',
  });

  const before = await get(`/organizations/${orgId}/bills/${bill.billId}/review`, owner.token);
  assert.ok(before.flags.some((f: any) => f.kind === 'addressed_elsewhere'), 'flagged to begin with');

  const member = await register('tiu-member');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: member.userId, role: 'member', status: 'active' },
  });
  await assert.rejects(
    () => post(`/organizations/${orgId}/bills/${bill.billId}/this-is-us`, { name: 'Halcyon Labs' }, member.token),
    /403/,
    'a member cannot decide that another company is us',
  );

  const res = await post(`/organizations/${orgId}/bills/${bill.billId}/this-is-us`, { name: 'Halcyon Labs' }, owner.token);
  assert.equal(res.added, true);
  assert.ok(!res.review.flags.some((f: any) => f.kind === 'addressed_elsewhere'),
    'the flag is gone in the same response — no reload needed to see it resolved');
});

test('closing a bill is admin-only — a member can ask, not kill', async () => {
  const owner = await register('nb-owner');
  const org = await post('/organizations', { organizationName: 'Close Co' }, owner.token);
  const orgId = org.organizationId as string;
  const bill = await uploadAndConfirm(orgId, owner.token, {
    vendor: 'Close Vendor', amount: 500, invoiceNo: 'NB-1', billTo: 'Halcyon Labs, Inc.',
  });
  const member = await register('nb-member');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: member.userId, role: 'member', status: 'active' },
  });

  await assert.rejects(
    () => post(`/organizations/${orgId}/bills/${bill.billId}/not-a-bill`, { reason: 'not_ours' }, member.token),
    /403/,
    'killing a payable costs as much as paying a false one and needs the same standing',
  );

  const closed = await post(`/organizations/${orgId}/bills/${bill.billId}/not-a-bill`, { reason: 'not_ours' }, owner.token);
  assert.ok(closed, 'an admin can close it');
});

// --- asking a colleague -------------------------------------------------------

test('anyone can ask a colleague about a bill, and the bill waits on the answer', async () => {
  const owner = await register('ask-o');
  const org = await post('/organizations', { organizationName: 'Ask Org' }, owner.token);
  const orgId = org.organizationId as string;
  const member = await register('ask-m');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: member.userId, role: 'member', status: 'active' },
  });
  const bill = await uploadAndConfirm(orgId, owner.token, {
    vendor: 'Ask Vendor', amount: 800, invoiceNo: 'ASKQ-1', billTo: 'Halcyon Labs, Inc.',
  });

  // The member — not an admin — must be able to ask. Asking is never the
  // dangerous act, so it cannot be the thing they lack standing for.
  const candidates = await get(`/organizations/${orgId}/bills/${bill.billId}/ask-candidates`, member.token);
  assert.ok(candidates.candidates.some((c: any) => c.userId === owner.userId), 'the owner is askable');
  assert.ok(!candidates.candidates.some((c: any) => c.userId === member.userId), 'you are not offered yourself');

  // A member who does not hold the task can still ASK — the question is
  // recorded and routed. It does not park the bill, because request_info is
  // task-scoped and parking is a state change on someone else's task.
  const asked = await post(`/organizations/${orgId}/bills/${bill.billId}/ask`, {
    askedOfUserId: owner.userId,
    question: 'Is Halcyon Labs one of ours?',
    aboutFlag: 'addressed_elsewhere',
  }, member.token);
  assert.ok(asked.billQuestionId, 'the question is recorded whoever asks');

  const recorded = await prisma.billQuestion.findUniqueOrThrow({ where: { billQuestionId: asked.billQuestionId } });
  assert.equal(recorded.askedOfUserId, owner.userId);
  assert.equal(recorded.aboutFlag, 'addressed_elsewhere', 'routing is learned per problem, not as one pile');
});

test('the person holding the task parks the bill when they ask', async () => {
  const owner = await register('askp-o');
  const org = await post('/organizations', { organizationName: 'Ask Park' }, owner.token);
  const orgId = org.organizationId as string;
  const other = await register('askp-other');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: other.userId, role: 'admin', status: 'active' },
  });
  const bill = await uploadAndConfirm(orgId, owner.token, {
    vendor: 'Park Vendor', amount: 640, invoiceNo: 'ASKP-1', billTo: 'Halcyon Labs, Inc.',
  });

  // The owner submitted the bill, so R1 excludes them from approving it and the
  // admin holds the task. The task holder is therefore the one who can park it.
  await post(`/organizations/${orgId}/bills/${bill.billId}/ask`, {
    askedOfUserId: owner.userId,
    question: 'Is Halcyon Labs one of ours?',
    aboutFlag: 'addressed_elsewhere',
  }, other.token);

  const detail = await get(`/organizations/${orgId}/bills/${bill.billId}/detail`, owner.token);
  assert.equal(detail.approval.macroState, 'returned_for_info', 'the bill waits on the answer rather than moving');
});

test('ask candidates put whoever actually answers first', async () => {
  const owner = await register('askr-o');
  const org = await post('/organizations', { organizationName: 'Ask Rank' }, owner.token);
  const orgId = org.organizationId as string;
  const quiet = await register('askr-quiet');
  const helpful = await register('askr-helpful');
  for (const u of [quiet, helpful]) {
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, userId: u.userId, role: 'member', status: 'active' },
    });
  }
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'V', amount: 100, invoiceNo: 'ASKR-1', billTo: 'Ask Rank' });

  // Quiet is asked twice and never replies; helpful is asked once and answers.
  await prisma.billQuestion.createMany({
    data: [
      { organizationId: orgId, paymentOrderId: bill.billId, askedByUserId: owner.userId, askedOfUserId: quiet.userId, question: 'q1' },
      { organizationId: orgId, paymentOrderId: bill.billId, askedByUserId: owner.userId, askedOfUserId: quiet.userId, question: 'q2' },
      { organizationId: orgId, paymentOrderId: bill.billId, askedByUserId: owner.userId, askedOfUserId: helpful.userId, question: 'q3', answer: 'yes', answeredAt: new Date() },
    ],
  });

  const { candidates } = await get(`/organizations/${orgId}/bills/${bill.billId}/ask-candidates`, owner.token);
  assert.equal(candidates[0].userId, helpful.userId, 'being asked a lot is not the same as being useful');
  assert.equal(candidates[0].answered, 1);
});

test('a question is visible to both sides, and only the person asked can answer', async () => {
  const owner = await register('q-owner');
  const org = await post('/organizations', { organizationName: 'Q Org' }, owner.token);
  const orgId = org.organizationId as string;
  const helper = await register('q-helper');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: helper.userId, role: 'admin', status: 'active' },
  });
  const bill = await uploadAndConfirm(orgId, owner.token, {
    vendor: 'Q Vendor', amount: 300, invoiceNo: 'Q-1', billTo: 'Halcyon Labs, Inc.',
  });

  const asked = await post(`/organizations/${orgId}/bills/${bill.billId}/ask`, {
    askedOfUserId: helper.userId, question: 'Can you confirm the vendor details?', aboutFlag: 'addressed_elsewhere',
  }, owner.token);

  // The asker sees it as outstanding; the person asked sees it as theirs.
  const asAsker = await get(`/organizations/${orgId}/bills/${bill.billId}/review`, owner.token);
  assert.equal(asAsker.questions.length, 1, 'the asker can see what they asked');
  assert.equal(asAsker.questions[0].youAsked, true);
  assert.equal(asAsker.questions[0].youWereAsked, false);

  const asHelper = await get(`/organizations/${orgId}/bills/${bill.billId}/review`, helper.token);
  assert.equal(asHelper.questions[0].youWereAsked, true, 'the person asked is told it is theirs');

  // The asker cannot answer on their behalf — that is not what anyone is waiting for.
  await assert.rejects(
    () => post(`/organizations/${orgId}/bills/${bill.billId}/questions/${asked.billQuestionId}/answer`, { answer: 'sure' }, owner.token),
    /403/,
  );

  const after = await post(`/organizations/${orgId}/bills/${bill.billId}/questions/${asked.billQuestionId}/answer`,
    { answer: 'Yes, checked against their portal.', outcome: 'answered' }, helper.token);
  assert.equal(after.questions[0].answer, 'Yes, checked against their portal.');
  assert.ok(after.questions[0].answeredAt, 'and it is marked answered');
  assert.equal(after.questions[0].stillOpen, false);
});

test('"I don\'t know" is a reply, not a resolution', async () => {
  // The failure this exists to stop: a non-answer closed the question, the
  // fields the asker wanted checked went back to normal, and the record said
  // it was resolved. Worse than never asking — it manufactures confidence.
  const owner = await register('hb-owner');
  const org = await post('/organizations', { organizationName: 'HB Org' }, owner.token);
  const orgId = org.organizationId as string;
  const helper = await register('hb-helper');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: helper.userId, role: 'admin', status: 'active' },
  });
  const bill = await uploadAndConfirm(orgId, owner.token, {
    vendor: 'HB Vendor', amount: 210, invoiceNo: 'HB-1', billTo: 'Halcyon Labs, Inc.',
  });
  const asked = await post(`/organizations/${orgId}/bills/${bill.billId}/ask`, {
    askedOfUserId: helper.userId, question: 'Can you confirm the vendor address?', aboutFlag: 'addressed_elsewhere',
  }, owner.token);

  const after = await post(`/organizations/${orgId}/bills/${bill.billId}/questions/${asked.billQuestionId}/answer`,
    { answer: "I don't know man, it's all you.", outcome: 'handed_back' }, helper.token);

  const q = after.questions[0];
  assert.equal(q.outcome, 'handed_back');
  assert.equal(q.stillOpen, true, 'it comes back to the asker as unresolved, not settled');
  assert.equal(q.answer, "I don't know man, it's all you.", 'the reply is still kept — it tells them who to ask next');
});

test('the asker\'s confirmed fields are what get highlighted, not the suggestion', async () => {
  const owner = await register('cf-owner');
  const org = await post('/organizations', { organizationName: 'CF Org' }, owner.token);
  const orgId = org.organizationId as string;
  const helper = await register('cf-helper');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: helper.userId, role: 'admin', status: 'active' },
  });
  const bill = await uploadAndConfirm(orgId, owner.token, {
    vendor: 'CF Vendor', amount: 410, invoiceNo: 'CF-1', billTo: 'Halcyon Labs, Inc.',
  });

  // The asker unticked everything except Street. That decision must win over
  // whatever the model proposed — a suggestion the human edited and a
  // suggestion nobody saw are not the same thing.
  const asked = await post(`/organizations/${orgId}/bills/${bill.billId}/ask`, {
    askedOfUserId: helper.userId,
    question: 'Can you confirm the vendor details?',
    highlightFields: ['remitTo.street'],
  }, owner.token);

  const stored = await prisma.billQuestion.findUniqueOrThrow({ where: { billQuestionId: asked.billQuestionId } });
  assert.deepEqual(stored.highlightFields, ['remitTo.street']);
});

test('a field the review screen cannot render is never highlighted', async () => {
  // The closed vocabulary holds even when the list comes from a client rather
  // than the model — otherwise the guarantee is only as good as the caller.
  const owner = await register('cf2-owner');
  const org = await post('/organizations', { organizationName: 'CF Two' }, owner.token);
  const orgId = org.organizationId as string;
  const helper = await register('cf2-helper');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: helper.userId, role: 'admin', status: 'active' },
  });
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'V', amount: 90, invoiceNo: 'CF2-1', billTo: 'CF Two' });

  const asked = await post(`/organizations/${orgId}/bills/${bill.billId}/ask`, {
    askedOfUserId: helper.userId,
    question: 'check this',
    highlightFields: ['remitTo.city', 'totally.made.up', 'DROP TABLE'],
  }, owner.token);

  const stored = await prisma.billQuestion.findUniqueOrThrow({ where: { billQuestionId: asked.billQuestionId } });
  assert.deepEqual(stored.highlightFields, ['remitTo.city'], 'invented keys are dropped, not stored');
});

test('a partial answer keeps only the unanswered fields open', async () => {
  const owner = await register('pa-owner');
  const org = await post('/organizations', { organizationName: 'PA Org' }, owner.token);
  const orgId = org.organizationId as string;
  const helper = await register('pa-helper');
  await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: helper.userId, role: 'admin', status: 'active' },
  });
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'PA', amount: 120, invoiceNo: 'PA-1', billTo: 'PA Org' });

  const asked = await post(`/organizations/${orgId}/bills/${bill.billId}/ask`, {
    askedOfUserId: helper.userId, question: 'Confirm the vendor address',
    highlightFields: ['remitTo.street', 'remitTo.city', 'remitTo.state', 'remitTo.zip'],
  }, owner.token);

  // Knows the street and city, not the rest. That must not be thrown away, and
  // must not look like the whole thing was answered.
  const after = await post(`/organizations/${orgId}/bills/${bill.billId}/questions/${asked.billQuestionId}/answer`, {
    answer: 'Street and city are right, no idea on the rest.',
    outcome: 'partial',
    resolvedFields: ['remitTo.street', 'remitTo.city'],
  }, helper.token);

  const q = after.questions[0];
  assert.equal(q.outcome, 'partial');
  assert.equal(q.stillOpen, true, 'the bill does not move on a half-answer');
  assert.deepEqual(q.openFields, ['remitTo.state', 'remitTo.zip'], 'only what is left stays highlighted');
});

test('forwarding raises a linked question carrying only what is outstanding', async () => {
  const owner = await register('fw-owner');
  const org = await post('/organizations', { organizationName: 'FW Org' }, owner.token);
  const orgId = org.organizationId as string;
  const b = await register('fw-b');
  const c = await register('fw-c');
  for (const u of [b, c]) {
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, userId: u.userId, role: 'admin', status: 'active' },
    });
  }
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'FW', amount: 130, invoiceNo: 'FW-1', billTo: 'FW Org' });

  const asked = await post(`/organizations/${orgId}/bills/${bill.billId}/ask`, {
    askedOfUserId: b.userId, question: 'Confirm the vendor address',
    highlightFields: ['remitTo.street', 'remitTo.city', 'remitTo.state'],
  }, owner.token);

  // B knows the street, and knows C knows the rest.
  await post(`/organizations/${orgId}/bills/${bill.billId}/questions/${asked.billQuestionId}/answer`, {
    answer: 'Street is right. Procurement owns the rest — passing to them.',
    outcome: 'forwarded',
    resolvedFields: ['remitTo.street'],
    forwardTo: { userId: c.userId, question: 'Can you confirm the city and state on this vendor?' },
  }, b.token);

  const asC = await get(`/organizations/${orgId}/bills/${bill.billId}/review`, c.token);
  const mine = asC.questions.find((q: any) => q.youWereAsked);
  assert.ok(mine, 'C is now the one being asked');
  assert.deepEqual(mine.openFields, ['remitTo.city', 'remitTo.state'],
    'C is not asked to redo the street B already settled');
  assert.ok(mine.forwardedFromQuestionId, 'and the chain is linked, not orphaned');
});

test('a field edit is recorded with who, when, and what it was before', async () => {
  const owner = await register('fc-owner');
  const org = await post('/organizations', { organizationName: 'FC Org' }, owner.token);
  const orgId = org.organizationId as string;
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'FC', amount: 500, invoiceNo: 'FC-1', billTo: 'FC Org' });

  const edit = await fetch(`${baseUrl}/organizations/${orgId}/bills/${bill.billId}/facts`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ poNumber: 'PO-77' }),
  });
  assert.ok(edit.ok, `edit failed: ${edit.status} ${await edit.text()}`);

  const changes = await prisma.billFieldChange.findMany({ where: { paymentOrderId: bill.billId } });
  const po = changes.find((c) => c.fieldKey === 'poNumber');
  assert.ok(po, 'the change is queryable on its own, not buried in the bill');
  assert.equal(po.newValue, 'PO-77');
  assert.equal(po.changedByUserId, owner.userId, 'and it says who');
  assert.ok(po.changedAt, 'and when — which the old jsonb trail never recorded');
});

test('the audit trail never blocks a correction', async () => {
  // An audit write must not be the reason someone cannot fix a bill. The trail
  // is valuable; the edit is essential.
  const owner = await register('fc2-owner');
  const org = await post('/organizations', { organizationName: 'FC Two' }, owner.token);
  const orgId = org.organizationId as string;
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'FC2', amount: 300, invoiceNo: 'FC2-1', billTo: 'FC Two' });

  const res = await fetch(`${baseUrl}/organizations/${orgId}/bills/${bill.billId}/facts`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ terms: 'Net 45' }),
  });
  assert.ok(res.ok, 'the edit succeeds regardless of what the audit write did');
});

test('an audit row cannot be edited or deleted, even by us', async () => {
  // Enforced by a trigger, not by grants: REVOKE does not stop a table's owner,
  // and the application connects as the owner. A trigger fires for everyone,
  // including a bug in our own code.
  const owner = await register('im-owner');
  const org = await post('/organizations', { organizationName: 'IM Org' }, owner.token);
  const orgId = org.organizationId as string;
  const bill = await uploadAndConfirm(orgId, owner.token, { vendor: 'IM', amount: 400, invoiceNo: 'IM-1', billTo: 'IM Org' });
  await fetch(`${baseUrl}/organizations/${orgId}/bills/${bill.billId}/facts`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ terms: 'Net 60' }),
  });
  const row = await prisma.billFieldChange.findFirstOrThrow({ where: { paymentOrderId: bill.billId } });

  await assert.rejects(
    () => prisma.$executeRaw`UPDATE bill_field_changes SET new_value = 'tampered' WHERE bill_field_change_id = ${row.billFieldChangeId}::uuid`,
    /append-only/,
  );
  await assert.rejects(
    () => prisma.$executeRaw`DELETE FROM bill_field_changes WHERE bill_field_change_id = ${row.billFieldChangeId}::uuid`,
    /append-only/,
  );
});
