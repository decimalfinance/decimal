import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

export const SOLANA_CHAIN = 'solana';
export const USDC_ASSET = 'usdc';
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export function deriveUsdcAtaForWallet(walletAddress: string) {
  const owner = new PublicKey(walletAddress);
  return getAssociatedTokenAddressSync(USDC_MINT, owner).toBase58();
}
