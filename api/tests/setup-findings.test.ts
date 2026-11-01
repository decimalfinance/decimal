// What the study works out by code, from records already in the shared shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minorToText, type BooksAccount, type BooksBill, type BooksCompany, type BooksExpense, type BooksLine, type BooksVendor } from '../src/integrations/books.js';
import { cleanName, companyProblems, computeFindings, type StudyInput } from '../src/integrations/setup/findings.js';

const COMPANY: BooksCompany = {
  id: 'realm-1', name: 'Larkspur Freight', country: 'US', homeCurrency: 'USD', plan: 'QuickBooks Online Plus', subscriptionStatus: 'SUBSCRIBED',
  fiscalYearStartMonth: 'January', industry: null, closingDate: null, multiCurrency: false, salesTax: false, accountNumbers: false, classes: 'off', locations: false, locationLabel: null,
};

const account = (id: string, name: string, over: Partial<BooksAccount> = {}): BooksAccount => ({
  id, name, fullName: name, number: null, type: 'Expense', subType: null, group: 'Expense', parentId: null, currency: 'USD', active: true, ...over,
});

const vendor = (id: string, name: string, over: Partial<BooksVendor> = {}): BooksVendor => ({
  id, name, company: null, email: null, phone: null, address: null, accountNumber: null, currency: 'USD', balanceMinor: null, termsId: null, active: true, createdAt: null, updatedAt: null, ...over,
});

const line = (accountId: string, amountMinor: bigint, description: string | null = null, over: Partial<BooksLine> = {}): BooksLine => ({
  amountMinor, description, kind: 'account', accountId, accountName: null, itemId: null, itemName: null, classId: null, className: null, customerId: null, taxCode: null, ...over,
});

let nextId = 1;
const bill = (vendorId: string | null, lines: BooksLine[], over: Partial<BooksBill> = {}): BooksBill => ({
  id: String(nextId++), number: null, vendorId, vendorName: null, date: '2026-03-01', dueDate: null, currency: 'USD',
  totalMinor: lines.reduce((n, l) => n + l.amountMinor, 0n), balanceMinor: 0n, taxMinor: null, payableAccountId: null, termsId: null, locationId: null, locationName: null, note: null,
  lines, createdAt: null, updatedAt: null, ...over,
});

const expense = (payeeId: string | null, lines: BooksLine[], over: Partial<BooksExpense> = {}): BooksExpense => ({
  id: String(nextId++), number: null, payeeId, payeeName: null, payeeType: 'Vendor', date: '2026-03-02', currency: 'USD',
  totalMinor: lines.reduce((n, l) => n + l.amountMinor, 0n), taxMinor: null, paymentType: 'CreditCard', paidFromAccountId: '41', paidFromAccountName: 'Amex', refund: false,
  locationId: null, locationName: null, note: null, lines, createdAt: null, updatedAt: null, ...over,
});

const read = <T>(records: T[], missing = 0) => ({ records, expected: records.length + missing, missing, problems: [] as string[] });

function study(over: Partial<StudyInput> = {}) {
  return computeFindings({
    company: COMPANY, since: '2024-11-01',
    accounts: read([account('7', 'Freight'), account('8', 'Travel'), account('9', 'Old stuff', { active: false })]),
    vendors: read([]),
    bills: read([]),
    expenses: read([]),
    ...over,
  });
}

test('findings: an empty company is a plain empty result', () => {
  const f = study({ accounts: read([]) });
  assert.deepEqual(f.counts, { accounts: 0, activeAccounts: 0, vendors: 0, activeVendors: 0, bills: 0, expenses: 0, billsUnpaid: 0 });
  assert.deepEqual(f.totals, { bills: '0.00 USD', expenses: '0.00 USD', unpaid: '0.00 USD' });
  assert.deepEqual(f.window, { since: '2024-11-01', firstBill: null, lastBill: null });
  assert.deepEqual([f.lookalikeVendors, f.codedTwoWays, f.cantPost, f.shortfalls, f.accountsBillsUse, f.busiestVendors], [[], [], [], [], [], []]);
  assert.equal(JSON.parse(JSON.stringify(f)).counts.bills, 0, 'safe to store');
});

