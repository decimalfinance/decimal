import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseBboxXml,
  findTextMatches,
  findAmountMatches,
  dateVariants,
  expandToRow,
  refineInvoiceSources,
  parseTesseractTsv,
  mergeWordPages,
  estimateSkewDeg,
  stripUnmeasuredSources,
  type TextPage,
} from '../src/payments/doc-provenance.js';
import { stripUnstorableCharacters } from '../src/payments/document-extract.js';

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

test('a value that is not on the page gets no box at all', () => {
  // This test used to assert the opposite — that an unmatched field KEEPS the
  // model's box — and that assertion was the bug, written down and guarded.
  //
  // The premise was that the model's box is a rough guess worth falling back
  // to. It is not a guess, it is an invention: C1 and C2, two unrelated
  // invoices, both came back with vendorName at exactly [0.05, 0.05, 0.4, 0.07]
  // and their header fields on a flat 0.03 ladder. Falling back to it means the
  // UI points confidently at blank paper and says the number came from there.
  //
  // Half-measured was the worst state: on C1 eight fields were relocated
  // correctly and three kept fabricated rectangles, indistinguishable in the
  // viewer from the eight real ones. So a box is shown only if it was measured.
  const invoice = fakeInvoice({
    poNumber: 'PO-DOES-NOT-EXIST',
    fieldSources: { poNumber: { page: 1, box: [0.5, 0.5, 0.1, 0.02] } },
  });
  refineInvoiceSources(invoice, [PAGE]);
  assert.equal(invoice.fieldSources?.poNumber, undefined);

  // The fields that WERE found are untouched by the rule.
  assert.ok(invoice.fieldSources?.invoiceNumber, 'a value on the page still gets its measured box');
});

test('a line item nobody could find on the page loses its box too', () => {
  const invoice = fakeInvoice({
    lineItems: [{
      description: 'Something that is not printed anywhere',
      quantity: 1, unitPrice: 10, total: 10,
      source: { page: 1, box: [0.05, 0.43, 0.7, 0.04] },
    }],
  });
  refineInvoiceSources(invoice, [PAGE]);
  assert.equal((invoice.lineItems[0] as { source?: unknown }).source, null);
});

test('the model box still does its one real job: picking between two matches', () => {
  // Dropping unmatched boxes does not mean ignoring them. Where a value appears
  // twice on the page, the model's rough location is exactly enough to choose
  // the right occurrence — the one job a guess can do honestly.
  const twice: TextPage = {
    words: [
      word('Net', 60, 100, 90, 112), word('30', 95, 100, 115, 112),
      word('Net', 60, 800, 90, 812), word('30', 95, 800, 115, 812),
    ],
  };
  const invoice = fakeInvoice({
    terms: 'Net 30',
    fieldSources: { terms: { page: 1, box: [0.06, 0.79, 0.06, 0.02] } },
  });
  refineInvoiceSources(invoice, [twice]);
  const box = invoice.fieldSources!.terms!.box;
  assert.ok(box[1] > 0.5, `the hint picked the lower occurrence, got y=${box[1]}`);
});

test('tesseract word boxes are normalised against the page-level row', () => {
  // Photographs and scans have no text layer, so nothing could ever be measured
  // on them and the invented boxes were rendered as fact. OCR is what gives
  // those documents real coordinates. Its characters stay a guess — used for
  // position only, never for grounding — but its geometry is a measurement.
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t1000\t2000\t-1\t',
    '5\t1\t1\t1\t1\t1\t100\t200\t300\t50\t96\tCoastal',
    // Paper texture read as punctuation: too unsure to help a match, and able
    // to drag a box somewhere wrong.
    '5\t1\t1\t1\t1\t2\t500\t600\t10\t10\t4\t.',
    '5\t1\t1\t1\t2\t1\t100\t400\t200\t50\t88\tFreight',
  ].join('\n');

  const page = parseTesseractTsv(tsv);
  assert.deepEqual(page.words.map((w) => w.text), ['Coastal', 'Freight']);
  assert.deepEqual(page.words[0], { text: 'Coastal', x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.125 });
});

