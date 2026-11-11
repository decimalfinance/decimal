// The Xero reader: what the setup harness holds for Xero. No database and no
// network: Xero is the fixture client, which answers as Xero's specification says.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BooksReadError } from '../src/integrations/books.js';
import { fixtureXeroClient, xeroDate, type XeroFixture, type XeroFixtureFault } from '../src/integrations/xero-fixture.js';
import { XeroApiError, xeroDay, xeroReader } from '../src/integrations/xero-reader.js';

const TENANT = '6f1c0d2a-1b7e-4c55-9a51-2f0a3c9e7d10';

const contact = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  ContactID: id, Name: name, ContactStatus: 'ACTIVE', IsSupplier: true, IsCustomer: false, UpdatedDateUTC: xeroDate('2026-01-05'), ...extra,
});

const bill = (id: string, extra: Record<string, unknown> = {}) => ({
  InvoiceID: id, Type: 'ACCPAY', Status: 'PAID', InvoiceNumber: `INV-${id}`,
  Contact: { ContactID: 'c-fuel', Name: 'Crossroads Fuel' },
  Date: xeroDate('2026-03-02'), DueDate: xeroDate('2026-04-01'), LineAmountTypes: 'Exclusive',
  LineItems: [{ LineItemID: `${id}-1`, Description: 'Diesel', AccountCode: '610', TaxType: 'NONE', TaxAmount: 0, LineAmount: 100 }],
  SubTotal: 100, TotalTax: 0, Total: 100, AmountDue: 0, CurrencyCode: 'USD', UpdatedDateUTC: xeroDate('2026-03-03'),
  ...extra,
});

function books(extra: Partial<XeroFixture> = {}): XeroFixture {
  return {
    Organisation: {
      OrganisationID: TENANT, Name: 'Larkspur Freight', LegalName: 'Larkspur Freight Inc', BaseCurrency: 'USD', CountryCode: 'US',
      OrganisationStatus: 'ACTIVE', Class: 'PREMIUM', LineOfBusiness: 'Freight', FinancialYearEndMonth: 12, FinancialYearEndDay: 31,
      PeriodLockDate: xeroDate('2026-06-30'), EndOfYearLockDate: xeroDate('2025-12-31'), SalesTaxBasis: 'ACCRUALS',
    },
    Currencies: [{ Code: 'USD' }, { Code: 'CAD' }],
    TrackingCategories: [
      { TrackingCategoryID: 't-1', Name: 'Division', Status: 'ACTIVE' },
      { TrackingCategoryID: 't-2', Name: 'Terminal', Status: 'ACTIVE' },
    ],
    Accounts: [
      { AccountID: 'a-bank', Code: '090', Name: 'Operating Checking', Type: 'BANK', BankAccountType: 'BANK', Class: 'ASSET', Status: 'ACTIVE' },
      { AccountID: 'a-card', Name: 'Company Visa', Type: 'BANK', BankAccountType: 'CREDITCARD', Class: 'ASSET', Status: 'ACTIVE' },
      { AccountID: 'a-fuel', Code: '610', Name: 'Fuel', Type: 'DIRECTCOSTS', Class: 'EXPENSE', Status: 'ACTIVE' },
      { AccountID: 'a-old', Code: '699', Name: 'Old Repairs', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ARCHIVED' },
    ],
    Contacts: [
      contact('c-fuel', 'Crossroads Fuel', {
        EmailAddress: 'ar@crossroads.example', AccountNumber: 'CF-12',
        Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: '(615) 555-0101' }],
        Addresses: [{ AddressType: 'POBOX', AddressLine1: '10 Depot Rd', City: 'Nashville', Region: 'TN', PostalCode: '37210' }],
        PaymentTerms: { Bills: { Day: 30, Type: 'DAYSAFTERBILLDATE' } },
        Balances: { AccountsPayable: { Outstanding: 412.5 } },
      }),
      contact('c-both', 'Harbor Cargo', { IsCustomer: true }),
      contact('c-card', 'Gas & Go', { IsSupplier: false }),
      contact('c-old', 'Crossroads Fuel Co', { ContactStatus: 'ARCHIVED' }),
      contact('c-buyer', 'Bramble Retail', { IsSupplier: false, IsCustomer: true }),
    ],
    Invoices: [bill('b-1')],
    BankTransactions: [],
    LinkedTransactions: [],
    ...extra,
  };
}

