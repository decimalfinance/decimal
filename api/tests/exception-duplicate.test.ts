import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  billFactsFrom, compareBills, pairKey, pairFingerprint, sideOf, recommendationFor, validateFinding,
  type BillFacts, type BillRow, type FingerprintSide,
} from '../src/exceptions/duplicate-logic.js';

// The deterministic half of the duplicate investigator. Nothing here involves a
// model: these are the facts it is handed and the rules that decide what its
// verdict means, so they are tested as ordinary code.

const row = (over: Partial<BillRow> & { lines?: unknown[]; tax?: number | null; verification?: unknown }): BillRow => ({
  paymentOrderId: over.paymentOrderId ?? 'a',
  invoiceNumber: over.invoiceNumber ?? 'INV-1',
  amountRaw: over.amountRaw ?? 1_000_000_000n,
  state: over.state ?? 'draft',
  createdAt: over.createdAt ?? new Date('2026-09-01T00:00:00Z'),
  counterparty: { displayName: 'Harborline Construction' },
  invoiceDocument: { filename: 'x.pdf' },
  metadataJson: {
    agent: { extracted: {
      invoiceNumber: over.invoiceNumber ?? 'INV-1', invoiceDate: '2026-09-01', subtotal: 1000, taxAmount: over.tax ?? 0,
      lineItems: over.lines ?? [{ description: 'Site survey', quantity: 1, unitPrice: 1000, total: 1000 }],
    } },
    ...(over.verification ? { verification: over.verification } : {}),
  },
});

const facts = (over: Partial<BillFacts>): BillFacts => ({
  id: 'a', vendorName: 'V', invoiceNumber: 'INV-1', invoiceDate: '2026-09-01', dueDate: null, poNumber: null,
  currency: 'USD', subtotal: 1000, tax: 0, total: 1000, state: 'draft', uploadedAt: '2026-09-01T00:00:00Z',
  confirmed: false, documentFilename: null,
  lines: [{ description: 'Site survey', quantity: 1, unitPrice: 1000, amount: 1000 }],
  ...over,
});

// ---- facts -----------------------------------------------------------------

test('bill facts use what a person confirmed over what the model read', () => {
  const f = billFactsFrom(row({
    verification: {
      confirmedAt: '2026-09-02T00:00:00Z',
      fields: { invoiceNumber: 'INV-1-CORRECTED', taxAmount: 80 },
      lines: [{ description: 'Site survey (corrected)', quantity: 1, unitPrice: 1000, amount: 1000 }],
    },
  }));
  assert.equal(f.invoiceNumber, 'INV-1-CORRECTED');
  assert.equal(f.tax, 80);
  assert.equal(f.lines[0]!.description, 'Site survey (corrected)');
  assert.equal(f.confirmed, true);
});

test('an extracted line calls its amount `total`, and the bill total comes from the order', () => {
  const f = billFactsFrom(row({ amountRaw: 1_080_000_000n }));
  assert.equal(f.lines[0]!.amount, 1000);
  assert.equal(f.total, 1080);
  assert.equal(f.vendorName, 'Harborline Construction');
});

// ---- comparison ------------------------------------------------------------

test('two copies of the same bill compare as identical', () => {
  const c = compareBills(facts({ id: 'a' }), facts({ id: 'b' }));
  assert.equal(c.identical, true);
  assert.equal(c.totalDifferenceExplainedBy, 'no_difference');
  assert.equal(c.lines.matched.length, 1);
});

test('a corrected tax line explains the whole difference and is not identical', () => {
  const c = compareBills(facts({ id: 'a', tax: 0, total: 1000 }), facts({ id: 'b', tax: 82.5, total: 1082.5 }));
  assert.equal(c.identical, false);
  assert.equal(c.totals.delta, 82.5);
  assert.equal(c.totalDifferenceExplainedBy, 'tax');
});

test('an extra line on one side shows up as only on that side', () => {
  const b = facts({ id: 'b', total: 1500, subtotal: 1500, lines: [
    { description: 'Site survey', quantity: 1, unitPrice: 1000, amount: 1000 },
    { description: 'Travel', quantity: 1, unitPrice: 500, amount: 500 },
  ] });
  const c = compareBills(facts({ id: 'a' }), b);
  assert.deepEqual(c.lines.onlyInB, [1]);
  assert.equal(c.identical, false);
  assert.equal(c.totalDifferenceExplainedBy, 'subtotal');
});

