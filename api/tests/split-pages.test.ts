import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planPageSplit } from '../src/payments/split-pages.js';

// The shapes come from the M-series (TESTING-INVOICES.md): where each invoice's
// number is printed, and the pages each bill should get.

test('three invoices, a page each, get a page each', () => {
  assert.deepEqual(planPageSplit([[1], [2], [3]], 3), [{ from: 1, to: 1 }, { from: 2, to: 2 }, { from: 3, to: 3 }]);
});

test('one template twice: the second invoice\'s number on both its pages still starts it on its first', () => {
  assert.deepEqual(planPageSplit([[1], [2, 3]], 3), [{ from: 1, to: 1 }, { from: 2, to: 3 }]);
});

test('a cover sheet listing both numbers goes to the first invoice, whichever row came back first', () => {
  const plan = [{ from: 1, to: 2 }, { from: 3, to: 3 }];
  assert.deepEqual(planPageSplit([[1, 2], [1, 3]], 3), plan);
  assert.deepEqual(planPageSplit([[1, 3], [1, 2]], 3), [plan[1], plan[0]], 'rows out of page order keep their own ranges');
});

test('two invoices printed on one page can\'t be split, so both keep the whole upload', () => {
  assert.equal(planPageSplit([[1], [1]], 1), null);
  assert.equal(planPageSplit([[1], [1]], 2), null);
});

test('no plan without a number found for every invoice, or with one invoice', () => {
  assert.equal(planPageSplit([[1], null], 2), null);
  assert.equal(planPageSplit([[1], []], 2), null);
  assert.equal(planPageSplit([[1, 2]], 2), null);
  assert.equal(planPageSplit([[9], [2]], 3), null, 'a page that isn\'t in the upload');
});

test('the same number on two rows, an invoice and its payment slip, gives each its page', () => {
  assert.deepEqual(planPageSplit([[1, 2], [1, 2]], 2), [{ from: 1, to: 1 }, { from: 2, to: 2 }]);
});

test('a page after the last invoice goes to it', () => {
  assert.deepEqual(planPageSplit([[1], [2]], 4), [{ from: 1, to: 1 }, { from: 2, to: 4 }]);
});
