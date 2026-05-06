import type { Prisma } from '@prisma/client';
import * as multisig from '@sqds/multisig';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { badRequest, notFound } from './api-errors.js';
import { config } from './config.js';
import { prisma } from './prisma.js';
import { deriveUsdcAtaForWallet, getSolanaConnection, SOLANA_CHAIN, USDC_ASSET } from './solana.js';

const SQUADS_SOURCE = 'squads_v4';
// Squads v4 uses the same program id on devnet and mainnet. The value remains
// configurable so tests or future deployments can override it explicitly.
const SQUADS_PERMISSION_MAP = {
  initiate: multisig.types.Permission.Initiate,
  vote: multisig.types.Permission.Vote,
  execute: multisig.types.Permission.Execute,
} as const;

type SquadsPermissionName = keyof typeof SQUADS_PERMISSION_MAP;
type SquadsMultisigAccountLike = {
  createKey: PublicKey;
  configAuthority: PublicKey;
  threshold: number;
  timeLock: number;
  transactionIndex: { toString(): string };
  staleTransactionIndex: { toString(): string };
  members: Array<{ key: PublicKey; permissions: { mask: number } }>;
};

type SquadsTreasuryRuntime = {
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getProgramTreasury: (programId: PublicKey) => Promise<PublicKey>;
  loadMultisig: (multisigPda: PublicKey) => Promise<SquadsMultisigAccountLike>;
};

const defaultRuntime: SquadsTreasuryRuntime = {
  getLatestBlockhash: () => getSolanaConnection().getLatestBlockhash(),
  getProgramTreasury: (programId) => resolveSquadsProgramTreasury(programId),
  loadMultisig: (multisigPda) => multisig.accounts.Multisig.fromAccountAddress(getSolanaConnection(), multisigPda),
};

let runtime: SquadsTreasuryRuntime = defaultRuntime;

export function setSquadsTreasuryRuntimeForTests(nextRuntime: Partial<SquadsTreasuryRuntime> | null) {
  runtime = nextRuntime ? { ...defaultRuntime, ...nextRuntime } : defaultRuntime;
}

export type SquadsTreasuryMemberInput = {
  personalWalletId: string;
  permissions: SquadsPermissionName[];
};

export type CreateSquadsTreasuryIntentInput = {
  displayName?: string | null;
  creatorPersonalWalletId: string;
  threshold: number;
  timeLockSeconds?: number;
  vaultIndex?: number;
  members: SquadsTreasuryMemberInput[];
};

