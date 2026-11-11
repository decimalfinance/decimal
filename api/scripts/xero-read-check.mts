// Read a real Xero organisation on the bench, two ways, and compare: through the
// reader, as a setup reads it, and through Xero's API asked plainly (whole lists,
// no where clause, no statuses), counted here. A where clause or a status filter
// Xero reads differently from the reader shows up as two counts that disagree.
// It only reads. It prints the organisation's details, counts and field names,
// and never a token.
//
// Run from api/, with the bench up and Xero signed in for the organisation:
//   DATABASE_URL=postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_bench \
//     npx tsx scripts/xero-read-check.mts <organizationId> [out.json]
//
// It refuses to run against anything but the bench: reading renews the sign-in,
// and the renewal belongs to whichever database holds it.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The Xero app's keys come from api/.env, which also points at the dev database,
// so keep the database URL the caller gave.
const requestedDb = process.env.DATABASE_URL;
try { process.loadEnvFile(join(import.meta.dirname, '..', '.env')); } catch { /* no .env: rely on the environment */ }
process.env.DATABASE_URL = requestedDb;
if (!/\/usdc_ops_bench(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing to run: DATABASE_URL must point at usdc_ops_bench.');
  process.exit(2);
}

const [organizationId, out] = process.argv.slice(2);
if (!organizationId) {
  console.error('usage: xero-read-check.mts <organizationId> [out.json]');
  process.exit(2);
}

const { xeroClientFor } = await import('../src/integrations/xero-connector.js');
const { xeroReader, xeroDay } = await import('../src/integrations/xero-reader.js');
const { BooksReadError } = await import('../src/integrations/books.js');
const { prisma } = await import('../src/infra/prisma.js');

const client = await xeroClientFor(organizationId);
if (!client) {
  console.error('This organisation has no live Xero connection on the bench.');
  process.exit(1);
}
const reader = xeroReader(client);

type Row = Record<string, unknown>;

/** Every record of a list, page by page, as Xero sends it. Says whether Xero sent a page count. */
async function everything(endpoint: string, query: Record<string, string> = {}) {
  const rows: Row[] = [];
  let paged = false;
  for (let page = 1; page <= 200; page += 1) {
    const answer = (await client!.get(endpoint, { ...query, page: String(page), pageSize: '1000' })) as Record<string, unknown>;
    const got = (answer[endpoint] ?? []) as Row[];
    const pagination = answer.pagination as { pageCount?: number } | undefined;
    if (pagination) paged = true;
    rows.push(...got);
    if (pagination?.pageCount !== undefined ? page >= pagination.pageCount : got.length === 0) break;
  }
  return { rows, paged };
}

const tally = (values: unknown[]) => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[String(value ?? '(none)')] = (counts[String(value ?? '(none)')] ?? 0) + 1;
  return counts;
};
const fieldsOf = (rows: Row[]) => [...new Set(rows.slice(0, 25).flatMap((r) => Object.keys(r)))].sort();
const read = async <T,>(what: string, work: () => Promise<T>) => {
  try {
    return await work();
  } catch (error) {
    const name = error instanceof BooksReadError ? `${error.kind}: ${error.message}` : String(error);
    console.log(`${what} failed: ${name}`);
    return null;
  }
};

// Two years back, the study's window.
const since = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);

const organisation = ((await client.get('Organisation')) as { Organisations: Row[] }).Organisations[0] ?? {};
const company = await read('company', () => reader.company());
const accounts = await read('accounts', () => reader.accounts());
const vendors = await read('vendors', () => reader.vendors());
const bills = await read('bills', () => reader.bills(since));
const expenses = await read('expenses', () => reader.expenses(since));

const plainAccounts = ((await client.get('Accounts')) as { Accounts: Row[] }).Accounts;
const contacts = await everything('Contacts', { includeArchived: 'true' });
const invoices = await everything('Invoices');
const bank = await everything('BankTransactions');
const linked = ((await client.get('LinkedTransactions', { page: '1' })) as { LinkedTransactions?: Row[] }).LinkedTransactions ?? [];

