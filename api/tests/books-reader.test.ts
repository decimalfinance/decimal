// The QuickBooks reader: what the setup harness holds. No database and no network:
// QuickBooks is a fake that answers the queries the way Intuit documents them.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { setQuickBooksForTests } from '../src/accounting/connections.js';
import { QboError, QuickBooks } from '../src/accounting/quickbooks.js';
import { BooksReadError, toMinor } from '../src/integrations/books.js';
import { quickBooksReader, readerForOrganization } from '../src/integrations/quickbooks-reader.js';

beforeEach(() => setQuickBooksForTests(null));

const PREFERENCES = {
  AccountingInfoPrefs: {
    BookCloseDate: '2026-06-30', UseAccountNumbers: true, TrackDepartments: true, DepartmentTerminology: 'Location',
    ClassTrackingPerTxn: false, ClassTrackingPerTxnLine: true,
  },
  CurrencyPrefs: { MultiCurrencyEnabled: false, HomeCurrency: { value: 'USD' } },
  TaxPrefs: { UsingSalesTax: true },
};

const COMPANY_INFO = {
  CompanyName: 'Larkspur Freight, Inc.', LegalName: 'Larkspur Freight Incorporated', Country: 'US', FiscalYearStartMonth: 'January',
  NameValue: [
    { Name: 'OfferingSku', Value: 'QuickBooks Online Plus' },
    { Name: 'SubscriptionStatus', Value: 'SUBSCRIBED' },
    { Name: 'QBOIndustryType', Value: 'Freight forwarding' },
  ],
};

type Rows = Record<string, unknown[]>;

/** Answers COUNT, paging and the single-row entities, and records every query it was asked. */
function fakeBooks(rows: Rows = {}) {
  const asked: string[] = [];
  const data: Rows = { Preferences: [PREFERENCES], CompanyInfo: [COMPANY_INFO], ...rows };
  return {
    asked,
    realmId: 'realm-1',
    query: async (sql: string) => {
      asked.push(sql);
      const entity = /FROM (\w+)/.exec(sql)![1]!;
      const all = data[entity] ?? [];
      if (sql.includes('COUNT(*)')) return { QueryResponse: { totalCount: all.length }, time: 'now' };
      const start = Number(/STARTPOSITION (\d+)/.exec(sql)?.[1] ?? 1);
      const max = Number(/MAXRESULTS (\d+)/.exec(sql)?.[1] ?? 100);
      const page = all.slice(start - 1, start - 1 + max);
      return { QueryResponse: page.length ? { [entity]: page, startPosition: start, maxResults: page.length } : {}, time: 'now' };
    },
  };
}

const noWait = () => {
  const waits: number[] = [];
  return { waits, wait: async (ms: number) => { waits.push(ms); } };
};

test('books reader: a company reads as one shape, with its plan, currency and what it tracks', async () => {
  const company = await quickBooksReader(fakeBooks()).company();
  assert.deepEqual(company, {
    id: 'realm-1',
    name: 'Larkspur Freight, Inc.',
    country: 'US',
    homeCurrency: 'USD',
    plan: 'QuickBooks Online Plus',
    subscriptionStatus: 'SUBSCRIBED',
    fiscalYearStartMonth: 'January',
    industry: 'Freight forwarding',
    closingDate: '2026-06-30',
    multiCurrency: false,
    salesTax: true,
    accountNumbers: true,
    classes: 'per_line',
    locations: true,
    locationLabel: 'Location',
  });
});

test('books reader: the closing date on its own is one read, the date company() gives', async () => {
  const books = fakeBooks();
  assert.equal(await quickBooksReader(books).closingDate(), '2026-06-30');
  assert.deepEqual(books.asked, ['SELECT * FROM Preferences'], 'company() takes two: a screen waits on this one');
  assert.equal(await quickBooksReader(fakeBooks({ Preferences: [{}], CompanyInfo: [{}] })).closingDate(), null);
});

