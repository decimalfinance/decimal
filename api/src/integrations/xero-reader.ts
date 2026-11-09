// Xero, read only, in the shape every system shares (books.ts).
//
// Written from Xero's Accounting API specification (XeroAPI/Xero-OpenAPI,
// xero_accounting.yaml) and run against the bench's fixture of it
// (xero-fixture.ts). Decimal has no Xero app yet, so this has never read a real
// Xero organisation. The client stays in this closure: what the harness gets back
// holds no way to write.
//
// Where Xero's shape differs, it is mapped here and nowhere else:
// - A contact can be a supplier and a customer at once. A vendor is any contact
//   that isn't a customer only, so one paid only by card still counts.
// - Accounts have codes and no parents; the code is the account number.
// - A tax-inclusive line carries its tax. Every other system's line is net, so it
//   is made net here.
// - Up to two tracking categories, set per line, stand where QuickBooks has classes
//   and locations. Both read as classes: Xero has nothing at the bill's level.
// - The closing date is the later of the two lock dates.
// - Money that left without a bill is spend money; a refund to a card is money
//   received on a credit card account.
// - Billable lines are linked transactions, read apart and joined by line.

import { z } from 'zod';
import {
  BooksReadError,
  toMinor,
  type BooksAccount,
  type BooksBill,
  type BooksCompany,
  type BooksExpense,
  type BooksLine,
  type BooksRead,
  type BooksReader,
  type BooksVendor,
} from './books.js';

const PAGE_SIZE = 1000; // Xero's largest page.
const LINKED_PAGE = 100; // LinkedTransactions takes no page size.
const NUMBERED_MAX = 100;
const MAX_PAGES = 500; // A runaway guard, far past any company's books.
const MAX_ATTEMPTS = 3;
const THROTTLE_WAIT_MS = 60_000; // Xero's limit is per minute.
const LONGEST_WAIT_MS = 60_000; // Past this (the daily limit), waiting inside a read doesn't help.
const UNAVAILABLE_WAIT_MS = 5_000;
const MAX_PROBLEMS = 25;

/** Bills in the books: approved, paid, or waiting on approval in Xero. Drafts are not entered yet. */
const STUDIED_STATUSES = 'SUBMITTED,AUTHORISED,PAID';
/** A bill that could be the same one includes drafts: entering it twice is the risk. */
const LOOKALIKE_STATUSES = 'DRAFT,SUBMITTED,AUTHORISED,PAID';

/** One GET on the Accounting API for one organisation (the xero-tenant-id), with its query. A non-2xx answer throws XeroApiError. */
export type XeroClient = {
  tenantId: string;
  get(endpoint: string, query?: Record<string, string>): Promise<unknown>;
};

/** Xero answered with an error. A 429 says, in Retry-After, how long to wait. */
export class XeroApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'XeroApiError';
  }
}

const contactRef = z.object({ ContactID: z.string(), Name: z.string().nullish() });

const lineItemSchema = z.object({
  LineItemID: z.string().nullish(),
  Description: z.string().nullish(),
  ItemCode: z.string().nullish(),
  AccountCode: z.string().nullish(),
  AccountID: z.string().nullish(),
  TaxType: z.string().nullish(),
  TaxAmount: z.number().nullish(),
  LineAmount: z.number().nullish(),
  Tracking: z.array(z.object({
    TrackingCategoryID: z.string().nullish(),
    TrackingOptionID: z.string().nullish(),
    Name: z.string().nullish(),
    Option: z.string().nullish(),
  })).nullish(),
});

const organisationSchema = z.object({
  OrganisationID: z.string().nullish(),
  Name: z.string().nullish(),
  LegalName: z.string().nullish(),
  BaseCurrency: z.string().nullish(),
  CountryCode: z.string().nullish(),
  OrganisationStatus: z.string().nullish(),
  Class: z.string().nullish(),
  LineOfBusiness: z.string().nullish(),
  FinancialYearEndMonth: z.number().nullish(),
  PeriodLockDate: z.string().nullish(),
  EndOfYearLockDate: z.string().nullish(),
  SalesTaxBasis: z.string().nullish(),
});

