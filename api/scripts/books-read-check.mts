// Read a real QuickBooks company through the connector, on the bench, and report
// what came back: the check no fake can do. It only reads. It prints company
// details, counts and field names, and never a token.
//
// Run from api/, with the bench up and QuickBooks connected to the organisation:
//   DATABASE_URL=postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_bench \
//     npx tsx scripts/books-read-check.mts <organizationId> [out.json]
//
// It refuses to run against anything but the bench: reading refreshes tokens, and
// those belong to whichever database holds them.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// QuickBooks keys come from api/.env, which also points at the dev database, so
// keep the database URL the caller gave.
const requestedDb = process.env.DATABASE_URL;
try { process.loadEnvFile(join(import.meta.dirname, '..', '.env')); } catch { /* no .env: rely on the environment */ }
process.env.DATABASE_URL = requestedDb;
if (!/\/usdc_ops_bench(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing to run: DATABASE_URL must point at usdc_ops_bench.');
  process.exit(2);
}

const [organizationId, out] = process.argv.slice(2);
if (!organizationId) {
  console.error('usage: books-read-check.mts <organizationId> [out.json]');
  process.exit(2);
}

const { getQuickBooksForOrg } = await import('../src/accounting/connections.js');
const { readerForOrganization } = await import('../src/integrations/quickbooks-reader.js');
const { BooksReadError } = await import('../src/integrations/books.js');
const { prisma } = await import('../src/infra/prisma.js');

const reader = await readerForOrganization(organizationId);
const client = await getQuickBooksForOrg(organizationId);
if (!reader || !client) {
  console.error('This organisation has no live QuickBooks connection on the bench.');
  process.exit(1);
}

/** Tally how often each value occurs. */
const tally = (values: Array<string | null | undefined>) => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value ?? '(none)'] = (counts[value ?? '(none)'] ?? 0) + 1;
  return counts;
};

/** The fields Intuit actually sends for an entity, from the first records. It shows what the reader ignores. */
async function fieldsOf(entity: string): Promise<string[]> {
  const answer = await client!.query<{ QueryResponse?: Record<string, Array<Record<string, unknown>>> }>(`SELECT * FROM ${entity} MAXRESULTS 25`);
  const seen = new Set<string>();
  for (const row of answer.QueryResponse?.[entity] ?? []) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen].sort();
}

// Two years back, the study's window.
const since = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);

/** Each part on its own, so one failure reports its name and the rest still run. */
async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | { failed: string; message: string }> {
  const started = Date.now();
  try {
    const value = await run();
    console.error(`  ${what}: ${Date.now() - started}ms`);
    return value;
  } catch (error) {
    const failed = error instanceof BooksReadError ? error.kind : 'unexpected';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ${what}: FAILED ${failed}: ${message}`);
    return { failed, message };
  }
}

const isFailure = (value: unknown): value is { failed: string; message: string } => typeof value === 'object' && value !== null && 'failed' in value;

const company = await attempt('company', () => reader.company());
const accounts = await attempt('accounts', () => reader.accounts());
const vendors = await attempt('vendors', () => reader.vendors());
const bills = await attempt('bills', () => reader.bills(since));
const expenses = await attempt('expenses', () => reader.expenses(since));

const counts = (read: unknown) => {
  if (isFailure(read)) return read;
  const r = read as { records: unknown[]; expected: number; missing: number; problems: string[] };
  return { read: r.records.length, expected: r.expected, missing: r.missing, problems: r.problems.slice(0, 10) };
};

const lines = isFailure(bills) ? [] : bills.records.flatMap((b) => b.lines);
const report = {
  checkedAt: new Date().toISOString(),
  since,
  company,
  reads: { accounts: counts(accounts), vendors: counts(vendors), bills: counts(bills), expenses: counts(expenses) },
  shape: {
    accountsByGroup: isFailure(accounts) ? null : tally(accounts.records.map((a) => a.group)),
    inactiveAccounts: isFailure(accounts) ? null : accounts.records.filter((a) => !a.active).length,
    inactiveVendors: isFailure(vendors) ? null : vendors.records.filter((v) => !v.active).length,
    billCurrencies: isFailure(bills) ? null : tally(bills.records.map((b) => b.currency)),
    billDates: isFailure(bills) || bills.records.length === 0 ? null : {
      first: bills.records.map((b) => b.date ?? '').sort()[0],
      last: bills.records.map((b) => b.date ?? '').sort().at(-1),
    },
    billsWithoutVendor: isFailure(bills) ? null : bills.records.filter((b) => !b.vendorId).length,
    billsWithTax: isFailure(bills) ? null : bills.records.filter((b) => b.taxMinor !== null && b.taxMinor !== 0n).length,
    billsWithLocation: isFailure(bills) ? null : bills.records.filter((b) => b.locationId).length,
    billLinesByKind: tally(lines.map((l) => l.kind)),
    billLinesWithClass: lines.filter((l) => l.classId).length,
    billLinesWithoutDescription: lines.filter((l) => !l.description).length,
    expensesByPayment: isFailure(expenses) ? null : tally(expenses.records.map((e) => e.paymentType)),
    expensesByPayee: isFailure(expenses) ? null : tally(expenses.records.map((e) => e.payeeType)),
    expenseRefunds: isFailure(expenses) ? null : expenses.records.filter((e) => e.refund).length,
  },
  samples: {
    bill: isFailure(bills) ? null : bills.records.find((b) => b.lines.length > 1) ?? bills.records[0] ?? null,
    expense: isFailure(expenses) ? null : expenses.records[0] ?? null,
    vendor: isFailure(vendors) ? null : vendors.records[0] ?? null,
    account: isFailure(accounts) ? null : accounts.records[0] ?? null,
  },
  fieldsIntuitSends: Object.fromEntries(await Promise.all(
    ['CompanyInfo', 'Preferences', 'Account', 'Vendor', 'Bill', 'Purchase'].map(async (entity) => [entity, await attempt(`fields of ${entity}`, () => fieldsOf(entity))]),
  )),
};

const json = JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
if (out) await writeFile(out, `${json}\n`);
console.log(json);
await prisma.$disconnect();