test('books reader: a company that shares no closing date and tracks nothing says so, not a guess', async () => {
  const books = fakeBooks({ Preferences: [{}], CompanyInfo: [{}] });
  const company = await quickBooksReader(books).company();
  assert.equal(company.closingDate, null);
  assert.equal(company.classes, 'off');
  assert.equal(company.locations, false);
  assert.equal(company.locationLabel, null);
  assert.equal(company.plan, null);
  assert.equal(company.homeCurrency, null, 'an unknown currency is not assumed for the company itself');
});

test('books reader: more than a page is read whole, in pages, and checked against the count', async () => {
  const vendors = Array.from({ length: 2345 }, (_, i) => ({ Id: String(i + 1), DisplayName: `Vendor ${i + 1}`, Active: i % 2 === 0 }));
  const books = fakeBooks({ Vendor: vendors });
  const read = await quickBooksReader(books).vendors();

  assert.equal(read.records.length, 2345);
  assert.equal(read.expected, 2345);
  assert.equal(read.missing, 0);
  assert.deepEqual(read.problems, []);
  assert.equal(new Set(read.records.map((v) => v.id)).size, 2345, 'no record twice');
  assert.equal(read.records.filter((v) => !v.active).length, 1172, 'inactive vendors are read too');
  assert.deepEqual(books.asked.filter((q) => q.includes('FROM Vendor')), [
    'SELECT COUNT(*) FROM Vendor WHERE Active IN (true, false)',
    'SELECT * FROM Vendor WHERE Active IN (true, false) STARTPOSITION 1 MAXRESULTS 1000',
    'SELECT * FROM Vendor WHERE Active IN (true, false) STARTPOSITION 1001 MAXRESULTS 1000',
    'SELECT * FROM Vendor WHERE Active IN (true, false) STARTPOSITION 2001 MAXRESULTS 1000',
  ]);
});

test('books reader: exactly one full page ends cleanly on the empty page after it', async () => {
  const accounts = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i + 1), Name: `Account ${i + 1}` }));
  const read = await quickBooksReader(fakeBooks({ Account: accounts })).accounts();
  assert.equal(read.records.length, 1000);
  assert.equal(read.missing, 0);
});

test('books reader: an empty company is empty, not failed', async () => {
  const reader = quickBooksReader(fakeBooks());
  for (const read of [await reader.accounts(), await reader.vendors(), await reader.bills('2024-11-01'), await reader.expenses('2024-11-01')]) {
    assert.deepEqual(read, { records: [], expected: 0, missing: 0, problems: [] });
  }
});

test('books reader: bills and expenses ask only from the date given, and refuse anything that is not a date', async () => {
  const books = fakeBooks();
  const reader = quickBooksReader(books);
  await reader.bills('2024-11-01');
  await reader.expenses('2024-11-01');
  assert.ok(books.asked.includes(`SELECT COUNT(*) FROM Bill WHERE TxnDate >= '2024-11-01'`));
  assert.ok(books.asked.includes(`SELECT * FROM Bill WHERE TxnDate >= '2024-11-01' STARTPOSITION 1 MAXRESULTS 1000`));
  assert.ok(books.asked.includes(`SELECT COUNT(*) FROM Purchase WHERE TxnDate >= '2024-11-01'`));
  await assert.rejects(reader.bills(`2024' OR '1'='1`), (e: BooksReadError) => e.kind === 'refused');
});

