// QuickBooks Online, read only, in the shape every system shares (books.ts).
//
// The client stays in this closure. What the harness gets back has no way to
// reach it, so it holds no way to write.

import { z } from 'zod';
import { getQuickBooksForOrg } from '../accounting/connections.js';
import { faultOf, QboError, qboLiteral } from '../accounting/quickbooks.js';
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

const PAGE_SIZE = 1000; // Intuit's maximum for one query.
const NUMBERED_MAX = 100; // Bills sharing a number: a handful, even across vendors.
const MAX_ATTEMPTS = 3;
const THROTTLE_WAIT_MS = 60_000; // Intuit: on a 429, wait 60 seconds.
const UNAVAILABLE_WAIT_MS = 5_000;
const MAX_PROBLEMS = 25;

const ref = z.object({ value: z.string(), name: z.string().nullish(), type: z.string().nullish() });
const meta = z.object({ CreateTime: z.string().nullish(), LastUpdatedTime: z.string().nullish() });
const tax = z.object({ TotalTax: z.number().nullish() });

const companyInfoSchema = z.object({
  CompanyName: z.string().nullish(),
  LegalName: z.string().nullish(),
  Country: z.string().nullish(),
  FiscalYearStartMonth: z.string().nullish(),
  NameValue: z.array(z.object({ Name: z.string().nullish(), Value: z.string().nullish() })).nullish(),
});

const preferencesSchema = z.object({
  AccountingInfoPrefs: z.object({
    BookCloseDate: z.string().nullish(),
    UseAccountNumbers: z.boolean().nullish(),
    TrackDepartments: z.boolean().nullish(),
    DepartmentTerminology: z.string().nullish(),
    ClassTrackingPerTxn: z.boolean().nullish(),
    ClassTrackingPerTxnLine: z.boolean().nullish(),
  }).nullish(),
  CurrencyPrefs: z.object({ MultiCurrencyEnabled: z.boolean().nullish(), HomeCurrency: ref.nullish() }).nullish(),
  TaxPrefs: z.object({ UsingSalesTax: z.boolean().nullish() }).nullish(),
});

const accountSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  FullyQualifiedName: z.string().nullish(),
  AcctNum: z.string().nullish(),
  AccountType: z.string().nullish(),
  AccountSubType: z.string().nullish(),
  Classification: z.string().nullish(),
  ParentRef: ref.nullish(),
  CurrencyRef: ref.nullish(),
  Active: z.boolean().nullish(),
});

const vendorSchema = z.object({
  Id: z.string(),
  DisplayName: z.string(),
  CompanyName: z.string().nullish(),
  PrimaryEmailAddr: z.object({ Address: z.string().nullish() }).nullish(),
  PrimaryPhone: z.object({ FreeFormNumber: z.string().nullish() }).nullish(),
  BillAddr: z.object({
    Line1: z.string().nullish(),
    Line2: z.string().nullish(),
    City: z.string().nullish(),
    CountrySubDivisionCode: z.string().nullish(),
    PostalCode: z.string().nullish(),
    Country: z.string().nullish(),
  }).nullish(),
  AcctNum: z.string().nullish(),
  CurrencyRef: ref.nullish(),
  Balance: z.number().nullish(),
  TermRef: ref.nullish(),
  Active: z.boolean().nullish(),
  MetaData: meta.nullish(),
});

const lineDetail = z.object({
  AccountRef: ref.nullish(),
  ItemRef: ref.nullish(),
  ClassRef: ref.nullish(),
  CustomerRef: ref.nullish(),
  TaxCodeRef: ref.nullish(),
});

const lineSchema = z.object({
  Amount: z.number().nullish(),
  Description: z.string().nullish(),
  AccountBasedExpenseLineDetail: lineDetail.nullish(),
  ItemBasedExpenseLineDetail: lineDetail.nullish(),
});

const billSchema = z.object({
  Id: z.string(),
  DocNumber: z.string().nullish(),
  VendorRef: ref.nullish(),
  TxnDate: z.string().nullish(),
  DueDate: z.string().nullish(),
  CurrencyRef: ref.nullish(),
  TotalAmt: z.number(),
  Balance: z.number().nullish(),
  TxnTaxDetail: tax.nullish(),
  APAccountRef: ref.nullish(),
  SalesTermRef: ref.nullish(),
  DepartmentRef: ref.nullish(),
  PrivateNote: z.string().nullish(),
  Line: z.array(lineSchema).nullish(),
  MetaData: meta.nullish(),
});

