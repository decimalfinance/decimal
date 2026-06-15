import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifySettlementError,
  classifySettlementResult,
} from '../src/agents/settlement-reconciler.js';

// Pure tests for the reconciler's decision logic. The DB-mutating paths need an isolated
// integration DB (the suite's truncate-based tests must not run against the shared database).

test('settled when all expected transfers reconcile', () => {
  assert.equal(classifySettlementResult({ allSettled: true }), 'settled');
});

test('mismatch when the transaction landed but deltas do not match', () => {
  assert.equal(classifySettlementResult({ allSettled: false }), 'mismatch');
});

test('a not-yet-visible transaction is pending (retry next tick), not a failure', () => {
  const error = new Error('Confirmed transaction is not yet available from RPC. Retry settlement verification shortly.');
  assert.equal(classifySettlementError(error), 'pending');
});

test('an on-chain failure releases the claim (tx_failed)', () => {
  const error = new Error('Execution transaction failed on-chain: {"InstructionError":[0,{"Custom":1}]}');
  assert.equal(classifySettlementError(error), 'tx_failed');
});

test('an unknown/transient error defaults to pending so money is never wrongly released', () => {
  assert.equal(classifySettlementError(new Error('fetch failed')), 'pending');
  assert.equal(classifySettlementError('weird non-error'), 'pending');
});