export async function createSquadsTreasuryIntent(
  organizationId: string,
  actorUserId: string,
  input: CreateSquadsTreasuryIntentInput,
) {
  const normalized = normalizeCreateIntentInput(input);
  const memberState = await loadAndValidateMembers(organizationId, actorUserId, normalized);
  const programId = new PublicKey(config.squadsProgramId);
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey, programId });
  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: normalized.vaultIndex,
    programId,
  });
  await assertSquadsTreasuryAvailable(organizationId, multisigPda, vaultPda);

  const [programTreasury, latestBlockhash] = await Promise.all([
    runtime.getProgramTreasury(programId),
    runtime.getLatestBlockhash(),
  ]);

  const instruction = multisig.instructions.multisigCreateV2({
    treasury: programTreasury,
    creator: new PublicKey(memberState.creator.walletAddress),
    multisigPda,
    configAuthority: null,
    threshold: normalized.threshold,
    members: memberState.squadsMembers,
    timeLock: normalized.timeLockSeconds,
    createKey: createKey.publicKey,
    rentCollector: new PublicKey(memberState.creator.walletAddress),
    memo: normalized.displayName ?? 'Decimal treasury',
    programId,
  });

  const message = new TransactionMessage({
    payerKey: new PublicKey(memberState.creator.walletAddress),
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [instruction],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([createKey]);

  const members = memberState.members.map((member) => ({
    personalWalletId: member.personalWalletId,
    walletAddress: member.walletAddress,
    userId: member.userId,
    membershipId: member.membershipId,
    permissions: member.permissions,
  }));

  return {
    intent: {
      provider: SQUADS_SOURCE,
      programId: programId.toBase58(),
      createKey: createKey.publicKey.toBase58(),
      multisigPda: multisigPda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      vaultIndex: normalized.vaultIndex,
      threshold: normalized.threshold,
      timeLockSeconds: normalized.timeLockSeconds,
      displayName: normalized.displayName,
      members,
    },
    transaction: {
      encoding: 'base64',
      serializedTransaction: Buffer.from(transaction.serialize()).toString('base64'),
      requiredSigner: memberState.creator.walletAddress,
      recentBlockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
  };
}

export async function confirmSquadsTreasuryCreation(
  organizationId: string,
  actorUserId: string,
  input: {
    signature: string;
    displayName?: string | null;
    createKey: string;
    multisigPda: string;
    vaultIndex?: number;
  },
) {
  const displayName = normalizeOptionalText(input.displayName);
  const programId = new PublicKey(config.squadsProgramId);
  const createKey = new PublicKey(input.createKey);
  const multisigPda = new PublicKey(input.multisigPda);
  const expectedMultisigPda = multisig.getMultisigPda({ createKey, programId })[0];
  if (!multisigPda.equals(expectedMultisigPda)) {
    throw badRequest('multisigPda does not match createKey.');
  }

  const vaultIndex = normalizeVaultIndex(input.vaultIndex);
  const vaultPda = multisig.getVaultPda({ multisigPda, index: vaultIndex, programId })[0];
  await assertSquadsTreasuryAvailable(organizationId, multisigPda, vaultPda);

  const multisigAccount = await runtime.loadMultisig(multisigPda);
  if (!publicKeysEqual(multisigAccount.createKey, createKey)) {
    throw badRequest('Onchain multisig create key does not match confirmation input.');
  }
  if (!publicKeysEqual(multisigAccount.configAuthority, PublicKey.default)) {
    throw badRequest('Only autonomous Squads treasuries are supported.');
  }

  const onchainMembers = serializeOnchainMembers(multisigAccount.members);
  const linkedMembers = await loadMembersByWalletAddresses(organizationId, onchainMembers.map((member) => member.walletAddress));
  if (linkedMembers.length !== onchainMembers.length) {
    throw badRequest('Every Squads member must be an active Decimal personal wallet in this organization.');
  }

  const creatorWallet = linkedMembers.find((member) => member.userId === actorUserId);
  if (!creatorWallet) {
    throw badRequest('The confirming user must control one of the Squads member wallets.');
  }

  const usdcAtaAddress = deriveUsdcAtaForWallet(vaultPda.toBase58());
  const wallet = await prisma.$transaction(async (tx) => {
    const created = await tx.treasuryWallet.create({
      data: {
        organizationId,
        chain: SOLANA_CHAIN,
        address: vaultPda.toBase58(),
        assetScope: USDC_ASSET,
        usdcAtaAddress,
        source: SQUADS_SOURCE,
        sourceRef: multisigPda.toBase58(),
        displayName,
        propertiesJson: {
          usdcAtaAddress,
          squads: {
            programId: programId.toBase58(),
            multisigPda: multisigPda.toBase58(),
            vaultPda: vaultPda.toBase58(),
            vaultIndex,
            createKey: createKey.toBase58(),
            threshold: Number(multisigAccount.threshold),
            timeLockSeconds: Number(multisigAccount.timeLock),
            transactionIndex: multisigAccount.transactionIndex.toString(),
            creationSignature: input.signature.trim(),
            members: onchainMembers,
          },
        } satisfies Prisma.InputJsonObject,
      },
    });

    for (const member of linkedMembers) {
      const onchainMember = onchainMembers.find((item) => item.walletAddress === member.walletAddress);
      await tx.organizationWalletAuthorization.upsert({
        where: {
          organizationId_treasuryWalletId_userWalletId_role: {
            organizationId,
            treasuryWalletId: created.treasuryWalletId,
            userWalletId: member.personalWalletId,
            role: 'squads_member',
          },
        },
        create: {
          organizationId,
          treasuryWalletId: created.treasuryWalletId,
          userWalletId: member.personalWalletId,
          membershipId: member.membershipId,
          role: 'squads_member',
          scope: 'treasury_wallet',
          metadataJson: {
            provider: SQUADS_SOURCE,
            permissions: onchainMember?.permissions ?? [],
            multisigPda: multisigPda.toBase58(),
            vaultPda: vaultPda.toBase58(),
          } satisfies Prisma.InputJsonObject,
        },
        update: {
          membershipId: member.membershipId,
          status: 'active',
          revokedAt: null,
          metadataJson: {
            provider: SQUADS_SOURCE,
            permissions: onchainMember?.permissions ?? [],
            multisigPda: multisigPda.toBase58(),
            vaultPda: vaultPda.toBase58(),
          } satisfies Prisma.InputJsonObject,
        },
      });
    }

    return created;
  });

  return serializeSquadsTreasuryWallet(wallet);
}

export async function getSquadsTreasuryStatus(organizationId: string, treasuryWalletId: string) {
  const wallet = await prisma.treasuryWallet.findFirst({
    where: { organizationId, treasuryWalletId },
  });
  if (!wallet) {
    throw notFound('Treasury wallet not found');
  }
  if (wallet.source !== SQUADS_SOURCE || !wallet.sourceRef) {
    throw badRequest('Treasury wallet is not a Squads v4 treasury.');
  }

  const programId = new PublicKey(config.squadsProgramId);
  const multisigPda = new PublicKey(wallet.sourceRef);
  const multisigAccount = await runtime.loadMultisig(multisigPda);
  const metadata = readSquadsMetadata(wallet.propertiesJson);
  const vaultIndex = typeof metadata?.vaultIndex === 'number' ? metadata.vaultIndex : config.squadsDefaultVaultIndex;
  const vaultPda = multisig.getVaultPda({ multisigPda, index: vaultIndex, programId })[0];
  const members = serializeOnchainMembers(multisigAccount.members);

  return {
    treasuryWalletId: wallet.treasuryWalletId,
    provider: SQUADS_SOURCE,
    programId: programId.toBase58(),
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    vaultIndex,
    threshold: Number(multisigAccount.threshold),
    timeLockSeconds: Number(multisigAccount.timeLock),
    transactionIndex: multisigAccount.transactionIndex.toString(),
    staleTransactionIndex: multisigAccount.staleTransactionIndex.toString(),
    members,
    localStateMatchesChain:
      wallet.address === vaultPda.toBase58()
      && metadata?.multisigPda === multisigPda.toBase58()
      && metadata?.vaultPda === vaultPda.toBase58(),
  };
}

export function serializeSquadsTreasuryWallet(wallet: {
  treasuryWalletId: string;
  organizationId: string;
  chain: string;
  address: string;
  assetScope: string;
  usdcAtaAddress: string | null;
  isActive: boolean;
  source: string;
  sourceRef: string | null;
  displayName: string | null;
  notes: string | null;
  propertiesJson: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    treasuryWalletId: wallet.treasuryWalletId,
    organizationId: wallet.organizationId,
    chain: wallet.chain,
    address: wallet.address,
    assetScope: wallet.assetScope,
    usdcAtaAddress: wallet.usdcAtaAddress,
    isActive: wallet.isActive,
    source: wallet.source,
    sourceRef: wallet.sourceRef,
    displayName: wallet.displayName,
    notes: wallet.notes,
    propertiesJson: wallet.propertiesJson,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function normalizeCreateIntentInput(input: CreateSquadsTreasuryIntentInput) {
  return {
    displayName: normalizeOptionalText(input.displayName),
    creatorPersonalWalletId: input.creatorPersonalWalletId,
    threshold: normalizeThreshold(input.threshold),
    timeLockSeconds: normalizeTimelock(input.timeLockSeconds),
    vaultIndex: normalizeVaultIndex(input.vaultIndex),
    members: normalizeMembers(input.members),
  };
}

function normalizeMembers(members: SquadsTreasuryMemberInput[]) {
  if (!members.length) {
    throw badRequest('At least one Squads member is required.');
  }
  const seen = new Set<string>();
  return members.map((member) => {
    if (seen.has(member.personalWalletId)) {
      throw badRequest('Duplicate Squads member personalWalletId.');
    }
    seen.add(member.personalWalletId);
    const permissions = [...new Set(member.permissions)];
    if (!permissions.length) {
      throw badRequest('Every Squads member requires at least one permission.');
    }
    return {
      personalWalletId: member.personalWalletId,
      permissions,
    };
  });
}

function normalizeThreshold(threshold: number) {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 65_535) {
    throw badRequest('threshold must be an integer between 1 and 65535.');
  }
  return threshold;
}

function normalizeTimelock(value: number | undefined) {
  const timeLock = value ?? config.squadsDefaultTimelockSeconds;
  if (!Number.isInteger(timeLock) || timeLock < 0 || timeLock > 7_776_000) {
    throw badRequest('timeLockSeconds must be an integer between 0 and 7776000.');
  }
  return timeLock;
}

function normalizeVaultIndex(value: number | undefined) {
  const vaultIndex = value ?? config.squadsDefaultVaultIndex;
  if (!Number.isInteger(vaultIndex) || vaultIndex < 0 || vaultIndex > 255) {
    throw badRequest('vaultIndex must be an integer between 0 and 255.');
  }
  return vaultIndex;
}

async function loadAndValidateMembers(
  organizationId: string,
  actorUserId: string,
  input: ReturnType<typeof normalizeCreateIntentInput>,
) {
  if (!input.members.some((member) => member.personalWalletId === input.creatorPersonalWalletId)) {
    throw badRequest('creatorPersonalWalletId must be included as a Squads member.');
  }

  const personalWallets = await prisma.personalWallet.findMany({
    where: {
      userWalletId: { in: input.members.map((member) => member.personalWalletId) },
      status: 'active',
      chain: SOLANA_CHAIN,
    },
    include: {
      user: {
        select: {
          userId: true,
          memberships: {
            where: {
              organizationId,
              status: 'active',
            },
            select: {
              membershipId: true,
              role: true,
            },
            take: 1,
          },
        },
      },
    },
  });

  if (personalWallets.length !== input.members.length) {
    throw badRequest('Every Squads member must be an active Solana personal wallet.');
  }

  const byId = new Map(personalWallets.map((wallet) => [wallet.userWalletId, wallet]));
  const members = input.members.map((member) => {
    const wallet = byId.get(member.personalWalletId);
    if (!wallet) {
      throw badRequest('Every Squads member must be an active Solana personal wallet.');
    }
    const membership = wallet.user.memberships[0];
    if (!membership) {
      throw badRequest('Every Squads member wallet owner must be an active organization member.');
    }
    return {
      personalWalletId: wallet.userWalletId,
      walletAddress: wallet.walletAddress,
      userId: wallet.userId,
      membershipId: membership.membershipId,
      permissions: member.permissions,
    };
  });

  const creator = members.find((member) => member.personalWalletId === input.creatorPersonalWalletId);
  if (!creator || creator.userId !== actorUserId) {
    throw badRequest('creatorPersonalWalletId must belong to the authenticated user.');
  }

  const voters = members.filter((member) => member.permissions.includes('vote'));
  if (input.threshold > voters.length) {
    throw badRequest('threshold cannot exceed the number of voting Squads members.');
  }
  for (const required of ['initiate', 'vote', 'execute'] as const) {
    if (!members.some((member) => member.permissions.includes(required))) {
      throw badRequest(`At least one Squads member must have ${required} permission.`);
    }
  }

  return {
    creator,
    members,
    squadsMembers: members.map((member) => ({
      key: new PublicKey(member.walletAddress),
      permissions: multisig.types.Permissions.fromPermissions(
        member.permissions.map((permission) => SQUADS_PERMISSION_MAP[permission]),
      ),
    })),
  };
}

async function loadMembersByWalletAddresses(organizationId: string, walletAddresses: string[]) {
  const wallets = await prisma.personalWallet.findMany({
    where: {
      chain: SOLANA_CHAIN,
      walletAddress: { in: walletAddresses },
      status: 'active',
    },
    include: {
      user: {
        select: {
          userId: true,
          memberships: {
            where: { organizationId, status: 'active' },
            select: { membershipId: true },
            take: 1,
          },
        },
      },
    },
  });

  return wallets
    .filter((wallet) => wallet.user.memberships[0])
    .map((wallet) => ({
      personalWalletId: wallet.userWalletId,
      walletAddress: wallet.walletAddress,
      userId: wallet.userId,
      membershipId: wallet.user.memberships[0]!.membershipId,
    }));
}

async function resolveSquadsProgramTreasury(programId: PublicKey) {
  if (config.squadsProgramTreasury) {
    return new PublicKey(config.squadsProgramTreasury);
  }
  const connection = getSolanaConnection();
  const programConfigPda = multisig.getProgramConfigPda({ programId })[0];
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  return programConfig.treasury as PublicKey;
}

async function assertSquadsTreasuryAvailable(organizationId: string, multisigPda: PublicKey, vaultPda: PublicKey) {
  const existing = await prisma.treasuryWallet.findFirst({
    where: {
      organizationId,
      OR: [
        { address: vaultPda.toBase58() },
        { sourceRef: multisigPda.toBase58() },
      ],
    },
    select: { treasuryWalletId: true },
  });
  if (existing) {
    throw badRequest('Squads treasury wallet already exists in this organization.');
  }
}

function serializeOnchainMembers(members: Array<{ key: PublicKey; permissions: { mask: number } }>) {
  return members.map((member) => ({
    walletAddress: member.key.toBase58(),
    permissionsMask: member.permissions.mask,
    permissions: permissionNamesFromMask(member.permissions.mask),
  }));
}

function permissionNamesFromMask(mask: number): SquadsPermissionName[] {
  return (Object.keys(SQUADS_PERMISSION_MAP) as SquadsPermissionName[]).filter(
    (permission) => (mask & SQUADS_PERMISSION_MAP[permission]) === SQUADS_PERMISSION_MAP[permission],
  );
}

function readSquadsMetadata(value: unknown) {
  if (!isRecordLike(value) || !isRecordLike(value.squads)) {
    return null;
  }
  return value.squads as {
    multisigPda?: string;
    vaultPda?: string;
    vaultIndex?: number;
  };
}

function publicKeysEqual(left: PublicKey, right: PublicKey) {
  return left.toBase58() === right.toBase58();
}

function normalizeOptionalText(value?: string | null) {
  return value?.trim() || null;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