test('a document with no page row yields no words rather than nonsense', () => {
  // Without the page-level row there is nothing to normalise against, and
  // dividing by zero would produce Infinity coordinates that render as a box
  // covering the whole document.
  const tsv = 'level\tleft\ttop\twidth\theight\tconf\ttext\n5\t10\t10\t20\t20\t90\tHello';
  assert.deepEqual(parseTesseractTsv(tsv).words, []);
});

test('when nothing on a document can be measured, every box is thrown away', () => {
  const invoice = fakeInvoice({
    fieldSources: { total: { page: 1, box: [0.85, 0.53, 0.1, 0.04] } },
    lineItems: [{
      description: 'Ocean freight', quantity: 1, unitPrice: 10, total: 10,
      source: { page: 1, box: [0.05, 0.33, 0.7, 0.04] },
    }],
  });
  stripUnmeasuredSources(invoice as unknown as Record<string, unknown>);
  assert.equal(invoice.fieldSources, undefined);
  assert.equal((invoice.lineItems[0] as { source?: unknown }).source, undefined);
});

test('the letterhead address gets a box round each part', () => {
  // Most invoices print the address on the letterhead rather than in a Remit To
  // panel, and that address was never refined at all — while the draft screen
  // asked for it under a key (`vendorAddress`) nothing ever wrote. So street,
  // city, state and zip showed no highlight on EVERY document, digital PDFs
  // included, where the exact characters were sitting in the text layer.
  // Sixteen of the thirty missing boxes across the C series were these four.
  const page: TextPage = {
    words: [
      word('9', 60, 300, 75, 315), word('Cannery', 80, 300, 150, 315), word('Row', 155, 300, 190, 315),
      word('Monterey,', 60, 320, 140, 335), word('CA', 145, 320, 170, 335), word('93940', 175, 320, 230, 335),
    ],
  };
  const invoice = fakeInvoice({ vendorAddress: '9 Cannery Row · Monterey, CA 93940' });
  refineInvoiceSources(invoice, [page]);
  const src = invoice.fieldSources!;

  // Each input points at its own words, not all four at one block.
  assert.ok(src['vendorAddress.street'], 'street');
  assert.ok(src['vendorAddress.city'], 'city');
  assert.ok(src['vendorAddress.state'], 'state');
  assert.ok(src['vendorAddress.zip'], 'zip');
  assert.ok(src['vendorAddress.city']!.box[1] > src['vendorAddress.street']!.box[1],
    'the city sits on the line below the street');
});

test('a two-letter state code is disambiguated by the address block', () => {
  // "CA" is two characters and can appear anywhere on an invoice. The
  // whole-address match is the hint that picks the right one — the same job the
  // model's box does when it is the only hint available.
  const page: TextPage = {
    words: [
      word('CA', 700, 100, 725, 115),          // a stray, far from the address
      word('9', 60, 300, 75, 315), word('Cannery', 80, 300, 150, 315), word('Row', 155, 300, 190, 315),
      word('Monterey,', 60, 320, 140, 335), word('CA', 145, 320, 170, 335), word('93940', 175, 320, 230, 335),
    ],
  };
  const invoice = fakeInvoice({ vendorAddress: '9 Cannery Row · Monterey, CA 93940' });
  refineInvoiceSources(invoice, [page]);
  const state = invoice.fieldSources!['vendorAddress.state']!;
  assert.ok(state.box[1] > 0.2, `picked the state in the address, not the stray, got y=${state.box[1]}`);
});

