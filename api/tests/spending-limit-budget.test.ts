import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  loadOnchainSpendingLimitRemaining,
  setSpendingLimitExecutionRuntimeForTests,
} from '../src/agents/spending-limit-execution.js';

// Pure unit tests for the on-chain remaining-budget read that backs the routing
// fit-check. No database is touched: only the swappable Solana runtime is stubbed.
// This is the read that lets a budget-exhausted payment fall back to a Squads
// proposal (does_not_fit) instead of hard-failing at execution time.

const spendingLimitPda = Keypair.generate().publicKey.toBase58();

afterEach(() => {
  setSpendingLimitExecutionRuntimeForTests(null);
});

test('remaining-budget read returns null when the onchain spending limit is not synced yet', async () => {
  setSpendingLimitExecutionRuntimeForTests({
    loadSpendingLimit: async () => null,
  });

  const remaining = await loadOnchainSpendingLimitRemaining(spendingLimitPda);

  assert.equal(remaining, null);
});

test('remaining-budget read returns the live period budget as a bigint', async () => {
  setSpendingLimitExecutionRuntimeForTests({
    loadSpendingLimit: async () => ({
      amount: { toString: () => '1000000' },
      remainingAmount: { toString: () => '250000' },
      members: [],
      destinations: [],
    }),
  });

  const remaining = await loadOnchainSpendingLimitRemaining(spendingLimitPda);

  assert.equal(remaining, 250000n);
});

test('remaining-budget read surfaces a fully-exhausted period as zero (forces proposal fallback)', async () => {
  setSpendingLimitExecutionRuntimeForTests({
    loadSpendingLimit: async () => ({
      amount: { toString: () => '1000000' },
      remainingAmount: { toString: () => '0' },
      members: [],
      destinations: [],
    }),
  });

  const remaining = await loadOnchainSpendingLimitRemaining(spendingLimitPda);

  assert.equal(remaining, 0n);
});
