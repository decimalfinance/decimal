// Evaluate the arithmetic investigator (src/exceptions/arithmetic.ts) against the
// real model, on the bench.
//
// Each case is an R-series invoice (synthetic_data/invoices/R-arithmetic/,
// TESTING-INVOICES.md) with its answer in catalog.json: the figure a reading
// misses, the one it misreads, or none because the document disagrees with
// itself. For each, a fresh organization is seeded and the PDF goes through the
// real intake. Two of them read right, so the eval makes the reading's mistake
// itself, saved as a person would: R4 loses the lines on its second page, and
// R6's $1,836.00 becomes $1,386.00. The check the agent makes is scored against
// the catalog, and a correction it found is applied through the API, which must
// leave the bill's figures adding up.
//
// Run from api/, with the bench up (`make bench`):
//   DATABASE_URL=postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_bench npx tsx scripts/arithmetic-eval.mts [caseId ...]
//
// It refuses to run against anything but the bench.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BENCH = 'http://127.0.0.1:3200';
// synthetic_data/ is gitignored, so a worktree has none of its own: point
// INVOICES_DIR at the checkout that does.
const INVOICES = process.env.INVOICES_DIR ?? join(import.meta.dirname, '..', '..', 'synthetic_data', 'invoices');
const TIMEOUT_MS = 120_000;

// DEV_AUTH_SECRET comes from api/.env. The database URL stays the caller's:
// .env points at the dev database.
const requestedDb = process.env.DATABASE_URL;
try { process.loadEnvFile(join(import.meta.dirname, '..', '.env')); } catch { /* no .env: rely on the environment */ }
process.env.DATABASE_URL = requestedDb;
if (!/\/usdc_ops_bench(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing to run: DATABASE_URL must point at usdc_ops_bench.');
  process.exit(2);
}
const secret = process.env.DEV_AUTH_SECRET;
if (!secret) { console.error('DEV_AUTH_SECRET is not set (api/.env).'); process.exit(2); }
const { prisma } = await import('../src/infra/prisma.js');

type Case = {
  id: string; file: string; vendor: string; billTo: string; invoiceNumber: string;
  expectedVerdict: 'missed' | 'misread' | 'document_error';
  hidden: { description: string; amount: string; page: number } | null;
  expect: string;
};
type Line = { description: string; quantity: number | null; unitPrice: number | null; amount: number | null; category: string | null; categoryConfirmedBy?: unknown };
type Check = {
  at: string; status: string; verdict: string; reason: string; dropped: string | null; source: string | null;
  missing: Array<{ description: string; amount: number; page: number }>;
  misread: Array<{ label: string; from: number; to: number; page: number }>;
  model: string | null; latencyMs: number | null; costUsd: number | null;
};

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

const cents = (n: number) => Math.round(n * 100);
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const arithmeticFlag = (draft: any) => (draft.flags as Array<{ kind: string; finding?: any }>).find((f) => f.kind === 'lines_do_not_sum' || f.kind === 'total_does_not_reconcile');

/** Save the draft with its lines replaced, as the review screen would. */
async function saveLines(orgId: string, token: string, billId: string, draft: any, lines: Line[]) {
  const value = (key: string) => {
    const f = [...draft.fields, ...draft.remitFields].find((x: { key: string }) => x.key === key);
    return f?.value === undefined || f.value === null || f.value === '' ? null : String(f.value);
  };
  const total = Number(value('total'));
  await call(`/organizations/${orgId}/bills/${billId}/save`, {
    fields: {
      vendorName: draft.vendor.name || null, vendorEmail: draft.vendor.email || null,
      invoiceNumber: value('invoiceNumber'), invoiceDate: value('invoiceDate'), dueDate: value('dueDate'),
      terms: value('terms'), poNumber: value('poNumber'), discount: value('discount'), currency: value('currency') ?? 'USD',
      ...(total > 0 ? { total } : {}),
      taxAmount: draft.taxAmount ?? null,
    },
    lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, category: l.category ?? null })),
    confirmedFieldKeys: [],
  }, token);
}