test('merging OCR passes keeps each pass a contiguous run', () => {
  // The matcher slides a window over CONSECUTIVE words, so a multi-word value
  // only matches while the words that spell it sit next to each other in the
  // list. Several OCR passes are run over the same page because they fail
  // differently — and an obvious-looking dedup, dropping a word the previous
  // pass already found, punches a hole in the later pass's run and breaks every
  // multi-word match across it. That cost three fields when tried, two of them
  // gains the extra pass had just made.
  //
  // So passes are concatenated whole. Duplicates are harmless: they produce
  // duplicate candidates in the same place and pickMatch picks one.
  const passA: TextPage = { words: [word('Coastal', 60, 40, 130, 55)] };
  const passB: TextPage = {
    words: [
      word('Coastal', 61, 41, 131, 56),   // the same word, found again
      word('Freight', 135, 40, 200, 55),  // and the one pass A missed
    ],
  };
  const merged = mergeWordPages([passA, passB]);
  assert.equal(merged.words.length, 3, 'nothing is dropped');

  // The proof that matters: "Coastal Freight" is findable, which it would not
  // be if the duplicate had been removed and pass B left with one word.
  assert.equal(findTextMatches([merged], ['Coastal Freight']).length, 1);
});

test('a line item row stops at the column gutter, not at a whitespace gap', () => {
  // C4 puts its line items in a right-hand column and its BILL TO block on the
  // left. "Dashboard build-out (3)" sits level with "BILL TO", and the row rule
  // was "every word at this height" — so the highlight stretched from the
  // middle of the address block to the right margin.
  //
  // A gap threshold cannot fix this, which is worth a test because it is the
  // obvious fix. On the real document:
  //
  //     BILL TO  ->  Dashboard    gap 0.215    the gutter, to exclude
  //     (3)      ->  3            gap 0.222    description to QTY, to keep
  //
  // The gutter is SMALLER than the gap inside the table. So the row is bounded
  // by things we know instead: the description on the left, the line's own
  // amount on the right.
  const page: TextPage = {
    words: [
      word('BILL', 71, 300, 92, 312),
      word('TO', 96, 300, 111, 312),
      word('Dashboard', 326, 300, 392, 312),
      word('build-out', 395, 300, 449, 312),
      word('(3)', 452, 300, 467, 312),
      word('3', 689, 300, 696, 312),
      word('$540.00', 771, 300, 819, 312),
      word('$1,620.00', 870, 300, 929, 312),
    ],
  };
  const match = findTextMatches([page], ['Dashboard build-out (3)'])[0]!;
  const row = expandToRow(page, match, 1620);

  assert.ok(row.x0 >= 0.32, `starts at the description, not the left column, got ${row.x0}`);
  assert.ok(row.x1 >= 0.92, `still reaches the amount, got ${row.x1}`);
});

test('without an amount the row still refuses to cross into the left column', () => {
  // The right bound needs the line's amount; the left bound never does. A line
  // item reads left to right — description first, then its figures — so
  // anything left of the description belongs to another column.
  const page: TextPage = {
    words: [
      word('BILL', 71, 300, 92, 312),
      word('TO', 96, 300, 111, 312),
      word('Dashboard', 326, 300, 392, 312),
      word('build-out', 395, 300, 449, 312),
      word('(3)', 452, 300, 467, 312),
    ],
  };
  const match = findTextMatches([page], ['Dashboard build-out (3)'])[0]!;
  assert.ok(expandToRow(page, match, null).x0 >= 0.32);
});

test('a row number printed just before the description is still included', () => {
  // Never reaching left would be too blunt: a short hop picks up a bullet or a
  // line number set close to the text, which IS part of the row.
  const page: TextPage = {
    words: [
      word('2.', 300, 300, 318, 312),          // close: 0.008 away
      word('Dashboard', 326, 300, 392, 312),
      word('build-out', 395, 300, 449, 312),
      word('(3)', 452, 300, 467, 312),
    ],
  };
  const match = findTextMatches([page], ['Dashboard build-out (3)'])[0]!;
  assert.ok(expandToRow(page, match, null).x0 < 0.31, 'the row number is part of the row');
});