test('books reader: bills like one are asked for by number, and by vendor from a date, quoted, and each comes back once', async () => {
  const row = { Id: '7', DocNumber: 'O\'Brien-1', VendorRef: { value: '5', name: 'Hall' }, TxnDate: '2026-10-01', TotalAmt: 12.5 };
  const books = fakeBooks({ Bill: [row] });
  const reader = quickBooksReader(books);
  const found = await reader.billsLike({ numbers: ['O\'Brien-1', 'OBRIEN1'], vendorIds: ['5'], since: '2026-07-01' });
  assert.ok(books.asked.includes(`SELECT * FROM Bill WHERE DocNumber IN ('O\\'Brien-1', 'OBRIEN1') MAXRESULTS 100`));
  assert.ok(books.asked.includes(`SELECT * FROM Bill WHERE VendorRef IN ('5') AND TxnDate >= '2026-07-01' MAXRESULTS 1000`));
  assert.deepEqual(found.map((b) => [b.id, b.number, b.totalMinor]), [['7', 'O\'Brien-1', 1250n]], 'found both ways, kept once');

  books.asked.length = 0;
  assert.deepEqual(await reader.billsLike({ numbers: [], vendorIds: [], since: '2026-07-01' }), []);
  assert.equal(books.asked.filter((q) => q.includes('FROM Bill')).length, 0, 'nothing to look for, nothing asked');
  await assert.rejects(reader.billsLike({ numbers: [], vendorIds: ['5'], since: '2026\' OR \'1\'=\'1' }), (e: BooksReadError) => e.kind === 'refused');
});

test('books reader: a bill keeps its header, its tax and each line, whichever way the line was coded', async () => {
  const { records: [bill] } = await quickBooksReader(fakeBooks({ Bill: [{
    Id: '145', DocNumber: 'INV-77', VendorRef: { value: '56', name: "O'Brien Freight" }, TxnDate: '2026-03-01', DueDate: '2026-03-31',
    CurrencyRef: { value: 'USD', name: 'United States Dollar' }, TotalAmt: 1080.07, Balance: 80.07, TxnTaxDetail: { TotalTax: 80.07 },
    APAccountRef: { value: '33', name: 'Accounts Payable (A/P)' }, SalesTermRef: { value: '3' }, DepartmentRef: { value: '2', name: 'Chicago' },
    PrivateNote: ' Reissued ', MetaData: { CreateTime: '2026-03-02T10:00:00-08:00', LastUpdatedTime: '2026-03-03T10:00:00-08:00' },
    Line: [
      { Id: '1', Amount: 900, Description: 'Ocean freight', DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: {
        AccountRef: { value: '7', name: 'Freight:Ocean' }, ClassRef: { value: '11', name: 'Imports' }, CustomerRef: { value: '9' }, TaxCodeRef: { value: 'TAX' } } },
      { Id: '2', Amount: 100, Description: '', DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '4', name: 'Pallets' } } },
      { Id: '3', Amount: 0, DetailType: 'SomethingNew' },
    ],
  }] })).bills('2024-11-01');

  assert.equal(bill!.number, 'INV-77');
  assert.equal(bill!.vendorId, '56');
  assert.equal(bill!.vendorName, "O'Brien Freight");
  assert.equal(bill!.dueDate, '2026-03-31');
  assert.equal(bill!.currency, 'USD');
  assert.equal(bill!.totalMinor, 108007n);
  assert.equal(bill!.balanceMinor, 8007n);
  assert.equal(bill!.taxMinor, 8007n);
  assert.equal(bill!.payableAccountId, '33');
  assert.equal(bill!.locationName, 'Chicago');
  assert.equal(bill!.note, 'Reissued');
  assert.equal(bill!.updatedAt, '2026-03-03T10:00:00-08:00');
  assert.deepEqual(bill!.lines, [
    { amountMinor: 90000n, description: 'Ocean freight', kind: 'account', accountId: '7', accountName: 'Freight:Ocean', itemId: null, itemName: null,
      classId: '11', className: 'Imports', customerId: '9', taxCode: 'TAX' },
    { amountMinor: 10000n, description: null, kind: 'item', accountId: null, accountName: null, itemId: '4', itemName: 'Pallets',
      classId: null, className: null, customerId: null, taxCode: null },
    { amountMinor: 0n, description: null, kind: 'other', accountId: null, accountName: null, itemId: null, itemName: null,
      classId: null, className: null, customerId: null, taxCode: null },
  ]);
});

