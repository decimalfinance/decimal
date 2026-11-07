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
  assert.deepEqual([f.lookalikeVendors, f.codedTwoWays, f.leftOut, f.shortfalls, f.accountsBillsUse, f.busiestVendors], [[], [], [], [], [], []]);
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
  assert.deepEqual(f.lookalikeVendors[0]!.vendors[0], { id: '1', name: 'Delta Freight, Inc.', active: true, bills: 2, expenses: 0, lastUsed: '2026-03-01', company: null, email: null, phone: null, address: null, accountNumber: null });
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
  assert.deepEqual(f.codedTwoWays, [], 'Delta moved, the other is steady');
  assert.deepEqual(f.movedLines, [{
    vendorId: '1',
    vendorName: 'Delta',
    line: 'freight ocean',
    example: 'Ocean freight',
    from: { id: '7', name: 'Freight' },
    to: { id: '8', name: 'Travel' },
    on: '2026-03-01',
    lines: 4,
  }]);
});

test('findings: a recent move to another category is what they do now, however few lines it has: the newer is learned, and the old one is not', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta')]),
    bills: read([
      ...Array.from({ length: 28 }, (_, i) => bill('1', [line('7', 1n, 'Ocean freight')], { date: `2025-${String((i % 12) + 1).padStart(2, '0')}-01` })),
      bill('1', [line('8', 1n, 'Ocean freight')], { date: '2026-02-01' }),
      bill('1', [line('8', 1n, 'Ocean freight')], { date: '2026-03-01' }),
    ]),
  });
  assert.deepEqual(f.codedTwoWays, []);
  assert.deepEqual(f.movedLines.map((m) => [m.from.id, m.to.id, m.on]), [['7', '8', '2026-02-01']]);
  assert.deepEqual(f.learnedLines.map((l) => [l.line, l.categoryId, l.lines]), [['freight ocean', '8', 2]]);
  assert.equal(f.learned.pairs, 0);
});

test('findings: one odd line at the end is still a slip, and the habit is still learned', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta')]),
    bills: read([
      ...Array.from({ length: 28 }, () => bill('1', [line('7', 1n, 'Ocean freight')], { date: '2025-06-01' })),
      bill('1', [line('8', 1n, 'Ocean freight')], { date: '2026-03-01' }),
    ]),
  });
  assert.deepEqual(f.codedTwoWays, []);
  assert.equal(f.learnedLines[0]?.categoryId, '7');
});

test('findings: vendors sharing a phone, an address or a trading name look alike, and the strongest reason is the one given', () => {
  const f = study({ vendors: read([
    vendor('1', 'Northgate Haulage', { phone: '(555) 201-4477' }),
    vendor('2', 'NGH Transport', { phone: '555.201.4477' }),
    vendor('3', 'Pine Depot', { address: '14 Mill Road, Akron OH' }),
    vendor('4', 'Akron Storage', { address: '14 MILL ROAD AKRON, OH' }),
    vendor('5', 'Blue Harbor LLC'),
    vendor('6', 'J Smith', { company: 'Blue Harbor, Inc.' }),
    vendor('7', 'Short Phone', { phone: '12345' }),
    vendor('8', 'Short Phone Two', { phone: '12345' }),
    vendor('9', 'Rosewood', { email: 'ap@rosewood.test', phone: '555 777 8888' }),
    vendor('10', 'Rosewood Trading', { email: 'AP@rosewood.test', phone: '555-777-8888' }),
  ]) });
  const groups = Object.fromEntries(f.lookalikeVendors.map((g) => [g.vendors.map((v) => v.id).sort().join(','), g.why]));
  assert.equal(groups['1,2'], 'same_phone');
  assert.equal(groups['3,4'], 'same_address');
  assert.equal(groups['5,6'], 'same_name');
  assert.equal(groups['7,8'], undefined, 'too short to mean anything');
  assert.equal(groups['10,9'], 'same_email');
});

test('findings: a look-alike group says what its vendors have in common, and shows the details to weigh', () => {
  const f = study({ vendors: read([
    vendor('1', 'Harbor Fuel', { phone: '555 201 4477', email: 'a@harbor.test' }),
    vendor('2', 'HARBOR FUEL LLC', { phone: '(555) 201-4477', email: 'b@harbor.test' }),
    vendor('3', 'Larkspur Trucking'),
    vendor('4', 'Larkspur Tracking'),
  ]) });
  const byIds = (ids: string) => f.lookalikeVendors.find((g) => g.vendors.map((v) => v.id).sort().join(',') === ids);
  assert.deepEqual(byIds('1,2')?.shared, ['name', 'email domain', 'phone']);
  assert.equal(byIds('1,2')?.differentAccounts, false);
  assert.equal(byIds('1,2')?.vendors.find((v) => v.id === '1')?.email, 'a@harbor.test');
  assert.deepEqual(byIds('3,4')?.shared, [], 'only close spelling, and it says so by saying nothing');
});