const purchaseSchema = z.object({
  Id: z.string(),
  DocNumber: z.string().nullish(),
  EntityRef: ref.nullish(),
  TxnDate: z.string().nullish(),
  CurrencyRef: ref.nullish(),
  TotalAmt: z.number(),
  TxnTaxDetail: tax.nullish(),
  PaymentType: z.string().nullish(),
  AccountRef: ref.nullish(),
  Credit: z.boolean().nullish(),
  DepartmentRef: ref.nullish(),
  PrivateNote: z.string().nullish(),
  Line: z.array(lineSchema).nullish(),
  MetaData: meta.nullish(),
});

/** The part of the client a reader may use. */
type QueryClient = { realmId: string; query(sql: string): Promise<unknown> };

function named(error: unknown): BooksReadError {
  if (error instanceof BooksReadError) return error;
  if (error instanceof QboError) {
    const fault = faultOf(error.body);
    const message = fault?.message ?? `QuickBooks answered ${error.status}.`;
    if (error.isAuthInvalid || error.status === 401) return new BooksReadError('sign_in_lost', message);
    if (error.status === 429) return new BooksReadError('throttled', message);
    if (error.status === 403 || fault?.code === '120' || fault?.code === '3100' || fault?.code === '5020') {
      return new BooksReadError('no_access', message);
    }
    // Its body may be an outage page. The status says enough.
    if (error.status >= 500) return new BooksReadError('unavailable', `QuickBooks answered ${error.status}.`);
    return new BooksReadError('refused', message);
  }
  return new BooksReadError('unavailable', error instanceof Error ? error.message : String(error));
}

const present = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