test('books reader: an expense says who was paid, from where, and whether it is a refund', async () => {
  const { records: [paid, back] } = await quickBooksReader(fakeBooks({ Purchase: [
    { Id: '200', TxnDate: '2026-02-02', TotalAmt: 42.5, PaymentType: 'CreditCard', AccountRef: { value: '41', name: 'Amex' },
      EntityRef: { value: '56', name: 'Delta', type: 'Vendor' }, Line: [{ Amount: 42.5, AccountBasedExpenseLineDetail: { AccountRef: { value: '8', name: 'Travel' } } }] },
    { Id: '201', TxnDate: '2026-02-03', TotalAmt: 10, PaymentType: 'CreditCard', AccountRef: { value: '41', name: 'Amex' }, Credit: true },
  ] })).expenses('2024-11-01');

  assert.equal(paid!.payeeName, 'Delta');
  assert.equal(paid!.payeeType, 'Vendor');
  assert.equal(paid!.paidFromAccountName, 'Amex');
  assert.equal(paid!.paymentType, 'CreditCard');
  assert.equal(paid!.totalMinor, 4250n);
  assert.equal(paid!.currency, 'USD', 'a record without a currency is in the home currency');
  assert.equal(paid!.refund, false);
  assert.equal(paid!.lines[0]!.accountId, '8');
  assert.equal(back!.refund, true);
  assert.equal(back!.payeeId, null, 'nobody named is nobody, not a guess');
  assert.deepEqual(back!.lines, []);
});

test('books reader: money is exact minor units, whatever the currency', () => {
  assert.equal(toMinor(0.07, 'USD'), 7n, '0.07 * 100 is 7.000000000000001 in floats');
  assert.equal(toMinor(19.99, 'USD'), 1999n);
  assert.equal(toMinor(1.1, 'USD'), 110n);
  assert.equal(toMinor(4.35, 'USD'), 435n, '4.35 * 100 is 434.99999999999994 in floats');
  assert.equal(toMinor(-12.5, 'USD'), -1250n);
  assert.equal(toMinor(0, 'USD'), 0n);
  assert.equal(toMinor(1000, 'JPY'), 1000n, 'yen has no minor unit');
  assert.equal(toMinor(1.234, 'KWD'), 1234n, 'Kuwaiti dinar has three');
  assert.equal(toMinor(12345678.9, 'USD'), 1234567890n);
  assert.equal(toMinor(5.5, 'not a currency'), 550n);
});

test('books reader: a short read says how much is missing, instead of passing for the whole thing', async () => {
  const books = fakeBooks({ Vendor: [{ Id: '1', DisplayName: 'Only one' }] });
  const query = books.query;
  const reader = quickBooksReader({
    realmId: books.realmId,
    query: async (sql: string) => (sql.includes('COUNT(*) FROM Vendor') ? { QueryResponse: { totalCount: 40 } } : query(sql)),
  });
  const read = await reader.vendors();
  assert.equal(read.records.length, 1);
  assert.equal(read.expected, 40);
  assert.equal(read.missing, 39);
});

test('books reader: a record it cannot read is named and counted as missing, and does not sink the rest', async () => {
  const read = await quickBooksReader(fakeBooks({ Bill: [
    { Id: '1', TotalAmt: 10 },
    { Id: '2', TotalAmt: 'ten dollars' },
    { Id: '3', TotalAmt: 30 },
  ] })).bills('2024-11-01');
  assert.deepEqual(read.records.map((b) => b.id), ['1', '3']);
  assert.equal(read.missing, 1);
  assert.equal(read.problems.length, 1);
  assert.match(read.problems[0]!, /^Bill 2: TotalAmt /);
});

