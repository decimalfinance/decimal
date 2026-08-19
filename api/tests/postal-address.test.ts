// --- vendor addresses off a letterhead ---------------------------------------
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitPostalAddress } from '../src/payments/bills.js';

test('a middle dot separates address parts just like a comma', () => {
  // Both of these are real B-series letterheads. Splitting on commas alone put
  // the city inside the street and left the city box reading "Not on document".
  assert.deepEqual(splitPostalAddress('500 Howard St · San Francisco, CA 94105'), {
    street: '500 Howard St', city: 'San Francisco', state: 'CA', zip: '94105',
  });
  assert.deepEqual(splitPostalAddress('1 Beacon St · Boston, MA 02108'), {
    street: '1 Beacon St', city: 'Boston', state: 'MA', zip: '02108',
  });
});

test('bullets and pipes separate too, and plain commas are unchanged', () => {
  assert.deepEqual(splitPostalAddress('12 Rutland St • Boston, MA 02118'), {
    street: '12 Rutland St', city: 'Boston', state: 'MA', zip: '02118',
  });
  assert.deepEqual(splitPostalAddress('88 Harbor Rd | Oakland, CA 94607'), {
    street: '88 Harbor Rd', city: 'Oakland', state: 'CA', zip: '94607',
  });
  assert.deepEqual(splitPostalAddress('660 Mission St, Floor 4, San Francisco, CA 94105'), {
    street: '660 Mission St, Floor 4', city: 'San Francisco', state: 'CA', zip: '94105',
  });
});

test('an address it cannot split stays whole in street rather than vanishing', () => {
  assert.deepEqual(splitPostalAddress('Somewhere Unhelpful'), {
    street: 'Somewhere Unhelpful', city: null, state: null, zip: null,
  });
  assert.deepEqual(splitPostalAddress(null), { street: null, city: null, state: null, zip: null });
});