const noWait = () => {
  const waits: number[] = [];
  return { waits, wait: async (ms: number) => { waits.push(ms); } };
};

const read = (fixture: XeroFixture, faults: XeroFixtureFault[] = [], wait = noWait()) => {
  const client = fixtureXeroClient(fixture, faults);
  return { client, reader: xeroReader(client, { wait: wait.wait }), waits: wait.waits };
};

test('xero reader: an organisation reads as the shared shape, its closing date the later lock date', async () => {
  const { reader } = read(books());
  assert.deepEqual(await reader.company(), {
    id: TENANT,
    name: 'Larkspur Freight',
    country: 'US',
    homeCurrency: 'USD',
    plan: 'PREMIUM',
    subscriptionStatus: 'ACTIVE',
    fiscalYearStartMonth: 'January',
    industry: 'Freight',
    closingDate: '2026-06-30',
    multiCurrency: true,
    salesTax: true,
    accountNumbers: true,
    classes: 'per_line',
    locations: false,
    locationLabel: null,
  });
  assert.equal(await reader.closingDate(), '2026-06-30');
});

test('xero reader: no lock dates and no tracking say so, not a guess', async () => {
  const fixture = books({ TrackingCategories: [], Currencies: [{ Code: 'USD' }] });
  fixture.Organisation = { ...fixture.Organisation, PeriodLockDate: undefined, EndOfYearLockDate: undefined, FinancialYearEndMonth: 6 };
  const { reader } = read(fixture);
  const company = await reader.company();
  assert.equal(company.closingDate, null);
  assert.equal(company.classes, 'off');
  assert.equal(company.multiCurrency, false);
  assert.equal(company.fiscalYearStartMonth, 'July');
  assert.equal(await reader.closingDate(), null);
});

test('xero reader: Xero dates read whether written as /Date()/ or as text', () => {
  assert.equal(xeroDay('/Date(1782777600000+0000)/'), '2026-06-30');
  assert.equal(xeroDay('2026-06-30T00:00:00'), '2026-06-30');
  assert.equal(xeroDay(null), null);
});

test('xero reader: accounts keep their codes as numbers, archived ones read as inactive, and none has a parent', async () => {
  const { records, expected, missing } = await read(books()).reader.accounts();
  assert.equal(expected, 4);
  assert.equal(missing, 0);
  assert.deepEqual(records.find((a) => a.id === 'a-fuel'), {
    id: 'a-fuel', name: 'Fuel', fullName: 'Fuel', number: '610', type: 'DIRECTCOSTS', subType: null, group: 'EXPENSE', parentId: null, currency: null, active: true, reserved: false,
  });
  assert.equal(records.find((a) => a.id === 'a-old')!.active, false);
  assert.equal(records.find((a) => a.id === 'a-card')!.subType, 'CREDITCARD');
});

test('xero reader: a vendor is any contact but a customer only, archived ones too, and customers are not counted missing', async () => {
  const { client, reader } = read(books());
  const vendors = await reader.vendors();
  assert.deepEqual(vendors.records.map((v) => v.id).sort(), ['c-both', 'c-card', 'c-fuel', 'c-old']);
  assert.equal(vendors.expected, 4);
  assert.equal(vendors.missing, 0);
  assert.deepEqual(vendors.records.find((v) => v.id === 'c-fuel'), {
    id: 'c-fuel', name: 'Crossroads Fuel', company: null, email: 'ar@crossroads.example', phone: '(615) 555-0101',
    address: '10 Depot Rd, Nashville, TN, 37210', accountNumber: 'CF-12', currency: 'USD', balanceMinor: 41250n,
    termsId: '30 DAYSAFTERBILLDATE', active: true, createdAt: null, updatedAt: '2026-01-05T00:00:00.000Z',
  });
  assert.equal(vendors.records.find((v) => v.id === 'c-old')!.active, false);
  assert.deepEqual(client.asked.find((a) => a.endpoint === 'Contacts')!.query, { includeArchived: 'true', page: '1', pageSize: '1000' });
});

