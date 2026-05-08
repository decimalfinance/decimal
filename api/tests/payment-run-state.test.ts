import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canCancelPaymentRun,
  canClosePaymentRun,
  derivePaymentRunStateFromRows,
  isPaymentRunState,
} from '../src/payments/run-state.js';
import { formatIsoDateTime, formatUsdcAmount, shortenAddress } from '../src/infra/api-format.js';

test('payment run state derivation is deterministic and terminal-aware', () => {
  assert.equal(isPaymentRunState('settled'), true);
  assert.equal(isPaymentRunState('unknown'), false);
  assert.equal(derivePaymentRunStateFromRows('closed', [{ derivedState: 'exception' }]), 'closed');
  assert.equal(derivePaymentRunStateFromRows('draft', [{ derivedState: 'approved' }, { derivedState: 'ready_for_execution' }]), 'ready_for_execution');
  assert.equal(derivePaymentRunStateFromRows('draft', [{ derivedState: 'settled' }, { derivedState: 'closed' }]), 'settled');
  assert.equal(derivePaymentRunStateFromRows('submitted_onchain', [{ derivedState: 'ready_for_execution' }]), 'submitted_onchain');
});

test('payment run cancel and close guards reject unsafe workflow moves', () => {
  assert.equal(canCancelPaymentRun({
    storedState: 'draft',
    derivedState: 'draft',
    orders: [{ derivedState: 'approved' }],
  }).allowed, true);
  assert.equal(canCancelPaymentRun({
    storedState: 'draft',
    derivedState: 'draft',
    orders: [{ derivedState: 'approved', hasExecutionEvidence: true }],
  }).allowed, false);
  assert.equal(canClosePaymentRun({
    derivedState: 'submitted_onchain',
    orders: [{ derivedState: 'settled' }, { derivedState: 'approved' }],
  }).allowed, false);
  assert.equal(canClosePaymentRun({
    derivedState: 'settled',
    orders: [{ derivedState: 'settled' }, { derivedState: 'closed' }],
  }).allowed, true);
});

test('API boundary formatting helpers produce stable human-readable values', () => {
  assert.equal(formatUsdcAmount('10000'), '0.01 USDC');
  assert.equal(formatUsdcAmount('123456789'), '123.456789 USDC');
  assert.equal(formatIsoDateTime('2026-04-17T00:00:00.000Z'), '2026-04-17T00:00:00.000Z');
  assert.equal(shortenAddress('VhfmPjvQxSiQW2FjnvoghewGGVYaWcz4cmDxpFPQEti'), 'VhfmPjvQ...xpFPQEti');
});
