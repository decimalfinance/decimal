import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncPaymentToQuickBooks } from '../src/accounting/sync.js';

// Pure unit tests for the QBO push. A fake client records the payloads so we can
// assert what Decimal actually sends to QuickBooks — no live sandbox, no DB.
function fakeQb() {
  const calls: { vendor: any; bill: any; billPayment: any } = { vendor: null, bill: null, billPayment: null };
  const qb: any = {
    query: async () => ({ QueryResponse: { Vendor: [] } }), // no existing vendor -> force create
    createVendor: async (body: any) => { calls.vendor = body; return { Vendor: { Id: 'V1' } }; },
    createBill: async (body: any) => { calls.bill = body; return { Bill: { Id: 'B1' } }; },
    createBillPayment: async (body: any) => { calls.billPayment = body; return { BillPayment: { Id: 'P1' } }; },
    readEntity: async () => ({ Bill: { Balance: 0 } }),
  };
  return { qb, calls };
}
const ACCOUNTS = { clearingAccountId: 'C1', defaultExpenseAccountId: 'E1' };
const NL = String.fromCharCode(10); // newline without a source-level escape
const TAB = String.fromCharCode(9);

test('amount is rounded to 2 decimals consistently across bill + payment (QBO ledger is 2dp)', async () => {
  const { qb, calls } = fakeQb();
  await syncPaymentToQuickBooks(qb, { id: 'decimal_x', vendorLabel: 'Acme', amountUsdc: 12345.678901 }, ACCOUNTS);
  assert.equal(calls.bill.Line[0].Amount, 12345.68);
  assert.equal(calls.billPayment.TotalAmt, 12345.68);
  assert.equal(calls.billPayment.Line[0].Amount, 12345.68);
  // identical amounts are what guarantee the bill nets to zero
  assert.equal(calls.bill.Line[0].Amount, calls.billPayment.TotalAmt);
  assert.equal(calls.billPayment.TotalAmt, calls.billPayment.Line[0].Amount);
});

test('a clean 2-decimal amount passes through unchanged (no regression)', async () => {
  const { qb, calls } = fakeQb();
  await syncPaymentToQuickBooks(qb, { id: 'd', vendorLabel: 'Acme', amountUsdc: 100.5 }, ACCOUNTS);
  assert.equal(calls.bill.Line[0].Amount, 100.5);
  assert.equal(calls.billPayment.TotalAmt, 100.5);
});

test('vendor DisplayName is sanitized: control chars -> space, trimmed, clamped to 100', async () => {
  const { qb, calls } = fakeQb();
  const messy = '  Acme' + NL + TAB + 'Corp ' + 'x'.repeat(200);
  await syncPaymentToQuickBooks(qb, { id: 'd', vendorLabel: messy, amountUsdc: 100 }, ACCOUNTS);
  const name: string = calls.vendor.DisplayName;
  const hasControl = Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  assert.equal(hasControl, false, 'no control chars survive');
  assert.equal(name, name.trim(), 'leading/trailing whitespace trimmed');
  assert.ok(name.length <= 100, `clamped to <=100, got ${name.length}`);
  assert.ok(name.startsWith('Acme Corp'), `control chars became a single space, got "${name.slice(0, 20)}"`);
});