test('findings: one business entered three times shows in its details, however they are written: an address, and a domain of its own', () => {
  const f = study({ vendors: read([
    vendor('1', "Tania's Nursery", { email: 'plantqueen@taniasnursery.test', phone: '(886) 554-2265', address: '1111 Elm St., Middlefield, CA, 94482, USA' }),
    vendor('2', 'Tanias Nursery', { phone: '(650) 555-0142', address: '1630 Woodside Road, Redwood City, CA, 94061, USA' }),
    vendor('3', "TANIA'S NURSERY INC", { email: 'accounts@taniasnursery.test', address: '1630 WOODSIDE RD., Redwood City, CA, 94061' }),
    vendor('4', 'Garden Help', { email: 'garden.help@gmail.com' }),
    vendor('5', 'Garden Help LLC', { email: 'gardenhelp.ap@gmail.com' }),
  ]) });
  const byIds = (ids: string) => f.lookalikeVendors.find((g) => g.vendors.map((v) => v.id).sort().join(',') === ids);
  assert.deepEqual(byIds('1,2,3')?.shared, ['name', 'email domain', 'address'], 'Road and Rd., with the country or without, are one address');
  assert.equal(byIds('1,2,3')?.oneBusiness, true, 'the INC record shares the domain with one and the address with the other');
  assert.deepEqual(byIds('4,5')?.shared, ['name'], 'everyone has gmail');
  assert.equal(byIds('4,5')?.oneBusiness, false, 'a name, and two inboxes that differ');
});

test('findings: look-alikes that read as one business are listed first, so "the first one" means the same group in the message and the list', () => {
  const phone = '(212) 555-0100';
  const f = study({
    vendors: read([
      vendor('1', 'Blue Oak Logistics', { email: 'AP@blueoak.example' }),
      vendor('2', 'BOL Shipping', { email: 'ap@blueoak.example' }),
      vendor('3', 'Sterling Office Supply, Inc.', { phone }),
      vendor('4', 'STERLING OFFICE SUPPLY', { phone }),
    ]),
    bills: read([bill('1', [line('7', 1n)]), bill('1', [line('7', 1n)]), bill('2', [line('7', 1n)]), bill('2', [line('7', 1n)]), bill('3', [line('7', 1n)])]),
  });
  assert.deepEqual(
    f.lookalikeVendors.map((g) => [g.vendors.map((v) => v.id).sort(), g.oneBusiness]),
    [[['3', '4'], true], [['1', '2'], false]],
    'one business first, though the other is used more',
  );
});

test('findings: a group reads as one business only on a name and a contact detail together, and never across two account numbers', () => {
  const oneBusiness = (...vendors: BooksVendor[]) => {
    const groups = study({ vendors: read(vendors) }).lookalikeVendors;
    assert.equal(groups.length, 1, vendors.map((v) => v.name).join(' / '));
    return groups[0]!.oneBusiness;
  };
  const phone = '(615) 555-0134';
  assert.equal(oneBusiness(vendor('1', 'Sterling Office Supply, Inc.', { phone }), vendor('2', 'STERLING OFFICE SUPPLY', { phone })), true, 'a name and a phone');
  assert.equal(oneBusiness(vendor('1', 'Midlnad Diesel Service', { phone }), vendor('2', 'Midland Diesel Service', { phone })), true, 'a typo and a phone');
  assert.equal(oneBusiness(vendor('1', 'Delta Freight'), vendor('2', 'DELTA FREIGHT LLC', { phone })), true, 'a name and nothing that differs');
  assert.equal(oneBusiness(vendor('1', 'Ridgeline', { phone, accountNumber: 'RT-1180' }), vendor('2', 'Ridgeline LLC', { phone, accountNumber: 'RTA-2290' })), false, 'two accounts could be two businesses');
  assert.equal(oneBusiness(vendor('1', 'RJ Hauling', { email: 'billing@sunrisebooks.test' }), vendor('2', 'M&M Transport', { email: 'billing@sunrisebooks.test' })), false, 'a bookkeeper they share');
  assert.equal(oneBusiness(vendor('1', 'MJ Mobile Repair', { phone }), vendor('2', 'Mark Johnson', { phone })), false, 'a phone under two names is theirs to say');
  assert.equal(oneBusiness(vendor('1', 'Harbor Fuel', { phone }), vendor('2', 'Harbor Fuel', { phone: '(212) 555-0199' })), false, 'one name and two phones could be two branches');
  assert.equal(oneBusiness(vendor('1', 'Northwind Traders', { phone }), vendor('2', 'Northwnd Traders', { phone: '(212) 555-0199' })), false, 'a close spelling alone proves nothing');
});

