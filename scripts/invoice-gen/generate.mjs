// Decimal — synthetic invoice generator v3.
//
// Renders the 22 cases from TESTING-INVOICES.md (cases.mjs) through headless
// Brave driven by puppeteer-core (Brave's own --print-to-pdf CLI hangs and
// never exits), with sips for image conversion. Output is deterministic apart
// from PDF metadata timestamps (which is what keeps B4 byte-different from A2).
//
//   cd scripts/invoice-gen && npm install   # once
//   node scripts/invoice-gen/generate.mjs [--out <dir>]
//
// Default output: <repo>/synthetic_data/invoices/  (gitignored)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { CASES, VENDORS, BILL_TO } from './cases.mjs';
import { buildHtml, money, moneyEUR } from './templates.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const outFlag = process.argv.indexOf('--out');
const OUT = outFlag > -1 ? path.resolve(process.argv[outFlag + 1]) : path.join(REPO_ROOT, 'synthetic_data', 'invoices');

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
if (!fs.existsSync(BRAVE)) { console.error(`Brave not found at ${BRAVE}`); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'invoice-gen-'));
const PROFILE = path.join(TMP, 'brave-profile');

const cents = (n) => Math.round(n * 100);
const lineCents = (l) => cents(l.qty * l.unit);

function compute(spec) {
  const allLines = spec.lineGroups ? spec.lineGroups.flatMap((g) => g.lines) : spec.lines;
  const c = { billTo: spec.billTo ?? BILL_TO };
  if (allLines) {
    c.subtotalCents = allLines.reduce((s, l) => s + lineCents(l), 0);
    c.taxCents = spec.taxRate ? Math.round(c.subtotalCents * spec.taxRate) : null;
    c.trueTotalCents = c.subtotalCents + (c.taxCents ?? 0);
    c.shownSubtotal = spec.printedSubtotal ?? c.subtotalCents / 100;
    c.shownTax = spec.printedTax ?? (c.taxCents == null ? null : c.taxCents / 100);
    c.shownTotal = spec.printedTotal ?? c.trueTotalCents / 100;
  }
  if (spec.statementRows) {
    c.shownTotal = spec.statementRows.filter((r) => r.status === 'Open').reduce((s, r) => s + r.amount, 0);
  }
  return c;
}

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: true,
  userDataDir: PROFILE,
  args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars'],
});

function sips(args) {
  const res = spawnSync('sips', args, { timeout: 30_000 });
  if (res.status !== 0) throw new Error(`sips failed: ${res.stderr?.toString().slice(0, 300)}`);
}

const SCREEN = { photo: [1100, 1500], scan: [1020, 1420], stamp: [1020, 1500] };

async function render(spec, vendor, computed) {
  const html = buildHtml(spec, vendor, computed);
  const htmlPath = path.join(TMP, `${spec.id}.html`);
  fs.writeFileSync(htmlPath, html);
  const outPath = path.join(OUT, spec.file);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const page = await browser.newPage();
  try {
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 30_000 });
    if (spec.format === 'pdf') {
      await page.pdf({ path: outPath, format: 'letter', preferCSSPageSize: true, printBackground: true });
    } else {
      const [width, height] = SCREEN[spec.degrade];
      await page.setViewport({ width, height });
      const shot = path.join(TMP, `${spec.id}.png`);
      await page.screenshot({ path: shot }); // viewport-sized: the photo crop is intentional
      if (spec.format === 'png') {
        fs.copyFileSync(shot, outPath);
      } else if (spec.degrade === 'scan') {
        sips(['--resampleWidth', '1000', '-s', 'format', 'jpeg', '-s', 'formatOptions', '55', shot, '--out', outPath]);
      } else {
        sips(['-s', 'format', 'jpeg', '-s', 'formatOptions', '62', shot, '--out', outPath]);
      }
    }
  } finally {
    await page.close();
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4096) {
    throw new Error(`${spec.id}: output missing or suspiciously small at ${outPath}`);
  }
  return outPath;
}

// ---------------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const catalog = [];
const byId = {};
for (const spec of CASES) {
  const vendor = VENDORS[spec.vendor];
  const computed = compute(spec);
  const outPath = await render(spec, vendor, computed);
  const fmt = spec.currency === 'EUR' ? moneyEUR : money;
  byId[spec.id] = { spec, computed, outPath };
  catalog.push({
    id: spec.id,
    section: spec.id[0],
    file: spec.file,
    format: spec.format,
    vendor: vendor.name,
    billTo: computed.billTo.name,
    invoiceNumber: spec.invoiceNo ?? null,
    currency: spec.currency ?? 'USD',
    documentTotal: computed.shownTotal != null ? fmt(computed.shownTotal) : null,
    expect: spec.expect,
  });
  console.log(`  ${spec.id}  ${spec.file}`);
}
await browser.close();

// ---- self-checks -----------------------------------------------------------
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// B2: lines must NOT sum to the printed total; B3: subtotal+tax must NOT reconcile.
check(byId.B2.computed.trueTotalCents === 400000 && cents(byId.B2.computed.shownTotal) === 482000,
  'B2 must show $4,820 over lines that sum to $4,000');
check(byId.B3.computed.subtotalCents === 400000 && byId.B3.computed.taxCents === 32000 && cents(byId.B3.computed.shownTotal) === 482000,
  'B3 must show $4,820 over $4,000 + $320 tax');

// Every other lined case must reconcile exactly.
for (const { spec, computed } of Object.values(byId)) {
  if (['B2', 'B3'].includes(spec.id) || !computed.trueTotalCents) continue;
  check(cents(computed.shownTotal) === computed.trueTotalCents, `${spec.id}: printed total must equal line sum`);
}