test('page tilt is measured from whole lines, in pixels', () => {
  // A line 800px long that falls 25px across its span is tilted about 1.8°,
  // which is what C1 actually measures.
  const line = (y: number, drop: number) => [
    { x: 100, y }, { x: 400, y: y + drop / 2 }, { x: 900, y: y + drop },
  ];
  assert.ok(Math.abs(estimateSkewDeg([line(200, 25)]) - 1.79) < 0.1);

  // Median, not mean: one misread line with a stray word at the far edge would
  // drag an average a long way, and a page has one tilt.
  assert.ok(Math.abs(estimateSkewDeg([line(200, 25), line(300, 25), line(400, 400)]) - 1.79) < 0.1);

  // A short line cannot pin down an angle — a couple of pixels of noise at each
  // end is degrees of slope — so it is not allowed to vote.
  assert.equal(estimateSkewDeg([[{ x: 10, y: 10 }, { x: 30, y: 14 }, { x: 50, y: 18 }]]), 0);
  assert.equal(estimateSkewDeg([]), 0);
});

test('on a tilted page the box turns with the text instead of growing to fit it', () => {
  // A photograph of paper is rarely square to the camera. Upright, a rectangle
  // round sloping text has to be tall enough to contain the whole slope: on C1,
  // 28px of fall against 13px of text, so the box comes out three times taller
  // than the words and reads as a band floating around the line.
  const ASPECT = 0.733, SKEW = 1.79;
  const slope = ASPECT * Math.tan(SKEW * Math.PI / 180);   // fall per unit of x
  const words = [];
  // "Ocean freight inbound APAC", falling at exactly the page's declared tilt.
  for (const [i, text] of ['Ocean', 'freight', 'inbound', 'APAC'].entries()) {
    const x0 = 0.10 + i * 0.20;
    const y = 0.30 + (x0 - 0.10) * slope;
    words.push({ text, x0, y0: y, x1: x0 + 0.18, y1: y + 0.014 });
  }
  const tilted: TextPage = { words, aspect: ASPECT, skewDeg: SKEW };
  const upright: TextPage = { words, aspect: ASPECT, skewDeg: 0 };

  const of = (page: TextPage) => {
    const invoice = fakeInvoice({ vendorName: 'Ocean freight inbound APAC' });
    refineInvoiceSources(invoice, [page]);
    return invoice.fieldSources!.vendorName!;
  };

  const a = of(tilted);
  const b = of(upright);
  assert.ok(a.angle === 1.79, 'the box carries the tilt for the viewer to apply');
  assert.equal(b.angle, undefined, 'and says nothing when the page is square');
  assert.ok(a.box[3] < b.box[3], `tilted box is the shorter one: ${a.box[3]} vs ${b.box[3]}`);

  // The centre sits ON THE LINE at the box's midpoint — not at the middle of
  // the rectangle enclosing it.
  //
  // This used to assert the opposite: that the tilted centre matched the
  // upright one, i.e. the middle of the enclosing rectangle. That is the
  // behaviour that put C1's first row visibly high, because the rectangle takes
  // its top edge from whatever reaches highest and one token there was a
  // misread em dash with a box three times the height of a real word.
  const midX = a.box[0] + a.box[2] / 2;
  const first = words[0]!;
  const lineAtMid = (first.y0 + first.y1) / 2 + (midX - (first.x0 + first.x1) / 2) * slope;
  const centre = a.box[1] + a.box[3] / 2;
  assert.ok(Math.abs(centre - lineAtMid) < 0.001,
    `centre ${centre} should sit on the line at ${lineAtMid}`);

  // The case that actually broke it: one word with a wildly oversized box.
  //
  // Tesseract read C1's em dash as "~" and gave it a box 0.0187 tall against
  // 0.005 for every real word beside it. Taking the centre from the enclosing
  // rectangle let that single glyph lift the highlight a third of a line clear
  // of the text. Taking it from the median of what the words themselves say
  // costs that one word its vote.
  const withMisread: TextPage = {
    ...tilted,
    words: [
      ...words.slice(0, 2),
      { text: '~', x0: 0.47, y0: 0.29, x1: 0.485, y1: 0.3187 },   // three lines tall
      ...words.slice(2),
    ],
  };
  const invoice = fakeInvoice({ vendorName: 'Ocean freight inbound APAC' });
  refineInvoiceSources(invoice, [withMisread]);
  const withOutlier = invoice.fieldSources!.vendorName!;
  const outlierCentre = withOutlier.box[1] + withOutlier.box[3] / 2;
  assert.ok(Math.abs(outlierCentre - lineAtMid) < 0.001,
    `one misread glyph must not move the centre: ${outlierCentre} vs ${lineAtMid}`);
});

