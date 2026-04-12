import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

export const SOLANA_CHAIN = 'solana';
export const USDC_ASSET = 'usdc';
export const USDC_DECIMALS = 6;
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export function deriveUsdcAtaForWallet(walletAddress: string) {
  const owner = new PublicKey(walletAddress);
  return getAssociatedTokenAddressSync(USDC_MINT, owner).toBase58();
}

export type SerializedSolanaInstruction = {
  programId: string;
  keys: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  dataBase64: string;
};

export function serializeSolanaInstruction(instruction: TransactionInstruction) {
  return {
    programId: instruction.programId.toBase58(),
    keys: instruction.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    dataBase64: Buffer.from(instruction.data).toString('base64'),
  } satisfies SerializedSolanaInstruction;
}

export function buildUsdcTransferInstructions(args: {
  sourceWallet: string;
  sourceTokenAccount: string;
  destinationWallet: string;
  destinationTokenAccount: string;
  amountRaw: string | bigint;
}) {
  const sourceWallet = new PublicKey(args.sourceWallet);
  const sourceTokenAccount = new PublicKey(args.sourceTokenAccount);
  const destinationWallet = new PublicKey(args.destinationWallet);
  const destinationTokenAccount = new PublicKey(args.destinationTokenAccount);

  const ensureDestinationAta = createAssociatedTokenAccountIdempotentInstruction(
    sourceWallet,
    destinationTokenAccount,
    destinationWallet,
    USDC_MINT,
  );
  const transfer = createTransferCheckedInstruction(
    sourceTokenAccount,
    USDC_MINT,
    destinationTokenAccount,
    sourceWallet,
    BigInt(args.amountRaw),
    USDC_DECIMALS,
    [],
    TOKEN_PROGRAM_ID,
  );

  return [ensureDestinationAta, transfer].map(serializeSolanaInstruction);
}
