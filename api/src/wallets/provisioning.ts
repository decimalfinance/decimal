import type { PersonalWallet, Prisma } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { ApiError, badRequest } from '../infra/api-errors.js';
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { createPrivySolanaWallet } from './personal.js';
import { fundNewDevnetWalletIfConfigured } from './devnet-funding.js';

export type WalletProvisioningStatus = 'created' | 'existing' | 'skipped' | 'failed';

export type PersonalWalletProvisioningResult = {
  status: WalletProvisioningStatus;
  reason: string | null;
  wallet: ReturnType<typeof serializePersonalWallet> | null;
};

export async function ensureManagedPersonalWalletForUser(
  userId: string,
  input: {
    label?: string | null;
    force?: boolean;
    failOnError?: boolean;
  } = {},
): Promise<PersonalWalletProvisioningResult> {
  const existing = await prisma.personalWallet.findFirst({
    where: {
      userId,
      chain: 'solana',
      status: 'active',
      walletType: 'privy_embedded',
      provider: 'privy',
      providerWalletId: { not: null },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) {
    return {
      status: 'existing',
      reason: null,
      wallet: serializePersonalWallet(existing),
    };
  }

  if (!input.force && !config.autoProvisionWallets) {
    return {
      status: 'skipped',
      reason: 'auto_provisioning_disabled',
      wallet: null,
    };
  }

  if (!config.privyAppId || !config.privyAppSecret) {
    if (input.failOnError) {
      throw new ApiError(500, 'privy_not_configured', 'Privy wallet provisioning is not configured.');
    }
    return {
      status: 'skipped',
      reason: 'privy_not_configured',
      wallet: null,
    };
  }

  try {
    const createdWallet = await createPrivySolanaWallet({
      userId,
      label: input.label ?? 'Decimal signing wallet',
      idempotencyKey: `personal-wallet-${userId}`,
    });
    const walletAddress = normalizeSolanaAddress(createdWallet.address);

    const wallet = await prisma.personalWallet.upsert({
      where: {
        userId_chain_walletAddress: {
          userId,
          chain: 'solana',
          walletAddress,
        },
      },
      update: {
        walletType: 'privy_embedded',
        provider: 'privy',
        providerWalletId: createdWallet.providerWalletId,
        label: input.label ?? createdWallet.displayName ?? 'Decimal signing wallet',
        status: 'active',
        verifiedAt: new Date(),
        metadataJson: createdWallet.metadata as Prisma.InputJsonValue,
      },
      create: {
        userId,
        chain: 'solana',
        walletAddress,
        walletType: 'privy_embedded',
        provider: 'privy',
        providerWalletId: createdWallet.providerWalletId,
        label: input.label ?? createdWallet.displayName ?? 'Decimal signing wallet',
        verifiedAt: new Date(),
        metadataJson: createdWallet.metadata as Prisma.InputJsonValue,
      },
    });
    const funding = await fundNewDevnetWalletIfConfigured(wallet.walletAddress)
      .catch((error) => {
        const reason = error instanceof Error ? error.message : 'devnet_funding_failed';
        logger.warn('devnet_funding.personal_wallet_failed', {
          userId,
          userWalletId: wallet.userWalletId,
          walletAddress: wallet.walletAddress,
          reason,
        });
        return { status: 'skipped' as const, reason };
      });
    if (funding.status === 'funded') {
      await prisma.personalWallet.update({
        where: { userWalletId: wallet.userWalletId },
        data: {
          metadataJson: {
            ...(isRecordLike(wallet.metadataJson) ? wallet.metadataJson : {}),
            devnetFunding: funding,
          } as Prisma.InputJsonValue,
        },
      });
    }

    return {
      status: 'created',
      reason: null,
      wallet: serializePersonalWallet(
        funding.status === 'funded'
          ? await prisma.personalWallet.findUniqueOrThrow({ where: { userWalletId: wallet.userWalletId } })
          : wallet,
      ),
    };
  } catch (error) {
    logger.warn('personal_wallet.provisioning_failed', {
      userId,
      failOnError: input.failOnError ?? false,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (input.failOnError) {
      throw error;
    }
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : 'Wallet provisioning failed',
      wallet: null,
    };
  }
}

export function serializePersonalWallet(wallet: Pick<
  PersonalWallet,
  | 'userWalletId'
  | 'userId'
  | 'chain'
  | 'walletAddress'
  | 'walletType'
  | 'provider'
  | 'providerWalletId'
  | 'label'
  | 'status'
  | 'verifiedAt'
  | 'lastUsedAt'
  | 'metadataJson'
  | 'createdAt'
  | 'updatedAt'
>) {
  return {
    userWalletId: wallet.userWalletId,
    userId: wallet.userId,
    chain: wallet.chain,
    walletAddress: wallet.walletAddress,
    walletType: wallet.walletType,
    provider: wallet.provider,
    providerWalletId: wallet.providerWalletId,
    label: wallet.label,
    status: wallet.status,
    verifiedAt: wallet.verifiedAt?.toISOString() ?? null,
    lastUsedAt: wallet.lastUsedAt?.toISOString() ?? null,
    metadataJson: wallet.metadataJson,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

function normalizeSolanaAddress(value: string) {
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    throw badRequest('Invalid Solana wallet address.');
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