test('lines worded differently are left unpaired rather than guessed', () => {
  const a = facts({ id: 'a', lines: [{ description: 'Consulting, phase 1 (40h)', quantity: 40, unitPrice: 25, amount: 1000 }] });
  const b = facts({ id: 'b', lines: [{ description: 'Advisory services (40h)', quantity: 40, unitPrice: 25, amount: 1000 }] });
  const c = compareBills(a, b);
  assert.equal(c.lines.matched.length, 0);
  assert.deepEqual(c.lines.onlyInA, [0]);
  assert.deepEqual(c.lines.onlyInB, [0]);
  assert.equal(c.identical, false, 'same total, but not provably the same bill');
});

test('case and punctuation do not stop two lines pairing', () => {
  const b = facts({ id: 'b', lines: [{ description: 'SITE SURVEY.', quantity: 1, unitPrice: 1000, amount: 1000 }] });
  assert.equal(compareBills(facts({ id: 'a' }), b).lines.matched.length, 1);
});

// ---- identity and staleness ------------------------------------------------

const side = (over: Partial<FingerprintSide>): FingerprintSide => ({
  id: 'a', invoiceNumber: 'INV-1', amountRaw: 1n, counterpartyId: 'v', state: 'draft', hasOverride: false, ...over,
});

test('either bill of a pair produces the same key', () => {
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'));
  assert.notEqual(pairKey('a', 'b'), pairKey('a', 'c'));
});

test('the fingerprint is the same from either side and changes when the evidence does', () => {
  const a = side({ id: 'a' }); const b = side({ id: 'b' });
  const base = pairFingerprint(a, b);
  assert.equal(pairFingerprint(b, a), base);
  assert.notEqual(pairFingerprint(a, { ...b, hasOverride: true }), base, 'clearing one side refreshes the other');
  assert.notEqual(pairFingerprint(a, { ...b, state: 'submitted' }), base);
  assert.notEqual(pairFingerprint(a, { ...b, amountRaw: 2n }), base);
  assert.equal(pairFingerprint(a, { ...b, invoiceNumber: 'inv 1' }), base, 'number formatting is not a change');
});

test('older and newer by upload time, with a stable tie-break', () => {
  const early = { id: 'z', createdAt: new Date('2026-09-01') };
  const late = { id: 'a', createdAt: new Date('2026-09-02') };
  assert.equal(sideOf(early, late), 'older');
  assert.equal(sideOf(late, early), 'newer');
  const t = new Date('2026-09-01');
  assert.equal(sideOf({ id: 'a', createdAt: t }, { id: 'b', createdAt: t }), 'older');
  assert.equal(sideOf({ id: 'b', createdAt: t }, { id: 'a', createdAt: t }), 'newer');
});

// ---- verdict → action ------------------------------------------------------

test('a duplicate keeps the older bill and closes the copy', () => {
  assert.equal(recommendationFor('duplicate', 'older'), 'clear_duplicate');
  assert.equal(recommendationFor('duplicate', 'newer'), 'not_ours');
});

test('a replacement keeps the corrected bill and closes the original', () => {
  assert.equal(recommendationFor('replacement', 'newer'), 'clear_duplicate');
  assert.equal(recommendationFor('replacement', 'older'), 'not_ours');
});

test('never both sides closed, never both sides of a real duplicate cleared', () => {
  for (const v of ['duplicate', 'replacement'] as const) {
    const pair = [recommendationFor(v, 'older'), recommendationFor(v, 'newer')].sort();
    assert.deepEqual(pair, ['clear_duplicate', 'not_ours'], `${v} closes exactly one side`);
  }
  assert.equal(recommendationFor('not_duplicate', 'older'), 'clear_duplicate');
  assert.equal(recommendationFor('unsure', 'newer'), 'ask_someone');
});

// ---- validation ------------------------------------------------------------