const currencySchema = z.object({ Code: z.string() });
const trackingCategorySchema = z.object({ TrackingCategoryID: z.string(), Name: z.string(), Status: z.string().nullish() });

const accountSchema = z.object({
  AccountID: z.string(),
  Code: z.string().nullish(),
  Name: z.string(),
  Type: z.string().nullish(),
  Class: z.string().nullish(),
  Status: z.string().nullish(),
  BankAccountType: z.string().nullish(),
  CurrencyCode: z.string().nullish(),
});

const contactSchema = z.object({
  ContactID: z.string(),
  Name: z.string(),
  ContactStatus: z.string().nullish(),
  EmailAddress: z.string().nullish(),
  AccountNumber: z.string().nullish(),
  Phones: z.array(z.object({
    PhoneType: z.string().nullish(),
    PhoneNumber: z.string().nullish(),
    PhoneAreaCode: z.string().nullish(),
    PhoneCountryCode: z.string().nullish(),
  })).nullish(),
  Addresses: z.array(z.object({
    AddressType: z.string().nullish(),
    AddressLine1: z.string().nullish(),
    AddressLine2: z.string().nullish(),
    City: z.string().nullish(),
    Region: z.string().nullish(),
    PostalCode: z.string().nullish(),
    Country: z.string().nullish(),
  })).nullish(),
  IsSupplier: z.boolean().nullish(),
  IsCustomer: z.boolean().nullish(),
  DefaultCurrency: z.string().nullish(),
  PaymentTerms: z.object({ Bills: z.object({ Day: z.number().nullish(), Type: z.string().nullish() }).nullish() }).nullish(),
  Balances: z.object({ AccountsPayable: z.object({ Outstanding: z.number().nullish() }).nullish() }).nullish(),
  UpdatedDateUTC: z.string().nullish(),
});

const invoiceSchema = z.object({
  InvoiceID: z.string(),
  Type: z.string().nullish(),
  Status: z.string().nullish(),
  InvoiceNumber: z.string().nullish(),
  Contact: contactRef.nullish(),
  Date: z.string().nullish(),
  DueDate: z.string().nullish(),
  LineAmountTypes: z.string().nullish(),
  LineItems: z.array(lineItemSchema).nullish(),
  Total: z.number(),
  TotalTax: z.number().nullish(),
  AmountDue: z.number().nullish(),
  CurrencyCode: z.string().nullish(),
  UpdatedDateUTC: z.string().nullish(),
});

const bankTransactionSchema = z.object({
  BankTransactionID: z.string(),
  Type: z.string(),
  Status: z.string().nullish(),
  Contact: contactRef.nullish(),
  Date: z.string().nullish(),
  Reference: z.string().nullish(),
  LineAmountTypes: z.string().nullish(),
  LineItems: z.array(lineItemSchema).nullish(),
  Total: z.number(),
  TotalTax: z.number().nullish(),
  CurrencyCode: z.string().nullish(),
  BankAccount: z.object({ AccountID: z.string().nullish(), Code: z.string().nullish(), Name: z.string().nullish() }).nullish(),
  UpdatedDateUTC: z.string().nullish(),
});

const linkedSchema = z.object({
  SourceTransactionID: z.string().nullish(),
  SourceLineItemID: z.string().nullish(),
  ContactID: z.string().nullish(),
  Status: z.string().nullish(),
  Type: z.string().nullish(),
});

type Contact = z.infer<typeof contactSchema>;
type Account = z.infer<typeof accountSchema>;