test('books reader: a row that shifts across a page boundary is not counted twice', async () => {
  const first = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i + 1), Name: `A${i + 1}` }));
  const reader = quickBooksReader({
    realmId: 'realm-1',
    query: async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { QueryResponse: { totalCount: 1001 } };
      return sql.includes('STARTPOSITION 1 ')
        ? { QueryResponse: { Account: first } }
        : { QueryResponse: { Account: [first[999], { Id: '1001', Name: 'A1001' }] } };
    },
  });
  const read = await reader.accounts();
  assert.equal(read.records.length, 1001);
  assert.equal(read.missing, 0);
});

test('books reader: paging stops if QuickBooks keeps returning the same full page', async () => {
  const same = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i + 1), Name: `A${i + 1}` }));
  let pages = 0;
  const read = await quickBooksReader({
    realmId: 'realm-1',
    query: async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { QueryResponse: { totalCount: 5000 } };
      pages += 1;
      assert.ok(pages < 5, 'it should have stopped');
      return { QueryResponse: { Account: same } };
    },
  }).accounts();
  assert.equal(pages, 2);
  assert.equal(read.records.length, 1000);
  assert.equal(read.missing, 4000, 'and it says the read is partial');
});

const failing = (error: unknown) => ({ realmId: 'realm-1', query: async () => { throw error; } });

test('books reader: a failed read is a named failure, never an empty list', async () => {
  const fault = (code: string, Message: string, Detail = '') => ({ Fault: { Error: [{ Message, Detail, code, element: '' }], type: 'ValidationFault' }, time: 'now' });
  const cases: Array<[string, unknown, string, RegExp]> = [
    ['a dead refresh token', new QboError(400, 'invalid_grant'), 'sign_in_lost', /invalid_grant/],
    ['an expired or revoked token', new QboError(401, fault('3200', 'AuthenticationFailed')), 'sign_in_lost', /AuthenticationFailed/],
    ['a person who lost admin', new QboError(403, fault('120', 'Authorization Failure', 'AuthorizationFailure: 11014')), 'no_access', /Authorization Failure: AuthorizationFailure/],
    ['a 400 carrying a permission code', new QboError(400, fault('5020', 'Permission Denied')), 'no_access', /Permission Denied/],
    ['a query Intuit will not run', new QboError(400, fault('4000', 'Error parsing query', 'QueryParserError')), 'refused', /Error parsing query: QueryParserError/],
  ];
  for (const [what, error, kind, message] of cases) {
    const { wait, waits } = noWait();
    await assert.rejects(quickBooksReader(failing(error), { wait }).vendors(), (e: BooksReadError) => {
      assert.ok(e instanceof BooksReadError, what);
      assert.equal(e.kind, kind, what);
      assert.match(e.message, message, what);
      return true;
    });
    assert.deepEqual(waits, [], `${what}: waiting would not help`);
  }
});

test('books reader: a fault on a 200, or an answer with no result in it, is a failure too', async () => {
  const onOk = { realmId: 'realm-1', query: async () => ({ Fault: { Error: [{ Message: 'Business Validation Error', code: '6000' }], type: 'ValidationFault' } }) };
  await assert.rejects(quickBooksReader(onOk).accounts(), (e: BooksReadError) => e.kind === 'refused' && /Business Validation Error/.test(e.message));
  const noResult = { realmId: 'realm-1', query: async () => ({ time: 'now' }) };
  await assert.rejects(quickBooksReader(noResult).accounts(), (e: BooksReadError) => e.kind === 'refused');
});

test('books reader: a company it cannot read at all is a failure, not a blank company', async () => {
  const none = { realmId: 'realm-1', query: async () => ({ QueryResponse: {} }) };
  await assert.rejects(quickBooksReader(none).company(), (e: BooksReadError) => e.kind === 'refused');
});

