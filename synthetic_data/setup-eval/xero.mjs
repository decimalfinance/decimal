#!/usr/bin/env node
// Each company the eval knows, in the shared books shape, as the Xero organisation it
// would be: the same records in Xero's fields and habits, read back through the Xero
// reader (api/src/integrations/xero-reader.ts). Ids stay, so the same hidden answers
// hold. Writes xero/<id>.json for the eval, and xero/demo.json for the bench.
//
// What Xero can't hold the way QuickBooks does, and how it is written here:
// - A contact has one name. A vendor's QuickBooks company name has nowhere to go.
// - Employees aren't contacts. Spend money to one is written with no contact, as
//   spend money with nobody named is (Xero allows it).
// - Customers are contacts, ids prefixed "cust-" so they can't meet a vendor's.
// - Accounts have no parents: the full name is the name. Every account but a bank
//   account has a code; one QuickBooks left unnumbered gets "Q" and its id.
// - Classes and locations are tracking categories, set on each line.
// - A bill with tax is entered tax-inclusive, so its lines carry their tax.
// - Billable lines are linked transactions.
//
// generate.mjs runs this at its end. On its own: node xero.mjs

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const day = (d) => (d ? `/Date(${Date.parse(`${d}T00:00:00Z`)}+0000)/` : undefined);
const instant = (t) => (t && !Number.isNaN(Date.parse(t)) ? `/Date(${Date.parse(t)}+0000)/` : undefined);
/** Minor units (a string in the fixtures) as Xero's decimal amount. Every fixture currency has two places. */
const money = (minor) => Number(BigInt(minor ?? '0')) / 100;

const ACCOUNT_TYPES = {
  'Bank': ['BANK', 'BANK'],
  'Credit Card': ['BANK', 'CREDITCARD'],
  'Accounts Receivable': ['CURRENT'],
  'Other Current Asset': ['CURRENT'],
  'Fixed Asset': ['FIXED'],
  'Other Asset': ['NONCURRENT'],
  'Accounts Payable': ['CURRLIAB'],
  'Other Current Liability': ['CURRLIAB'],
  'Long Term Liability': ['TERMLIAB'],
  'Equity': ['EQUITY'],
  'Income': ['REVENUE'],
  'Other Income': ['OTHERINCOME'],
  'Cost of Goods Sold': ['DIRECTCOSTS'],
  'Expense': ['EXPENSE'],
  'Other Expense': ['EXPENSE'],
};
const CLASSES = { Asset: 'ASSET', Liability: 'LIABILITY', Equity: 'EQUITY', Revenue: 'REVENUE', Expense: 'EXPENSE' };

/**
 * @param books a company in the shared shape, amounts as strings
 * @param options tenantId, lock dates, the two tracking categories' names, vendors that are customers too
 */