export function quickBooksReader(client: QueryClient, options: { wait?: (ms: number) => Promise<void> } = {}): BooksReader {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  /** One query. Waits and tries again when that can help; any other failure comes back named. */
  async function ask(sql: string): Promise<Record<string, unknown>> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const answer = await client.query(sql) as { QueryResponse?: Record<string, unknown>; Fault?: unknown };
        if (answer?.Fault) throw new QboError(200, answer);
        if (!answer?.QueryResponse) throw new BooksReadError('refused', 'QuickBooks answered without a result.');
        return answer.QueryResponse;
      } catch (error) {
        const failure = named(error);
        const retryIn = failure.kind === 'throttled' ? THROTTLE_WAIT_MS : failure.kind === 'unavailable' ? UNAVAILABLE_WAIT_MS : null;
        if (retryIn === null || attempt >= MAX_ATTEMPTS) throw failure;
        await wait(retryIn);
      }
    }
  }

  async function single<S extends z.ZodTypeAny>(entity: string, schema: S): Promise<z.infer<S>> {
    const rows = (await ask(`SELECT * FROM ${entity}`))[entity] as unknown[] | undefined;
    const parsed = schema.safeParse(rows?.[0]);
    if (!parsed.success) throw new BooksReadError('refused', `QuickBooks returned ${entity} in a shape Decimal cannot read.`);
    return parsed.data;
  }

  // Both come from the same answer, and every money read needs the currency.
  let preferences: Promise<z.infer<typeof preferencesSchema>> | null = null;
  const prefs = () => {
    preferences ??= single('Preferences', preferencesSchema).catch((error) => {
      preferences = null;
      throw error;
    });
    return preferences;
  };
  const homeCurrency = async () => (await prefs()).CurrencyPrefs?.HomeCurrency?.value ?? 'USD';

  /** Every record, page by page, checked against the count Intuit gives when asked separately. */
  async function readAll<S extends z.ZodType<{ Id: string }>, T>(
    entity: string,
    where: string,
    schema: S,
    toRecord: (row: z.infer<S>) => T,
  ): Promise<BooksRead<T>> {
    const counted = (await ask(`SELECT COUNT(*) FROM ${entity}${where}`)).totalCount;
    const expected = typeof counted === 'number' ? counted : 0;
    const records: T[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    for (let start = 1; ; start += PAGE_SIZE) {
      const page = ((await ask(`SELECT * FROM ${entity}${where} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`))[entity] ?? []) as Array<{ Id?: unknown }>;
      let fresh = 0;
      for (const row of page) {
        const id = String(row?.Id ?? '?');
        // A row can shift across a page boundary while reading.
        if (seen.has(id)) continue;
        seen.add(id);
        fresh += 1;
        const parsed = schema.safeParse(row);
        if (parsed.success) records.push(toRecord(parsed.data));
        else if (problems.length < MAX_PROBLEMS) {
          const issue = parsed.error.issues[0];
          problems.push(`${entity} ${id}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'unreadable'}`.trim());
        }
      }
      // A short page is the last one. A full page of nothing new would otherwise never end.
      if (page.length < PAGE_SIZE || fresh === 0) break;
    }
    return { records, expected, missing: Math.max(0, expected - records.length), problems };
  }

  function toLine(line: z.infer<typeof lineSchema>, currency: string): BooksLine {
    const detail = line.AccountBasedExpenseLineDetail ?? line.ItemBasedExpenseLineDetail ?? null;
    return {
      amountMinor: toMinor(line.Amount ?? 0, currency),
      description: present(line.Description),
      kind: line.AccountBasedExpenseLineDetail ? 'account' : line.ItemBasedExpenseLineDetail ? 'item' : 'other',
      accountId: detail?.AccountRef?.value ?? null,
      accountName: detail?.AccountRef?.name ?? null,
      itemId: detail?.ItemRef?.value ?? null,
      itemName: detail?.ItemRef?.name ?? null,
      classId: detail?.ClassRef?.value ?? null,
      className: detail?.ClassRef?.name ?? null,
      customerId: detail?.CustomerRef?.value ?? null,
      taxCode: detail?.TaxCodeRef?.value ?? null,
    };
  }

  const onOrAfter = (since: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new BooksReadError('refused', `Not a date: ${since}`);
    return ` WHERE TxnDate >= '${since}'`;
  };

  function toBill(b: z.infer<typeof billSchema>, home: string): BooksBill {
    const currency = b.CurrencyRef?.value ?? home;
    return {
      id: b.Id,
      number: present(b.DocNumber),
      vendorId: b.VendorRef?.value ?? null,
      vendorName: b.VendorRef?.name ?? null,
      date: b.TxnDate ?? null,
      dueDate: b.DueDate ?? null,
      currency,
      totalMinor: toMinor(b.TotalAmt, currency),
      balanceMinor: typeof b.Balance === 'number' ? toMinor(b.Balance, currency) : null,
      taxMinor: typeof b.TxnTaxDetail?.TotalTax === 'number' ? toMinor(b.TxnTaxDetail.TotalTax, currency) : null,
      payableAccountId: b.APAccountRef?.value ?? null,
      termsId: b.SalesTermRef?.value ?? null,
      locationId: b.DepartmentRef?.value ?? null,
      locationName: b.DepartmentRef?.name ?? null,
      note: present(b.PrivateNote),
      lines: (b.Line ?? []).map((line) => toLine(line, currency)),
      createdAt: b.MetaData?.CreateTime ?? null,
      updatedAt: b.MetaData?.LastUpdatedTime ?? null,
    };
  }

  const quoted = (values: string[]) => values.map((v) => `'${qboLiteral(v)}'`).join(', ');

  return {
    system: 'quickbooks',
    companyId: client.realmId,

    async company(): Promise<BooksCompany> {
      const info = await single('CompanyInfo', companyInfoSchema);
      const settings = await prefs();
      const accounting = settings.AccountingInfoPrefs;
      const nameValue = (name: string) => present(info.NameValue?.find((n) => n.Name === name)?.Value);
      const locations = accounting?.TrackDepartments === true;
      return {
        id: client.realmId,
        name: present(info.CompanyName) ?? present(info.LegalName) ?? 'QuickBooks company',
        country: present(info.Country),
        homeCurrency: settings.CurrencyPrefs?.HomeCurrency?.value ?? null,
        plan: nameValue('OfferingSku'),
        subscriptionStatus: nameValue('SubscriptionStatus'),
        fiscalYearStartMonth: present(info.FiscalYearStartMonth),
        industry: nameValue('QBOIndustryType'),
        closingDate: present(accounting?.BookCloseDate),
        multiCurrency: settings.CurrencyPrefs?.MultiCurrencyEnabled === true,
        salesTax: settings.TaxPrefs?.UsingSalesTax === true,
        accountNumbers: accounting?.UseAccountNumbers === true,
        classes: accounting?.ClassTrackingPerTxnLine ? 'per_line' : accounting?.ClassTrackingPerTxn ? 'per_transaction' : 'off',
        locations,
        locationLabel: locations ? present(accounting?.DepartmentTerminology) : null,
      };
    },

    async closingDate() {
      return present((await prefs()).AccountingInfoPrefs?.BookCloseDate);
    },

    accounts() {
      return readAll('Account', ' WHERE Active IN (true, false)', accountSchema, (a): BooksAccount => ({
        id: a.Id,
        name: a.Name,
        fullName: a.FullyQualifiedName ?? a.Name,
        number: present(a.AcctNum),
        type: a.AccountType ?? null,
        subType: a.AccountSubType ?? null,
        group: a.Classification ?? null,
        parentId: a.ParentRef?.value ?? null,
        currency: a.CurrencyRef?.value ?? null,
        active: a.Active !== false,
      }));
    },

    async vendors() {
      const home = await homeCurrency();
      return readAll('Vendor', ' WHERE Active IN (true, false)', vendorSchema, (v): BooksVendor => {
        const currency = v.CurrencyRef?.value ?? home;
        const address = v.BillAddr;
        return {
          id: v.Id,
          name: v.DisplayName,
          company: present(v.CompanyName),
          email: present(v.PrimaryEmailAddr?.Address),
          phone: present(v.PrimaryPhone?.FreeFormNumber),
          address: address
            ? present([address.Line1, address.Line2, address.City, address.CountrySubDivisionCode, address.PostalCode, address.Country].filter(Boolean).join(', '))
            : null,
          accountNumber: present(v.AcctNum),
          currency,
          balanceMinor: typeof v.Balance === 'number' ? toMinor(v.Balance, currency) : null,
          termsId: v.TermRef?.value ?? null,
          active: v.Active !== false,
          createdAt: v.MetaData?.CreateTime ?? null,
          updatedAt: v.MetaData?.LastUpdatedTime ?? null,
        };
      });
    },

    async bills(since) {
      const where = onOrAfter(since);
      const home = await homeCurrency();
      return readAll('Bill', where, billSchema, (b) => toBill(b, home));
    },

    // Number matching in QuickBooks ignores case, and IN takes a list (both tried on
    // a sandbox, 5 Nov 2026). A row it can't read is left out: this is a lookup, not
    // a count that has to add up.
    async billsLike({ numbers, vendorIds, since }) {
      const home = await homeCurrency();
      const found = new Map<string, BooksBill>();
      const keep = (rows: unknown) => {
        for (const row of Array.isArray(rows) ? rows : []) {
          const parsed = billSchema.safeParse(row);
          if (parsed.success) found.set(parsed.data.Id, toBill(parsed.data, home));
        }
      };
      if (numbers.length > 0) {
        keep((await ask(`SELECT * FROM Bill WHERE DocNumber IN (${quoted(numbers)}) MAXRESULTS ${NUMBERED_MAX}`)).Bill);
      }
      if (vendorIds.length > 0) {
        const dated = onOrAfter(since).replace(' WHERE ', ' AND ');
        keep((await ask(`SELECT * FROM Bill WHERE VendorRef IN (${quoted(vendorIds)})${dated} MAXRESULTS ${PAGE_SIZE}`)).Bill);
      }
      return [...found.values()];
    },

    async expenses(since) {
      const where = onOrAfter(since);
      const home = await homeCurrency();
      return readAll('Purchase', where, purchaseSchema, (p): BooksExpense => {
        const currency = p.CurrencyRef?.value ?? home;
        return {
          id: p.Id,
          number: present(p.DocNumber),
          payeeId: p.EntityRef?.value ?? null,
          payeeName: p.EntityRef?.name ?? null,
          payeeType: p.EntityRef?.type ?? null,
          date: p.TxnDate ?? null,
          currency,
          totalMinor: toMinor(p.TotalAmt, currency),
          taxMinor: typeof p.TxnTaxDetail?.TotalTax === 'number' ? toMinor(p.TxnTaxDetail.TotalTax, currency) : null,
          paymentType: p.PaymentType ?? null,
          paidFromAccountId: p.AccountRef?.value ?? null,
          paidFromAccountName: p.AccountRef?.name ?? null,
          refund: p.Credit === true,
          locationId: p.DepartmentRef?.value ?? null,
          locationName: p.DepartmentRef?.name ?? null,
          note: present(p.PrivateNote),
          lines: (p.Line ?? []).map((line) => toLine(line, currency)),
          createdAt: p.MetaData?.CreateTime ?? null,
          updatedAt: p.MetaData?.LastUpdatedTime ?? null,
        };
      });
    },
  };
}

/** A reader for this organisation's connected books, or null when there is no live connection. */
export async function readerForOrganization(organizationId: string): Promise<BooksReader | null> {
  const client = await getQuickBooksForOrg(organizationId);
  return client ? quickBooksReader(client) : null;
}