test('findings: counts and totals are made here, in the home currency, with refunds taken off', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta'), vendor('2', 'Gone Ltd', { active: false })]),
    bills: read([
      bill('1', [line('7', 100_00n)], { date: '2026-01-15', balanceMinor: 100_00n }),
      bill('1', [line('7', 250_50n)], { date: '2025-06-01' }),
      bill('1', [line('7', 999_00n)], { currency: 'EUR', date: '2026-02-01', balanceMinor: 999_00n }),
    ]),
    expenses: read([expense('1', [line('8', 40_00n)]), expense('1', [line('8', 5_00n)], { refund: true })]),
  });
  assert.equal(f.counts.bills, 3);
  assert.equal(f.counts.billsUnpaid, 2);
  assert.equal(f.counts.activeVendors, 1);
  assert.equal(f.counts.activeAccounts, 2);
  assert.equal(f.totals.bills, '350.50 USD', 'the euro bill is not added to dollars');
  assert.equal(f.totals.unpaid, '100.00 USD');
  assert.equal(f.totals.expenses, '35.00 USD');
  assert.deepEqual(f.window, { since: '2024-11-01', firstBill: '2025-06-01', lastBill: '2026-02-01' });
  assert.deepEqual(f.busiestVendors, [{ id: '1', name: 'Delta', bills: 3, expenses: 2, total: '385.50 USD' }]);
  assert.deepEqual(f.accountsBillsUse, [{ id: '7', name: 'Freight', lines: 3 }]);
});

test('findings: figures show exactly, in any currency', () => {
  assert.equal(minorToText(108007n, 'USD'), '1,080.07 USD');
  assert.equal(minorToText(7n, 'USD'), '0.07 USD');
  assert.equal(minorToText(-1250n, 'USD'), '-12.50 USD');
  assert.equal(minorToText(123456789n, 'JPY'), '123,456,789 JPY');
  assert.equal(minorToText(1234n, 'KWD'), '1.234 KWD');
});

test('findings: a name is compared without its case, punctuation or legal form', () => {
  assert.equal(cleanName('The Delta, LLC'), 'delta');
  assert.equal(cleanName('DELTA INC.'), 'delta');
  assert.equal(cleanName("O'Brien & Sons Ltd"), 'obrien and sons');
  assert.equal(cleanName('The Company'), 'the company', 'a name that is all filler keeps its words');
});

test('findings: look-alike vendors are caught by name, inbox and close spelling, and two stores stay two stores', () => {
  const vendors = [
    vendor('1', 'Delta Freight, Inc.'),
    vendor('2', 'DELTA FREIGHT'),
    vendor('3', 'Blue Oak Logistics', { email: 'AP@blueoak.example' }),
    vendor('4', 'BOL Shipping', { email: 'ap@blueoak.example' }),
    vendor('5', 'Northwind Traders'),
    vendor('6', 'Northwnd Traders'),
    vendor('7', 'Store 12'),
    vendor('8', 'Store 13'),
    vendor('9', 'Acme'),
    vendor('10', 'Apex'),
    vendor('11', 'Unrelated Partners'),
  ];
  const f = study({ vendors: read(vendors), bills: read([bill('1', [line('7', 1n)]), bill('1', [line('7', 1n)]), bill('2', [line('7', 1n)])]) });
  const groups = f.lookalikeVendors.map((g) => [g.why, g.vendors.map((v) => v.id)]);
  assert.deepEqual(groups, [
    ['same_name', ['1', '2']],
    ['same_email', ['3', '4']],
    ['similar_name', ['5', '6']],
  ], 'most used first');
  assert.deepEqual(f.lookalikeVendors[0]!.vendors[0], { id: '1', name: 'Delta Freight, Inc.', active: true, bills: 2, expenses: 0, lastUsed: '2026-03-01' });
});

test('findings: look-alikes nobody uses are left out, and three of a kind are one group', () => {
  const f = study({ vendors: read([
    vendor('1', 'Dusty Co', { active: false }),
    vendor('2', 'Dusty Company', { active: false }),
    vendor('3', 'Triple'),
    vendor('4', 'Triple Inc'),
    vendor('5', 'TRIPLE LLC'),
  ]) });
  assert.deepEqual(f.lookalikeVendors.map((g) => g.vendors.map((v) => v.id).sort()), [['3', '4', '5']]);
});

