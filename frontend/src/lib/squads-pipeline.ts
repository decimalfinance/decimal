import { VersionedTransaction } from '@solana/web3.js';
import { api } from '../api';
import type {
  DecimalProposalIntentResponse,
  SquadsConfigProposalIntentResponse,
} from '../types';
import { createSolanaConnection, waitForSignatureVisible } from './solana-wallet';

// Both shapes carry the same transaction sub-object — just widen here so any
// caller can hand us either an old config-proposal intent or a new generic
// DecimalProposal intent without changing the helper.
type SignableIntent = {
  transaction: {
    serializedTransaction: string;
  };
};

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Sign a Squads intent with the given personal wallet via the backend Privy
 * signing endpoint, submit to chain, and poll the signature via
 * getSignatureStatuses (blockhash-agnostic). Returns the on-chain signature.
 */
export async function signAndSubmitIntent(args: {
  intent: SignableIntent | SquadsConfigProposalIntentResponse | DecimalProposalIntentResponse;
  signerPersonalWalletId: string;
}): Promise<string> {
  const { intent, signerPersonalWalletId } = args;
  const signed = await api.signPersonalWalletVersionedTransaction(signerPersonalWalletId, {
    serializedTransactionBase64: intent.transaction.serializedTransaction,
  });
  const connection = createSolanaConnection('confirmed');
  const bytes = decodeBase64ToBytes(signed.signedTransactionBase64);
  VersionedTransaction.deserialize(bytes);
  const sig = await connection.sendRawTransaction(bytes, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  const visible = await waitForSignatureVisible(connection, sig, { timeoutMs: 30_000 });
  if (!visible.confirmed && !visible.seen) {
    throw new Error('Transaction never appeared on chain after submission. Try again.');
  }
  return sig;
}