test('a tilt too small to matter is left alone', () => {
  // C2 measures -0.25°. Correcting that would move every box for no visible
  // gain, on an estimate that is itself only good to a fraction of a degree.
  const words = [word('Kepler', 100, 300, 200, 314), word('Legal', 210, 300, 300, 314)];
  const invoice = fakeInvoice({ vendorName: 'Kepler Legal' });
  refineInvoiceSources(invoice, [{ words, aspect: 0.718, skewDeg: -0.25 }]);
  assert.equal(invoice.fieldSources!.vendorName!.angle, undefined);
});

test('on a tilted page a row follows its own text, not a flat band', () => {
  // The failure this prevents is worse than a missing highlight: it points at a
  // real figure and says it belongs to this line.
  //
  // C1 slopes 1.79° down to the right, and one row is about as tall as the
  // amount column falls behind its own description. So a flat band around
  // "Drayage — Port of Oakland" cannot reach the $450.00 that belongs to it,
  // while the $950.00 belonging to the row ABOVE lands squarely inside — and
  // the highlight spans one row's description and the previous row's money.
  //
  // Measured on the real document: "Drayage" sits at y 0.2317, its own amount
  // at 0.2463 — 0.0146 apart against a tolerance near 0.007.
  const aspect = 0.733;
  const tan = Math.tan(1.79 * Math.PI / 180);
  // A row's y at a given x, once the slope has had its way.
  const at = (x: number, rowY: number) => rowY + (x - 0.155) * aspect * tan;

  const w = (text: string, x: number, rowY: number) => {
    const y = at(x, rowY);
    return { text, x0: x, y0: y - 0.004, x1: x + 0.05, y1: y + 0.004 };
  };

  const ROW2 = 0.2135, ROW3 = 0.2317;   // one row apart, as printed
  const page: TextPage = {
    aspect, skewDeg: 1.79,
    words: [
      w('Customs', 0.155, ROW2), w('brokerage', 0.21, ROW2), w('$950.00', 0.828, ROW2),
      w('Drayage', 0.155, ROW3), w('Oakland', 0.21, ROW3), w('$450.00', 0.828, ROW3),
    ],
  };

  const invoice = fakeInvoice({
    lineItems: [{ description: 'Drayage Oakland', quantity: 1, unitPrice: 450, total: 450 }],
  });
  refineInvoiceSources(invoice, [page]);
  const box = (invoice.lineItems[0] as { source?: { box: number[] } }).source!;
  const right = box.box[0] + box.box[2];
  assert.ok(right > 0.86, `the row reaches its own amount at x 0.828, got ${right}`);

  // And the proof it followed the slope rather than widening: the row that
  // matters is row 3, so the box must sit below row 2's money, not around it.
  const rowTwoMoneyY = at(0.828, ROW2);
  assert.ok(box.box[1] > rowTwoMoneyY - 0.004,
    `starts below the previous row's amount at ${rowTwoMoneyY}, got ${box.box[1]}`);
});

