import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseBboxXml,
  findTextMatches,
  findAmountMatches,
  dateVariants,
  expandToRow,
  refineInvoiceSources,
  type TextPage,
} from '../src/payments/doc-provenance.js';

// A miniature invoice text layer (fractions of a 1000x1000 page for readability).
function word(text: string, x0: number, y0: number, x1: number, y1: number) {
  return { text, x0: x0 / 1000, y0: y0 / 1000, x1: x1 / 1000, y1: y1 / 1000 };
}

const PAGE: TextPage = {
  words: [
    word('INVOICE', 60, 40, 180, 70),
    word('Acme', 60, 120, 110, 140),
    word('Logistics', 115, 120, 190, 140),
    word('LLC', 195, 120, 225, 140),
    word('INVOICE', 60, 200, 110, 212),
    word('NUMBER', 115, 200, 165, 212),
    word('AP-2026-1021', 60, 220, 160, 235),
    word('INVOICE', 300, 200, 350, 212),
    word('DATE', 355, 200, 390, 212),
    word('May', 300, 220, 330, 235),
    word('22,', 335, 220, 355, 235),
    word('2026', 360, 220, 395, 235),
    word('Net', 600, 220, 625, 235),
    word('30', 630, 220, 650, 235),
    // lines table — two rows, amounts at the right edge
    word('Cloud', 60, 400, 105, 415),
    word('infrastructure', 110, 400, 210, 415),
    word('1', 500, 400, 508, 415),
    word('$0.06', 700, 400, 745, 415),
    word('Design', 60, 440, 112, 455),
    word('sprint', 117, 440, 160, 455),
    word('1', 500, 440, 508, 455),
    word('$0.09', 700, 440, 745, 455),
    // totals block — same amount as a line appears again at the bottom
    word('Subtotal', 600, 600, 660, 615),
    word('$0.15', 700, 600, 745, 615),
    word('Total', 600, 640, 640, 658),
    word('due', 645, 640, 672, 658),
    word('$0.15', 700, 640, 745, 658),
  ],
};

test('parseBboxXml normalizes word boxes against page dimensions', () => {
  const xml = `
  <doc>
    <page width="500.000000" height="1000.000000">
      <word xMin="50.000000" yMin="100.000000" xMax="150.000000" yMax="120.000000">Hello</word>
      <word xMin="160.000000" yMin="100.000000" xMax="250.000000" yMax="120.000000">R&amp;D</word>
    </page>
  </doc>`;
  const pages = parseBboxXml(xml);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.words.length, 2);
  assert.equal(pages[0]!.words[0]!.text, 'Hello');
  assert.equal(pages[0]!.words[1]!.text, 'R&D');
  assert.ok(Math.abs(pages[0]!.words[0]!.x0 - 0.1) < 1e-9);
  assert.ok(Math.abs(pages[0]!.words[0]!.y1 - 0.12) < 1e-9);
});

test('finds a hyphenated value that is a single word', () => {
  const matches = findTextMatches([PAGE], ['AP-2026-1021']);
  assert.equal(matches.length, 1);
  assert.ok(Math.abs(matches[0]!.x0 - 0.06) < 1e-9);
  assert.ok(Math.abs(matches[0]!.y0 - 0.22) < 1e-9);
});

test('finds a value split across words ("Net 30") and a date printed differently', () => {
  const terms = findTextMatches([PAGE], ['Net 30']);
  assert.equal(terms.length, 1);
  assert.ok(terms[0]!.x0 >= 0.59 && terms[0]!.x1 <= 0.66);

  // Extracted as ISO, printed as "May 22, 2026".
  const date = findTextMatches([PAGE], dateVariants('2026-05-22'));
  assert.equal(date.length, 1);
  assert.ok(date[0]!.x0 >= 0.29 && date[0]!.x1 <= 0.40);
});

test('amount matching ignores currency and commas; totals prefer the bottom occurrence', () => {
  const matches = findAmountMatches([PAGE], 0.15);
  assert.equal(matches.length, 2);

  const invoice = fakeInvoice({ amount: 0.15 });
  refineInvoiceSources(invoice, [PAGE]);
  const total = invoice.fieldSources?.total;
  assert.ok(total, 'total source set');
  // bottom occurrence is the Total due row at y=640/1000
  assert.ok(total!.box[1] > 0.6, `expected bottom occurrence, got y=${total!.box[1]}`);
});

test('line items expand to the whole table row and land on the right row', () => {
  const invoice = fakeInvoice({
    lineItems: [
      { description: 'Cloud infrastructure', quantity: 1, unitPrice: 0.06, total: 0.06, source: null },
      { description: 'Design sprint', quantity: 1, unitPrice: 0.09, total: 0.09, source: null },
    ],
  });
  refineInvoiceSources(invoice, [PAGE]);

  const first = invoice.lineItems[0]!.source!;
  const second = invoice.lineItems[1]!.source!;
  assert.ok(first, 'first line has a source');
  assert.ok(second, 'second line has a source');
  // Row 1 sits at y≈0.400-0.415 and spans description through amount.
  assert.ok(first.box[1] < 0.41 && first.box[1] > 0.38, `row1 y=${first.box[1]}`);
  assert.ok(first.box[0] < 0.07, 'row starts at the description');
  assert.ok(first.box[0] + first.box[2] > 0.74, 'row extends through the amount column');
  // Row 2 is the 440-band, distinctly below row 1.
  assert.ok(second.box[1] > first.box[1] + 0.02, 'rows are distinct bands');
});

test('expandToRow unions only words on the same text line', () => {
  const match = { page: 1, x0: 0.06, y0: 0.4, x1: 0.21, y1: 0.415 };
  const row = expandToRow(PAGE, match);
  assert.ok(row.x1 > 0.74, 'includes the amount at the right edge');
  assert.ok(row.y0 >= 0.39 && row.y1 <= 0.43, 'does not swallow neighboring rows');
});

test('a value with no text-layer match keeps the model box', () => {
  const invoice = fakeInvoice({
    poNumber: 'PO-DOES-NOT-EXIST',
    fieldSources: { poNumber: { page: 1, box: [0.5, 0.5, 0.1, 0.02] } },
  });
  refineInvoiceSources(invoice, [PAGE]);
  assert.deepEqual(invoice.fieldSources?.poNumber, { page: 1, box: [0.5, 0.5, 0.1, 0.02] });
});

function fakeInvoice(overrides: Record<string, unknown>) {
  return {
    vendorName: 'Acme Logistics LLC',
    vendorAddress: null,
    vendorEmail: null,
    amount: 0.15,
    currency: 'USD',
    invoiceNumber: 'AP-2026-1021',
    invoiceDate: '2026-05-22',
    dueDate: null,
    terms: 'Net 30',
    poNumber: null,
    earlyPayDiscount: null,
    subtotal: null,
    taxAmount: null,
    billToName: null,
    remitTo: null,
    paymentDetails: null,
    walletAddress: null,
    lineItems: [],
    categoryHint: null,
    confidence: { vendor: 1, amount: 1, overall: 1 },
    fieldConfidence: null,
    fieldSources: null,
    ...overrides,
  } as Parameters<typeof refineInvoiceSources>[0];
}
