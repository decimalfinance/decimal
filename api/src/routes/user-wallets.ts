import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, badRequest, notFound } from '../api-errors.js';
import { assertOrganizationAdmin } from '../organization-access.js';
import { prisma } from '../prisma.js';
import { createPrivySolanaWallet, deletePrivyWallet, signPrivySolanaTransaction } from '../privy-wallets.js';
import { config } from '../config.js';
import {
  USDC_DECIMALS,
  USDC_MINT,
  deriveUsdcAtaForWallet,
  fetchWalletBalances,
  getSolanaAirdropConnection,
  getSolanaConnection,
  getSolanaDevnetConnection,
  waitForSignatureVisible,
} from '../solana.js';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export const userWalletsRouter = Router();

const createChallengeSchema = z.object({
  walletAddress: z.string().trim().min(1),
});

const connectExternalWalletSchema = z.object({
  walletAddress: z.string().trim().min(1),
  nonce: z.string().trim().min(16).max(256),
  signedMessageBase64: z.string().trim().min(1),
  signatureBase64: z.string().trim().min(1),
  provider: z.string().trim().max(80).optional(),
  label: z.string().trim().max(120).optional(),
});

const registerEmbeddedWalletSchema = z.object({
  walletAddress: z.string().trim().min(1),
  provider: z.string().trim().min(1).max(80).default('privy'),
  providerWalletId: z.string().trim().max(160).optional(),
  label: z.string().trim().max(120).optional(),
});

const createManagedWalletSchema = z.object({
  provider: z.enum(['privy', 'fireblocks', 'coinbase_cdp', 'para', 'turnkey', 'dfns']),
  label: z.string().trim().min(1).max(100).optional(),
});

const signVersionedTransactionSchema = z.object({
  serializedTransactionBase64: z.string().trim().min(1),
});

const userWalletParamsSchema = z.object({
  userWalletId: z.string().uuid(),
});

