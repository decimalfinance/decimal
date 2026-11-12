// Evaluate the multi-invoice split against the real model, on the bench.
//
// Each case is one PDF from the M-series (synthetic_data/invoices/M-multi-invoice/,
// TESTING-INVOICES.md) holding several invoices, a slip, a cover page, or two
// invoices on one page, with the bills and page ranges to expect in catalog.json.
// For each, a fresh organization is seeded, the file is uploaded through the real
// intake (real extraction, real split), and every bill's pages are checked.
//
// A bill's pages: its own pages when the upload was split (draft.upload.pages),
// else the whole upload. So a case the split rightly leaves alone, two invoices on
// one page, passes with both bills on the one page.
//
// Run from api/, with the bench up (`make bench`):
//   npx tsx scripts/multi-invoice-eval.mts [caseId ...]
//
// It talks to the bench's API only (:3200), which runs on usdc_ops_bench.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BENCH = 'http://127.0.0.1:3200';
// synthetic_data/ is gitignored, so a worktree has none of its own: point
// INVOICES_DIR at the checkout that does.
const INVOICES = process.env.INVOICES_DIR ?? join(import.meta.dirname, '..', '..', 'synthetic_data', 'invoices');

// DEV_AUTH_SECRET comes from api/.env. Nothing else in it is used.
try { process.loadEnvFile(join(import.meta.dirname, '..', '.env')); } catch { /* no .env: rely on the environment */ }
const secret = process.env.DEV_AUTH_SECRET;
if (!secret) { console.error('DEV_AUTH_SECRET is not set (api/.env).'); process.exit(2); }

type Expected = { vendor: string; invoiceNumber: string; total: string; pages: [number, number] };
type Case = { id: string; file: string; expectBills: Expected[]; expect: string };

async function call(path: string, body: unknown, token?: string, method = 'POST') {
  const res = await fetch(`${BENCH}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Invoice numbers as people compare them: case, spaces and dashes aside. */
const same = (a: string | null | undefined, b: string) => (a ?? '').replace(/[\s-]/g, '').toUpperCase() === b.replace(/[\s-]/g, '').toUpperCase();

async function runCase(c: Case) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const seed = await call('/auth/dev/seed', {
    secret, organizationName: `Eval ${c.id} ${stamp}`,
    owner: { email: `eval-${stamp}@dev.decimal.test`, displayName: 'Eval Owner' },
  });
  const orgId = seed.organizationId as string;
  const token = seed.users[0].sessionToken as string;
  // Under a neutral name: the catalog's names give the answer away.
  const bytes = await readFile(join(INVOICES, c.file));
  const started = Date.now();
  const out = await call(`/organizations/${orgId}/invoices/upload`, {
    filename: `upload-${randomBytes(2).toString('hex')}.pdf`, mimeType: 'application/pdf', dataBase64: bytes.toString('base64'), autoAdvance: false,
  }, token);
  const ms = Date.now() - started;
  const uploadPages = Number(out?.pageCount ?? 0) || null;
  const bills = await Promise.all(((out?.paymentOrders ?? []) as Array<{ paymentOrder: { paymentOrderId: string; invoiceNumber: string | null } }>).map(async ({ paymentOrder }) => {
    const draft = await call(`/organizations/${orgId}/bills/${paymentOrder.paymentOrderId}/draft`, null, token, 'GET');
    const whole = draft.upload?.pageCount ?? draft.document?.pageCount ?? uploadPages ?? 0;
    const own = draft.upload?.pages as { from: number; to: number } | null | undefined;
    return {
      invoiceNumber: paymentOrder.invoiceNumber,
      pages: own ? [own.from, own.to] as [number, number] : [1, whole] as [number, number],
      split: Boolean(own),
      shown: draft.document?.pageCount as number | null,
    };
  }));
  return { bills, ms };
}

const catalog = JSON.parse(await readFile(join(INVOICES, 'catalog.json'), 'utf8')) as Array<Record<string, unknown>>;
const only = process.argv.slice(2);
const cases = catalog
  .filter((e) => Array.isArray(e.expectBills))
  .map((e) => e as unknown as Case)
  .filter((c) => only.length === 0 || only.includes(c.id));
if (cases.length === 0) { console.error('No cases matched.'); process.exit(2); }

let right = 0;
for (const c of cases) {
  process.stdout.write(`\n▶ ${c.id}: ${c.expect}\n`);
  try {
    const { bills, ms } = await runCase(c);
    const problems: string[] = [];
    if (bills.length !== c.expectBills.length) problems.push(`${bills.length} bills, expected ${c.expectBills.length}`);
    for (const e of c.expectBills) {
      const bill = bills.find((b) => same(b.invoiceNumber, e.invoiceNumber));
      if (!bill) { problems.push(`no bill for ${e.invoiceNumber}`); continue; }
      const ok = bill.pages[0] === e.pages[0] && bill.pages[1] === e.pages[1];
      const showsOwn = !bill.split || bill.shown === bill.pages[1] - bill.pages[0] + 1;
      console.log(`  ${ok && showsOwn ? '✓' : '✗'} ${e.invoiceNumber}: pages ${bill.pages[0]}-${bill.pages[1]}${bill.split ? ' (its own)' : ' (the whole upload)'}, expected ${e.pages[0]}-${e.pages[1]}${showsOwn ? '' : `; its document has ${bill.shown} pages`}`);
      if (!ok) problems.push(`${e.invoiceNumber} on pages ${bill.pages.join('-')}, expected ${e.pages.join('-')}`);
      if (!showsOwn) problems.push(`${e.invoiceNumber}'s document has ${bill.shown} pages`);
    }
    for (const b of bills) if (!c.expectBills.some((e) => same(b.invoiceNumber, e.invoiceNumber))) problems.push(`an extra bill, ${b.invoiceNumber ?? 'with no number'}`);
    if (problems.length === 0) right += 1;
    console.log(`  ${problems.length === 0 ? 'PASS' : `FAIL: ${problems.join('; ')}`} · ${(ms / 1000).toFixed(1)} s`);
  } catch (error) {
    console.log(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${right}/${cases.length} uploads split right`);
process.exit(right === cases.length ? 0 : 1);