export function toXero(books, options = {}) {
  const c = books.company;
  const home = c.homeCurrency ?? 'USD';
  const tenantId = options.tenantId ?? c.id;

  const accounts = books.accounts.map((a) => {
    const [type, bankType] = ACCOUNT_TYPES[a.type] ?? ['EXPENSE'];
    return {
      AccountID: a.id,
      Code: a.number ?? (type === 'BANK' ? undefined : `Q${a.id}`),
      Name: a.fullName ?? a.name,
      Type: type,
      Class: CLASSES[a.group] ?? 'EXPENSE',
      Status: a.active ? 'ACTIVE' : 'ARCHIVED',
      ...(bankType ? { BankAccountType: bankType } : {}),
      ...(a.currency ? { CurrencyCode: a.currency } : {}),
    };
  });
  const codeOf = new Map(accounts.map((a) => [a.AccountID, a.Code]));

  const classCategory = { TrackingCategoryID: 'tc-class', Name: options.classLabel ?? 'Class', Status: 'ACTIVE' };
  const locationCategory = { TrackingCategoryID: 'tc-location', Name: options.locationLabel ?? c.locationLabel ?? 'Location', Status: 'ACTIVE' };
  const usedClasses = new Map();
  const usedLocations = new Map();

  const customers = new Map();
  const customer = (id, name) => {
    const key = `cust-${id}`;
    if (!customers.has(key) || (name && customers.get(key).Name.startsWith('Customer '))) {
      customers.set(key, { ContactID: key, Name: name ?? `Customer ${id}`, ContactStatus: 'ACTIVE', IsSupplier: false, IsCustomer: true });
    }
    return key;
  };

  const links = [];
  /** Lines in Xero's shape. Tax-inclusive when the record has tax: each line carries its share, the largest the remainder. */
  const lineItems = (record, sourceId) => {
    const tax = BigInt(record.taxMinor ?? '0');
    const nets = record.lines.map((l) => BigInt(l.amountMinor));
    const base = nets.reduce((s, n) => s + (n > 0n ? n : 0n), 0n);
    const shares = nets.map((n) => (tax > 0n && base > 0n && n > 0n ? (tax * n) / base : 0n));
    if (tax > 0n && base > 0n) {
      const largest = nets.indexOf(nets.reduce((m, n) => (n > m ? n : m), nets[0]));
      shares[largest] += tax - shares.reduce((s, n) => s + n, 0n);
    }
    return record.lines.map((l, i) => {
      const id = `${sourceId}-${i + 1}`;
      const tracking = [];
      if (l.classId) {
        usedClasses.set(l.classId, l.className ?? l.classId);
        tracking.push({ TrackingCategoryID: classCategory.TrackingCategoryID, TrackingOptionID: `class-${l.classId}`, Name: classCategory.Name, Option: l.className ?? l.classId });
      }
      if (record.locationId) {
        usedLocations.set(record.locationId, record.locationName ?? record.locationId);
        tracking.push({ TrackingCategoryID: locationCategory.TrackingCategoryID, TrackingOptionID: `loc-${record.locationId}`, Name: locationCategory.Name, Option: record.locationName ?? record.locationId });
      }
      if (l.customerId) {
        links.push({
          LinkedTransactionID: `link-${id}`, SourceTransactionID: sourceId, SourceLineItemID: id,
          ContactID: customer(l.customerId), Status: 'BILLED', Type: 'BILLABLEEXPENSE',
        });
      }
      return {
        LineItemID: id,
        ...(l.description ? { Description: l.description } : {}),
        ...(l.kind === 'item' ? { ItemCode: l.itemName ?? l.itemId } : {}),
        ...(l.accountId && codeOf.get(l.accountId) ? { AccountCode: codeOf.get(l.accountId) } : l.accountId ? { AccountID: l.accountId } : {}),
        ...(l.taxCode ? { TaxType: l.taxCode } : {}),
        TaxAmount: money(shares[i]),
        LineAmount: money(nets[i] + shares[i]),
        ...(tracking.length ? { Tracking: tracking } : {}),
      };
    });
  };
  const amountType = (record) => (BigInt(record.taxMinor ?? '0') > 0n ? 'Inclusive' : 'NoTax');

  const billed = new Set(books.bills.map((b) => b.vendorId).filter(Boolean));
  const alsoCustomers = new Set(options.alsoCustomers ?? []);
  const vendors = books.vendors.map((v) => ({
    ContactID: v.id,
    Name: v.name,
    ContactStatus: v.active ? 'ACTIVE' : 'ARCHIVED',
    ...(v.email ? { EmailAddress: v.email } : {}),
    ...(v.accountNumber ? { AccountNumber: v.accountNumber } : {}),
    Phones: v.phone ? [{ PhoneType: 'DEFAULT', PhoneNumber: v.phone }] : [],
    Addresses: v.address ? [{ AddressType: 'POBOX', AddressLine1: v.address }] : [],
    IsSupplier: billed.has(v.id),
    IsCustomer: alsoCustomers.has(v.id),
    DefaultCurrency: v.currency ?? home,
    ...(v.balanceMinor !== null && v.balanceMinor !== undefined ? { Balances: { AccountsPayable: { Outstanding: money(v.balanceMinor) } } } : {}),
    ...(instant(v.updatedAt) ? { UpdatedDateUTC: instant(v.updatedAt) } : {}),
  }));

  const invoices = books.bills.map((b) => ({
    InvoiceID: b.id,
    Type: 'ACCPAY',
    Status: BigInt(b.balanceMinor ?? '0') === 0n ? 'PAID' : 'AUTHORISED',
    ...(b.number ? { InvoiceNumber: b.number } : {}),
    ...(b.vendorId ? { Contact: { ContactID: b.vendorId, Name: b.vendorName } } : {}),
    Date: day(b.date),
    ...(b.dueDate ? { DueDate: day(b.dueDate) } : {}),
    LineAmountTypes: amountType(b),
    LineItems: lineItems(b, b.id),
    SubTotal: money((BigInt(b.totalMinor) - BigInt(b.taxMinor ?? '0')).toString()),
    TotalTax: money(b.taxMinor ?? '0'),
    Total: money(b.totalMinor),
    AmountDue: money(b.balanceMinor ?? '0'),
    AmountPaid: money((BigInt(b.totalMinor) - BigInt(b.balanceMinor ?? '0')).toString()),
    CurrencyCode: b.currency,
    ...(instant(b.updatedAt) ? { UpdatedDateUTC: instant(b.updatedAt) } : {}),
  }));

  const spends = books.expenses.map((e) => {
    const contact = e.payeeType === 'Vendor' && e.payeeId ? { ContactID: e.payeeId, Name: e.payeeName }
      : e.payeeType === 'Customer' && e.payeeId ? { ContactID: customer(e.payeeId, e.payeeName), Name: e.payeeName }
        : null;
    return {
      BankTransactionID: e.id,
      Type: e.refund ? 'RECEIVE' : 'SPEND',
      Status: 'AUTHORISED',
      ...(contact ? { Contact: contact } : {}),
      Date: day(e.date),
      ...(e.number ? { Reference: e.number } : {}),
      LineAmountTypes: amountType(e),
      LineItems: lineItems(e, e.id),
      SubTotal: money((BigInt(e.totalMinor) - BigInt(e.taxMinor ?? '0')).toString()),
      TotalTax: money(e.taxMinor ?? '0'),
      Total: money(e.totalMinor),
      CurrencyCode: e.currency,
      BankAccount: { AccountID: e.paidFromAccountId, Name: e.paidFromAccountName },
      ...(instant(e.updatedAt) ? { UpdatedDateUTC: instant(e.updatedAt) } : {}),
    };
  });

  const options_ = (used, prefix) => [...used.entries()].map(([id, name]) => ({ TrackingOptionID: `${prefix}-${id}`, Name: name, Status: 'ACTIVE' }));
  const tracking = [
    ...(usedClasses.size || c.classes !== 'off' ? [{ ...classCategory, Options: options_(usedClasses, 'class') }] : []),
    ...(usedLocations.size || c.locations ? [{ ...locationCategory, Options: options_(usedLocations, 'loc') }] : []),
  ];

  const currencies = new Set([home, ...books.bills.map((b) => b.currency), ...books.expenses.map((e) => e.currency), ...books.vendors.map((v) => v.currency).filter(Boolean)]);
  const startMonth = MONTHS.indexOf(c.fiscalYearStartMonth ?? 'January');
  const endMonth = startMonth <= 0 ? 12 : startMonth;

  return {
    Organisation: {
      OrganisationID: tenantId,
      Name: c.name,
      LegalName: c.name,
      BaseCurrency: home,
      CountryCode: c.country ?? 'US',
      // Xero documents ACTIVE only. What a lapsed subscription shows through the API is not verified;
      // the fixture says the status as QuickBooks did, so the same company stops the same setup.
      OrganisationStatus: c.subscriptionStatus === 'ACTIVE' || !c.subscriptionStatus ? 'ACTIVE' : c.subscriptionStatus,
      Class: c.multiCurrency ? 'PREMIUM' : 'STANDARD',
      Version: c.country === 'GB' ? 'UK' : 'US',
      ...(c.industry ? { LineOfBusiness: c.industry } : {}),
      FinancialYearEndMonth: endMonth,
      FinancialYearEndDay: new Date(Date.UTC(2026, endMonth, 0)).getUTCDate(),
      ...(options.periodLockDate ?? c.closingDate ? { PeriodLockDate: day(options.periodLockDate ?? c.closingDate) } : {}),
      ...(options.endOfYearLockDate ? { EndOfYearLockDate: day(options.endOfYearLockDate) } : {}),
      SalesTaxBasis: c.salesTax ? 'ACCRUALS' : 'NONE',
    },
    Currencies: [...currencies].map((code) => ({ Code: code })),
    TrackingCategories: tracking,
    Accounts: accounts,
    Contacts: [...vendors, ...customers.values()],
    Invoices: invoices,
    BankTransactions: spends,
    LinkedTransactions: links,
  };
}

