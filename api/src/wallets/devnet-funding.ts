import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { getSolanaConnection, waitForSignatureVisible } from '../solana.js';

export type DevnetFundingResult =
  | { status: 'skipped'; reason: string }
  | {
      status: 'funded' | 'already_funded';
      walletAddress: string;
      funderAddress: string;
      currentBalanceLamports: number;
      targetBalanceLamports: number;
      lamports: number;
      signature: string | null;
    };

type DevnetFundingRuntime = {
  getRecipientBalance: (wallet: PublicKey) => Promise<number>;
  sendLamports: (input: { recipient: PublicKey; lamports: number; funder: Keypair }) => Promise<string>;
  waitForSignature: (signature: string) => Promise<{ confirmed: boolean; seen: boolean }>;
};

type DevnetFundingOptions = {
  minimumLamports?: number;
  reason?: string;
};

const defaultRuntime: DevnetFundingRuntime = {
  getRecipientBalance: (wallet) => getSolanaConnection().getBalance(wallet, 'confirmed'),
  sendLamports: async ({ recipient, lamports, funder }) => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: recipient,
        lamports,
      }),
    );
    return getSolanaConnection().sendTransaction(tx, [funder], {
      preflightCommitment: 'confirmed',
    });
  },
  waitForSignature: (signature) => waitForSignatureVisible(getSolanaConnection(), signature, {
    timeoutMs: 20_000,
    pollIntervalMs: 1_000,
  }),
};

let runtime: DevnetFundingRuntime = defaultRuntime;
let funderCache: Keypair | null = null;

export function setDevnetFundingRuntimeForTests(nextRuntime: Partial<DevnetFundingRuntime> | null) {
  runtime = nextRuntime ? { ...defaultRuntime, ...nextRuntime } : defaultRuntime;
  funderCache = null;
}

export async function fundNewDevnetWalletIfConfigured(
  walletAddress: string,
  options: DevnetFundingOptions = {},
): Promise<DevnetFundingResult> {
  if (!config.devnetAutoFundWallets) {
    return { status: 'skipped', reason: 'devnet_auto_fund_disabled' };
  }
  if (config.solanaNetwork !== 'devnet') {
    return { status: 'skipped', reason: 'not_devnet' };
  }
  if (config.devnetAutoFundLamports <= 0) {
    return { status: 'skipped', reason: 'zero_lamports' };
  }

  const targetLamports = options.minimumLamports ?? config.devnetAutoFundLamports;
  if (!Number.isInteger(targetLamports) || targetLamports <= 0) {
    return { status: 'skipped', reason: 'invalid_minimum_lamports' };
  }

  const recipient = new PublicKey(walletAddress);
  const funder = loadFunderKeypair();
  const currentBalance = await runtime.getRecipientBalance(recipient);
  if (currentBalance >= targetLamports) {
    logger.info('devnet_funding.skipped_already_funded', {
      walletAddress: recipient.toBase58(),
      funderAddress: funder.publicKey.toBase58(),
      currentBalanceLamports: currentBalance,
      targetLamports,
      reason: options.reason ?? null,
    });
    return {
      status: 'already_funded',
      walletAddress: recipient.toBase58(),
      funderAddress: funder.publicKey.toBase58(),
      currentBalanceLamports: currentBalance,
      targetBalanceLamports: targetLamports,
      lamports: 0,
      signature: null,
    };
  }

  const transferLamports = targetLamports - currentBalance;
  const signature = await runtime.sendLamports({
    recipient,
    lamports: transferLamports,
    funder,
  });
  const confirmation = await runtime.waitForSignature(signature);
  if (!confirmation.confirmed) {
    logger.warn('devnet_funding.confirmation_timeout', {
      walletAddress: recipient.toBase58(),
      funderAddress: funder.publicKey.toBase58(),
      currentBalanceLamports: currentBalance,
      targetBalanceLamports: targetLamports,
      lamports: transferLamports,
      signature,
      reason: options.reason ?? null,
    });
  }

  logger.info('devnet_funding.funded', {
    walletAddress: recipient.toBase58(),
    funderAddress: funder.publicKey.toBase58(),
    currentBalanceLamports: currentBalance,
    targetBalanceLamports: targetLamports,
    lamports: transferLamports,
    signature,
    confirmed: confirmation.confirmed,
    reason: options.reason ?? null,
  });

  return {
    status: 'funded',
    walletAddress: recipient.toBase58(),
    funderAddress: funder.publicKey.toBase58(),
    currentBalanceLamports: currentBalance,
    targetBalanceLamports: targetLamports,
    lamports: transferLamports,
    signature,
  };
}

export function getDevnetFunderAddressIfConfigured(): string | null {
  if (!config.devnetFunderKeypairPath) {
    return null;
  }
  return loadFunderKeypair().publicKey.toBase58();
}

function loadFunderKeypair() {
  if (funderCache) {
    return funderCache;
  }
  const keypairPath = path.resolve(config.devnetFunderKeypairPath);
  const raw = fs.readFileSync(keypairPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => Number.isInteger(value))) {
    throw new Error('DEVNET_FUNDER_KEYPAIR_PATH must point to a Solana keypair JSON array.');
  }
  funderCache = Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  return funderCache;
}