test('xero reader: a bill keeps its header and lines; a tax-inclusive line is made net, in exact minor units', async () => {
  const fixture = books({
    Invoices: [bill('b-1', {
      LineAmountTypes: 'Inclusive', AmountDue: 30.1, TotalTax: 10.03, Total: 130.33,
      LineItems: [
        { LineItemID: 'l-1', Description: 'Diesel', AccountCode: '610', TaxType: 'TAX001', TaxAmount: 9.13, LineAmount: 109.53, Tracking: [{ TrackingCategoryID: 't-1', TrackingOptionID: 'o-1', Name: 'Division', Option: 'Linehaul' }] },
        { LineItemID: 'l-2', Description: 'Brake pads', ItemCode: 'BRK-1', AccountCode: '699', TaxType: 'TAX001', TaxAmount: 0.9, LineAmount: 20.8 },
        { LineItemID: 'l-3', Description: 'See statement', LineAmount: 0 },
      ],
    })],
    LinkedTransactions: [{ LinkedTransactionID: 'k-1', SourceTransactionID: 'b-1', SourceLineItemID: 'l-1', ContactID: 'c-buyer', Status: 'APPROVED', Type: 'BILLABLEEXPENSE' }],
  });
  const { records: [b] } = await read(fixture).reader.bills('2026-01-01');
  assert.deepEqual({ ...b, lines: undefined }, {
    id: 'b-1', number: 'INV-b-1', vendorId: 'c-fuel', vendorName: 'Crossroads Fuel', date: '2026-03-02', dueDate: '2026-04-01',
    currency: 'USD', totalMinor: 13033n, balanceMinor: 3010n, taxMinor: 1003n, payableAccountId: null, termsId: null,
    locationId: null, locationName: null, note: null, lines: undefined, createdAt: null, updatedAt: '2026-03-03T00:00:00.000Z',
  });
  assert.deepEqual(b!.lines, [
    { amountMinor: 10040n, description: 'Diesel', kind: 'account', accountId: 'a-fuel', accountName: 'Fuel', itemId: null, itemName: null, classId: 'o-1', className: 'Linehaul', customerId: 'c-buyer', taxCode: 'TAX001' },
    { amountMinor: 1990n, description: 'Brake pads', kind: 'item', accountId: 'a-old', accountName: 'Old Repairs', itemId: 'BRK-1', itemName: 'BRK-1', classId: null, className: null, customerId: null, taxCode: 'TAX001' },
    { amountMinor: 0n, description: 'See statement', kind: 'other', accountId: null, accountName: null, itemId: null, itemName: null, classId: null, className: null, customerId: null, taxCode: null },
  ]);
});

test('xero reader: bills are ACCPAY in the books from the date given; drafts, voids and sales are left out, not missing', async () => {
  const fixture = books({
    Invoices: [
      bill('b-1'),
      bill('b-old', { Date: xeroDate('2025-12-31') }),
      bill('b-draft', { Status: 'DRAFT' }),
      bill('b-void', { Status: 'VOIDED' }),
      bill('b-sale', { Type: 'ACCREC' }),
      bill('b-waiting', { Status: 'SUBMITTED', AmountDue: 100 }),
    ],
  });
  const { client, reader } = read(fixture);
  const bills = await reader.bills('2026-01-01');
  assert.deepEqual(bills.records.map((b) => b.id), ['b-1', 'b-waiting']);
  assert.equal(bills.missing, 0);
  const asked = client.asked.find((a) => a.endpoint === 'Invoices')!.query;
  assert.equal(asked.where, 'Type=="ACCPAY" && Date>=DateTime(2026,01,01)');
  assert.equal(asked.Statuses, 'SUBMITTED,AUTHORISED,PAID');
  await assert.rejects(reader.bills('March'), (e: unknown) => e instanceof BooksReadError && e.kind === 'refused');
});

test('xero reader: more than a page is read whole, page by page, and a short answer says how much is missing', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => bill(`b-${i}`));
  const whole = read(books({ Invoices: many }));
  const all = await whole.reader.bills('2026-01-01');
  assert.equal(all.records.length, 2500);
  assert.equal(all.expected, 2500);
  assert.deepEqual(whole.client.asked.filter((a) => a.endpoint === 'Invoices').map((a) => a.query.page), ['1', '2', '3']);

  const short = await read(books({ Invoices: many }), [{ on: 'Invoices', short: 2 }]).reader.bills('2026-01-01');
  assert.equal(short.records.length, 2498);
  assert.equal(short.expected, 2500);
  assert.equal(short.missing, 2);
});