const customerOnly = (c: Row) => c.IsCustomer === true && c.IsSupplier !== true;
const byId = new Map(contacts.rows.map((c) => [String(c.ContactID), c]));
const inWindow = (r: Row) => (xeroDay(r.Date as string) ?? '') >= since;
const studiedBills = invoices.rows.filter((r) => r.Type === 'ACCPAY' && ['SUBMITTED', 'AUTHORISED', 'PAID'].includes(String(r.Status)) && inWindow(r));
// Money out, and money back from someone who isn't a customer: the reader's rule, applied to the whole list.
const studiedExpenses = bank.rows.filter((r) => {
  if (r.Status !== 'AUTHORISED' || !inWindow(r)) return false;
  if (r.Type === 'SPEND') return true;
  const who = byId.get(String((r.Contact as Row | undefined)?.ContactID ?? ''));
  return r.Type === 'RECEIVE' && Boolean(who) && who!.IsCustomer !== true;
});

const report = {
  since,
  organisation: {
    name: organisation.Name, legalName: organisation.LegalName, isDemoCompany: organisation.IsDemoCompany, class: organisation.Class,
    country: organisation.CountryCode, currency: organisation.BaseCurrency, status: organisation.OrganisationStatus,
    periodLockDate: xeroDay(organisation.PeriodLockDate as string), endOfYearLockDate: xeroDay(organisation.EndOfYearLockDate as string),
    salesTaxBasis: organisation.SalesTaxBasis, financialYearEndMonth: organisation.FinancialYearEndMonth,
  },
  readerCompany: company,
  counts: {
    accounts: { reader: accounts?.records.length ?? null, readerExpected: accounts?.expected ?? null, plain: plainAccounts.length },
    vendors: { reader: vendors?.records.length ?? null, readerExpected: vendors?.expected ?? null, plain: contacts.rows.filter((c) => !customerOnly(c)).length, contactsInAll: contacts.rows.length },
    bills: { reader: bills?.records.length ?? null, readerExpected: bills?.expected ?? null, readerMissing: bills?.missing ?? null, plain: studiedBills.length },
    expenses: { reader: expenses?.records.length ?? null, readerExpected: expenses?.expected ?? null, readerMissing: expenses?.missing ?? null, plain: studiedExpenses.length },
  },
  // In cents, summed apart: the reader's from its records, the plain one from Xero's own Total on each.
  totals: {
    bills: { reader: String((bills?.records ?? []).reduce((n, b) => n + b.totalMinor, 0n)), plain: String(studiedBills.reduce((n, r) => n + BigInt(Math.round(Number(r.Total) * 100)), 0n)) },
    expenses: { reader: String((expenses?.records ?? []).reduce((n, e) => n + e.totalMinor, 0n)), plain: String(studiedExpenses.reduce((n, r) => n + BigInt(Math.round(Number(r.Total) * 100)), 0n)) },
  },
  problems: { vendors: vendors?.problems ?? [], bills: bills?.problems ?? [], expenses: expenses?.problems ?? [] },
  paged: { contacts: contacts.paged, invoices: invoices.paged, bankTransactions: bank.paged },
  invoices: { all: invoices.rows.length, byType: tally(invoices.rows.map((r) => r.Type)), billsByStatus: tally(invoices.rows.filter((r) => r.Type === 'ACCPAY').map((r) => r.Status)) },
  bankTransactions: { all: bank.rows.length, byType: tally(bank.rows.map((r) => r.Type)), byStatus: tally(bank.rows.map((r) => r.Status)) },
  linkedTransactions: { firstPage: linked.length, byType: tally(linked.map((r) => r.Type)), byStatus: tally(linked.map((r) => r.Status)) },
  lines: {
    billLines: (bills?.records ?? []).reduce((n, b) => n + b.lines.length, 0),
    withItems: (bills?.records ?? []).filter((b) => b.lines.some((l) => l.kind === 'item')).length,
    withTracking: (bills?.records ?? []).filter((b) => b.lines.some((l) => l.classId)).length,
    billable: (bills?.records ?? []).filter((b) => b.lines.some((l) => l.customerId)).length,
    otherCurrency: (bills?.records ?? []).filter((b) => b.currency !== (company?.homeCurrency ?? 'USD')).length,
  },
  fields: { Invoices: fieldsOf(invoices.rows.filter((r) => r.Type === 'ACCPAY')), BankTransactions: fieldsOf(bank.rows), Contacts: fieldsOf(contacts.rows) },
};

console.log(JSON.stringify(report, null, 2));
if (out) await writeFile(out, JSON.stringify(report, null, 2));
await prisma.$disconnect();
