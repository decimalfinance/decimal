import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namesLookRelated } from '../src/payments/bills.js';

// The "addressed to someone else" gate. Getting this wrong in the permissive
// direction means a bill made out to another company passes review silently,
// so the false-negative cases below matter more than the false-positive ones.
//
// Regression: "Decimal Labs" vs "Halcyon Labs, Inc." was treated as related
// because both contain "labs" — a real misaddressed bill reached review with
// no flag at all.

test('a bill addressed to a different company is not treated as related', () => {
  assert.equal(namesLookRelated('Halcyon Labs, Inc.', 'Decimal Labs'), false);
  assert.equal(namesLookRelated('Halcyon Labs, Inc.', 'acme corp'), false);
  assert.equal(namesLookRelated('Northwind Trading', 'Acme Corporation'), false);
});

test('generic industry words alone never make two companies related', () => {
  for (const [a, b] of [
    ['Alpha Technologies', 'Beta Technologies'],
    ['Foo Systems Inc', 'Bar Systems LLC'],
    ['One Global Solutions', 'Two Global Solutions'],
    ['Redwood Digital Studio', 'Bluepeak Digital Studio'],
  ] as const) {
    assert.equal(namesLookRelated(a, b), false, `${a} vs ${b} should NOT look related`);
  }
});

test('the same company in different dress still matches', () => {
  assert.equal(namesLookRelated('Acme Corp', 'acme corp'), true);
  assert.equal(namesLookRelated('Acme Corporation Ltd', 'Acme'), true);
  assert.equal(namesLookRelated('Decimal Labs, Inc.', 'Decimal Labs'), true);
  assert.equal(namesLookRelated('Northwind Trading Co.', 'Northwind Trading'), true);
});

test('when nothing distinctive remains, stay quiet rather than cry wolf', () => {
  // Both sides reduce to noise — we genuinely cannot tell, and a false alarm
  // on every bill would train people to click through the real ones.
  assert.equal(namesLookRelated('Labs Inc', 'Labs LLC'), true);
  assert.equal(namesLookRelated('', 'Acme'), true);
});