test('findings: a kind of line written several ways carries the other wordings, newest first, and a change of case is not one', () => {
  const f = study({
    vendors: read([vendor('1', 'Gridline Power'), vendor('2', 'Delta')]),
    bills: read([
      ...['01', '02'].map((m) => bill('1', [line('7', 1n, 'Electric - Depot 1')], { date: `2026-${m}-01` })),
      ...['03', '04'].map((m) => bill('1', [line('7', 1n, 'Electric - Depot 2')], { date: `2026-${m}-01` })),
      ...['05', '06'].map((m) => bill('1', [line('7', 1n, 'Electric - Depot 3')], { date: `2026-${m}-01` })),
      bill('1', [line('7', 1n, 'ELECTRIC - DEPOT 3.')], { date: '2026-07-01' }),
      ...['01', '02', '03'].map((m) => bill('2', [line('7', 1n, 'Ocean freight')], { date: `2026-${m}-01` })),
      bill('2', [line('7', 1n, 'OCEAN FREIGHT.')], { date: '2026-04-01' }),
    ]),
  });
  const sample = (vendorId: string) => f.learned.sample.find((s) => s.vendorId === vendorId);
  assert.equal(sample('1')?.example, 'ELECTRIC - DEPOT 3.');
  assert.deepEqual(sample('1')?.alsoWritten, ['Electric - Depot 2', 'Electric - Depot 1'], 'seven lines, three depots');
  assert.equal(sample('2')?.alsoWritten, undefined, 'one wording, however it was typed');
});

test('findings: lines with no words are never asked about or said to have moved, because nothing can fill them in', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta'), vendor('2', 'Steady'), vendor('3', 'Control')]),
    bills: read([
      ...['7', '8', '7', '8'].map((c, i) => bill('1', [line(c, 1n, null)], { date: `2026-0${i + 1}-01` })),
      ...['7', '7', '8', '8'].map((c, i) => bill('2', [line(c, 1n, ' ')], { date: `2026-0${i + 1}-01` })),
      ...['7', '8', '7', '8'].map((c, i) => bill('3', [line(c, 1n, 'Ocean freight')], { date: `2026-0${i + 1}-01` })),
    ]),
  });
  assert.deepEqual(f.codedTwoWays.map((c) => c.vendorName), ['Control'], 'the same mix with words is still a question');
  assert.deepEqual(f.movedLines, []);
});

test('findings: two ways still mixed in time have not switched', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta')]),
    bills: read([
      bill('1', [line('7', 1n, 'Ocean freight')], { date: '2026-01-01' }),
      bill('1', [line('8', 1n, 'Ocean freight')], { date: '2026-02-01' }),
      bill('1', [line('7', 1n, 'Ocean freight')], { date: '2026-03-01' }),
      bill('1', [line('8', 1n, 'Ocean freight')], { date: '2026-04-01' }),
    ]),
  });
  assert.deepEqual(f.movedLines, []);
  assert.deepEqual(f.codedTwoWays, [{
    vendorId: '1',
    vendorName: 'Delta',
    line: 'freight ocean',
    example: 'Ocean freight',
    accounts: [
      { id: '7', name: 'Freight', lines: 2, firstUsed: '2026-01-01', lastUsed: '2026-03-01' },
      { id: '8', name: 'Travel', lines: 2, firstUsed: '2026-02-01', lastUsed: '2026-04-01' },
    ],
  }]);
});

test('findings: a line is the same line whatever month, year or quantity it mentions, and the newest wording is kept', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta')]),
    bills: read([
      bill('1', [line('7', 1n, 'Monthly storage (40 pallets) - October 2026')], { date: '2026-10-01', number: 'D-10' }),
      bill('1', [line('7', 1n, 'Monthly storage, Nov 2026')], { date: '2026-11-01', number: 'D-11' }),
      bill('1', [line('7', 1n, 'Monthly storage - Sept')], { date: '2026-09-01', number: 'D-9' }),
    ]),
  });
  assert.deepEqual(f.learnedLines, [{
    vendorId: '1', vendorName: 'Delta', line: 'monthly storage', example: 'Monthly storage, Nov 2026',
    categoryId: '7', categoryName: 'Freight', lines: 3, lastUsed: '2026-11-01', number: 'D-11',
  }]);
});

test('findings: what can fill in a bill needs words to match on, and a category still in use', () => {
  const f = study({
    vendors: read([vendor('1', 'Delta'), vendor('2', 'Steady')]),
    bills: read([
      ...Array.from({ length: 3 }, () => bill('1', [line('8', 1n, null)])),
      ...Array.from({ length: 3 }, () => bill('2', [line('9', 1n, 'Pallets')])),
    ]),
  });
  assert.equal(f.learned.pairs, 2, 'both are habits');
  assert.deepEqual(f.learnedLines, []);
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
      { vendorId: '2', vendorName: 'Steady', line: 'storage', example: 'Storage', categoryId: '7', accountName: 'Freight', lines: 9 },
      { vendorId: '1', vendorName: 'Delta', line: 'airfare', example: 'Airfare', categoryId: '8', accountName: 'Travel', lines: 3 },
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
  assert.deepEqual(f.leftOut, [
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
