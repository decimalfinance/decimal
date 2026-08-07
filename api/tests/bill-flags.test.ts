import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namesLookRelated, evaluateBillFlags, summarizeBillFlags } from '../src/payments/bill-flags.js';

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

// --- the flags themselves -----------------------------------------------
//
// These exist because the bug was never a missing check. The check was there;
// the workbench just never asked. Both surfaces now call evaluateBillFlags, so
// what is asserted here is what BOTH screens show.

const baseFacts = {
  vendorName: 'Acme Cloud Services, Inc.',
  organizationName: 'Decimal Labs',
  amountRaw: 4_820_000_000n,
  billToName: null,
  triggeredRules: [] as string[],
  vendorHold: null,
  ceilingMinor: null,
  duplicates: [],
  duplicateOverride: null,
  amounts: { lineItemsTotal: null, subtotal: null, tax: null, total: null },
};

test('a bill addressed to another company is flagged, danger, and blocking', () => {
  const flags = evaluateBillFlags({ ...baseFacts, billToName: 'Halcyon Labs, Inc.' });
  const flag = flags.find((f) => f.kind === 'addressed_elsewhere');
  assert.ok(flag, 'expected an addressed_elsewhere flag');
  assert.equal(flag.severity, 'danger');
  assert.equal(flag.blocking, true);
  assert.match(flag.message, /Halcyon Labs, Inc\./);
  assert.equal(summarizeBillFlags(flags).blocking, true);
});

test('a bill addressed to us raises nothing', () => {
  const flags = evaluateBillFlags({ ...baseFacts, billToName: 'Decimal Labs, Inc.' });
  assert.deepEqual(flags, []);
  assert.equal(summarizeBillFlags(flags).blocking, false);
});

test('the worst flag comes first, so a one-line row shows the worst thing', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    billToName: 'Halcyon Labs, Inc.',
    triggeredRules: ['unreviewed_counterparty'],
  });
  // new_vendor is info and would otherwise sort first by insertion order.
  assert.equal(flags[0]!.severity, 'danger');
  assert.equal(summarizeBillFlags(flags).worst!.kind, 'addressed_elsewhere');
  assert.equal(summarizeBillFlags(flags).dangerCount, 1);
});

test('every flag carries a short form a table row can render', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    billToName: 'Halcyon Labs, Inc.',
    triggeredRules: ['known_counterparty_wallet_changed', 'invalid_extracted_wallet_address', 'unreviewed_counterparty'],
    ceilingMinor: 1_000_000n,
  });
  assert.ok(flags.length >= 4);
  for (const f of flags) {
    assert.ok(f.short.length > 0 && f.short.length <= 40, `bad short form: "${f.short}"`);
    assert.ok(f.message.length > f.short.length);
  }
});

test('an info-only flag never blocks the bill', () => {
  const flags = evaluateBillFlags({ ...baseFacts, triggeredRules: ['unreviewed_counterparty'] });
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.kind, 'new_vendor');
  assert.equal(summarizeBillFlags(flags).blocking, false);
});

// --- arithmetic ---------------------------------------------------------------
//
// The cheapest gate we have and the only one that catches extraction being
// confidently wrong. Every case below asserts the dangerous bill is BLOCKED,
// not merely that a clean one passes — a gate that never refuses anything is
// decoration.

test('line items that do not add up to the document total block the bill', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: 4_000, subtotal: null, tax: null, total: 4_820 },
  });
  const flag = flags.find((f) => f.kind === 'lines_do_not_sum');
  assert.ok(flag, 'a total the lines do not support must be flagged');
  assert.equal(flag.blocking, true);
  assert.equal(summarizeBillFlags(flags).blocking, true);
});

test('subtotal plus tax that does not equal the total blocks the bill', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: null, subtotal: 4_000, tax: 320, total: 4_820 },
  });
  const flag = flags.find((f) => f.kind === 'total_does_not_reconcile');
  assert.ok(flag, '4,000 + 320 is not 4,820 and must not pass silently');
  assert.equal(flag.blocking, true);
});

test('a bill whose figures reconcile raises nothing', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: 4_500, subtotal: 4_500, tax: 320, total: 4_820 },
  });
  assert.deepEqual(flags, []);
});

test('sub-cent rounding is not treated as disagreement', () => {
  // Invoices print to two decimals; a third-decimal remainder is arithmetic,
  // not a discrepancy, and flagging it would train people to ignore the flag.
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: 4_820.001, subtotal: 4_820, tax: 0, total: 4_820 },
  });
  assert.deepEqual(flags, []);
});

test('missing figures are not mismatches', () => {
  // Plenty of real invoices carry no subtotal or tax line. Absence must stay
  // silent, or every simple invoice screams.
  for (const amounts of [
    { lineItemsTotal: null, subtotal: null, tax: null, total: 4_820 },
    { lineItemsTotal: null, subtotal: 4_820, tax: null, total: 4_820 },
    { lineItemsTotal: 4_820, subtotal: null, tax: null, total: null },
  ]) {
    assert.deepEqual(evaluateBillFlags({ ...baseFacts, amounts }), [], JSON.stringify(amounts));
  }
});

test('a line the model could not read stops the sum being trusted', () => {
  // If one line's total is unreadable, the remaining lines will not match the
  // document — and claiming a mismatch would be blaming the document for our
  // own gap. The check simply does not run.
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: null, subtotal: 4_820, tax: 0, total: 4_820 },
  });
  assert.deepEqual(flags, []);
});