test('books reader: throttled, it waits the minute Intuit asks for and goes on', async () => {
  const books = fakeBooks({ Account: [{ Id: '1', Name: 'Travel' }] });
  let throttles = 2;
  const { wait, waits } = noWait();
  const read = await quickBooksReader({
    realmId: 'realm-1',
    query: async (sql: string) => {
      if (throttles > 0) { throttles -= 1; throw new QboError(429, { Fault: { Error: [{ Message: 'ThrottleExceeded', code: '3001' }] } }); }
      return books.query(sql);
    },
  }, { wait }).accounts();
  assert.deepEqual(waits, [60_000, 60_000]);
  assert.equal(read.records.length, 1);
});

test('books reader: it stops after three tries and says why: throttled, or down', async () => {
  for (const [error, kind, delay] of [
    [new QboError(429, ''), 'throttled', 60_000],
    [new QboError(503, '<html>Service Unavailable</html>'), 'unavailable', 5_000],
    [new TypeError('fetch failed'), 'unavailable', 5_000],
  ] as const) {
    const { wait, waits } = noWait();
    await assert.rejects(quickBooksReader(failing(error), { wait }).accounts(), (e: BooksReadError) => e.kind === kind);
    assert.deepEqual(waits, [delay, delay], 'two waits between three tries');
  }
});

test('books reader: through the real client, an outage page comes back as unavailable, not a parse crash', async () => {
  const realFetch = globalThis.fetch;
  const far = Date.now() + 86_400_000;
  const client = new QuickBooks({ realmId: 'realm-1', accessToken: 'x', refreshToken: 'y', expiresAt: far, refreshExpiresAt: far });
  const signals: Array<AbortSignal | null | undefined> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal);
    return new Response('<html>Service Unavailable</html>', { status: 503 });
  }) as typeof fetch;
  try {
    const { wait } = noWait();
    await assert.rejects(quickBooksReader(client, { wait }).accounts(), (e: BooksReadError) => {
      assert.equal(e.kind, 'unavailable');
      assert.equal(e.message, 'QuickBooks answered 503.', 'the outage page stays out of it');
      return true;
    });
    assert.equal(signals.length, 3);
    assert.ok(signals.every((s) => s instanceof AbortSignal), 'a hung request has a time limit');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('books reader: a failed read of the settings is tried again by the next read', async () => {
  const books = fakeBooks({ Vendor: [{ Id: '1', DisplayName: 'A', Balance: 5 }] });
  let refuse = true;
  const reader = quickBooksReader({
    realmId: 'realm-1',
    query: async (sql: string) => {
      if (refuse) throw new QboError(400, { Fault: { Error: [{ Message: 'No', code: '1' }] } });
      return books.query(sql);
    },
  });
  await assert.rejects(reader.vendors(), BooksReadError);
  refuse = false;
  assert.equal((await reader.vendors()).records[0]!.balanceMinor, 500n);
});

test('books reader: the settings are asked for once, however many reads need the currency', async () => {
  const books = fakeBooks();
  const reader = quickBooksReader(books);
  await reader.vendors();
  await reader.bills('2024-11-01');
  await reader.expenses('2024-11-01');
  await reader.company();
  assert.equal(books.asked.filter((q) => q.includes('FROM Preferences')).length, 1);
});

test('books reader: what the harness holds can read, and has no way to write', async () => {
  const reader = quickBooksReader(fakeBooks()) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(reader).sort(), ['accounts', 'bills', 'billsLike', 'closingDate', 'company', 'companyId', 'expenses', 'system', 'vendors']);
  for (const value of Object.values(reader)) {
    assert.ok(typeof value === 'string' || typeof value === 'function', 'no client hanging off it');
  }
});

test('books reader: an organisation with no live connection has no reader', async () => {
  setQuickBooksForTests(() => null);
  assert.equal(await readerForOrganization('00000000-0000-0000-0000-000000000000'), null);
  const client = fakeBooks();
  setQuickBooksForTests(() => client as unknown as QuickBooks);
  const reader = await readerForOrganization('00000000-0000-0000-0000-000000000000');
  assert.equal(reader?.system, 'quickbooks');
  assert.equal(reader?.companyId, 'realm-1');
});