function named(error: unknown): BooksReadError {
  if (error instanceof BooksReadError) return error;
  if (error instanceof XeroApiError) {
    if (error.status === 401) return new BooksReadError('sign_in_lost', error.message);
    if (error.status === 403) return new BooksReadError('no_access', error.message);
    if (error.status === 429) return new BooksReadError('throttled', error.message);
    // Its body may be an outage page. The status says enough.
    if (error.status >= 500) return new BooksReadError('unavailable', `Xero answered ${error.status}.`);
    return new BooksReadError('refused', error.message);
  }
  return new BooksReadError('unavailable', error instanceof Error ? error.message : String(error));
}

const present = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

/** Xero writes dates as /Date(1569801600000+0000)/, and sometimes as ISO text. Either becomes an instant. */
function instant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ticks = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value);
  const date = ticks ? new Date(Number(ticks[1])) : new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A day, YYYY-MM-DD. Xero keeps a transaction's date as midnight UTC. */
export function xeroDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const written = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return written ? written[1]! : instant(value)?.toISOString().slice(0, 10) ?? null;
}

const xeroTime = (value: string | null | undefined) => instant(value)?.toISOString() ?? null;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Xero gives the month the year ends; the shape wants the one it starts. */
const startMonth = (endMonth: number | null | undefined) => (endMonth && endMonth >= 1 && endMonth <= 12 ? MONTHS[endMonth % 12]! : null);

const later = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : a ?? b);

/** A contact that only buys from them. Every other contact can be paid, so it is a vendor. */
const customerOnly = (c: Contact) => c.IsCustomer === true && c.IsSupplier !== true;