test('a tilted box is as tall as the text in it, not as tall as the slope', () => {
  // The height was first DERIVED — enclosing height minus width x tan(tilt) —
  // which is right on paper and fragile in practice. The subtraction ran long,
  // hit its own floor, and produced a bar thinner than the glyphs that the
  // padding then had to make up: C1's rows came out about 2.9x the height of
  // their text, which is a band, not a highlight.
  //
  // Measuring beats deriving when the measurement is sitting right there. The
  // words in the box know how tall they are.
  const aspect = 0.733, tan = Math.tan(1.79 * Math.PI / 180);
  const H = 0.009;                                  // the text height
  const at = (x: number) => 0.30 + (x - 0.15) * aspect * tan;
  const w = (text: string, x: number, width: number) => {
    const y = at(x);
    return { text, x0: x, y0: y - H / 2, x1: x + width, y1: y + H / 2 };
  };
  const page: TextPage = {
    aspect, skewDeg: 1.79,
    words: [w('Drayage', 0.15, 0.06), w('Oakland', 0.22, 0.06), w('$450.00', 0.80, 0.06)],
  };

  const invoice = fakeInvoice({
    lineItems: [{ description: 'Drayage Oakland', quantity: 1, unitPrice: 450, total: 450 }],
  });
  refineInvoiceSources(invoice, [page]);
  const box = (invoice.lineItems[0] as { source?: { box: number[]; angle?: number } }).source!;

  assert.ok(box.angle === 1.79, 'and still carries the tilt');
  // Snug: a highlight round one line of text, not a band containing its fall.
  // Loose on purpose — this guards the SHAPE, not a chosen size. The drift
  // below is what a band would have to be, and the exact multiple is a look
  // that can be tuned without breaking a test that was never about it.
  assert.ok(box.box[3] < H * 2.6, `box ${box.box[3]} should be under ${H * 2.6}`);
  assert.ok(box.box[3] > H, `but not thinner than the glyphs: ${box.box[3]}`);

  // The drift across this row is far larger than the text is tall, which is the
  // whole reason an upright box could not work.
  const drift = (box.box[2]) * aspect * tan;
  assert.ok(drift > H, `drift ${drift} exceeds text height ${H}`);
});

test('a lone state code with nothing to corroborate it gets no box', () => {
  // C1's letterhead is a photograph of small grey type, and OCR read none of
  // it: not the street, not the city, not the zip, not the email. It did find
  // "CA" — in the CUSTOMER's address further down the page — and with a single
  // match and nothing to compare it against, that became the vendor's state
  // highlight. A two-character coincidence pointing at the wrong company.
  const page: TextPage = {
    words: [
      // The bill-to block, which is all this page could be read for.
      word('660', 60, 300, 100, 314), word('Mission', 105, 300, 180, 314),
      word('San', 60, 320, 95, 334), word('Francisco,', 100, 320, 190, 334),
      word('CA', 195, 320, 220, 334), word('94105', 225, 320, 285, 334),
    ],
  };
  const invoice = fakeInvoice({ vendorAddress: '9 Cannery Row · Monterey, CA 93940' });
  refineInvoiceSources(invoice, [page]);
  const src = invoice.fieldSources ?? {};
  assert.equal(src['vendorAddress.state'], undefined, 'the vendor state is not the customer state');
  assert.equal(src['vendorAddress.street'], undefined);
  assert.equal(src['vendorAddress.city'], undefined);
  assert.equal(src['vendorAddress.zip'], undefined);
});

