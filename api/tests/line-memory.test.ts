// Line memory's matcher, on its own: which lines read as the same thing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineSimilarity, lineTokens, matchLine, type Precedent } from '../src/accounting/line-memory.js';

const p = (description: string, category: string, at: number): Precedent => ({
  key: [...lineTokens(description)].sort().join(' '), description, tokens: lineTokens(description), category, paymentOrderId: `bill-${at}`, invoiceNumber: `INV-${at}`, byUserId: null, at, confirmed: true,
});

test('line memory: quantities, months and plurals do not make a line different', () => {
  assert.deepEqual([...lineTokens('Stock photography licenses (8)')], ['stock', 'photography', 'license']);
  assert.equal(lineSimilarity(lineTokens('Social media management — August'), lineTokens('Social media management - September')), 1);
  assert.equal(lineSimilarity(lineTokens('Stock photography licenses (8)'), lineTokens('Stock Photography License (12)')), 1);
});

test('line memory: the same kind of line matches; a different thing from the same vendor does not', () => {
  const memory = [p('Stock photography licenses (8)', 'Taxes & licenses', 2), p('Social media management — August', 'Advertising & marketing', 1)];
  assert.equal(matchLine('Stock photography licenses (20)', memory)?.category, 'Taxes & licenses');
  assert.equal(matchLine('Social media management — October', memory)?.category, 'Advertising & marketing');
  assert.equal(matchLine('Content production (4 assets)', memory), null, 'nothing like it yet: no guess from memory');
  assert.equal(matchLine('Photography for the launch event', memory), null, 'one shared word is not the same line');
});

test('line memory: when two precedents are equally close, the newest decision wins', () => {
  const memory = [p('Font license — campaign use', 'Taxes & licenses', 5), p('Font license — campaign use', 'Dues & subscriptions', 1)]
    .sort((a, b) => b.at - a.at);
  const m = matchLine('Font license - campaign use', memory)!;
  assert.equal(m.category, 'Taxes & licenses');
  assert.equal(m.invoiceNumber, 'INV-5');
});

test('line memory: the model is shown one line per kind, word-sharing ones first, then the newest others', async () => {
  const { relevantPrecedents } = await import('../src/accounting/line-memory.js');
  const memory = [
    p('Office chairs (4)', 'Office supplies & software', 9),
    p('Font license — campaign use', 'Taxes & licenses', 8),
    p('Font license — campaign use', 'Dues & subscriptions', 3),   // older decision, same kind: not shown
    p('Stock photography licenses (8)', 'Taxes & licenses', 5),
  ].sort((a, b) => b.at - a.at);
  const shown = relevantPrecedents(['Font license — web use'], memory, 3);
  assert.deepEqual(shown.map((s) => s.description), ['Font license — campaign use', 'Stock photography licenses (8)', 'Office chairs (4)'],
    'most shared words first; then by recency');
  assert.equal(shown[0]!.category, 'Taxes & licenses', 'the decision in force, not an older one');
  assert.equal(relevantPrecedents(['Font license — web use'], memory, 1).length, 1, 'never more than asked');
  assert.deepEqual(relevantPrecedents(['(4)'], memory), [], 'a line with no words has nothing to compare');
});
