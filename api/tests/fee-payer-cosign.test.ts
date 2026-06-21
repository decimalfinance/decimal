import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

// The fee-payer sponsorship mechanic: a transaction whose fee payer differs from its
// instruction signer can be signed in two steps — the signer (agent, via Privy) first,
// then the fee payer after — and BOTH signatures survive the round-trip. This is exactly
// what cosignWithFeePayer relies on, so lock it.
test('fee-payer cosign preserves the signer signature and fills the fee-payer slot', () => {
  const feePayer = Keypair.generate();
  const signer = Keypair.generate();
  const dest = Keypair.generate();

  // An instruction that requires `signer` to sign (transfer from signer's account).
  const ix = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: dest.publicKey, lamports: 1000 });
  const message = new TransactionMessage({
    payerKey: feePayer.publicKey, // fee payer becomes account 0
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [ix],
  }).compileToV0Message();

  const keys = message.staticAccountKeys;
  const feePayerIdx = keys.findIndex((k) => k.equals(feePayer.publicKey));
  const signerIdx = keys.findIndex((k) => k.equals(signer.publicKey));
  assert.equal(feePayerIdx, 0, 'fee payer is account 0');
  assert.ok(signerIdx > 0, 'signer is a separate required signer');

  // Step 1: the instruction signer signs (simulating the agent via Privy). The
  // fee-payer slot is still empty.
  const tx = new VersionedTransaction(message);
  tx.sign([signer]);
  assert.ok(tx.signatures[signerIdx].some((b) => b !== 0), 'signer signed');
  assert.ok(tx.signatures[feePayerIdx].every((b) => b === 0), 'fee-payer slot empty before cosign');

  // Step 2: round-trip through serialize (as Privy returns the signed tx) then cosign
  // with the fee payer — what cosignWithFeePayer does.
  const roundTripped = VersionedTransaction.deserialize(tx.serialize());
  roundTripped.sign([feePayer]);

  assert.equal(roundTripped.signatures.length, 2, 'two required signatures');
  assert.ok(roundTripped.signatures[feePayerIdx].some((b) => b !== 0), 'fee-payer signed after cosign');
  assert.ok(roundTripped.signatures[signerIdx].some((b) => b !== 0), 'signer signature preserved');
});
