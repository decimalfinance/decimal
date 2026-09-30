// QuickBooks, in two moments: the bill is posted when it is APPROVED (the
// books learn the money is owed), the payment is recorded against it when it is
// PAID. Categories come from what a person confirmed in review.
//
// QuickBooks is a fake that records every call, so these assert exactly what
// Decimal would send.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';
import { setQuickBooksForTests } from '../src/accounting/connections.js';
import { syncApprovedBill, syncSettledPaymentOrder, sweepUnsyncedSettledOrders } from '../src/accounting/account-sync.js';
import { raw, post, get, makeWorld, confirmBody } from './helpers/companion-harness.js';

beforeEach(() => setQuickBooksForTests(null));

type Chart = Array<{ Id: string; Name: string }>;
const CLOUD: Chart = [{ Id: '301', Name: 'Cloud hosting & infrastructure' }, { Id: '302', Name: 'Travel' }];

function fakeQuickBooks(initial: Chart = CLOUD) {
  const state = { chart: initial, failBill: null as string | null };
  const calls = { bills: [] as Array<{ body: any; requestId: string }>, payments: [] as Array<{ body: any; requestId: string }>, vendors: [] as any[] };
  const qb: any = {
    query: async (q: string) => q.includes('FROM Account')
      ? { QueryResponse: { Account: state.chart.map((a) => ({ ...a, FullyQualifiedName: a.Name, Classification: 'Expense', AccountType: 'Expense' })) } }
      : { QueryResponse: { Vendor: calls.vendors.length ? [{ Id: 'V1' }] : [] } },
    createVendor: async (body: any) => { calls.vendors.push(body); return { Vendor: { Id: 'V1' } }; },
    createBill: async (body: any, requestId: string) => {
      if (state.failBill) throw new Error(state.failBill);
      calls.bills.push({ body, requestId });
      return { Bill: { Id: `B${calls.bills.length}` } };
    },
    createBillPayment: async (body: any, requestId: string) => { calls.payments.push({ body, requestId }); return { BillPayment: { Id: `P${calls.payments.length}` } }; },
    readEntity: async () => ({ Bill: { Balance: calls.payments.length ? 0 : 700 } }),
  };
  setQuickBooksForTests(() => qb);
  return { state, calls };
}

async function connect(orgId: string) {
  const far = new Date(Date.now() + 86_400_000);
  await prisma.accountingConnection.create({ data: { organizationId: orgId, realmId: 'realm-test', accessToken: 'x', refreshToken: 'y', accessTokenExpiresAt: far, refreshTokenExpiresAt: far } });
  await prisma.accountingAccountMap.create({ data: { organizationId: orgId, clearingAccountId: '901', clearingAccountName: 'USDC clearing' } });
}