test('xero reader: a record it cannot read is named and counted missing, and does not sink the rest', async () => {
  const { records, missing, problems } = await read(books({ Invoices: [bill('b-1'), { InvoiceID: 'b-bad', Type: 'ACCPAY', Status: 'PAID', Date: xeroDate('2026-03-02') }] })).reader.bills('2026-01-01');
  assert.deepEqual(records.map((b) => b.id), ['b-1']);
  assert.equal(missing, 1);
  assert.match(problems[0]!, /^Invoices b-bad: Total/);
});

test('xero reader: spend money says who was paid and from where; money back from a vendor counts, other money in does not', async () => {
  const spend = (id: string, extra: Record<string, unknown>) => ({
    BankTransactionID: id, Type: 'SPEND', Status: 'AUTHORISED', Date: xeroDate('2026-02-10'), Reference: `R-${id}`, LineAmountTypes: 'Exclusive',
    LineItems: [{ LineItemID: `${id}-1`, Description: 'Fuel stop', AccountCode: '610', LineAmount: 50, TaxAmount: 0 }],
    Total: 50, TotalTax: 0, CurrencyCode: 'USD', BankAccount: { AccountID: 'a-card', Name: 'Company Visa' }, ...extra,
  });
  const fixture = books({
    BankTransactions: [
      spend('t-vendor', { Contact: { ContactID: 'c-card', Name: 'Gas & Go' } }),
      spend('t-customer', { Contact: { ContactID: 'c-buyer', Name: 'Bramble Retail' }, BankAccount: { AccountID: 'a-bank', Name: 'Operating Checking' } }),
      spend('t-nobody', {}),
      spend('t-refund', { Type: 'RECEIVE', Contact: { ContactID: 'c-card', Name: 'Gas & Go' } }),
      spend('t-sale', { Type: 'RECEIVE', Contact: { ContactID: 'c-buyer', Name: 'Bramble Retail' }, BankAccount: { AccountID: 'a-bank' } }),
      spend('t-deposit', { Type: 'RECEIVE', Contact: { ContactID: 'c-card', Name: 'Gas & Go' }, BankAccount: { AccountID: 'a-bank' } }),
      spend('t-cheque', { Type: 'RECEIVE', Contact: { ContactID: 'c-fuel', Name: 'Crossroads Fuel' }, BankAccount: { AccountID: 'a-bank' } }),
      spend('t-both', { Type: 'RECEIVE', Contact: { ContactID: 'c-both', Name: 'Harbor Cargo' }, BankAccount: { AccountID: 'a-bank' } }),
      spend('t-transfer', { Type: 'SPEND-TRANSFER' }),
      spend('t-early', { Date: xeroDate('2025-06-01') }),
    ],
  });
  const { client, reader } = read(fixture);
  const expenses = await reader.expenses('2026-01-01');
  assert.deepEqual(expenses.records.map((e) => [e.id, e.payeeType, e.refund, e.paymentType]), [
    ['t-vendor', 'Vendor', false, 'CreditCard'],
    ['t-customer', 'Customer', false, 'Bank'],
    ['t-nobody', null, false, 'CreditCard'],
    ['t-refund', 'Vendor', true, 'CreditCard'],
    ['t-deposit', 'Vendor', true, 'Bank'],
    ['t-cheque', 'Vendor', true, 'Bank'],
  ]);
  assert.equal(expenses.missing, 0);
  const first = expenses.records[0]!;
  assert.equal(first.number, 'R-t-vendor');
  assert.equal(first.paidFromAccountName, 'Company Visa');
  assert.equal(first.lines[0]!.accountId, 'a-fuel');
  assert.equal(client.asked.find((a) => a.endpoint === 'BankTransactions')!.query.where, '(Type=="SPEND" || Type=="RECEIVE") && Status=="AUTHORISED" && Date>=DateTime(2026,01,01)');
});