userWalletsRouter.get(['/personal-wallets', '/user-wallets'], async (req, res, next) => {
  try {
    const items = await prisma.personalWallet.findMany({
      where: {
        userId: req.auth!.userId,
        status: 'active',
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ items: items.map(serializeUserWallet) });
  } catch (error) {
    next(error);
  }
});

// Active personal wallets owned by users with active membership in the
// organization. Used by the Squads creation dialog so an admin can pick
// other members' personal wallets as Squads members. Admin-only because
// only admins can create treasuries.
const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

userWalletsRouter.get('/organizations/:organizationId/personal-wallets', async (req, res, next) => {
  try {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);

    const wallets = await prisma.personalWallet.findMany({
      where: {
        chain: 'solana',
        status: 'active',
        user: {
          memberships: {
            some: {
              organizationId,
              status: 'active',
            },
          },
        },
      },
      include: {
        user: {
          select: {
            userId: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            memberships: {
              where: { organizationId, status: 'active' },
              select: { membershipId: true, role: true, status: true },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ user: { displayName: 'asc' } }, { createdAt: 'asc' }],
    });

    res.json({
      items: wallets.map((wallet) => ({
        ...serializeUserWallet(wallet),
        user: {
          userId: wallet.user.userId,
          email: wallet.user.email,
          displayName: wallet.user.displayName,
          avatarUrl: wallet.user.avatarUrl,
        },
        membership: wallet.user.memberships[0]
          ? {
            membershipId: wallet.user.memberships[0].membershipId,
            role: wallet.user.memberships[0].role,
            status: wallet.user.memberships[0].status,
          }
          : null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

userWalletsRouter.post(['/personal-wallets/challenge', '/user-wallets/challenge'], async (req, res, next) => {
  try {
    const input = createChallengeSchema.parse(req.body);
    const walletAddress = normalizeSolanaAddress(input.walletAddress);
    const nonce = crypto.randomBytes(24).toString('hex');
    const message = [
      'Decimal wallet verification',
      '',
      `Wallet: ${walletAddress}`,
      `User: ${req.auth!.userId}`,
      `Nonce: ${nonce}`,
      '',
      'This signature links this wallet to your Decimal account. It does not authorize a transaction.',
    ].join('\n');

    await prisma.walletChallenge.create({
      data: {
        userId: req.auth!.userId,
        walletAddress,
        nonceHash: hashNonce(nonce),
        message,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    res.status(201).json({
      chain: 'solana',
      walletAddress,
      nonce,
      message,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

userWalletsRouter.post(['/personal-wallets/external', '/user-wallets/external'], async (req, res, next) => {
  try {
    const input = connectExternalWalletSchema.parse(req.body);
    const walletAddress = normalizeSolanaAddress(input.walletAddress);
    const challenge = await prisma.walletChallenge.findFirst({
      where: {
        userId: req.auth!.userId,
        walletAddress,
        nonceHash: hashNonce(input.nonce),
        consumedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!challenge || challenge.expiresAt <= new Date()) {
      throw badRequest('Wallet verification challenge expired. Try connecting the wallet again.');
    }

    const signedMessage = Buffer.from(input.signedMessageBase64, 'base64');
    const signature = Buffer.from(input.signatureBase64, 'base64');
    if (!signedMessage.toString('utf8').includes(input.nonce)) {
      throw badRequest('Signed message does not match the active wallet challenge.');
    }

    if (!verifyEd25519Signature(walletAddress, signedMessage, signature)) {
      throw badRequest('Wallet signature could not be verified.');
    }

    const wallet = await prisma.$transaction(async (tx) => {
      await tx.walletChallenge.update({
        where: { walletChallengeId: challenge.walletChallengeId },
        data: { consumedAt: new Date() },
      });

      return tx.personalWallet.upsert({
        where: {
          userId_chain_walletAddress: {
            userId: req.auth!.userId,
            chain: 'solana',
            walletAddress,
          },
        },
        update: {
          walletType: 'external',
          provider: input.provider ?? 'browser_wallet',
          label: input.label ?? null,
          status: 'active',
          verifiedAt: new Date(),
          lastUsedAt: new Date(),
        },
        create: {
          userId: req.auth!.userId,
          chain: 'solana',
          walletAddress,
          walletType: 'external',
          provider: input.provider ?? 'browser_wallet',
          label: input.label ?? null,
          verifiedAt: new Date(),
          lastUsedAt: new Date(),
        },
      });
    });

    res.status(201).json(serializeUserWallet(wallet));
  } catch (error) {
    next(error);
  }
});

userWalletsRouter.post(['/personal-wallets/embedded', '/user-wallets/embedded'], async (req, res, next) => {
  try {
    const input = registerEmbeddedWalletSchema.parse(req.body);
    const walletAddress = normalizeSolanaAddress(input.walletAddress);
    const wallet = await prisma.personalWallet.upsert({
      where: {
        userId_chain_walletAddress: {
          userId: req.auth!.userId,
          chain: 'solana',
          walletAddress,
        },
      },
      update: {
        walletType: 'privy_embedded',
        provider: input.provider,
        providerWalletId: input.providerWalletId ?? null,
        label: input.label ?? null,
        status: 'active',
        verifiedAt: new Date(),
      },
      create: {
        userId: req.auth!.userId,
        chain: 'solana',
        walletAddress,
        walletType: 'privy_embedded',
        provider: input.provider,
        providerWalletId: input.providerWalletId ?? null,
        label: input.label ?? null,
        verifiedAt: new Date(),
      },
    });

    res.status(201).json(serializeUserWallet(wallet));
  } catch (error) {
    next(error);
  }
});

userWalletsRouter.post(['/personal-wallets/managed', '/user-wallets/managed'], async (req, res, next) => {
  try {
    const input = createManagedWalletSchema.parse(req.body);
    if (input.provider !== 'privy') {
      throw new ApiError(501, 'provider_not_supported', 'This wallet provider is not enabled yet.');
    }

    const createdWallet = await createPrivySolanaWallet({
      userId: req.auth!.userId,
      label: input.label ?? 'Privy signing wallet',
    });
    const walletAddress = normalizeSolanaAddress(createdWallet.address);

    const wallet = await prisma.personalWallet.upsert({
      where: {
        userId_chain_walletAddress: {
          userId: req.auth!.userId,
          chain: 'solana',
          walletAddress,
        },
      },
      update: {
        walletType: 'privy_embedded',
        provider: 'privy',
        providerWalletId: createdWallet.providerWalletId,
        label: input.label ?? createdWallet.displayName ?? 'Privy signing wallet',
        status: 'active',
        verifiedAt: new Date(),
        metadataJson: createdWallet.metadata,
      },
      create: {
        userId: req.auth!.userId,
        chain: 'solana',
        walletAddress,
        walletType: 'privy_embedded',
        provider: 'privy',
        providerWalletId: createdWallet.providerWalletId,
        label: input.label ?? createdWallet.displayName ?? 'Privy signing wallet',
        verifiedAt: new Date(),
        metadataJson: createdWallet.metadata,
      },
    });

    res.status(201).json(serializeUserWallet(wallet));
  } catch (error) {
    next(error);
  }
});

userWalletsRouter.delete(
  ['/personal-wallets/:userWalletId', '/user-wallets/:userWalletId'],
  async (req, res, next) => {
    try {
      const { userWalletId } = userWalletParamsSchema.parse(req.params);
      const wallet = await prisma.personalWallet.findFirst({
        where: {
          userWalletId,
          userId: req.auth!.userId,
          status: 'active',
        },
      });
      if (!wallet) {
        throw notFound('Personal wallet not found');
      }
      if (wallet.chain !== 'solana' || wallet.provider !== 'privy' || wallet.walletType !== 'privy_embedded' || !wallet.providerWalletId) {
        throw new ApiError(400, 'unsupported_wallet_delete', 'Only Privy embedded Solana wallets can be deleted through this endpoint.');
      }

      const deleted = await deletePrivyWallet({ providerWalletId: wallet.providerWalletId });
      const archivedAt = new Date();
      const archivedMetadata = appendWalletDeletionMetadata(wallet.metadataJson, {
        archivedAt,
        remoteDeleted: deleted.remoteDeleted,
        remoteAlreadyMissing: deleted.remoteAlreadyMissing,
      });

      const result = await prisma.$transaction(async (tx) => {
        const revokedAuthorizations = await tx.organizationWalletAuthorization.updateMany({
          where: {
            userWalletId: wallet.userWalletId,
            status: 'active',
          },
          data: {
            status: 'revoked',
            revokedAt: archivedAt,
          },
        });

        const archivedWallet = await tx.personalWallet.update({
          where: { userWalletId: wallet.userWalletId },
          data: {
            status: 'archived',
            providerWalletId: null,
            metadataJson: archivedMetadata,
          },
        });

        return { archivedWallet, revokedAuthorizationCount: revokedAuthorizations.count };
      });

      res.json({
        deleted: true,
        remoteDeleted: deleted.remoteDeleted,
        remoteAlreadyMissing: deleted.remoteAlreadyMissing,
        revokedAuthorizationCount: result.revokedAuthorizationCount,
        wallet: serializeUserWallet(result.archivedWallet),
      });
    } catch (error) {
      next(error);
    }
  },
);

userWalletsRouter.post(
  ['/personal-wallets/:userWalletId/sign-versioned-transaction', '/user-wallets/:userWalletId/sign-versioned-transaction'],
  async (req, res, next) => {
    try {
      const { userWalletId } = userWalletParamsSchema.parse(req.params);
      const input = signVersionedTransactionSchema.parse(req.body);
      const wallet = await prisma.personalWallet.findFirst({
        where: {
          userWalletId,
          userId: req.auth!.userId,
          status: 'active',
        },
      });
      if (!wallet) {
        throw notFound('Personal wallet not found');
      }
      if (wallet.chain !== 'solana' || wallet.provider !== 'privy' || wallet.walletType !== 'privy_embedded' || !wallet.providerWalletId) {
        throw new ApiError(400, 'unsupported_wallet_signer', 'Only Privy embedded Solana wallets can sign through this endpoint.');
      }

      assertSignableVersionedTransaction(input.serializedTransactionBase64, wallet.walletAddress);
      const signed = await signPrivySolanaTransaction({
        providerWalletId: wallet.providerWalletId,
        serializedTransactionBase64: input.serializedTransactionBase64,
      });

      await prisma.personalWallet.update({
        where: { userWalletId: wallet.userWalletId },
        data: { lastUsedAt: new Date() },
      });

      res.json({
        userWalletId: wallet.userWalletId,
        walletAddress: wallet.walletAddress,
        signedTransactionBase64: signed.signedTransactionBase64,
        encoding: signed.encoding,
      });
    } catch (error) {
      next(error);
    }
  },
);

const transferOutSchema = z.object({
  recipient: z.string().trim().min(32).max(64),
  amountRaw: z.string().regex(/^\d+$/, 'amountRaw must be a positive integer string (raw base units)'),
  asset: z.enum(['sol', 'usdc']),
});

// Drain / partial-transfer helper for personal Privy wallets. Builds the
// appropriate Solana instruction(s), signs via the existing Privy
// signing service, submits, and best-effort confirms. Used by the
// Profile UI's "Transfer" affordance so users can recover funds they
// sent to a Privy wallet for testing without needing the Privy SDK
// client-side.
//
// SOL: SystemProgram.transfer with `amountRaw` as lamports.
// USDC: idempotent ATA creation for the recipient (no-op if it exists)
//   followed by createTransferChecked at USDC_DECIMALS. `amountRaw`
//   is in raw base units (1 USDC = 1_000_000).
//
// Same wallet ownership + provider checks as sign-versioned-transaction.
userWalletsRouter.post(
  ['/personal-wallets/:userWalletId/transfer-out', '/user-wallets/:userWalletId/transfer-out'],
  async (req, res, next) => {
    try {
      const { userWalletId } = userWalletParamsSchema.parse(req.params);
      const input = transferOutSchema.parse(req.body);

      const wallet = await prisma.personalWallet.findFirst({
        where: { userWalletId, userId: req.auth!.userId, status: 'active' },
      });
      if (!wallet) {
        throw notFound('Personal wallet not found');
      }
      if (
        wallet.chain !== 'solana' ||
        wallet.provider !== 'privy' ||
        wallet.walletType !== 'privy_embedded' ||
        !wallet.providerWalletId
      ) {
        throw new ApiError(
          400,
          'unsupported_wallet_signer',
          'Only Privy embedded Solana wallets can sign through this endpoint.',
        );
      }

      let recipientPubkey: PublicKey;
      try {
        recipientPubkey = new PublicKey(input.recipient);
      } catch {
        throw badRequest('recipient is not a valid Solana address.');
      }
      if (recipientPubkey.toBase58() === wallet.walletAddress) {
        throw badRequest('Cannot transfer to the same wallet.');
      }

      const amountRaw = BigInt(input.amountRaw);
      if (amountRaw <= 0n) {
        throw badRequest('amountRaw must be greater than zero.');
      }

      const connection = getSolanaConnection();
      const sourcePubkey = new PublicKey(wallet.walletAddress);
      const { blockhash } = await connection.getLatestBlockhash('confirmed');

      let instructions: TransactionInstruction[];
      if (input.asset === 'sol') {
        instructions = [
          SystemProgram.transfer({
            fromPubkey: sourcePubkey,
            toPubkey: recipientPubkey,
            lamports: amountRaw,
          }),
        ];
      } else {
        const sourceAta = new PublicKey(deriveUsdcAtaForWallet(wallet.walletAddress));
        const destinationAta = new PublicKey(deriveUsdcAtaForWallet(recipientPubkey.toBase58()));
        instructions = [
          createAssociatedTokenAccountIdempotentInstruction(
            sourcePubkey,
            destinationAta,
            recipientPubkey,
            USDC_MINT,
          ),
          createTransferCheckedInstruction(
            sourceAta,
            USDC_MINT,
            destinationAta,
            sourcePubkey,
            amountRaw,
            USDC_DECIMALS,
            [],
            TOKEN_PROGRAM_ID,
          ),
        ];
      }

      const message = new TransactionMessage({
        payerKey: sourcePubkey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      const serializedTransactionBase64 = Buffer.from(transaction.serialize()).toString('base64');

      const signed = await signPrivySolanaTransaction({
        providerWalletId: wallet.providerWalletId,
        serializedTransactionBase64,
      });

      const signedBytes = Buffer.from(signed.signedTransactionBase64, 'base64');
      const signature = await connection.sendRawTransaction(signedBytes, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      // Best-effort visibility check via signature-status polling
      // (10s budget). We don't use confirmTransaction({blockhash, ...})
      // because the intent's recentBlockhash window often closes before
      // we get here, producing "block height exceeded" even when the
      // tx actually landed. Errors from the poller are swallowed —
      // signature is what matters; the caller can verify on chain.
      try {
        await waitForSignatureVisible(connection, signature, { timeoutMs: 10_000 });
      } catch {
        // tx errored on chain; surfacing the signature is still useful
        // for the caller to inspect via an explorer
      }

      await prisma.personalWallet.update({
        where: { userWalletId: wallet.userWalletId },
        data: { lastUsedAt: new Date() },
      });

      res.json({
        signature,
        asset: input.asset,
        amountRaw: input.amountRaw,
        recipient: recipientPubkey.toBase58(),
        userWalletId: wallet.userWalletId,
      });
    } catch (error) {
      next(error);
    }
  },
);

// Live balances for the caller's personal wallets — SOL lamports + USDC
// raw via the configured network's RPC. Mirrors the
// /treasury-wallets/balances shape so the frontend can reuse its
// formatting helpers. Polls in parallel; surfaces per-wallet rpcError
// instead of failing the whole list when one wallet is unreachable.
userWalletsRouter.get(
  ['/personal-wallets/balances', '/user-wallets/balances'],
  async (req, res, next) => {
    try {
      const wallets = await prisma.personalWallet.findMany({
        where: { userId: req.auth!.userId, status: 'active', chain: 'solana' },
        orderBy: { createdAt: 'asc' },
      });

      const items = await Promise.all(
        wallets.map(async (wallet) => {
          const usdcAtaAddress = (() => {
            try {
              return deriveUsdcAtaForWallet(wallet.walletAddress);
            } catch {
              return null;
            }
          })();
          const balances = await fetchWalletBalances({
            walletAddress: wallet.walletAddress,
            usdcAtaAddress,
          });
          return {
            userWalletId: wallet.userWalletId,
            walletAddress: wallet.walletAddress,
            label: wallet.label,
            walletType: wallet.walletType,
            provider: wallet.provider,
            usdcAtaAddress,
            ...balances,
          };
        }),
      );

      res.json({
        items,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  },
);

const airdropSolSchema = z.object({
  amountSol: z.number().positive().max(2).optional(),
});

// Devnet SOL airdrop. Always hits the devnet RPC connection
// (SOLANA_DEVNET_RPC_URL), never the configured network connection —
// a mainnet airdrop request would just be a hard error from the RPC,
// and we want this to remain useful for testing even when the app is
// running in mainnet mode.
//
// Devnet airdrops are rate-limited per IP/wallet by Solana's network;
// hitting that limit returns a 429-shaped error from the RPC which we
// surface as-is. Default amount is 1 SOL; max is 2 SOL per call (the
// public devnet faucet's hard ceiling).
userWalletsRouter.post(
  ['/personal-wallets/:userWalletId/airdrop-sol', '/user-wallets/:userWalletId/airdrop-sol'],
  async (req, res, next) => {
    try {
      const { userWalletId } = userWalletParamsSchema.parse(req.params);
      const input = airdropSolSchema.parse(req.body ?? {});
      const wallet = await prisma.personalWallet.findFirst({
        where: { userWalletId, userId: req.auth!.userId, status: 'active' },
      });
      if (!wallet) {
        throw notFound('Personal wallet not found');
      }
      if (wallet.chain !== 'solana') {
        throw badRequest('Airdrop only supported for Solana wallets.');
      }

      const amountSol = input.amountSol ?? 1;
      const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
      const pubkey = new PublicKey(wallet.walletAddress);

      // requestAirdrop hits a node that supports the method (Solana's
      // public devnet RPC by default). Premium providers like Alchemy
      // disable the method and return "Invalid request" — we'd rather
      // fail in code review than at runtime, so the connection is
      // explicitly the airdrop one, not the general devnet one.
      const airdropConnection = getSolanaAirdropConnection();
      const signature = await airdropConnection.requestAirdrop(pubkey, lamports);

      // Poll signature visibility on the configured devnet RPC (usually
      // Alchemy — faster, better rate limits). Both connections read
      // the same chain so the airdrop tx is visible on either one.
      try {
        await waitForSignatureVisible(getSolanaDevnetConnection(), signature, { timeoutMs: 8_000 });
      } catch {
        // swallow — signature is what matters; airdrop errored on chain
        // is rare and the user can verify the signature themselves
      }

      res.json({
        signature,
        amountSol,
        walletAddress: wallet.walletAddress,
        userWalletId: wallet.userWalletId,
      });
    } catch (error) {
      next(error);
    }
  },
);

function serializeUserWallet(wallet: {
  userWalletId: string;
  userId: string;
  chain: string;
  walletAddress: string;
  walletType: string;
  provider: string | null;
  providerWalletId: string | null;
  label: string | null;
  status: string;
  verifiedAt: Date | null;
  lastUsedAt: Date | null;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
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

function appendWalletDeletionMetadata(metadataJson: unknown, input: {
  archivedAt: Date;
  remoteDeleted: boolean;
  remoteAlreadyMissing: boolean;
}) {
  const metadata = metadataJson && typeof metadataJson === 'object' && !Array.isArray(metadataJson)
    ? { ...metadataJson }
    : {};

  return {
    ...metadata,
    deletion: {
      archivedAt: input.archivedAt.toISOString(),
      remoteDeleted: input.remoteDeleted,
      remoteAlreadyMissing: input.remoteAlreadyMissing,
    },
  };
}

function normalizeSolanaAddress(value: string) {
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    throw badRequest('Invalid Solana wallet address.');
  }
}

function assertSignableVersionedTransaction(serializedTransactionBase64: string, walletAddress: string) {
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(serializedTransactionBase64, 'base64'));
  } catch {
    throw badRequest('serializedTransactionBase64 must be a valid serialized Solana versioned transaction.');
  }

  const requiredSigners = transaction.message.staticAccountKeys
    .slice(0, transaction.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
  if (!requiredSigners.includes(walletAddress)) {
    throw badRequest('Personal wallet is not a required signer for this transaction.');
  }

  const squadsProgramId = config.squadsProgramId;
  const programIds = transaction.message.compiledInstructions
    .map((instruction) => transaction.message.staticAccountKeys[instruction.programIdIndex]?.toBase58())
    .filter(Boolean);
  if (!programIds.includes(squadsProgramId)) {
    throw badRequest('This signing endpoint currently only supports Squads v4 treasury creation transactions.');
  }
}

function hashNonce(nonce: string) {
  return crypto.createHash('sha256').update(nonce).digest('hex');
}

function verifyEd25519Signature(walletAddress: string, message: Buffer, signature: Buffer) {
  if (signature.length !== 64) {
    return false;
  }

  const publicKeyBytes = new PublicKey(walletAddress).toBytes();
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(publicKeyBytes),
  ]);
  const publicKey = crypto.createPublicKey({
    key: spki,
    format: 'der',
    type: 'spki',
  });

  return crypto.verify(null, message, publicKey, signature);
}
