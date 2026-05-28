import { Connection } from '@solana/web3.js';
import { getPublicSolanaRpcUrl } from '../public-config';

export function resolveSolanaRpcUrl(): string {
  return getPublicSolanaRpcUrl();
}

/**
 * Poll getSignatureStatuses until the signature is at least confirmed.
 * This is blockhash-agnostic and works better for transactions created
 * server-side, then signed/submitted through Privy after some delay.
 */
export async function waitForSignatureVisible(
  connection: Connection,
  signature: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<{ confirmed: boolean; seen: boolean }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  let everSeen = false;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      everSeen = true;
      if (status.err) {
        throw new Error(`On-chain error: ${JSON.stringify(status.err)}`);
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { confirmed: true, seen: true };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { confirmed: false, seen: everSeen };
}