const seen = new Set(['this.total', 'other.total', 'other.line.0']);
const differentTotals = compareBills(facts({ id: 'a' }), facts({ id: 'b', tax: 82.5, total: 1082.5 }));
const identical = compareBills(facts({ id: 'a' }), facts({ id: 'b' }));

test('a finding citing evidence no tool returned is dropped', () => {
  const v = validateFinding({
    verdict: 'replacement', confidence: 'high', headline: 'Corrected reissue', reason: 'Tax corrected.',
    findings: [
      { claim: 'The tax line is the only difference.', refs: ['this.total', 'other.total'] },
      { claim: 'The vendor emailed to say so.', refs: ['email.123'] },
    ],
    checked: ['totals'], couldNotCheck: [],
  }, seen, differentTotals, 'fallback');
  assert.equal(v.findings.length, 1);
  assert.equal(v.verdict, 'replacement');
  assert.equal(v.confidence, 'high');
  assert.ok(v.adjustments.some((a) => /dropped/.test(a)));
});

test('no real evidence at all means unsure', () => {
  const v = validateFinding({
    verdict: 'not_duplicate', confidence: 'high', headline: 'Different work', reason: 'Different work.',
    findings: [{ claim: 'Trust me.', refs: ['nowhere'] }], checked: [], couldNotCheck: [],
  }, seen, differentTotals, 'fallback');
  assert.equal(v.verdict, 'unsure');
  assert.equal(v.confidence, 'low');
});

test('calling identical bills anything but a duplicate is capped at low confidence', () => {
  const v = validateFinding({
    verdict: 'not_duplicate', confidence: 'high', headline: 'h', reason: 'r r r',
    findings: [{ claim: 'c', refs: ['this.total'] }], checked: [], couldNotCheck: [],
  }, seen, identical, 'fallback');
  assert.equal(v.verdict, 'not_duplicate', 'the verdict is shown, not rewritten');
  assert.equal(v.confidence, 'low');
});

test('a "duplicate" whose totals differ is capped at low confidence', () => {
  const v = validateFinding({
    verdict: 'duplicate', confidence: 'high', headline: 'h', reason: 'r r r',
    findings: [{ claim: 'c', refs: ['this.total'] }], checked: [], couldNotCheck: [],
  }, seen, differentTotals, 'fallback');
  assert.equal(v.confidence, 'low');
});

test('an unknown verdict reads as unsure, and an empty reason falls back to the headline', () => {
  const v = validateFinding({
    verdict: 'maybe', confidence: 'certain', headline: '', reason: '',
    findings: [{ claim: 'c', refs: ['this.total'] }], checked: 'not a list', couldNotCheck: null,
  }, seen, null, 'Looks like a duplicate of INV-1');
  assert.equal(v.verdict, 'unsure');
  assert.equal(v.confidence, 'low');
  assert.equal(v.headline, 'Looks like a duplicate of INV-1');
  assert.equal(v.reason, 'Looks like a duplicate of INV-1');
  assert.deepEqual(v.checked, []);
});

// ---- the terminal tool ------------------------------------------------------

test('the finding schema satisfies strict mode: every property required, nothing extra', async () => {
  const { strictSchemaViolations } = await import('../src/payments/document-extract.js');
  const { SUBMIT_FINDING_SCHEMA } = await import('../src/exceptions/duplicate.js');
  assert.deepEqual(strictSchemaViolations(SUBMIT_FINDING_SCHEMA), []);
});

test('refs written into a claim are taken out, leaving the sentence', async () => {
  const { stripInlineRefs } = await import('../src/exceptions/duplicate-logic.js');
  // Verbatim from the first real-model run (gpt-4.1-mini, B4 vs A2).
  assert.equal(
    stripInlineRefs('Both bills have identical invoice number BW-2210, invoice date 2026-08-06, and total $4500 (refs: this.invoiceNumber, other.invoiceNumber, this.invoiceDate, other.invoiceDate, compare.totals).'),
    'Both bills have identical invoice number BW-2210, invoice date 2026-08-06, and total $4500.',
  );
  assert.equal(stripInlineRefs('Tax is the only difference [see: compare.tax].'), 'Tax is the only difference.');
  assert.equal(stripInlineRefs('A plain sentence stays as it is.'), 'A plain sentence stays as it is.');
});