/** Make the reading's mistake the case is about, when the reading didn't. Returns what was done. */
async function tamper(c: Case, orgId: string, token: string, billId: string): Promise<string | null> {
  const draft = await call(`/organizations/${orgId}/bills/${billId}/draft`, null, token, 'GET');
  const lines = draft.lines as Line[];
  if (c.id === 'R4') {
    // The lines on page 2: the last few, adding up to the hidden amount.
    const want = cents(Number(c.hidden!.amount));
    for (let k = 1; k <= Math.min(6, lines.length - 1); k += 1) {
      if (lines.slice(-k).reduce((s, l) => s + cents(l.amount ?? 0), 0) === want) {
        await saveLines(orgId, token, billId, draft, lines.slice(0, -k));
        return `dropped the last ${k} lines (${money(want / 100)})`;
      }
    }
    return arithmeticFlag(draft) ? null : 'could not find the page-2 lines to drop';
  }
  if (c.id === 'R6') {
    const i = lines.findIndex((l) => l.description.toLowerCase().includes(c.hidden!.description.toLowerCase()) && cents(l.amount ?? 0) === cents(Number(c.hidden!.amount)));
    if (i < 0) return arithmeticFlag(draft) ? null : `could not find "${c.hidden!.description}" at ${c.hidden!.amount}`;
    const changed = lines.map((l, j) => (j === i ? { ...l, amount: 1386, unitPrice: l.quantity === 1 ? 1386 : l.unitPrice } : l));
    await saveLines(orgId, token, billId, draft, changed);
    return `read "${lines[i]!.description}" as $1,386.00`;
  }
  // R1 to R3: a reading that kept the figure as a line left nothing to find, so
  // it is dropped, as a reading that missed it would have.
  if (c.expectedVerdict === 'missed' && c.hidden && !arithmeticFlag(draft)) {
    const want = cents(Number(c.hidden.amount));
    const i = lines.findIndex((l) => cents(l.amount ?? 0) === want);
    if (i < 0) return `could not find "${c.hidden.description}" at ${c.hidden.amount} to drop`;
    await saveLines(orgId, token, billId, draft, lines.filter((_, j) => j !== i));
    return `dropped "${lines[i]!.description}" (${money(want / 100)}), which the reading kept as a line`;
  }
  return null;
}

async function storedCheck(billId: string): Promise<Check | null> {
  const row = await prisma.paymentOrder.findUnique({ where: { paymentOrderId: billId }, select: { metadataJson: true } });
  const check = (row?.metadataJson as Record<string, unknown> | null)?.arithmeticCheck;
  return check && typeof check === 'object' ? check as Check : null;
}

