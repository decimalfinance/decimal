// Evaluate the duplicate investigator against the real model, on the bench.
//
// Each case is a PAIR of real invoice PDFs with a known right answer. For each,
// a fresh organization is seeded, both documents are uploaded through the real
// intake (real extraction, real duplicate gate), and the brief the agent writes
// is scored against the expected verdict.
//
// The bar: every verdict right, and never a HIGH-confidence wrong one. A
// confident wrong duplicate call is worse than the plain flag it replaces.
//
// Run from api/, with the bench up (`make bench`):
//   set -a; source .env; set +a
//   DATABASE_URL=postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_bench npx tsx scripts/exception-eval.mts [caseId ...]
//
// It refuses to run against anything but the bench: it seeds organizations and
// uploads documents, and none of that belongs in anyone's own data.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BENCH = 'http://127.0.0.1:3200';
// synthetic_data/ is gitignored, so a worktree has none of its own: point
// INVOICES_DIR at the checkout that does.
const INVOICES = process.env.INVOICES_DIR ?? join(import.meta.dirname, '..', '..', 'synthetic_data', 'invoices');
const TIMEOUT_MS = 150_000;

// DEV_AUTH_SECRET comes from api/.env. Read it natively, but keep the database
// URL the caller gave: .env points at the dev database, and letting it win here
// would aim this script at somebody's own data.
const requestedDb = process.env.DATABASE_URL;
try { process.loadEnvFile(join(import.meta.dirname, '..', '.env')); } catch { /* no .env: rely on the environment */ }
process.env.DATABASE_URL = requestedDb;

if (!/\/usdc_ops_bench(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing to run: DATABASE_URL must point at usdc_ops_bench.');
  process.exit(2);
}
const secret = process.env.DEV_AUTH_SECRET;
if (!secret) { console.error('DEV_AUTH_SECRET is not set (source api/.env).'); process.exit(2); }

const { prisma } = await import('../src/infra/prisma.js');

type Verdict = 'duplicate' | 'replacement' | 'not_duplicate' | 'unsure';
type Case = { id: string; a: string; b: string; expected: Verdict; note: string };

/** Pairs already in the corpus, before any eval-specific set exists. */
const BUILTIN: Case[] = [
  { id: 'B4xA2', a: 'A-routing/A2-mid-band-4500.pdf', b: 'B-draft-gates/B4-duplicate-of-A2.pdf', expected: 'duplicate', note: 'same vendor, number and amount; different bytes' },
];

/** The X-series, when the invoice agent has generated it: pairs marked in catalog.json. */
async function catalogCases(): Promise<Case[]> {
  try {
    const catalog = JSON.parse(await readFile(join(INVOICES, 'catalog.json'), 'utf8')) as Array<Record<string, string>>;
    const byId = new Map(catalog.map((e) => [e.id, e]));
    return catalog
      .filter((e) => e.expectedVerdict && e.pairWith)
      .map((e) => ({
        id: e.id.replace(/b$/, ''),
        a: byId.get(e.pairWith)?.file ?? '',
        b: e.file,
        expected: e.expectedVerdict as Verdict,
        note: e.expect ?? '',
      }))
      .filter((c) => c.a);
  } catch {
    return [];
  }
}

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

async function upload(orgId: string, token: string, rel: string): Promise<string> {
  const bytes = await readFile(join(INVOICES, rel));
  const filename = rel.split('/').pop()!;
  const out = await call(`/organizations/${orgId}/invoices/upload`, {
    filename, mimeType: filename.endsWith('.pdf') ? 'application/pdf' : 'image/png', dataBase64: bytes.toString('base64'), autoAdvance: false,
  }, token);
  const id = out?.paymentOrders?.[0]?.paymentOrder?.paymentOrderId;
  if (!id) throw new Error(`upload of ${rel} produced no bill`);
  return id;
}

type Brief = { status: string; verdict: Verdict | null; confidence: string | null; headline: string | null; reason: string | null; recommendedAction: string | null; findings: Array<{ claim: string }>; couldNotCheck: string[] };

async function waitForBrief(orgId: string, token: string, billId: string): Promise<{ brief: Brief | null; flagged: boolean }> {
  const started = Date.now();
  for (;;) {
    const draft = await call(`/organizations/${orgId}/bills/${billId}/draft`, null, token, 'GET');
    const flag = (draft.flags as Array<{ kind: string; brief?: Brief }>).find((f) => f.kind === 'possible_duplicate');
    if (!flag) return { brief: null, flagged: false };
    if (flag.brief && flag.brief.status !== 'running') return { brief: flag.brief, flagged: true };
    if (Date.now() - started > TIMEOUT_MS) return { brief: flag.brief ?? null, flagged: true };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function runCase(c: Case) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const seed = await call('/auth/dev/seed', {
    secret, organizationName: `Eval ${c.id} ${stamp}`,
    owner: { email: `eval-${stamp}@dev.decimal.test`, displayName: 'Eval Owner' },
  });
  const orgId = seed.organizationId as string;
  const token = seed.users[0].sessionToken as string;
  const aId = await upload(orgId, token, c.a);
  const bId = await upload(orgId, token, c.b);
  const newer = await waitForBrief(orgId, token, bId);
  const older = newer.brief ? await waitForBrief(orgId, token, aId) : { brief: null, flagged: false };
  const row = await prisma.billExceptionBrief.findFirst({
    where: { organizationId: orgId }, orderBy: { updatedAt: 'desc' },
    select: { model: true, latencyMs: true, turns: true, promptTokens: true, completionTokens: true, error: true },
  });
  return { c, newer, older, row };
}

const only = process.argv.slice(2);
const cases = [...BUILTIN, ...(await catalogCases())].filter((c) => only.length === 0 || only.includes(c.id));
if (cases.length === 0) { console.error('No cases matched.'); process.exit(2); }

let right = 0;
let confidentWrong = 0;
for (const c of cases) {
  process.stdout.write(`\n▶ ${c.id} — expect ${c.expected} (${c.note})\n`);
  try {
    const { newer, older, row } = await runCase(c);
    if (!newer.flagged) { console.log('  ✗ the duplicate gate never fired, so there was nothing to investigate'); continue; }
    const b = newer.brief;
    if (!b || b.status !== 'ready' || !b.verdict) {
      console.log(`  ✗ no finding (${b?.status ?? 'none'}${row?.error ? `: ${row.error}` : ''})`);
      continue;
    }
    const ok = b.verdict === c.expected;
    if (ok) right += 1; else if (b.confidence === 'high') confidentWrong += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${b.verdict} (${b.confidence})${!ok && b.confidence === 'high' ? '  ← HIGH-CONFIDENCE WRONG' : ''}`);
    console.log(`    headline: ${b.headline}`);
    console.log(`    reason:   ${b.reason}`);
    for (const f of b.findings) console.log(`    · ${f.claim}`);
    if (b.couldNotCheck.length) console.log(`    couldn't check: ${b.couldNotCheck.join('; ')}`);
    console.log(`    newer bill → ${b.recommendedAction}   older bill → ${older.brief?.recommendedAction ?? '?'}`);
    if (row) console.log(`    ${row.model} · ${row.turns} turns · ${row.latencyMs} ms · ${row.promptTokens}+${row.completionTokens} tokens`);
  } catch (error) {
    console.log(`  ✗ case failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${right}/${cases.length} verdicts right · ${confidentWrong} high-confidence wrong`);
await prisma.$disconnect();
process.exit(confidentWrong > 0 ? 1 : 0);
