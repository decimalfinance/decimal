import fs from 'node:fs';
import path from 'node:path';

const DATA_PATH = new URL('./ap_cases.jsonl', import.meta.url).pathname;
const DEFAULT_OUT_DIR = new URL('./generated_invoices', import.meta.url).pathname;
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = loadCases(DATA_PATH)
    .filter((row) => (args.scenario ? row.scenarioLabels.includes(args.scenario) : true))
    .filter((row) => (args.caseIds.length ? args.caseIds.includes(row.caseId) : true))
    .slice(0, args.limit);

  if (!cases.length) {
    throw new Error('No synthetic AP cases matched the requested filters.');
  }

  fs.mkdirSync(args.outDir, { recursive: true });

  const written = cases.map((row) => {
    const filename = `${row.caseId}-${slug(row.expected.invoice.vendorName)}.${args.mode}.pdf`;
    const outPath = path.join(args.outDir, filename);
    const bytes = args.mode === 'raw' ? renderRawDocumentPdf(row) : renderInvoicePdf(row);
    fs.writeFileSync(outPath, bytes);
    return outPath;
  });

  console.log(JSON.stringify({ written }, null, 2));
}

function parseArgs(argv) {
  const args = {
    limit: 2,
    mode: 'invoice',
    outDir: DEFAULT_OUT_DIR,
    scenario: null,
    caseIds: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') {
      args.limit = Number(argv[++i]);
    } else if (arg === '--mode') {
      args.mode = argv[++i];
    } else if (arg === '--out') {
      args.outDir = path.resolve(argv[++i]);
    } else if (arg === '--scenario') {
      args.scenario = argv[++i];
    } else if (arg === '--case') {
      args.caseIds.push(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  node synthetic_data/render-invoice-pdfs.mjs [--limit 2] [--mode invoice|raw]
  node synthetic_data/render-invoice-pdfs.mjs --scenario known_vendor_wallet_change --limit 5
  node synthetic_data/render-invoice-pdfs.mjs --case ap_case_0001 --case ap_case_0008
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  if (!['invoice', 'raw'].includes(args.mode)) {
    throw new Error('--mode must be invoice or raw');
  }

  return args;
}

function loadCases(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function renderInvoicePdf(row) {
  const invoice = row.expected.invoice;
  const scenario = row.scenarioLabels.join(', ');
  const c = new PdfContent();

  c.text(52, 58, 24, 'INVOICE', 'F2');
  c.text(52, 84, 10, 'Synthetic AP dataset invoice', 'F1', 0.35);
  c.text(390, 58, 11, `Case: ${row.caseId}`, 'F3');
  c.text(390, 76, 10, `Scenario: ${truncate(scenario, 26)}`, 'F1', 0.45);
  c.line(52, 108, 543, 108, 0.82);

  c.text(52, 138, 9, 'FROM', 'F2', 0.45);
  c.text(52, 160, 17, invoice.vendorName, 'F2');
  c.text(52, 182, 10, invoice.vendorEmail ?? 'billing@example.invalid', 'F1', 0.35);

  c.text(340, 138, 9, 'BILL TO', 'F2', 0.45);
  c.text(340, 160, 16, 'Decimal Finance Ops', 'F2');
  c.text(340, 182, 10, 'accounts payable', 'F1', 0.35);

  c.roundedBox(52, 220, 491, 86);
  const meta = [
    ['Invoice number', invoice.invoiceNumber],
    ['Invoice date', invoice.invoiceDate],
    ['Due date', invoice.dueDate],
    ['Terms', invoice.paymentTerms],
  ];
  meta.forEach(([label, value], index) => {
    const x = 74 + (index % 2) * 238;
    const y = 246 + Math.floor(index / 2) * 36;
    c.text(x, y, 8, label.toUpperCase(), 'F2', 0.45);
    c.text(x, y + 17, 12, value ?? '-', 'F1');
  });

  const tableTop = 350;
  c.text(52, tableTop - 26, 10, 'LINE ITEMS', 'F2', 0.45);
  c.line(52, tableTop, 543, tableTop, 0.78);
  c.text(62, tableTop + 20, 9, 'Description', 'F2', 0.45);
  c.text(355, tableTop + 20, 9, 'Qty', 'F2', 0.45);
  c.text(405, tableTop + 20, 9, 'Unit', 'F2', 0.45);
  c.text(495, tableTop + 20, 9, 'Total', 'F2', 0.45);
  c.line(52, tableTop + 34, 543, tableTop + 34, 0.88);

  let y = tableTop + 58;
  for (const item of invoice.lineItems.slice(0, 8)) {
    c.text(62, y, 11, truncate(item.description, 42), 'F1');
    c.text(358, y, 11, String(item.quantity ?? 1), 'F1');
    c.text(398, y, 11, money(item.unitPrice, invoice.currency), 'F1');
    c.text(488, y, 11, money(item.total, invoice.currency), 'F1');
    y += 24;
  }
  c.line(52, y - 8, 543, y - 8, 0.88);

  const totalsX = 370;
  c.text(totalsX, y + 20, 10, 'Subtotal', 'F1', 0.35);
  c.text(485, y + 20, 11, money(invoice.subtotal, invoice.currency), 'F1');
  c.text(totalsX, y + 44, 10, 'Tax', 'F1', 0.35);
  c.text(485, y + 44, 11, money(invoice.taxAmount, invoice.currency), 'F1');
  c.text(totalsX, y + 74, 12, 'Total due', 'F2');
  c.text(475, y + 74, 14, money(invoice.amount, invoice.currency), 'F2');

  const payTop = Math.max(y + 122, 650);
  c.roundedBox(52, payTop, 491, 108);
  c.text(74, payTop + 28, 9, 'PAY TO USDC WALLET', 'F2', 0.45);
  c.text(74, payTop + 56, 16, invoice.walletAddress ?? 'No wallet printed on invoice', 'F3');
  c.text(74, payTop + 82, 9, `Expected policy: ${row.expected.policy.expectedDecision}`, 'F1', 0.38);

  c.text(52, 802, 8, 'Generated from synthetic_data/ap_cases.jsonl for Decimal local testing.', 'F1', 0.5);

  return makePdf(c.toString());
}

function renderRawDocumentPdf(row) {
  const c = new PdfContent();
  c.text(52, 58, 18, `RAW INVOICE SOURCE - ${row.caseId}`, 'F2');
  c.text(52, 82, 9, `Scenario: ${row.scenarioLabels.join(', ')}`, 'F1', 0.45);
  c.line(52, 104, 543, 104, 0.82);

  const lines = wrapPreservingLines(row.rawDocument, 82);
  let y = 132;
  for (const line of lines.slice(0, 42)) {
    c.text(52, y, 9, line, 'F3');
    y += 15;
  }
  c.text(52, 802, 8, 'Raw mode preserves the agent input text inside a PDF wrapper.', 'F1', 0.5);

  return makePdf(c.toString());
}

class PdfContent {
  constructor() {
    this.parts = [];
  }

  text(x, topY, size, value, font = 'F1', gray = 0) {
    this.parts.push(`${gray} g BT /${font} ${size} Tf 1 0 0 1 ${num(x)} ${num(PAGE.height - topY)} Tm (${escapePdfText(String(value))}) Tj ET 0 g`);
  }

  line(x1, y1, x2, y2, gray = 0) {
    this.parts.push(`${gray} G ${num(x1)} ${num(PAGE.height - y1)} m ${num(x2)} ${num(PAGE.height - y2)} l S 0 G`);
  }

  roundedBox(x, y, width, height) {
    this.parts.push(`0.9 G ${num(x)} ${num(PAGE.height - y - height)} ${num(width)} ${num(height)} re S 0 G`);
  }

  toString() {
    return this.parts.join('\n');
  }
}

function makePdf(contentStream) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    `<< /Length ${Buffer.byteLength(contentStream, 'utf8')} >>\nstream\n${contentStream}\nendstream`,
  ];

  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(out, 'utf8'));
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(out, 'utf8');
  out += `xref\n0 ${objects.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'utf8');
}

function wrapPreservingLines(text, width) {
  const out = [];
  for (const sourceLine of String(text).split(/\r?\n/)) {
    if (sourceLine.length <= width) {
      out.push(sourceLine);
      continue;
    }
    let line = sourceLine;
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
    out.push(line);
  }
  return out;
}

function money(value, currency) {
  const amount = Number(value ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'USD' || currency === 'USDC' ? `$${amount}` : `${amount} ${currency}`;
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function num(value) {
  return Number(value).toFixed(2).replace(/\.00$/, '');
}

function escapePdfText(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
    .replace(/[^\x20-\x7E]/g, '?');
}

main();