/** Open the bill until the check made on its current figures is in. */
async function waitForCheck(orgId: string, token: string, billId: string, since: number) {
  const started = Date.now();
  for (;;) {
    const draft = await call(`/organizations/${orgId}/bills/${billId}/draft`, null, token, 'GET');
    const flag = arithmeticFlag(draft);
    if (!flag) return { draft, flag: null, check: null };
    const check = await storedCheck(billId);
    if (flag.finding?.status !== 'running' && check && Date.parse(check.at) >= since) return { draft, flag, check };
    if (Date.now() - started > TIMEOUT_MS) return { draft, flag, check: null };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function score(c: Case, check: Check): string[] {
  const problems: string[] = [];
  if (check.verdict !== c.expectedVerdict) problems.push(`verdict ${check.verdict}, expected ${c.expectedVerdict}`);
  if (c.expectedVerdict === 'missed' && c.hidden) {
    const found = check.missing.reduce((s, m) => s + cents(m.amount), 0);
    if (found !== cents(Number(c.hidden.amount))) problems.push(`found ${money(found / 100)}, expected ${money(Number(c.hidden.amount))}`);
  }
  if (c.expectedVerdict === 'misread' && c.hidden) {
    const m = check.misread.find((x) => cents(x.to) === cents(Number(c.hidden!.amount)));
    if (!m) problems.push(`no misread to ${money(Number(c.hidden.amount))}`);
  }
  return problems;
}

async function runCase(c: Case) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const seed = await call('/auth/dev/seed', {
    secret, organizationName: `${c.billTo} ${c.id} ${stamp}`,
    owner: { email: `eval-${stamp}@dev.decimal.test`, displayName: 'Eval Owner' },
  });
  const orgId = seed.organizationId as string;
  const token = seed.users[0].sessionToken as string;
  const bytes = await readFile(join(INVOICES, c.file));
  // Under a neutral name: the catalog's names give the answer away.
  const up = await call(`/organizations/${orgId}/invoices/upload`, {
    filename: `invoice-${randomBytes(2).toString('hex')}.pdf`, mimeType: 'application/pdf', dataBase64: bytes.toString('base64'), autoAdvance: false,
  }, token);
  const billId = up?.paymentOrders?.[0]?.paymentOrder?.paymentOrderId as string | undefined;
  if (!billId) throw new Error('the upload made no bill');
  const since = Date.now();
  const tampered = await tamper(c, orgId, token, billId);
  const { draft, flag, check } = await waitForCheck(orgId, token, billId, tampered ? Date.now() : since - 60_000);
  return { orgId, token, billId, tampered, draft, flag, check };
}

const catalog = JSON.parse(await readFile(join(INVOICES, 'catalog.json'), 'utf8')) as Array<Record<string, unknown>>;
const only = process.argv.slice(2);
const cases = catalog
  .filter((e) => e.section === 'R' && typeof e.expectedVerdict === 'string')
  .map((e) => e as unknown as Case)
  .filter((c) => only.length === 0 || only.includes(c.id));
if (cases.length === 0) { console.error('No cases matched.'); process.exit(2); }

let right = 0;
let applied = 0;
let toApply = 0;
let spent = 0;
const latencies: number[] = [];
for (const c of cases) {
  process.stdout.write(`\n▶ ${c.id}: expect ${c.expectedVerdict}. ${c.expect}\n`);
  try {
    const { orgId, token, billId, tampered, flag, check } = await runCase(c);
    if (tampered) console.log(`  (made the mistake: ${tampered})`);
    if (!flag) { console.log('  ✗ no arithmetic flag, so nothing to investigate'); continue; }
    if (!check) { console.log('  ✗ no check came back in time'); continue; }
    spent += check.costUsd ?? 0;
    if (check.latencyMs) latencies.push(check.latencyMs);
    const what = [
      ...check.missing.map((m) => `missing "${m.description}" ${money(m.amount)} p${m.page}`),
      ...check.misread.map((m) => `misread "${m.label}" ${money(m.from)} → ${money(m.to)} p${m.page}`),
    ].join('; ');
    const problems = score(c, check);
    console.log(`  ${problems.length === 0 ? '✓' : '✗'} ${check.verdict}${what ? `: ${what}` : ''}${check.dropped ? ` (dropped: ${check.dropped})` : ''}`);
    console.log(`    ${check.model ?? 'no model'} · ${check.latencyMs ?? '?'} ms · $${(check.costUsd ?? 0).toFixed(4)} · read from ${check.source ?? 'nothing'}`);
    console.log(`    "${flag.finding?.headline ?? ''}"`);
    if (problems.length === 0) right += 1;
    else console.log(`    ${problems.join('; ')}`);
    if (flag.finding?.correction) {
      toApply += 1;
      const after = await call(`/organizations/${orgId}/bills/${billId}/correct-figures`, {}, token);
      const left = arithmeticFlag(after);
      if (!left) applied += 1;
      console.log(`  ${left ? '✗' : '✓'} applied: ${left ? `still flagged (${left.kind})` : 'the figures add up'}`);
    }
  } catch (error) {
    console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
  }
}

const mean = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
console.log(`\n${right}/${cases.length} right · ${applied}/${toApply} corrections applied cleanly · $${spent.toFixed(4)} in all · ${mean} ms a check on average`);
await prisma.$disconnect();
process.exit(right === cases.length && applied === toApply ? 0 : 1);