test('findings: a vendor coded two ways is found per line, and a slip is not two ways', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta'), vendor('2', 'Steady')]),
    bills: read([
      bill('1', [line('7', 1n, 'Ocean freight')], { date: '2026-01-01' }),
      bill('1', [line('7', 1n, 'OCEAN FREIGHT.')], { date: '2026-02-01' }),
      bill('1', [line('8', 1n, 'Ocean freight')], { date: '2026-03-01' }),
      bill('1', [line('8', 1n, 'Ocean freight')], { date: '2026-04-01' }),
      // Steady: nine one way, one slip.
      ...Array.from({ length: 9 }, () => bill('2', [line('7', 1n, 'Storage')])),
      bill('2', [line('8', 1n, 'Storage')]),
      // Delta again: a different line is allowed a different category.
      bill('1', [line('8', 1n, 'Airfare')]),
    ]),
  });
  assert.deepEqual(f.codedTwoWays, [{
    vendorId: '1',
    vendorName: 'Delta',
    line: 'ocean freight',
    accounts: [
      { id: '7', name: 'Freight', lines: 2, lastUsed: '2026-02-01' },
      { id: '8', name: 'Travel', lines: 2, lastUsed: '2026-04-01' },
    ],
  }]);
});

test('findings: only what is repeated and consistent counts as learned, from bills and expenses alike', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta'), vendor('2', 'Steady'), vendor('3', 'Once'), vendor('4', 'Split')]),
    bills: read([
      ...Array.from({ length: 2 }, () => bill('1', [line('8', 1n, 'Airfare')])),
      ...Array.from({ length: 9 }, () => bill('2', [line('7', 1n, 'Storage')])),
      bill('2', [line('8', 1n, 'Storage')]),
      bill('3', [line('7', 1n, 'One off')]),
      bill('4', [line('7', 1n, 'Half')]), bill('4', [line('8', 1n, 'Half')]), bill('4', [line('7', 1n, 'Half')]), bill('4', [line('8', 1n, 'Half')]),
    ]),
    expenses: read([expense('1', [line('8', 1n, 'Airfare')])]),
  });
  assert.deepEqual(f.learned, {
    pairs: 2,
    lines: 13,
    sample: [
      { vendorId: '2', vendorName: 'Steady', line: 'storage', categoryId: '7', accountName: 'Freight', lines: 9 },
      { vendorId: '1', vendorName: 'Delta', line: 'airfare', categoryId: '8', accountName: 'Travel', lines: 3 },
    ],
  });
});

test('findings: a person or customer paid by expense is not a vendor habit', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta')]),
    expenses: read(Array.from({ length: 4 }, () => expense('E9', [line('8', 1n, 'Lunch')], { payeeType: 'Employee' }))),
  });
  assert.equal(f.learned.pairs, 0);
  assert.deepEqual(f.busiestVendors, []);
});

test('findings: what cannot be posted yet is listed with bills to open', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta')]),
    bills: read([
      bill('1', [line('7', 1n)], { id: 'plain' }),
      bill('1', [line('7', 1n, null, { kind: 'item', accountId: null, itemId: '4' })], { id: 'item' }),
      bill('1', [line('7', 1n, null, { classId: '11' })], { id: 'class' }),
      bill('1', [line('7', 1n)], { id: 'where', locationId: '2' }),
      bill('1', [line('7', 1n)], { id: 'euro', currency: 'EUR' }),
      bill('1', [line('7', 1n, null, { customerId: '9' })], { id: 'billable' }),
    ]),
  });
  assert.deepEqual(f.cantPost, [
    { kind: 'item_lines', bills: 1, sampleBillIds: ['item'] },
    { kind: 'classes', bills: 1, sampleBillIds: ['class'] },
    { kind: 'locations', bills: 1, sampleBillIds: ['where'] },
    { kind: 'other_currency', bills: 1, sampleBillIds: ['euro'] },
    { kind: 'billable_to_customer', bills: 1, sampleBillIds: ['billable'] },
  ]);
});

test('findings: a read that came back short is on the list, so it can be told', () => {
  const f = study({ bills: { records: [bill('1', [line('7', 1n)])], expected: 40, missing: 39, problems: ['Bill 2: TotalAmt expected number'] } });
  assert.deepEqual(f.shortfalls, [{ what: 'bills', expected: 40, read: 1, problems: ['Bill 2: TotalAmt expected number'] }]);
});

test('findings: a company that cannot work is named before anyone is asked anything else', () => {
  assert.deepEqual(companyProblems(COMPANY), []);
  assert.deepEqual(companyProblems({ ...COMPANY, homeCurrency: null }), [], 'an unknown currency is not a known problem');
  assert.equal(companyProblems({ ...COMPANY, homeCurrency: 'GBP' })[0]!.code, 'not_usd');
  assert.equal(companyProblems({ ...COMPANY, subscriptionStatus: 'CANCELLED' })[0]!.code, 'subscription');
  assert.deepEqual(companyProblems({ ...COMPANY, subscriptionStatus: 'TRIAL' }), []);
});