// A3/A4 prove the split is vendor history, not money.
check(cents(byId.A3.computed.shownTotal) === 31240 && cents(byId.A4.computed.shownTotal) === 31240,
  'A3 and A4 must both total $312.40');

// A2 vs B4: identical figures, different bytes.
check(byId.A2.spec.invoiceNo === byId.B4.spec.invoiceNo && cents(byId.A2.computed.shownTotal) === cents(byId.B4.computed.shownTotal),
  'B4 must carry the same invoice number and total as A2');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
check(sha(byId.A2.outPath) !== sha(byId.B4.outPath), 'B4 must be byte-different from A2 (sha256 dedupe would eat it)');

// Bill-to: Testing Labs everywhere except B1.
for (const { spec, computed } of Object.values(byId)) {
  if (spec.id === 'B1') check(computed.billTo.name !== BILL_TO.name, 'B1 must be billed to the wrong org');
  else check(computed.billTo.name === BILL_TO.name, `${spec.id}: must be billed to Testing Labs`);
}

// Invoice numbers unique except the A2/B4 pair; A3's vendor appears once.
const nums = CASES.filter((s) => s.invoiceNo && s.id !== 'B4').map((s) => s.invoiceNo);
check(new Set(nums).size === nums.length, 'invoice numbers must be unique apart from B4');
check(CASES.filter((s) => s.vendor === 'juniper').length === 1, "A3's vendor must appear nowhere else");

// Text layer + renderability (uses the same tools intake uses, when present).
const has = (cmd) => spawnSync('which', [cmd]).status === 0;
if (has('pdftotext')) {
  for (const { spec, computed, outPath } of Object.values(byId)) {
    if (spec.format !== 'pdf') continue;
    const txt = spawnSync('pdftotext', [outPath, '-']).stdout.toString();
    check(txt.includes(computed.billTo.name), `${spec.id}: bill-to name missing from PDF text layer`);
    if (spec.invoiceNo) check(txt.includes(spec.invoiceNo), `${spec.id}: invoice number missing from text layer`);
  }
} else console.log('  (pdftotext not installed — skipping text-layer check)');
if (has('pdftoppm')) {
  for (const { spec, outPath } of Object.values(byId)) {
    if (spec.format !== 'pdf') continue;
    const r = spawnSync('pdftoppm', ['-r', '60', '-png', '-f', '1', '-l', '1', outPath, path.join(TMP, `smoke-${spec.id}`)]);
    check(r.status === 0, `${spec.id}: pdftoppm failed to rasterize`);
  }
} else console.log('  (pdftoppm not installed — skipping raster smoke; intake will fall back to sips)');

// C3 must be 3+ pages; every other PDF must be exactly one.
if (has('pdfinfo')) {
  for (const { spec, outPath } of Object.values(byId)) {
    if (spec.format !== 'pdf') continue;
    const info = spawnSync('pdfinfo', [outPath]).stdout.toString();
    const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
    if (spec.multipage) check(pages >= 3, `${spec.id} must be 3+ pages (got ${pages})`);
    else check(pages === 1, `${spec.id} must be a single page (got ${pages})`);
  }
}

if (failures.length) {
  console.error('\nSELF-CHECK FAILURES:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nAll self-checks passed.');

// ---- catalog + README ------------------------------------------------------
fs.writeFileSync(path.join(OUT, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

const tableRows = catalog.map((c) =>
  `| ${c.id} | \`${c.file}\` | ${c.vendor} | ${c.documentTotal ?? '—'} | ${c.expect} |`).join('\n');

fs.writeFileSync(path.join(OUT, 'README.md'), `# Testing Labs — synthetic invoice set v3

22 invoices, one per branch or gate of the Draft → Approval → Pay pipeline.
Spec: \`TESTING-INVOICES.md\` (repo root). Regenerate with:

\`\`\`
node scripts/invoice-gen/generate.mjs
\`\`\`

Forward to **testing-labs@bills.decimal.finance** or upload on the Bills screen,
then prepare as a Bill Clerk (Priya/Omar), confirm, and route.

## Setup — do this once, first

- **Set the bill ceiling** (E2 is a no-op without it): sign in as Zara
  (\`zara.owner@dev.decimal.test\`), Policies page → Bill ceiling → **$100,000**.
  Everything else in the set stays under it; E2's $150,000 must exceed it.

## Upload order — history is built by uploads, nothing is pre-seeded

1. **A1 → A2 → A3 → A4**, confirming each. A4 needs Brightwave history (A1/A2
   first); A3's vendor (Juniper) must never appear again.
2. **B-section** afterwards — B4 only after A2 is confirmed (it duplicates it).
3. **C and D** in any order — D4 after any Brightwave bill exists.
4. **E1, E2** last. E1 walks the full path through Dara's release.

A3 and A4 are the same $312.40 on purpose: same money, different chains —
proving the split is vendor history, not amount.

## The files

| # | File | Vendor | Doc total | What it proves |
|---|---|---|---|---|
${tableRows}

## Notes

- A and E are deliberately clean — if everything is broken, real flags stop standing out.
- C1 crops the remit footer (photo framing) and D2 omits bank details — both
  should surface \`unreadable_payment_details\` at the payment step.
- No HEIC on purpose: email intake accepts it but extraction can't render it (known gap).
- Full per-file expectations: \`catalog.json\`.
`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nWrote ${catalog.length} invoices + catalog.json + README.md to ${OUT}`);