test('xero reader: bills like one are asked for by number and by vendor from a date, drafts included, each once', async () => {
  const fixture = books({
    Invoices: [
      bill('b-1', { InvoiceNumber: 'CF-100' }),
      bill('b-2', { InvoiceNumber: 'CF-101', Status: 'DRAFT' }),
      bill('b-3', { InvoiceNumber: 'X-9', Contact: { ContactID: 'c-both', Name: 'Harbor Cargo' } }),
      bill('b-4', { InvoiceNumber: 'CF-100', Contact: { ContactID: 'c-both', Name: 'Harbor Cargo' }, Date: xeroDate('2025-01-01') }),
    ],
  });
  const { client, reader } = read(fixture);
  const like = await reader.billsLike({ numbers: ['CF-100'], vendorIds: ['c-fuel'], since: '2026-01-01' });
  assert.deepEqual(like.map((b) => b.id).sort(), ['b-1', 'b-2', 'b-4']);
  const asks = client.asked.filter((a) => a.endpoint === 'Invoices').map((a) => a.query);
  assert.equal(asks[0]!.InvoiceNumbers, 'CF-100');
  assert.equal(asks[1]!.ContactIDs, 'c-fuel');
  assert.ok(asks.every((q) => q.Statuses === 'DRAFT,SUBMITTED,AUTHORISED,PAID'));
});

test('xero reader: a failed read is a named failure, never an empty list', async () => {
  const cases: Array<[number, BooksReadError['kind']]> = [[401, 'sign_in_lost'], [403, 'no_access'], [400, 'refused'], [503, 'unavailable'], [429, 'throttled']];
  for (const [status, kind] of cases) {
    const { reader } = read(books(), [{ on: 'Contacts', status }]);
    await assert.rejects(reader.vendors(), (e: unknown) => e instanceof BooksReadError && e.kind === kind, `${status}`);
  }
});

test('xero reader: throttled, it waits as long as Xero asks and goes on; past a minute, it stops and says so', async () => {
  let calls = 0;
  const flaky = fixtureXeroClient(books());
  const throttledOnce = { ...flaky, get: async (endpoint: string, query?: Record<string, string>) => {
    calls += 1;
    if (calls === 1) throw new XeroApiError(429, 'Rate limit hit', 7);
    return flaky.get(endpoint, query);
  } };
  const wait = noWait();
  assert.equal((await xeroReader(throttledOnce, { wait: wait.wait }).accounts()).records.length, 4);
  assert.deepEqual(wait.waits, [7000]);

  const daily = { ...flaky, get: async () => { throw new XeroApiError(429, 'Daily limit hit', 3600); } };
  const none = noWait();
  await assert.rejects(xeroReader(daily, { wait: none.wait }).accounts(), (e: unknown) => e instanceof BooksReadError && e.kind === 'throttled');
  assert.deepEqual(none.waits, []);
});

test('xero reader: down, it tries three times and says why', async () => {
  const { reader, waits } = read(books(), [{ on: 'Accounts', status: 503 }]);
  await assert.rejects(reader.accounts(), (e: unknown) => e instanceof BooksReadError && e.kind === 'unavailable');
  assert.deepEqual(waits, [5000, 5000]);
});

test('xero reader: the organisation and chart are asked once, however many reads need them', async () => {
  const { client, reader } = read(books());
  await Promise.all([reader.company(), reader.bills('2026-01-01'), reader.expenses('2026-01-01'), reader.accounts()]);
  assert.equal(client.asked.filter((a) => a.endpoint === 'Organisation').length, 1);
  assert.equal(client.asked.filter((a) => a.endpoint === 'Accounts').length, 1);
  assert.equal(client.asked.filter((a) => a.endpoint === 'LinkedTransactions').length, 1);
});

test('xero reader: what the harness holds can read, and has no way to write', () => {
  const { reader } = read(books());
  assert.deepEqual(Object.keys(reader).sort(), ['accounts', 'bills', 'billsLike', 'closingDate', 'company', 'companyId', 'expenses', 'system', 'vendors']);
  assert.equal(reader.system, 'xero');
  assert.equal(reader.companyId, TENANT);
});

test('xero fixture: a where it cannot read is refused, as Xero refuses one', async () => {
  const client = fixtureXeroClient(books());
  await assert.rejects(client.get('Invoices', { where: 'Type==ACCPAY' }), (e: unknown) => e instanceof XeroApiError && e.status === 400);
});
