// Does the model follow the team's past lines on SIMILAR lines — and only on
// those? Calls the real model (OPENAI key from api/.env); touches no database.
//
//   cd api && npx tsx scripts/line-precedent-eval.mts
//
// Each line is coded twice, with and without the team's precedents, against
// the standard chart. "follow" lines should take the team's category and quote
// the past line; "own" lines share words with a precedent but are a different
// purchase, and must not be stretched to it.
import { join } from 'node:path';
try { process.loadEnvFile(join(import.meta.dirname, '..', '.env')); } catch { /* environment only */ }
process.env.DATABASE_URL = process.env.DATABASE_URL?.replace(/usdc_ops_local/, 'usdc_ops_bench');

const { matchExpenseAccounts } = await import('../src/accounting/ocr-coding.js');
const { DEFAULT_EXPENSE_ACCOUNTS } = await import('../src/accounting/default-chart.js');
const { relevantPrecedents, lineTokens } = await import('../src/accounting/line-memory.js');

// The team's decisions: two of them deliberately NOT what a model would pick
// alone (licences to Taxes & licenses), so following them is visible.
const team = [
  { description: 'Stock photography licenses (8)', category: 'Taxes & licenses' },
  { description: 'Font license — campaign use', category: 'Taxes & licenses' },
  { description: 'Social media management — August', category: 'Advertising & marketing' },
  { description: 'AWS EC2 compute — August', category: 'Cloud hosting & infrastructure' },
  { description: 'Night cleaning crew', category: 'Contractors' },
];
const cases: Array<{ line: string; expect: 'follow' | 'own'; team?: string }> = [
  { line: 'Font license — web use', expect: 'follow', team: 'Taxes & licenses' },
  { line: 'Typeface licence for packaging', expect: 'follow', team: 'Taxes & licenses' },
  { line: 'Stock photo subscription, annual', expect: 'follow', team: 'Taxes & licenses' },
  { line: 'AWS RDS database — September', expect: 'follow', team: 'Cloud hosting & infrastructure' },
  { line: 'Photography for product launch event', expect: 'own' },
  { line: 'Business class flight to Austin', expect: 'own' },
  { line: 'Office chairs (4)', expect: 'own' },
  { line: 'Stock market data feed — monthly', expect: 'own' },
];

const memory = team.map((t, i) => ({ ...t, key: [...lineTokens(t.description)].sort().join(' '), tokens: lineTokens(t.description), paymentOrderId: `p${i}`, invoiceNumber: null, byUserId: null, at: 100 - i, confirmed: true }));
let pass = 0;
for (const c of cases) {
  const precedents = relevantPrecedents([c.line], memory);
  const [withTeam, alone] = await Promise.all([
    matchExpenseAccounts({ categoryHint: null, lineItems: [{ description: c.line }], accounts: DEFAULT_EXPENSE_ACCOUNTS, precedents }),
    matchExpenseAccounts({ categoryHint: null, lineItems: [{ description: c.line }], accounts: DEFAULT_EXPENSE_ACCOUNTS }),
  ]);
  const got = withTeam.lines[0];
  const ok = c.expect === 'follow'
    ? got?.accountName === c.team && Boolean(got?.like)
    : !got?.like;
  if (ok) pass += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.line}`);
  console.log(`      shown ${precedents.length} past line(s); with team: ${got?.accountName ?? '—'}${got?.like ? ` (like "${got.like}")` : ''}; alone: ${alone.lines[0]?.accountName ?? '—'}`);
}
console.log(`\n${pass}/${cases.length} as expected`);
process.exit(0);
