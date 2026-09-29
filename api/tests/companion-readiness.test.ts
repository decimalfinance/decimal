import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companionReadiness } from '../src/companion/readiness.js';

// "Ready" is the companion's promise that nothing about a bill calls for
// judgement. It is only worth making if it is strict, and the reason it gives
// for anything else has to be the most important one.

const clean = {
  state: 'draft',
  vendorName: 'Brightwave Media',
  flags: [] as Array<{ severity: 'danger' | 'warning' | 'info'; blocking: boolean; short: string }>,
  missing: [] as string[],
  priorBillsFromVendor: 4,
  hasCodingRule: true,
  fieldStatus: { vendorName: 'confident', total: 'confident', invoiceNumber: 'confident' } as Record<string, unknown>,
  ungrounded: [] as string[],
  confirmedByPerson: false,
};

test('a bill with a known vendor, a category habit and nothing doubtful is ready', () => {
  assert.deepEqual(companionReadiness(clean), { ready: true, reason: null });
});

test('only drafts are sorted; a bill past review has no verdict', () => {
  assert.equal(companionReadiness({ ...clean, state: 'submitted' }), null);
});

test('a blocking flag is the reason, ahead of everything else', () => {
  const v = companionReadiness({
    ...clean,
    priorBillsFromVendor: 0,
    hasCodingRule: false,
    flags: [{ severity: 'info', blocking: false, short: 'First bill from vendor' }, { severity: 'danger', blocking: true, short: 'Possible duplicate' }],
  })!;
  assert.equal(v.ready, false);
  assert.equal(v.reason, 'Possible duplicate');
});

test('missing facts come next, then warnings', () => {
  assert.equal(companionReadiness({ ...clean, missing: ['amount', 'line items'] })!.reason, 'Missing amount and line items');
  assert.equal(companionReadiness({ ...clean, flags: [{ severity: 'warning', blocking: false, short: 'Similar vendor' }] })!.reason, 'Similar vendor');
});

test('an info flag alone does not stop a bill being ready', () => {
  assert.equal(companionReadiness({ ...clean, flags: [{ severity: 'info', blocking: false, short: 'Duplicate cleared' }] })!.ready, true);
});

test('a doubtful read of a key field needs a look, unless a person already confirmed it', () => {
  const doubtful = { ...clean, fieldStatus: { ...clean.fieldStatus, total: 'partial' } };
  assert.equal(companionReadiness(doubtful)!.reason, 'Worth a second look at the total');
  assert.equal(companionReadiness({ ...doubtful, confirmedByPerson: true })!.ready, true);
  assert.equal(companionReadiness({ ...clean, ungrounded: ['invoiceNumber'] })!.reason, 'Worth a second look at the invoice number');
});

test('a first bill from a vendor, or one with no category habit, is not ready', () => {
  assert.equal(companionReadiness({ ...clean, priorBillsFromVendor: 0 })!.reason, 'First bill from Brightwave Media');
  assert.equal(companionReadiness({ ...clean, hasCodingRule: false })!.reason, 'No category habit for Brightwave Media yet');
});
