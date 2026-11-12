// Decimal — synthetic invoice generator v3.
//
// Renders every case from TESTING-INVOICES.md (cases.mjs) through headless
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
import { CASES, PARTS, VENDORS, BILL_TO } from './cases.mjs';
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
    // Totals-block lines between subtotal and tax: freight, a discount (negative), a deposit.
    c.adjustments = spec.adjustments ?? [];
    c.adjustmentCents = c.adjustments.reduce((sum, a) => sum + cents(a.amount), 0);
    c.totalLabel = spec.totalLabel;
    c.trueTotalCents = c.subtotalCents + c.adjustmentCents + (c.taxCents ?? 0);
    c.shownSubtotal = spec.printedSubtotal ?? c.subtotalCents / 100;
    c.shownTax = spec.printedTax ?? (c.taxCents == null ? null : c.taxCents / 100);
    c.shownTotal = spec.printedTotal ?? c.trueTotalCents / 100;
    c.taxLabel = spec.taxLabel;
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

async function render(spec, vendor, computed, outPathOverride, htmlOverride) {
  const html = htmlOverride ?? buildHtml(spec, vendor, computed);
  const htmlPath = path.join(TMP, `${spec.id}.html`);
  fs.writeFileSync(htmlPath, html);
  const outPath = outPathOverride ?? path.join(OUT, spec.file);
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
const PARTS_DIR = path.join(TMP, 'parts');
fs.mkdirSync(PARTS_DIR, { recursive: true });

// A composed case (the M series) is rendered part by part into scratch and
// joined with pdfunite, so each page keeps its own layout.
async function renderPart(key) {
  const spec = { id: key, format: 'pdf', ...PARTS[key] };
  if (spec.halves) spec.halfParts = spec.halves.map((h) => ({ spec: h, vendor: VENDORS[h.vendor], c: compute(h) }));
  const computed = compute(spec);
  const outPath = await render(spec, VENDORS[spec.vendor], computed, path.join(PARTS_DIR, `${key}.pdf`));
  byId[key] = { spec, computed, outPath, part: true };
  return outPath;
}

for (const spec of CASES) {
  const vendor = VENDORS[spec.vendor];
  if (spec.halves) spec.halfParts = spec.halves.map((h) => ({ spec: h, vendor: VENDORS[h.vendor], c: compute(h) }));
  const computed = compute(spec);
  let outPath;
  if (spec.compose) {
    const files = [];
    for (const key of spec.compose) files.push(await renderPart(key));
    outPath = path.join(OUT, spec.file);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const r = spawnSync('pdfunite', [...files, outPath]);
    if (r.status !== 0) throw new Error(`${spec.id}: pdfunite failed: ${r.stderr}`);
  } else if (spec.rasterOf) {
    // Image-only scan: rasterise another case's PDF to grayscale JPEGs and print them back as a PDF.
    const src = byId[spec.rasterOf].outPath;
    const prefix = path.join(TMP, `scan-${spec.id}`);
    const r = spawnSync('pdftoppm', ['-r', '150', '-gray', '-jpeg', '-jpegopt', 'quality=72', src, prefix]);
    if (r.status !== 0) throw new Error(`${spec.id}: pdftoppm failed`);
    const pics = fs.readdirSync(TMP).filter((f) => f.startsWith(`scan-${spec.id}-`) && f.endsWith('.jpg')).sort();
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      * { margin:0; padding:0; } @page { size: letter; margin: 0; }
      img { display:block; width:8.5in; height:11in; page-break-after: always; }
      img:last-child { page-break-after: auto; }
    </style></head><body>${pics.map((f) => `<img src="file://${path.join(TMP, f)}">`).join('')}</body></html>`;
    outPath = await render(spec, null, computed, undefined, html);
  } else {
    outPath = await render(spec, vendor, computed);
  }
  const fmt = spec.currency === 'EUR' ? moneyEUR : money;
  byId[spec.id] = { spec, computed, outPath };
  const multi = !!spec.expectBills;
  catalog.push({
    id: spec.id,
    section: spec.id[0],
    file: spec.file,
    format: spec.format,
    ...(multi ? {} : { vendor: vendor.name }),
    billTo: computed.billTo.name,
    ...(multi ? {} : { invoiceNumber: spec.invoiceNo ?? null }),
    currency: spec.currency ?? 'USD',
    ...(multi ? {} : { documentTotal: computed.shownTotal != null ? fmt(computed.shownTotal) : null }),
    ...(multi ? { pages: spec.pages, expectBills: spec.expectBills } : {}),
    ...(spec.hidden !== undefined ? { expectedVerdict: spec.expectedVerdict, hidden: spec.hidden } : {}),
    expect: spec.expect,
    ...(spec.pairWith ? { pairWith: spec.pairWith, expectedVerdict: spec.expectedVerdict } : {}),
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
  if (['B2', 'B3', 'R5'].includes(spec.id) || !computed.trueTotalCents) continue;
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
const nums = CASES.filter((s) => s.invoiceNo && s.id !== 'B4' && !s.pairWith).map((s) => s.invoiceNo);
const partNums = [
  ...Object.values(PARTS).filter((p) => p.invoiceNo && p.template !== 'remitslip').map((p) => p.invoiceNo),
  ...CASES.flatMap((s) => (s.halves ?? []).map((h) => h.invoiceNo)),
];
check(new Set([...nums, ...partNums]).size === nums.length + partNums.length, 'invoice numbers must be unique apart from B4, the X pairs and an M3 remittance slip');
check(CASES.filter((s) => s.vendor === 'juniper').length === 1, "A3's vendor must appear nowhere else");

// E3–E6 test the per-bill ceiling exception, so the ceiling must be their only
// blocker: every one over $100,000, and each from a vendor used nowhere else.
for (const id of ['E3', 'E4', 'E5', 'E6']) {
  const { spec, computed } = byId[id];
  check(cents(computed.shownTotal) > 10_000_000, `${id} must be over the $100,000 ceiling`);
  check(CASES.filter((s) => s.vendor === spec.vendor).length === 1, `${id}'s vendor must appear nowhere else`);
}

// X series: six duplicate-investigator pairs. Each pair is one vendor that
// appears nowhere else, and each must trip the duplicate gate (same invoice
// number, or no number on at least one side and exactly equal totals).
const normNo = (n) => (n ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
const XEXPECT = {
  X1: { sameNo: true, sameTotal: true, sameBytes: false },
  X2: { sameNo: true, sameTotal: false },
  X3: { sameNo: false, noNumber: true, sameTotal: true },
  X4: { sameNo: false, noNumber: true, sameTotal: true, sameBytes: false },
  X5: { sameNo: true, sameTotal: false },
  X6: { sameNo: false, noNumber: true, sameTotal: true },
};
for (const [n, want] of Object.entries(XEXPECT)) {
  const a = byId[`${n}a`], b = byId[`${n}b`];
  if (!a || !b) { check(false, `${n}: both halves must exist`); continue; }
  check(a.spec.vendor === b.spec.vendor, `${n}: both invoices must be from one vendor`);
  check(CASES.filter((s) => s.vendor === a.spec.vendor).length === 2, `${n}: its vendor must appear nowhere else`);
  check(b.spec.pairWith === `${n}a`, `${n}b must pair with ${n}a`);
  const sameTotal = cents(a.computed.shownTotal) === cents(b.computed.shownTotal);
  check(sameTotal === want.sameTotal, `${n}: totals ${want.sameTotal ? 'must be equal' : 'must differ'}`);
  const na = normNo(a.spec.invoiceNo), nb = normNo(b.spec.invoiceNo);
  if (want.noNumber) check(!na && !nb && sameTotal, `${n}: no numbers and equal totals needed to trip the gate`);
  else check(na && na === nb, `${n}: same invoice number needed to trip the gate`);
  if (want.sameBytes === false) check(sha(a.outPath) !== sha(b.outPath), `${n}: files must differ byte-wise`);
}


// R series: each case is one fictional vendor used nowhere else, and the
// figure named in `hidden` must be on the page it names.
const pageText = (file, n) => spawnSync('pdftotext', ['-layout', '-f', String(n), '-l', String(n), file, '-']).stdout.toString();
const hasPdftotext = spawnSync('which', ['pdftotext']).status === 0;
const usage = {};
const use = (key, owner) => { (usage[key] ??= new Set()).add(owner); };
for (const sp of CASES) {
  if (sp.vendor) use(sp.vendor, sp.id);
  for (const h of sp.halves ?? []) use(h.vendor, sp.id);
  for (const k of sp.compose ?? []) if (PARTS[k].vendor && PARTS[k].vendor !== 'parcelpost') use(PARTS[k].vendor, sp.id);
}
for (const sp of CASES) {
  if (!/^[RM]/.test(sp.id)) continue;
  for (const [key, owners] of Object.entries(usage)) {
    if (owners.has(sp.id)) check(owners.size === 1, `${sp.id}: vendor ${key} must appear in no other case`);
  }
}
const R_VERDICTS = { R1: 'missed', R2: 'missed', R3: 'missed', R4: 'missed', R5: 'document_error', R6: 'misread' };
for (const [id, verdict] of Object.entries(R_VERDICTS)) {
  const r = byId[id];
  check(r.spec.expectedVerdict === verdict, `${id} must expect ${verdict}`);
  check(r.spec.file.startsWith('R-arithmetic/'), `${id} must live in R-arithmetic/`);
  if (id === 'R5') {
    check(r.spec.hidden === null, 'R5 hides nothing');
    check(r.computed.trueTotalCents === 185000 && cents(r.computed.shownTotal) === 158000, 'R5: lines $1,850.00 but total prints $1,580.00');
    continue;
  }
  const h = r.spec.hidden;
  if (id === 'R1') check(r.computed.subtotalCents === 200000 && r.computed.taxCents === 16000 && cents(r.computed.shownTotal) === 224500 && cents(Number(h.amount)) === 8500, 'R1: $2,000 + $85 freight + $160 tax = $2,245');
  if (id === 'R2') check(r.computed.subtotalCents === 300000 && cents(r.computed.shownTotal) === 270000 && cents(Number(h.amount)) === -30000, 'R2: $3,000 − $300 = $2,700');
  if (id === 'R3') check(r.computed.subtotalCents === 400000 && cents(r.computed.shownTotal) === 300000 && cents(Number(h.amount)) === -100000, 'R3: $4,000 − $1,000 = $3,000');
  if (id === 'R4') {
    const last = r.spec.lineGroups[1].lines;
    check(last.length === 3 && last.reduce((sum, l) => sum + lineCents(l), 0) === cents(Number(h.amount)) && h.page === 2, 'R4: hidden is the three page-2 lines');
    check(r.spec.lineGroups.flatMap((g) => g.lines).length === 14, 'R4: 14 lines');
  }
  if (id === 'R6') check(r.computed.subtotalCents === 345100 && cents(Number(h.amount)) === 183600 && cents(r.computed.shownTotal) === 345100, 'R6: $1,836 + $1,200 + $415 = $3,451');
  if (hasPdftotext && id !== 'R4') check(pageText(r.outPath, h.page).includes(money(Number(h.amount))), `${id}: hidden figure ${money(Number(h.amount))} must be on page ${h.page}`);
  if (hasPdftotext && id === 'R4') {
    for (const l of r.spec.lineGroups[1].lines) check(pageText(r.outPath, 2).includes(money(l.qty * l.unit)), `R4: ${l.desc} must be on page 2`);
    check(pageText(r.outPath, 2).includes('Total due') && !pageText(r.outPath, 1).includes('Total due'), 'R4: totals only on page 2');
  }
}

// M series: expectBills must match the parts, and each bill's invoice number
// must sit on its own pages.
const allParts = {};
for (const sp of CASES) {
  for (const k of sp.compose ?? []) allParts[PARTS[k].invoiceNo ?? k] ??= byId[k];
  for (const h of sp.halves ?? []) allParts[h.invoiceNo] = { spec: h, computed: compute(h) };
}
for (const sp of CASES.filter((x) => x.expectBills)) {
  const src = sp.rasterOf ? byId[sp.rasterOf] : byId[sp.id];
  check(!sp.rasterOf || JSON.stringify(sp.expectBills) === JSON.stringify(byId[sp.rasterOf].spec.expectBills), `${sp.id}: must expect the same bills as ${sp.rasterOf}`);
  let prevEnd = 0;
  for (const b of sp.expectBills) {
    const part = allParts[b.invoiceNumber];
    check(part && VENDORS[part.spec.vendor].name === b.vendor && money(part.computed.shownTotal) === b.total, `${sp.id}: ${b.invoiceNumber} vendor/total must match its part`);
    check(b.pages[0] >= 1 && b.pages[1] >= b.pages[0], `${sp.id}: ${b.invoiceNumber} page range invalid`);
    if (sp.id !== 'M4') { check(b.pages[0] === prevEnd + 1, `${sp.id}: ${b.invoiceNumber} range must follow the previous bill`); prevEnd = b.pages[1]; }
    if (hasPdftotext && !sp.noTextLayer) {
      const inRange = [];
      for (let n = b.pages[0]; n <= b.pages[1]; n++) inRange.push(pageText(src.outPath, n));
      check(inRange.some((t) => t.includes(b.invoiceNumber)), `${sp.id}: ${b.invoiceNumber} must appear on pages ${b.pages}`);
      if (!['M4', 'M5'].includes(sp.id)) for (const o of sp.expectBills) if (o !== b) check(!inRange.some((t) => t.includes(o.invoiceNumber)), `${sp.id}: ${o.invoiceNumber} must not appear inside ${b.invoiceNumber}'s pages`);
    }
  }
  if (!sp.noTextLayer && sp.id !== 'M4') check(prevEnd === sp.pages, `${sp.id}: ranges must cover all ${sp.pages} pages`);
}
if (hasPdftotext) {
  const m2 = byId.M2.outPath;
  for (let n = 1; n <= 3; n++) check(pageText(m2, n).includes('Net 30'), `M2: "Net 30" must print on page ${n}`);
  check(!pageText(m2, 2).includes('Total due') && pageText(m2, 3).includes('$4,224.00'), 'M2: the second invoice has its totals on its second page');
  check(pageText(byId.M3.outPath, 2).includes('Please detach and return with your payment') && pageText(byId.M3.outPath, 2).includes('$1,860.00'), 'M3: page 2 is the slip repeating the amount due');
  const m4 = pageText(byId.M4.outPath, 1);
  check(m4.indexOf('FJ-2031') < m4.indexOf('GSG-7714') && m4.includes('$1,100.00') && m4.includes('$1,196.00'), 'M4: both invoices on page 1, in order');
  const m5 = pageText(byId.M5.outPath, 1);
  check(m5.includes('RS-3382') && m5.includes('TC-1190') && m5.includes('Parcelpost'), 'M5: cover lists both attached invoices');
}
if (spawnSync('which', ['pdfimages']).status === 0) {
  const imgs = spawnSync('pdfimages', ['-list', byId.M6.outPath]).stdout.toString().trim().split('\n').length - 2;
  check(imgs === 3, `M6: must hold exactly 3 page images (got ${imgs})`);
}

// Text layer + renderability (uses the same tools intake uses, when present).
const has = (cmd) => spawnSync('which', [cmd]).status === 0;
if (has('pdftotext')) {
  for (const { spec, computed, outPath } of Object.values(byId)) {
    if (spec.format !== 'pdf') continue;
    const txt = spawnSync('pdftotext', [outPath, '-']).stdout.toString();
    if (spec.noTextLayer) { check(txt.trim() === '', `${spec.id}: must have NO text layer`); continue; }
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
    if (spec.pages) check(pages === spec.pages, `${spec.id} must be ${spec.pages} pages (got ${pages})`);
    else if (spec.multipage) check(pages >= 3, `${spec.id} must be 3+ pages (got ${pages})`);
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

const xPairs = catalog.filter((c) => c.pairWith);
const xVerdicts = xPairs.map((c) => `${c.pairWith.slice(0, -1)} ${c.expectedVerdict}`).join(', ');
const nSeries = (letter) => catalog.filter((c) => c.id.startsWith(letter)).length;
const seriesList = [['A', 'routing'], ['B', 'draft gates'], ['C', 'extraction'], ['D', 'shape variety'], ['E', 'payment path'], ['F', 'companion'], ['R', 'arithmetic'], ['X', 'duplicate pairs'], ['M', 'multi-invoice uploads']]
  .map(([l, n]) => `${l} ${n} (${nSeries(l)})`).join(' · ');

const tableRows = catalog.map((c) =>
  `| ${c.id} | \`${c.file}\` | ${c.vendor} | ${c.documentTotal ?? '—'} | ${c.expect} |`).join('\n');

fs.writeFileSync(path.join(OUT, 'README.md'), `# Testing Labs — synthetic invoice set v3

${catalog.length} invoices: upload series A–F (one per branch or gate of the Draft → Approval → Pay
pipeline) and eval series R, X and M, which the backend's own evals read. Spec: \`TESTING-INVOICES.md\` (repo root). Regenerate with:

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

## F-companion: line memory and findings

F1 to F4 lean on Brightwave history built by A and E: upload them after A1 → A4.
Expectations are in the table; the findings name BW-2219, BW-2245 and BW-2195.

## X-duplicates: the duplicate investigator's pairs

${xPairs.length} pairs (X1a/X1b to X${xPairs.length}a/X${xPairs.length}b), each from its own vendor and each
tripping the duplicate flag. \`api/scripts/exception-eval.mts\` reads them from
\`catalog.json\` (\`pairWith\`, \`expectedVerdict\`, \`expect\`) and uploads them
itself: do not upload these by hand into a team you care about.
Expected verdicts: ${xVerdicts}.

Render only a new series with \`node scripts/invoice-gen/generate.mjs --out <scratch>\`
and copy that folder in: a full render re-stamps every PDF and changes bytes.

## R-arithmetic: the arithmetic investigator's documents

R1 to R6 are correct documents with a figure a reader can miss. \`catalog.json\` gives
each \`expectedVerdict\` (missed, misread or document_error) and \`hidden\`, the figure the
eval removes from the stored reading (null for R5). Upload by hand only into a team
you don't mind polluting: the eval uploads them itself.
${catalog.filter((c) => c.hidden !== undefined).map((c) => `- ${c.id}: ${c.expectedVerdict}${c.hidden ? `, hidden ${c.hidden.description} (${c.hidden.amount}, page ${c.hidden.page})` : ', nothing hidden'}`).join('\n')}

## M-multi-invoice: several invoices in one upload

M1 to M6 hold more than one invoice (or an invoice plus a slip or cover page). \`catalog.json\`
gives \`expectBills\`: each bill's vendor, number, total and 1-based inclusive page range, in
document order. M4 puts two invoices on one page, so both ranges are [1,1]; M6 is M1 as an
image-only scan with no text layer.
${catalog.filter((c) => c.expectBills).map((c) => `- ${c.id}: ${c.expectBills.map((b) => `${b.invoiceNumber} [${b.pages}]`).join(', ')}`).join('\n')}

## Series

${seriesList}

## Notes

- A and E are deliberately clean — if everything is broken, real flags stop standing out.
- C1 crops the remit footer (photo framing) and D2 omits bank details — both
  should surface \`unreadable_payment_details\` at the payment step.
- No HEIC on purpose: email intake accepts it but extraction can't render it (known gap).
- Full per-file expectations: \`catalog.json\`.
`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nWrote ${catalog.length} invoices + catalog.json + README.md to ${OUT}`);