/** Every company as a Xero organisation, and the demo. generate.mjs calls this once its companies are written. */
export function writeXero() {
  const out = join(HERE, 'xero');
  mkdirSync(out, { recursive: true });
  const ids = readdirSync(join(HERE, 'companies')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  for (const id of ids) {
    const books = JSON.parse(readFileSync(join(HERE, 'companies', `${id}.json`), 'utf8'));
    writeFileSync(join(out, `${id}.json`), `${JSON.stringify(toXero(books), null, 2)}\n`);
  }
  // The bench's demo: the messy freight company as a Xero organisation would hold it, with what
  // only Xero has. Lock dates (it keeps a closing date of its own), named tracking categories, and
  // two carriers it also sells to.
  const freight = JSON.parse(readFileSync(join(HERE, 'companies', 'messy-freight.json'), 'utf8'));
  const demo = toXero(freight, {
    tenantId: '4f9d3c1e-7a2b-4e6f-9b8d-1c5a2e7f3d90',
    periodLockDate: '2026-09-30',
    endOfYearLockDate: '2025-12-31',
    classLabel: 'Division',
    locationLabel: 'Terminal',
    alsoCustomers: ['39', '57'],
  });
  writeFileSync(join(out, 'demo.json'), `${JSON.stringify(demo, null, 2)}\n`);
  console.log(`xero: ${ids.length} companies and the demo in ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeXero();