export function xeroReader(client: XeroClient, options: { wait?: (ms: number) => Promise<void> } = {}): BooksReader {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  /** One GET. Waits and tries again when that can help; any other failure comes back named. */
  async function ask(endpoint: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const answer = await client.get(endpoint, query);
        if (!answer || typeof answer !== 'object') throw new BooksReadError('refused', `Xero answered ${endpoint} with nothing Decimal can read.`);
        return answer as Record<string, unknown>;
      } catch (error) {
        const failure = named(error);
        const asked = error instanceof XeroApiError && error.retryAfterSeconds !== null ? error.retryAfterSeconds * 1000 : THROTTLE_WAIT_MS;
        const retryIn = failure.kind === 'throttled' ? (asked <= LONGEST_WAIT_MS ? asked : null) : failure.kind === 'unavailable' ? UNAVAILABLE_WAIT_MS : null;
        if (retryIn === null || attempt >= MAX_ATTEMPTS) throw failure;
        await wait(retryIn);
      }
    }
  }

  /** A list that comes whole, in one answer, under its plural name: GET Organisation answers "Organisations". */
  async function list<S extends z.ZodTypeAny>(endpoint: string, key: string, schema: S, query: Record<string, string> = {}) {
    const rows = (await ask(endpoint, query))[key];
    if (!Array.isArray(rows)) throw new BooksReadError('refused', `Xero answered ${endpoint} without its list.`);
    const parsed: Array<z.infer<S>> = [];
    const problems: string[] = [];
    for (const row of rows) {
      const one = schema.safeParse(row);
      if (one.success) parsed.push(one.data);
      else if (problems.length < MAX_PROBLEMS) problems.push(problemOf(endpoint, row, one.error));
    }
    return { parsed, rows: rows.length, problems };
  }

  function problemOf(endpoint: string, row: unknown, error: z.ZodError) {
    const record = (row ?? {}) as Record<string, unknown>;
    const id = String(record.InvoiceID ?? record.ContactID ?? record.BankTransactionID ?? record.AccountID ?? '?');
    const issue = error.issues[0];
    return `${endpoint} ${id}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'unreadable'}`.trim();
  }

  /**
   * Every record, page by page. Xero says how many there are on each page it sends
   * (pagination.itemCount); the ones `keep` turns away were read, and aren't missing.
   */
  async function readAll<S extends z.ZodTypeAny, T>(
    endpoint: string,
    query: Record<string, string>,
    schema: S,
    idOf: (row: Record<string, unknown>) => string,
    keep: (row: z.infer<S>) => boolean,
    toRecord: (row: z.infer<S>) => T,
  ): Promise<BooksRead<T>> {
    const records: T[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    let itemCount: number | null = null;
    let turnedAway = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const answer = await ask(endpoint, { ...query, page: String(page), pageSize: String(PAGE_SIZE) });
      const rows = answer[endpoint];
      if (!Array.isArray(rows)) throw new BooksReadError('refused', `Xero answered ${endpoint} without its list.`);
      const pagination = (answer.pagination ?? null) as { pageCount?: unknown; itemCount?: unknown } | null;
      if (typeof pagination?.itemCount === 'number') itemCount = pagination.itemCount;
      let fresh = 0;
      for (const row of rows as Array<Record<string, unknown>>) {
        const id = idOf(row ?? {});
        // A row can shift across a page boundary while reading.
        if (seen.has(id)) continue;
        seen.add(id);
        fresh += 1;
        const parsed = schema.safeParse(row);
        if (!parsed.success) {
          if (problems.length < MAX_PROBLEMS) problems.push(problemOf(endpoint, row, parsed.error));
          continue;
        }
        if (keep(parsed.data)) records.push(toRecord(parsed.data));
        else turnedAway += 1;
      }
      // Xero says how many pages there are. Without that, a page with nothing new is the end:
      // a short page might only be Xero keeping pages smaller than asked.
      const pageCount = typeof pagination?.pageCount === 'number' ? pagination.pageCount : null;
      if (pageCount !== null ? page >= pageCount : rows.length === 0 || fresh === 0) break;
    }
    const expected = Math.max(records.length, (itemCount ?? seen.size) - turnedAway);
    return { records, expected, missing: Math.max(0, expected - records.length), problems };
  }

  // Read once per reader: the organisation's currency, the chart that turns a line's code into its
  // account, the contacts that say who a payee is, and the lines billed on to a customer.
  const once = <T>(work: () => Promise<T>) => {
    let held: Promise<T> | null = null;
    return () => {
      held ??= work().catch((error) => {
        held = null;
        throw error;
      });
      return held;
    };
  };

  const organisation = once(async () => {
    const org = (await list('Organisation', 'Organisations', organisationSchema)).parsed[0];
    if (!org) throw new BooksReadError('refused', 'Xero returned no organisation Decimal can read.');
    return org;
  });
  const homeCurrency = async () => (await organisation()).BaseCurrency ?? 'USD';

  const chart = once(async () => {
    const read = await list('Accounts', 'Accounts', accountSchema);
    const byId = new Map(read.parsed.map((a) => [a.AccountID, a]));
    const byCode = new Map(read.parsed.flatMap((a) => (a.Code ? [[a.Code, a] as const] : [])));
    return { ...read, byId, byCode };
  });

  const contacts = once(() => readAll(
    'Contacts', { includeArchived: 'true' }, contactSchema,
    (row) => String(row.ContactID ?? '?'), () => true, (c) => c,
  ));

  /** Line id to the customer it is billed on to. Voided links bill nobody. */
  const billable = once(async () => {
    const out = new Map<string, string>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const rows = (await ask('LinkedTransactions', { page: String(page) })).LinkedTransactions;
      if (!Array.isArray(rows)) throw new BooksReadError('refused', 'Xero answered LinkedTransactions without its list.');
      for (const row of rows) {
        const link = linkedSchema.safeParse(row);
        if (!link.success || link.data.Status === 'VOIDED' || !link.data.SourceLineItemID || !link.data.ContactID) continue;
        if (link.data.Type && link.data.Type !== 'BILLABLEEXPENSE') continue;
        out.set(link.data.SourceLineItemID, link.data.ContactID);
      }
      if (rows.length < LINKED_PAGE) break;
    }
    return out;
  });

  function toLine(line: z.infer<typeof lineItemSchema>, currency: string, inclusive: boolean, accounts: Map<string, Account>, byCode: Map<string, Account>, billedTo: Map<string, string>): BooksLine {
    const account = (line.AccountID ? accounts.get(line.AccountID) : undefined) ?? (line.AccountCode ? byCode.get(line.AccountCode) : undefined);
    const accountId = account?.AccountID ?? line.AccountID ?? null;
    const item = present(line.ItemCode);
    const tracked = (line.Tracking ?? []).find((t) => present(t.Option));
    const gross = toMinor(line.LineAmount ?? 0, currency);
    const tax = toMinor(line.TaxAmount ?? 0, currency);
    return {
      // Net, as every other system keeps a line. Counted in minor units, so no float slips in.
      amountMinor: inclusive ? gross - tax : gross,
      description: present(line.Description),
      kind: item ? 'item' : accountId || present(line.AccountCode) ? 'account' : 'other',
      accountId,
      accountName: account?.Name ?? null,
      itemId: item,
      itemName: item,
      classId: tracked?.TrackingOptionID ?? null,
      className: present(tracked?.Option),
      customerId: (line.LineItemID && billedTo.get(line.LineItemID)) || null,
      taxCode: present(line.TaxType),
    };
  }

  const onOrAfter = (since: string) => {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
    if (!date) throw new BooksReadError('refused', `Not a date: ${since}`);
    return `Date>=DateTime(${date[1]},${date[2]},${date[3]})`;
  };

  async function lineContext() {
    const [{ byId, byCode }, billedTo] = await Promise.all([chart(), billable()]);
    return { byId, byCode, billedTo };
  }

  function toBill(b: z.infer<typeof invoiceSchema>, home: string, ctx: Awaited<ReturnType<typeof lineContext>>): BooksBill {
    const currency = b.CurrencyCode ?? home;
    const inclusive = b.LineAmountTypes === 'Inclusive';
    return {
      id: b.InvoiceID,
      // On a bill, the supplier's invoice number. Xero's screen calls it Reference.
      number: present(b.InvoiceNumber),
      vendorId: b.Contact?.ContactID ?? null,
      vendorName: present(b.Contact?.Name),
      date: xeroDay(b.Date),
      dueDate: xeroDay(b.DueDate),
      currency,
      totalMinor: toMinor(b.Total, currency),
      balanceMinor: typeof b.AmountDue === 'number' ? toMinor(b.AmountDue, currency) : null,
      taxMinor: typeof b.TotalTax === 'number' ? toMinor(b.TotalTax, currency) : null,
      // Every Xero bill goes to the one accounts payable account.
      payableAccountId: null,
      termsId: null,
      locationId: null,
      locationName: null,
      note: null,
      lines: (b.LineItems ?? []).map((line) => toLine(line, currency, inclusive, ctx.byId, ctx.byCode, ctx.billedTo)),
      createdAt: null,
      updatedAt: xeroTime(b.UpdatedDateUTC),
    };
  }

  const isBill = (b: z.infer<typeof invoiceSchema>) => (b.Type ?? 'ACCPAY') === 'ACCPAY';
  /** Asked for by type and status already. Checked again, so an answer that ignored either can't count a draft or a sale. */
  const studied = (b: z.infer<typeof invoiceSchema>) => isBill(b) && STUDIED_STATUSES.split(',').includes(b.Status ?? 'AUTHORISED');
  const listOf = (values: string[]) => values.join(',');

  return {
    system: 'xero',
    companyId: client.tenantId,

    async company(): Promise<BooksCompany> {
      const org = await organisation();
      const [currencies, tracking] = await Promise.all([list('Currencies', 'Currencies', currencySchema), list('TrackingCategories', 'TrackingCategories', trackingCategorySchema)]);
      const closingDate = later(xeroDay(org.PeriodLockDate), xeroDay(org.EndOfYearLockDate));
      return {
        id: client.tenantId,
        name: present(org.Name) ?? present(org.LegalName) ?? 'Xero organisation',
        country: present(org.CountryCode),
        homeCurrency: present(org.BaseCurrency),
        plan: present(org.Class),
        subscriptionStatus: present(org.OrganisationStatus),
        fiscalYearStartMonth: startMonth(org.FinancialYearEndMonth),
        industry: present(org.LineOfBusiness),
        closingDate,
        multiCurrency: currencies.parsed.length > 1,
        salesTax: Boolean(org.SalesTaxBasis && org.SalesTaxBasis !== 'NONE'),
        // Every Xero account but a bank account has a code.
        accountNumbers: true,
        classes: tracking.parsed.some((t) => (t.Status ?? 'ACTIVE') === 'ACTIVE') ? 'per_line' : 'off',
        locations: false,
        locationLabel: null,
      };
    },

    async closingDate() {
      const org = await organisation();
      return later(xeroDay(org.PeriodLockDate), xeroDay(org.EndOfYearLockDate));
    },

    async accounts() {
      const read = await chart();
      const records = read.parsed.map((a): BooksAccount => ({
        id: a.AccountID,
        name: a.Name,
        fullName: a.Name,
        number: present(a.Code),
        type: a.Type ?? null,
        subType: present(a.BankAccountType),
        group: a.Class ?? null,
        parentId: null,
        currency: a.CurrencyCode ?? null,
        active: (a.Status ?? 'ACTIVE') === 'ACTIVE',
      }));
      // One answer holds the whole chart, so the only missing accounts are ones that couldn't be read.
      return { records, expected: read.rows, missing: read.rows - records.length, problems: read.problems };
    },

    async vendors() {
      const [home, read] = await Promise.all([homeCurrency(), contacts()]);
      const vendors = read.records.filter((c) => !customerOnly(c));
      const records = vendors.map((c): BooksVendor => {
        const currency = c.DefaultCurrency ?? home;
        const address = (c.Addresses ?? []).find((a) => a.AddressType === 'POBOX' && a.AddressLine1) ?? (c.Addresses ?? []).find((a) => a.AddressLine1);
        const phone = (c.Phones ?? []).find((p) => p.PhoneNumber);
        const terms = c.PaymentTerms?.Bills;
        const owed = c.Balances?.AccountsPayable?.Outstanding;
        return {
          id: c.ContactID,
          name: c.Name,
          company: null,
          email: present(c.EmailAddress),
          phone: phone ? present([phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].filter(Boolean).join(' ')) : null,
          address: address
            ? present([address.AddressLine1, address.AddressLine2, address.City, address.Region, address.PostalCode, address.Country].filter(Boolean).join(', '))
            : null,
          accountNumber: present(c.AccountNumber),
          currency,
          balanceMinor: typeof owed === 'number' ? toMinor(owed, currency) : null,
          termsId: terms?.Type ? `${terms.Day ?? 0} ${terms.Type}` : null,
          active: (c.ContactStatus ?? 'ACTIVE') === 'ACTIVE',
          createdAt: null,
          updatedAt: xeroTime(c.UpdatedDateUTC),
        };
      });
      // Customers only were read and set aside, so they aren't missing.
      const expected = Math.max(records.length, read.expected - (read.records.length - vendors.length));
      return { records, expected, missing: Math.max(0, expected - records.length), problems: read.problems };
    },

    async bills(since) {
      const where = `Type=="ACCPAY" && ${onOrAfter(since)}`;
      const [home, ctx] = await Promise.all([homeCurrency(), lineContext()]);
      return readAll('Invoices', { where, Statuses: STUDIED_STATUSES }, invoiceSchema, (row) => String(row.InvoiceID ?? '?'), studied, (b) => toBill(b, home, ctx));
    },

    async billsLike({ numbers, vendorIds, since }) {
      const [home, ctx] = await Promise.all([homeCurrency(), lineContext()]);
      const found = new Map<string, BooksBill>();
      const keep = (rows: unknown) => {
        for (const row of Array.isArray(rows) ? rows : []) {
          const parsed = invoiceSchema.safeParse(row);
          if (parsed.success && isBill(parsed.data)) found.set(parsed.data.InvoiceID, toBill(parsed.data, home, ctx));
        }
      };
      if (numbers.length > 0) {
        keep((await ask('Invoices', { where: 'Type=="ACCPAY"', InvoiceNumbers: listOf(numbers), Statuses: LOOKALIKE_STATUSES, page: '1', pageSize: String(NUMBERED_MAX) })).Invoices);
      }
      if (vendorIds.length > 0) {
        const where = `Type=="ACCPAY" && ${onOrAfter(since)}`;
        keep((await ask('Invoices', { where, ContactIDs: listOf(vendorIds), Statuses: LOOKALIKE_STATUSES, page: '1', pageSize: String(PAGE_SIZE) })).Invoices);
      }
      return [...found.values()];
    },

    async expenses(since) {
      const where = `(Type=="SPEND" || Type=="RECEIVE") && Status=="AUTHORISED" && ${onOrAfter(since)}`;
      const [home, ctx, people] = await Promise.all([homeCurrency(), lineContext(), contacts()]);
      const byContact = new Map(people.records.map((c) => [c.ContactID, c]));
      const payee = (t: z.infer<typeof bankTransactionSchema>) => (t.Contact ? byContact.get(t.Contact.ContactID) : undefined);
      // Money out, and money back from a vendor: someone who isn't a customer, so it can't be a sale.
      // Other money in (a sale, a transfer, interest with nobody named) is not an expense.
      const keep = (t: z.infer<typeof bankTransactionSchema>) => {
        if (t.Status && t.Status !== 'AUTHORISED') return false;
        if (t.Type === 'SPEND') return true;
        const who = payee(t);
        return t.Type === 'RECEIVE' && Boolean(who) && who!.IsCustomer !== true;
      };
      return readAll('BankTransactions', { where }, bankTransactionSchema, (row) => String(row.BankTransactionID ?? '?'), keep, (t): BooksExpense => {
        const currency = t.CurrencyCode ?? home;
        const inclusive = t.LineAmountTypes === 'Inclusive';
        const who = payee(t);
        const fromAccount = t.BankAccount?.AccountID ? ctx.byId.get(t.BankAccount.AccountID) : undefined;
        return {
          id: t.BankTransactionID,
          number: present(t.Reference),
          payeeId: t.Contact?.ContactID ?? null,
          payeeName: present(t.Contact?.Name) ?? who?.Name ?? null,
          payeeType: t.Contact ? (who && customerOnly(who) ? 'Customer' : 'Vendor') : null,
          date: xeroDay(t.Date),
          currency,
          totalMinor: toMinor(t.Total, currency),
          taxMinor: typeof t.TotalTax === 'number' ? toMinor(t.TotalTax, currency) : null,
          paymentType: fromAccount?.BankAccountType === 'CREDITCARD' ? 'CreditCard' : fromAccount?.BankAccountType === 'PAYPAL' ? 'PayPal' : 'Bank',
          paidFromAccountId: t.BankAccount?.AccountID ?? null,
          paidFromAccountName: present(t.BankAccount?.Name) ?? fromAccount?.Name ?? null,
          refund: t.Type === 'RECEIVE',
          locationId: null,
          locationName: null,
          note: null,
          lines: (t.LineItems ?? []).map((line) => toLine(line, currency, inclusive, ctx.byId, ctx.byCode, ctx.billedTo)),
          createdAt: null,
          updatedAt: xeroTime(t.UpdatedDateUTC),
        };
      });
    },
  };
}