/** Approve the submitted bill as the approver it waits on; the post runs in the background. */
async function approve(w: Awaited<ReturnType<typeof makeWorld>>) {
  const inbox = await get(`/organizations/${w.orgId}/bills/approvals-inbox`, w.apprA.token);
  const mine = (inbox.waitingOnYou as Array<{ paymentOrderId: string; taskId: string }>).find((x) => x.paymentOrderId === w.bills.submitted)!;
  await post(`/organizations/${w.orgId}/approvals/tasks/${mine.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, w.apprA.token);
  await drainAsyncIntake();
}

const syncOf = (billId: string) => prisma.accountingSync.findUnique({ where: { paymentOrderId_provider: { paymentOrderId: billId, provider: 'quickbooks' } } });

test('quickbooks: approving a bill posts it, with a line per confirmed category — and no payment', async () => {
  const w = await makeWorld();
  const { calls } = fakeQuickBooks();
  await connect(w.orgId);
  await approve(w);

  assert.equal(calls.bills.length, 1, 'one bill');
  const bill = calls.bills[0]!;
  assert.equal(bill.requestId, `decimal_${w.bills.submitted}_bill`, 'idempotent through the requestid');
  assert.deepEqual(bill.body.Line.map((l: any) => [l.Amount, l.AccountBasedExpenseLineDetail.AccountRef.value]), [[700, '301']],
    'the category confirmed in review, matched to its QuickBooks account (it was recorded against the standard list, before QuickBooks)');
  assert.equal(bill.body.DocNumber, 'SC-1');
  assert.equal(calls.payments.length, 0, 'nothing is paid, so no payment is recorded');
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.status, 'synced');
  assert.equal(sync?.externalBillId, 'B1');
  assert.equal(sync?.externalBillPaymentId, null);

  // Again, and through the sweep: still one bill.
  assert.equal(await syncApprovedBill(w.bills.submitted), 'skipped');
  await sweepUnsyncedSettledOrders();
  assert.equal(calls.bills.length, 1, 'never a second bill');
});

test('quickbooks: nothing is posted before approval, and an organisation without QuickBooks leaves no trace', async () => {
  const w = await makeWorld();
  const { calls } = fakeQuickBooks();
  await connect(w.orgId);
  for (const id of [w.bills.ready, w.bills.lonely, w.bills.submitted]) {
    assert.equal(await syncApprovedBill(id), 'skipped', 'a draft, or a bill still in approval, is not posted');
  }
  await sweepUnsyncedSettledOrders();
  assert.equal(calls.bills.length, 0);

  const other = await makeWorld('No Books Ltd');
  setQuickBooksForTests(() => null);
  await approve(other);
  assert.equal(await prisma.accountingSync.count({ where: { organizationId: other.orgId } }), 0, 'not connected is not an error');
});

test('quickbooks: when the bill is paid, the payment is recorded against the bill posted at approval', async () => {
  const w = await makeWorld();
  const { calls } = fakeQuickBooks();
  await connect(w.orgId);
  await approve(w);
  await prisma.paymentOrder.update({ where: { paymentOrderId: w.bills.submitted }, data: { state: 'settled' } });
  assert.equal(await syncSettledPaymentOrder(w.bills.submitted), 'synced');
  assert.equal(calls.bills.length, 1, 'no second bill');
  assert.equal(calls.payments.length, 1);
  const pmt = calls.payments[0]!;
  assert.deepEqual(pmt.body.Line[0].LinkedTxn, [{ TxnId: 'B1', TxnType: 'Bill' }], 'against the approved bill');
  assert.equal(pmt.body.CheckPayment.BankAccountRef.value, '901', 'from the clearing account');
  assert.equal(pmt.body.TotalAmt, 700);
  assert.equal((await syncOf(w.bills.submitted))?.externalBillPaymentId, 'P1');
  assert.equal(await syncSettledPaymentOrder(w.bills.submitted), 'skipped', 'and only once');
});

test('quickbooks: a category missing from the chart fails loudly, lands in the right inbox, and a retry after fixing the chart goes through', async () => {
  const w = await makeWorld();
  const qb = fakeQuickBooks([{ Id: '302', Name: 'Travel' }]);
  await connect(w.orgId);
  await approve(w);
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.status, 'error');
  assert.match(sync?.error ?? '', /"Cloud hosting & infrastructure" is not in your QuickBooks chart/);
  assert.equal(qb.calls.bills.length, 0, 'nothing half-posted');

  const ownerBox = await get(`/organizations/${w.orgId}/inbox`, w.owner.token);
  const line = ownerBox.items.find((i: { billId: string }) => i.billId === w.bills.submitted)?.lines.find((l: { kind: string }) => l.kind === 'sync_failed');
  assert.match(line?.text ?? '', /^Couldn't post to QuickBooks: /, 'whoever manages accounting is told');
  const approverBox = await get(`/organizations/${w.orgId}/inbox`, w.apprA.token);
  assert.equal(JSON.stringify(approverBox).includes('sync_failed'), false, 'an approver is not');

  // Someone adds the account in QuickBooks, then retries.
  qb.state.chart = CLOUD;
  const retried = await post(`/organizations/${w.orgId}/payment-orders/${w.bills.submitted}/accounting/sync`, {}, w.owner.token);
  assert.equal(retried.outcome, 'synced');
  assert.equal(qb.calls.bills[0]!.body.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, '301');
  const after = await get(`/organizations/${w.orgId}/inbox`, w.owner.token);
  assert.equal(JSON.stringify(after).includes('sync_failed'), false, 'the inbox line clears itself');
});

test('quickbooks: when QuickBooks refuses, it retries in the background — and stops after five tries', async () => {
  const w = await makeWorld();
  const qb = fakeQuickBooks();
  qb.state.failBill = 'QuickBooks is unavailable';
  await connect(w.orgId);
  await approve(w);
  assert.equal((await syncOf(w.bills.submitted))?.attempts, 1);
  await sweepUnsyncedSettledOrders();
  assert.equal((await syncOf(w.bills.submitted))?.attempts, 2, 'the sweep retries');
  await prisma.accountingSync.update({ where: { paymentOrderId_provider: { paymentOrderId: w.bills.submitted, provider: 'quickbooks' } }, data: { attempts: 5 } });
  await sweepUnsyncedSettledOrders();
  assert.equal((await syncOf(w.bills.submitted))?.attempts, 5, 'gives up after five; a person can still retry');
  qb.state.failBill = null;
  assert.equal((await post(`/organizations/${w.orgId}/payment-orders/${w.bills.submitted}/accounting/sync`, {}, w.owner.token)).outcome, 'synced');
});

test('quickbooks: confirming a bill records its categories as the bill\'s coding, which vendor habits learn from', async () => {
  const w = await makeWorld();
  fakeQuickBooks();
  await post(`/organizations/${w.orgId}/bills/${w.bills.ready}/confirm`, confirmBody('SS-2', 310), w.owner.token);
  const coding = await prisma.paymentOrderGlCoding.findUniqueOrThrow({ where: { paymentOrderId: w.bills.ready } });
  assert.deepEqual((coding.lines as Array<{ accountId: string; accountName: string; amount: number }>).map((l) => [l.accountId, l.accountName, l.amount]),
    [['301', 'Cloud hosting & infrastructure', 310]]);
  assert.equal(coding.acceptedByUserId, w.owner.userId, 'recorded as the person who confirmed it');
});

test('quickbooks: the Coding inbox is gone, and its old address lands on the Inbox', async () => {
  const w = await makeWorld();
  for (const [method, path] of [
    ['GET', `/organizations/${w.orgId}/accounting/quickbooks/coding-inbox`],
    ['POST', `/organizations/${w.orgId}/accounting/quickbooks/sync-coded`],
    ['POST', `/organizations/${w.orgId}/payment-orders/${w.bills.ready}/gl-coding`],
  ] as const) {
    assert.equal((await raw(method, path, w.owner.token, method === 'GET' ? undefined : {})).status, 404, `${method} ${path} no longer exists`);
  }
  const summary = await get(`/organizations/${w.orgId}/summary`, w.owner.token);
  assert.equal('codingInboxCount' in summary, false);
});