test('a state code IS kept when the rest of its address is beside it', () => {
  // The rule is corroboration, not a ban on short values. Where the address is
  // legible, the long parts anchor the short ones and all four get a box.
  const page: TextPage = {
    words: [
      word('9', 60, 300, 75, 314), word('Cannery', 80, 300, 150, 314), word('Row', 155, 300, 190, 314),
      word('Monterey,', 60, 320, 140, 334), word('CA', 145, 320, 170, 334), word('93940', 175, 320, 230, 334),
      // The same two letters elsewhere on the page, far away.
      word('CA', 700, 800, 725, 814),
    ],
  };
  const invoice = fakeInvoice({ vendorAddress: '9 Cannery Row · Monterey, CA 93940' });
  refineInvoiceSources(invoice, [page]);
  const src = invoice.fieldSources!;
  assert.ok(src['vendorAddress.street'], 'street');
  assert.ok(src['vendorAddress.city'], 'city');
  assert.ok(src['vendorAddress.zip'], 'zip');
  const state = src['vendorAddress.state'];
  assert.ok(state, 'state');
  assert.ok(state!.box[1] < 0.5, `the CA in the address, not the stray one: y=${state!.box[1]}`);
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

// --- a credit note prints its figures negative -------------------------------
//
// The document says "-$240.00"; the extraction reports 240. The signed
// comparison was off by 480 and matched nothing, so the model's guessed box
// survived and the highlight landed on blank paper halfway down the page.

const CREDIT_PAGE: TextPage = {
  words: [
    word('Credit', 60, 200, 110, 212),
    word('-$240.00', 880, 200, 950, 212),   // the line item
    word('Total', 780, 280, 820, 292),
    word('credit', 825, 280, 865, 292),
    word('-$240.00', 870, 280, 950, 292),   // the total
  ],
};

test('a negative figure on the page still anchors a positive extracted amount', () => {
  const hits = findAmountMatches([CREDIT_PAGE], 240);
  assert.equal(hits.length, 2, 'both printings of -$240.00 are found');
  // Sorted by position: the line item sits above the total.
  const ys = hits.map((h) => h.y0).sort((a, b) => a - b);
  assert.ok(Math.abs(ys[0]! - 0.2) < 0.01, 'the line item row');
  assert.ok(Math.abs(ys[1]! - 0.28) < 0.01, 'the total row');
});

test('the sign is still preferred when the document agrees with it', () => {
  const mixed: TextPage = {
    words: [
      word('Charge', 60, 100, 120, 112),
      word('$240.00', 880, 100, 950, 112),
      word('Credit', 60, 300, 110, 312),
      word('-$240.00', 880, 300, 950, 312),
    ],
  };
  // Asking for -240 must not drift onto the positive charge just because the
  // magnitudes agree — the fallback is only for when nothing matches exactly.
  const negative = findAmountMatches([mixed], -240);
  assert.equal(negative.length, 1, 'only the figure that actually reads -240');
  assert.ok(Math.abs(negative[0]!.y0 - 0.3) < 0.01);

  const positive = findAmountMatches([mixed], 240);
  assert.equal(positive.length, 1, 'and only the one that reads 240');
  assert.ok(Math.abs(positive[0]!.y0 - 0.1) < 0.01);
});

// --- grounding -------------------------------------------------------------
//
// The one confidence signal that is not the model's opinion of itself. "0.98"
// and "5,420.00 is printed on page 1" are different kinds of claim, and only
// the second can be checked.

test('a figure that is not on the page is reported', async () => {
  const { ungroundedFields } = await import('../src/payments/doc-provenance.js');
  const page = {
    words: '#ZA-8102 Subtotal $5,420.00 Total due $5,420.00'.split(' ').map((text) => ({
      text, x0: 0, y0: 0, x1: 0.1, y1: 0.02,
    })),
  };

  // What was actually read: both values present, in different formatting.
  assert.deepEqual(
    ungroundedFields({ amount: 5420, invoiceNumber: 'ZA-8102' }, [page]),
    [],
    'punctuation and currency symbols are not a difference',
  );

  // A total nobody printed. This is the failure that matters: it reads cleanly,
  // the model is sure, and it would be paid without anyone looking.
  assert.deepEqual(
    ungroundedFields({ amount: 8420, invoiceNumber: 'ZA-8102' }, [page]),
    ['total'],
  );
  assert.deepEqual(
    ungroundedFields({ amount: 5420, invoiceNumber: 'ZA-9999' }, [page]),
    ['invoiceNumber'],
  );
});

test('no text layer means we could not check, not that it passed', async () => {
  // A photograph has no text to search. Returning [] would say "verified" about
  // the documents least able to be verified — exactly backwards.
  const { ungroundedFields } = await import('../src/payments/doc-provenance.js');
  assert.equal(ungroundedFields({ amount: 5420 }, null), null);
  assert.equal(ungroundedFields({ amount: 5420 }, []), null);
});

test('grounding stays away from anything it would cry wolf about', async () => {
  // A document printing "August 5, 2026" against an extracted "2026-08-05" is
  // correct. Checking dates, terms or addresses would put a warning on nearly
  // every invoice, and a warning on everything is a warning on nothing.
  const { ungroundedFields } = await import('../src/payments/doc-provenance.js');
  const page = {
    words: 'Invoice ZA-8102 Date August 5, 2026 Terms Net 15 Total $5,420.00'.split(' ').map((text) => ({
      text, x0: 0, y0: 0, x1: 0.1, y1: 0.02,
    })),
  };
  assert.deepEqual(
    ungroundedFields(
      { amount: 5420, invoiceNumber: 'ZA-8102', invoiceDate: '2026-08-05', terms: 'Net 15' },
      [page],
    ),
    [],
  );
});

test('a multi-page document reports all of its pages, not one', async () => {
  // The text path has no images to count and answered "1". True of most
  // invoices, and wrong about precisely the documents it handles best: a
  // three-page PDF reported one page, and the viewer — which trusts that
  // number — left pages two and three rendered, stored and unreachable.
  const { documentPageCount } = await import('../src/payments/document-extract.js');

  const three = { length: 3 };
  assert.equal(documentPageCount(three, null), 3, 'the renders are what the viewer shows');
  assert.equal(documentPageCount(null, three), 3, 'pdftotext emits an entry per page');
  assert.equal(documentPageCount(three, { length: 1 }), 3, 'renders win — they are the display');

  // Neither available is the only case where any answer is a guess, and one is
  // the least wrong.
  assert.equal(documentPageCount(null, null), 1);
  assert.equal(documentPageCount({ length: 0 }, null), 1, 'zero renders is not zero pages');
});

// --- characters Postgres will not store --------------------------------------

test('a NUL from the model is removed before anything tries to store it', () => {
  // D4 failed to become a bill at all, on 22P05 — "\u0000 cannot be converted
  // to text" — and the raw Prisma error went to the screen. A NUL is valid JSON
  // and a valid JavaScript string and illegal in a Postgres text or jsonb
  // value, so it travels from the model all the way to the INSERT before
  // anything objects. The document was innocent: its text layer has no NUL in
  // it anywhere. The model emitted one.
  const dirty = {
    vendorName: 'Brightwave Media Ltd\u0000',
    lineItems: [{ description: 'Design retainer \u0000\u0001 August' }],
    remitTo: { street: '14 Clerkenwell\u0007 Road' },
  };
  assert.deepEqual(stripUnstorableCharacters(dirty), {
    vendorName: 'Brightwave Media Ltd',
    lineItems: [{ description: 'Design retainer  August' }],
    remitTo: { street: '14 Clerkenwell Road' },
  });
});

test('the whitespace a letterhead actually uses survives', () => {
  // Tab, newline and carriage return are how an address is printed across two
  // lines — stripping those would undo the address splitting.
  assert.equal(
    stripUnstorableCharacters('340 Congress St\r\n\tAustin, TX 78701'),
    '340 Congress St\r\n\tAustin, TX 78701',
  );
});
