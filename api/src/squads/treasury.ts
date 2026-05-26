import type { Prisma } from '@prisma/client';
import * as multisig from '@sqds/multisig';
import BN from 'bn.js';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type TransactionInstruction } from '@solana/web3.js';
import { ApiError, badRequest, conflict, notFound } from '../infra/api-errors.js';
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { ensureDefaultAutomationAgentWithWallet } from '../agents/automation.js';
import { submitPaymentOrder } from '../payments/orders.js';
import { fundNewDevnetWalletIfConfigured } from '../wallets/devnet-funding.js';
import { signPrivySolanaTransaction } from '../wallets/personal.js';
import {
  buildDestinationAtaCreateInstruction,
  buildUsdcTransferTransactionInstructions,
  deriveUsdcAtaForWallet,
  getSolanaConnection,
  isSolanaSignatureLike,
  serializeSolanaInstruction,
  SOLANA_CHAIN,
  USDC_ASSET,
  USDC_DECIMALS,
  USDC_MINT,
  verifyUsdcSettlementFromSignature,
  waitForSignatureVisible,
  type ExpectedUsdcSettlement,
} from '../solana.js';
import {
  markPaymentOrderSquadsProposalExecuted,
  markPaymentOrderSquadsProposalPrepared,
  markPaymentOrderSquadsProposalSubmitted,
  markPaymentRunSquadsProposalExecuted,
  markPaymentRunSquadsProposalPrepared,
  markPaymentRunSquadsProposalSubmitted,
} from './payment-markers.js';
import {
  SQUADS_SOURCE,
  type SquadsSettlementVerification,
  isRecordLike,
  isSettlementSettled,
  mergeJsonObject,
  serializeSettlementVerification,
} from './shared.js';

const MAX_SQUADS_PAYMENT_RUN_TRANSFERS = 8;
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
type SquadsProposalAccountLike = {
  transactionIndex: { toString(): string };
  status: { __kind: string };
  approved: PublicKey[];
  rejected: PublicKey[];
  cancelled: PublicKey[];
};
type SquadsConfigTransactionAccountLike = {
  index: { toString(): string };
  actions: multisig.types.ConfigAction[];
};
type SquadsVaultTransactionAccountLike = {
  index: { toString(): string };
  vaultIndex: number;
  message: unknown;
};
type SquadsSpendingLimitAccountLike = {
  multisig: PublicKey;
  createKey: PublicKey;
  vaultIndex: number;
  mint: PublicKey;
  amount: { toString(): string };
  period: multisig.types.Period;
  remainingAmount: { toString(): string };
  lastReset: { toString(): string };
  members: PublicKey[];
  destinations: PublicKey[];
};
type SquadsProposalCreator = {
  walletAddress: string;
  personalWalletId: string | null;
  providerWalletId?: string | null;
  automationAgentId?: string | null;
  agentWalletId?: string | null;
  agentName?: string | null;
};
type SquadsProposalActor = {
  actorUserId: string | null;
  actorType: 'user' | 'agent';
  actorId: string | null;
};

type SquadsTreasuryRuntime = {
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getProgramTreasury: (programId: PublicKey) => Promise<PublicKey>;
  loadMultisig: (multisigPda: PublicKey) => Promise<SquadsMultisigAccountLike>;
  loadProposal: (proposalPda: PublicKey) => Promise<SquadsProposalAccountLike | null>;
  loadConfigTransaction: (configTransactionPda: PublicKey) => Promise<SquadsConfigTransactionAccountLike | null>;
  loadVaultTransaction: (vaultTransactionPda: PublicKey) => Promise<SquadsVaultTransactionAccountLike | null>;
  loadSpendingLimit: (spendingLimitPda: PublicKey) => Promise<SquadsSpendingLimitAccountLike | null>;
  signTransaction: typeof signPrivySolanaTransaction;
  sendRawTransaction: (rawTransaction: Buffer) => Promise<string>;
  waitForSignature: (signature: string) => Promise<{ confirmed: boolean; seen: boolean }>;
};

const defaultRuntime: SquadsTreasuryRuntime = {
  getLatestBlockhash: () => getSolanaConnection().getLatestBlockhash(),
  getProgramTreasury: (programId) => resolveSquadsProgramTreasury(programId),
  loadMultisig: (multisigPda) => multisig.accounts.Multisig.fromAccountAddress(getSolanaConnection(), multisigPda),
  loadProposal: async (proposalPda) => {
    try {
      return await multisig.accounts.Proposal.fromAccountAddress(getSolanaConnection(), proposalPda);
    } catch (error) {
      if (isMissingSquadsAccountError(error)) {
        return null;
      }
      throw error;
    }
  },
  loadConfigTransaction: async (configTransactionPda) => {
    try {
      return await multisig.accounts.ConfigTransaction.fromAccountAddress(getSolanaConnection(), configTransactionPda);
    } catch (error) {
      if (isMissingSquadsAccountError(error)) {
        return null;
      }
      throw error;
    }
  },
  loadVaultTransaction: async (vaultTransactionPda) => {
    try {
      return await multisig.accounts.VaultTransaction.fromAccountAddress(getSolanaConnection(), vaultTransactionPda);
    } catch (error) {
      if (isMissingSquadsAccountError(error)) {
        return null;
      }
      throw error;
    }
  },
  loadSpendingLimit: async (spendingLimitPda) => {
    try {
      return await multisig.accounts.SpendingLimit.fromAccountAddress(getSolanaConnection(), spendingLimitPda);
    } catch (error) {
      if (isMissingSquadsAccountError(error)) {
        return null;
      }
      throw error;
    }
  },
  signTransaction: signPrivySolanaTransaction,
  sendRawTransaction: (rawTransaction) => getSolanaConnection().sendRawTransaction(rawTransaction),
  waitForSignature: (signature) => waitForSignatureVisible(getSolanaConnection(), signature, {
    timeoutMs: 20_000,
    pollIntervalMs: 1_000,
  }),
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

export type CreateSquadsAddMemberProposalInput = {
  creatorPersonalWalletId: string;
  newMemberPersonalWalletId: string;
  permissions: SquadsPermissionName[];
  newThreshold?: number;
  memo?: string | null;
};

export type CreateSquadsAddAgentMemberProposalInput = {
  creatorPersonalWalletId: string;
  agentWalletId: string;
  permissions: SquadsPermissionName[];
  newThreshold?: number;
  memo?: string | null;
};

export type CreateSquadsChangeThresholdProposalInput = {
  creatorPersonalWalletId: string;
  newThreshold: number;
  memo?: string | null;
};

export type SquadsSpendingLimitPeriod = 'one_time' | 'day' | 'week' | 'month';

export type CreateSquadsSpendingLimitProposalInput = {
  creatorPersonalWalletId: string;
  agentWalletId: string;
  policyName: string;
  policyCode?: string | null;
  amountRaw: string | bigint;
  period: SquadsSpendingLimitPeriod;
  counterpartyWalletIds: string[];
  memo?: string | null;
};

export type CreateSquadsRemoveSpendingLimitProposalInput = {
  creatorPersonalWalletId: string;
  memo?: string | null;
};

export type CreateSquadsReplaceSpendingLimitProposalInput = {
  creatorPersonalWalletId: string;
  agentWalletId?: string;
  policyName?: string;
  policyCode?: string | null;
  amountRaw?: string | bigint;
  period?: SquadsSpendingLimitPeriod;
  counterpartyWalletIds?: string[];
  memo?: string | null;
};

export type CreateSquadsPaymentProposalInput = {
  paymentOrderId: string;
  creatorPersonalWalletId: string;
  memo?: string | null;
};

export type CreateSquadsPaymentRunProposalInput = {
  paymentRunId: string;
  creatorPersonalWalletId: string;
  memo?: string | null;
};

export type ListDecimalProposalsInput = {
  status?: 'pending' | 'all' | 'closed';
  proposalType?: string;
  treasuryWalletId?: string;
  limit?: number;
};

export type ConfirmDecimalProposalSignatureInput = {
  signature: string;
};

export type ListSquadsConfigProposalsInput = {
  status?: 'pending' | 'all' | 'closed';
  limit?: number;
};

export async function createSquadsTreasuryIntent(
  organizationId: string,
  actorUserId: string,
  input: CreateSquadsTreasuryIntentInput,
) {
  const normalized = normalizeCreateIntentInput(input);
  const memberState = await loadAndValidateMembers(organizationId, actorUserId, normalized);
  const defaultAgentMember = await loadDefaultAgentTreasuryMember(organizationId);
  const treasuryMembers = appendAgentTreasuryMember(memberState.members, defaultAgentMember);
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
    members: treasuryMembers.map(toSquadsMember),
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

  const members = treasuryMembers.map(serializeTreasuryCreateIntentMember);

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
      defaultAgentIncluded: Boolean(defaultAgentMember),
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

export async function createSquadsAddMemberProposalIntent(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  input: CreateSquadsAddMemberProposalInput,
) {
  const creator = await loadActorPersonalWallet(actorUserId, input.creatorPersonalWalletId);
  const newMember = await loadOrganizationPersonalWallet(organizationId, input.newMemberPersonalWalletId);
  const permissions = normalizePermissionNames(input.permissions);
  const actions: multisig.types.ConfigAction[] = [{
    __kind: 'AddMember',
    newMember: {
      key: new PublicKey(newMember.walletAddress),
      permissions: multisig.types.Permissions.fromPermissions(
        permissions.map((permission) => SQUADS_PERMISSION_MAP[permission]),
      ),
    },
  }];
  if (input.newThreshold !== undefined) {
    actions.push({ __kind: 'ChangeThreshold', newThreshold: normalizeThreshold(input.newThreshold) });
  }

  return createSquadsConfigProposalIntent({
    organizationId,
    treasuryWalletId,
    actorUserId,
    creator,
    actions,
    memo: normalizeOptionalText(input.memo) ?? `Add ${newMember.walletAddress} to Decimal treasury`,
    semanticType: 'add_member',
  });
}

export async function createSquadsAddAgentMemberProposalIntent(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  input: CreateSquadsAddAgentMemberProposalInput,
) {
  const creator = await loadActorPersonalWallet(actorUserId, input.creatorPersonalWalletId);
  const agentWallet = await loadOrganizationAgentWallet(organizationId, input.agentWalletId);
  const permissions = normalizePermissionNames(input.permissions);
  const actions: multisig.types.ConfigAction[] = [{
    __kind: 'AddMember',
    newMember: {
      key: new PublicKey(agentWallet.walletAddress),
      permissions: multisig.types.Permissions.fromPermissions(
        permissions.map((permission) => SQUADS_PERMISSION_MAP[permission]),
      ),
    },
  }];
  if (input.newThreshold !== undefined) {
    actions.push({ __kind: 'ChangeThreshold', newThreshold: normalizeThreshold(input.newThreshold) });
  }

  return createSquadsConfigProposalIntent({
    organizationId,
    treasuryWalletId,
    actorUserId,
    creator,
    actions,
    memo: normalizeOptionalText(input.memo) ?? `Add ${agentWallet.label ?? agentWallet.walletAddress} automation wallet to Decimal treasury`,
    semanticType: 'add_agent_member',
    metadataJson: {
      automationAgentId: agentWallet.automationAgentId,
      agentWalletId: agentWallet.agentWalletId,
      agentWalletAddress: agentWallet.walletAddress,
    },
  });
}

export async function createSquadsChangeThresholdProposalIntent(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  input: CreateSquadsChangeThresholdProposalInput,
) {
  const creator = await loadActorPersonalWallet(actorUserId, input.creatorPersonalWalletId);
  return createSquadsConfigProposalIntent({
    organizationId,
    treasuryWalletId,
    actorUserId,
    creator,
    actions: [{ __kind: 'ChangeThreshold', newThreshold: normalizeThreshold(input.newThreshold) }],
    memo: normalizeOptionalText(input.memo) ?? `Change Decimal treasury threshold to ${input.newThreshold}`,
    semanticType: 'change_threshold',
  });
}

export async function createSquadsSpendingLimitProposalIntent(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  input: CreateSquadsSpendingLimitProposalInput,
) {
  const creator = await loadActorPersonalWallet(actorUserId, input.creatorPersonalWalletId);
  const agentWallet = await loadOrganizationAgentWallet(organizationId, input.agentWalletId);
  const { programId, multisigPda, multisigAccount, vaultIndex } = await loadSquadsTreasury(organizationId, treasuryWalletId);
  assertOnchainMemberPermission(multisigAccount, agentWallet.walletAddress, 'initiate');

  const amountRaw = normalizePositiveBigInt(input.amountRaw, 'amountRaw');
  const period = normalizeSpendingLimitPeriod(input.period);
  const destinations = await loadTrustedSpendingLimitDestinations(organizationId, input.counterpartyWalletIds);
  const destinationWalletAddresses = uniqueStrings(destinations.map((destination) => destination.walletAddress));
  if (!destinationWalletAddresses.length) {
    throw badRequest('At least one trusted destination is required for a spending limit.');
  }

  const createKey = Keypair.generate().publicKey;
  const [spendingLimitPda] = multisig.getSpendingLimitPda({
    multisigPda,
    createKey,
    programId,
  });
  const action: multisig.types.ConfigAction = {
    __kind: 'AddSpendingLimit',
    createKey,
    vaultIndex,
    mint: USDC_MINT,
    amount: new BN(amountRaw.toString()),
    period,
    members: [new PublicKey(agentWallet.walletAddress)],
    destinations: destinationWalletAddresses.map((walletAddress) => new PublicKey(walletAddress)),
  };

  const response = await createSquadsConfigProposalIntent({
    organizationId,
    treasuryWalletId,
    actorUserId,
    creator,
    actions: [action],
    memo: normalizeOptionalText(input.memo) ?? `Add ${input.policyName.trim()} spending limit`,
    semanticType: 'add_spending_limit',
    metadataJson: {
      automationAgentId: agentWallet.automationAgentId,
      agentWalletId: agentWallet.agentWalletId,
      spendingLimitPda: spendingLimitPda.toBase58(),
    },
  });

  const policy = await prisma.$transaction(async (tx) => {
    const row = await tx.spendingLimitPolicy.create({
      data: {
        organizationId,
        treasuryWalletId,
        automationAgentId: agentWallet.automationAgentId,
        agentWalletId: agentWallet.agentWalletId,
        decimalProposalId: response.decimalProposal.decimalProposalId,
        policyName: normalizeRequiredText(input.policyName, 'policyName'),
        policyCode: normalizeOptionalText(input.policyCode),
        asset: USDC_ASSET,
        mintAddress: USDC_MINT.toBase58(),
        amountRaw,
        period: spendingLimitPeriodName(period),
        vaultIndex,
        createKey: createKey.toBase58(),
        spendingLimitPda: spendingLimitPda.toBase58(),
        destinationPolicy: 'explicit_allowlist',
        status: 'proposed',
        metadataJson: {
          proposalTransactionIndex: response.intent.transactionIndex,
          destinationWalletAddresses,
        },
      },
    });
    await tx.spendingLimitPolicyDestination.createMany({
      data: destinations.map((destination) => ({
        spendingLimitPolicyId: row.spendingLimitPolicyId,
        organizationId,
        counterpartyWalletId: destination.counterpartyWalletId,
        walletAddress: destination.walletAddress,
      })),
      skipDuplicates: true,
    });
    return tx.spendingLimitPolicy.findUniqueOrThrow({
      where: { spendingLimitPolicyId: row.spendingLimitPolicyId },
      include: spendingLimitPolicyInclude,
    });
  });

  return {
    ...response,
    spendingLimitPolicy: serializeSpendingLimitPolicy(policy),
  };
}

export async function createSquadsRemoveSpendingLimitProposalIntent(
  organizationId: string,
  actorUserId: string,
  spendingLimitPolicyId: string,
  input: CreateSquadsRemoveSpendingLimitProposalInput,
) {
  const creator = await loadActorPersonalWallet(actorUserId, input.creatorPersonalWalletId);
  const policy = await loadSpendingLimitPolicyForMutation(organizationId, spendingLimitPolicyId);
  if (policy.status !== 'active') {
    throw badRequest('Only active spending limit policies can be removed.');
  }

  const response = await createSquadsConfigProposalIntent({
    organizationId,
    treasuryWalletId: policy.treasuryWalletId,
    actorUserId,
    creator,
    actions: [{
      __kind: 'RemoveSpendingLimit',
      spendingLimit: new PublicKey(policy.spendingLimitPda),
    }],
    memo: normalizeOptionalText(input.memo) ?? `Remove ${policy.policyName} spending policy`,
    semanticType: 'remove_spending_limit',
    metadataJson: {
      spendingLimitPolicyId: policy.spendingLimitPolicyId,
      spendingLimitPda: policy.spendingLimitPda,
    },
  });

  const updatedPolicy = await prisma.spendingLimitPolicy.update({
    where: { spendingLimitPolicyId: policy.spendingLimitPolicyId },
    data: {
      status: 'revocation_proposed',
      metadataJson: {
        ...(isRecordLike(policy.metadataJson) ? policy.metadataJson : {}),
        revocationProposalId: response.decimalProposal.decimalProposalId,
        revocationTransactionIndex: response.intent.transactionIndex,
        revocationRequestedAt: new Date().toISOString(),
      },
    },
    include: spendingLimitPolicyInclude,
  });

  return {
    ...response,
    spendingLimitPolicy: serializeSpendingLimitPolicy(updatedPolicy),
  };
}

export async function createSquadsReplaceSpendingLimitProposalIntent(
  organizationId: string,
  actorUserId: string,
  spendingLimitPolicyId: string,
  input: CreateSquadsReplaceSpendingLimitProposalInput,
) {
  const creator = await loadActorPersonalWallet(actorUserId, input.creatorPersonalWalletId);
  const existingPolicy = await loadSpendingLimitPolicyForMutation(organizationId, spendingLimitPolicyId);
  if (existingPolicy.status !== 'active') {
    throw badRequest('Only active spending limit policies can be replaced.');
  }

  const agentWallet = input.agentWalletId
    ? await loadOrganizationAgentWallet(organizationId, input.agentWalletId)
    : {
        ...existingPolicy.agentWallet,
        agentWalletId: existingPolicy.agentWalletId,
        automationAgentId: existingPolicy.automationAgentId,
      };
  const { programId, multisigPda, multisigAccount, vaultIndex } = await loadSquadsTreasury(organizationId, existingPolicy.treasuryWalletId);
  assertOnchainMemberPermission(multisigAccount, agentWallet.walletAddress, 'initiate');

  const amountRaw = input.amountRaw === undefined
    ? existingPolicy.amountRaw
    : normalizePositiveBigInt(input.amountRaw, 'amountRaw');
  const period = input.period
    ? normalizeSpendingLimitPeriod(input.period)
    : normalizeSpendingLimitPeriod(existingPolicy.period as SquadsSpendingLimitPeriod);
  const destinations = input.counterpartyWalletIds
    ? await loadTrustedSpendingLimitDestinations(organizationId, input.counterpartyWalletIds)
    : existingPolicy.destinations.map((destination) => destination.counterpartyWallet);
  const destinationWalletAddresses = uniqueStrings(destinations.map((destination) => destination.walletAddress));
  if (!destinationWalletAddresses.length) {
    throw badRequest('At least one trusted destination is required for a spending limit.');
  }

  const createKey = Keypair.generate().publicKey;
  const [replacementSpendingLimitPda] = multisig.getSpendingLimitPda({
    multisigPda,
    createKey,
    programId,
  });
  const removeAction: multisig.types.ConfigAction = {
    __kind: 'RemoveSpendingLimit',
    spendingLimit: new PublicKey(existingPolicy.spendingLimitPda),
  };
  const addAction: multisig.types.ConfigAction = {
    __kind: 'AddSpendingLimit',
    createKey,
    vaultIndex,
    mint: USDC_MINT,
    amount: new BN(amountRaw.toString()),
    period,
    members: [new PublicKey(agentWallet.walletAddress)],
    destinations: destinationWalletAddresses.map((walletAddress) => new PublicKey(walletAddress)),
  };

  const policyName = normalizeOptionalText(input.policyName) ?? existingPolicy.policyName;
  const policyCode = input.policyCode === undefined ? existingPolicy.policyCode : normalizeOptionalText(input.policyCode);
  const response = await createSquadsConfigProposalIntent({
    organizationId,
    treasuryWalletId: existingPolicy.treasuryWalletId,
    actorUserId,
    creator,
    actions: [removeAction, addAction],
    memo: normalizeOptionalText(input.memo) ?? `Replace ${existingPolicy.policyName} spending policy`,
    semanticType: 'replace_spending_limit',
    metadataJson: {
      replacesSpendingLimitPolicyId: existingPolicy.spendingLimitPolicyId,
      oldSpendingLimitPda: existingPolicy.spendingLimitPda,
      newSpendingLimitPda: replacementSpendingLimitPda.toBase58(),
      automationAgentId: agentWallet.automationAgentId,
      agentWalletId: agentWallet.agentWalletId,
    },
  });

  const result = await prisma.$transaction(async (tx) => {
    const replacement = await tx.spendingLimitPolicy.create({
      data: {
        organizationId,
        treasuryWalletId: existingPolicy.treasuryWalletId,
        automationAgentId: agentWallet.automationAgentId,
        agentWalletId: agentWallet.agentWalletId,
        decimalProposalId: response.decimalProposal.decimalProposalId,
        policyName,
        policyCode,
        asset: USDC_ASSET,
        mintAddress: USDC_MINT.toBase58(),
        amountRaw,
        period: spendingLimitPeriodName(period),
        vaultIndex,
        createKey: createKey.toBase58(),
        spendingLimitPda: replacementSpendingLimitPda.toBase58(),
        destinationPolicy: 'explicit_allowlist',
        status: 'proposed',
        metadataJson: {
          proposalTransactionIndex: response.intent.transactionIndex,
          destinationWalletAddresses,
          replacesSpendingLimitPolicyId: existingPolicy.spendingLimitPolicyId,
        },
      },
    });
    await tx.spendingLimitPolicyDestination.createMany({
      data: destinations.map((destination) => ({
        spendingLimitPolicyId: replacement.spendingLimitPolicyId,
        organizationId,
        counterpartyWalletId: destination.counterpartyWalletId,
        walletAddress: destination.walletAddress,
      })),
      skipDuplicates: true,
    });
    const updatedOriginal = await tx.spendingLimitPolicy.update({
      where: { spendingLimitPolicyId: existingPolicy.spendingLimitPolicyId },
      data: {
        status: 'replacement_proposed',
        metadataJson: {
          ...(isRecordLike(existingPolicy.metadataJson) ? existingPolicy.metadataJson : {}),
          replacementSpendingLimitPolicyId: replacement.spendingLimitPolicyId,
          replacementProposalId: response.decimalProposal.decimalProposalId,
          replacementTransactionIndex: response.intent.transactionIndex,
          replacementRequestedAt: new Date().toISOString(),
        },
      },
      include: spendingLimitPolicyInclude,
    });
    const replacementWithRelations = await tx.spendingLimitPolicy.findUniqueOrThrow({
      where: { spendingLimitPolicyId: replacement.spendingLimitPolicyId },
      include: spendingLimitPolicyInclude,
    });
    return { updatedOriginal, replacement: replacementWithRelations };
  });

  return {
    ...response,
    originalSpendingLimitPolicy: serializeSpendingLimitPolicy(result.updatedOriginal),
    replacementSpendingLimitPolicy: serializeSpendingLimitPolicy(result.replacement),
  };
}

export async function listSpendingLimitPolicies(
  organizationId: string,
  input: { treasuryWalletId?: string; automationAgentId?: string; status?: string; limit?: number } = {},
) {
  const policies = await prisma.spendingLimitPolicy.findMany({
    where: {
      organizationId,
      ...(input.treasuryWalletId ? { treasuryWalletId: input.treasuryWalletId } : {}),
      ...(input.automationAgentId ? { automationAgentId: input.automationAgentId } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    include: spendingLimitPolicyInclude,
    orderBy: { createdAt: 'desc' },
    take: input.limit ?? 100,
  });
  return { items: policies.map(serializeSpendingLimitPolicy) };
}

export async function getSpendingLimitPolicy(organizationId: string, spendingLimitPolicyId: string) {
  const policy = await prisma.spendingLimitPolicy.findFirstOrThrow({
    where: { organizationId, spendingLimitPolicyId },
    include: spendingLimitPolicyInclude,
  });
  return serializeSpendingLimitPolicy(policy);
}

export async function syncSpendingLimitPolicy(organizationId: string, spendingLimitPolicyId: string) {
  const policy = await prisma.spendingLimitPolicy.findFirstOrThrow({
    where: { organizationId, spendingLimitPolicyId },
    include: spendingLimitPolicyInclude,
  });
  const account = await runtime.loadSpendingLimit(new PublicKey(policy.spendingLimitPda));
  const now = new Date();
  const nextStatus = resolveSyncedSpendingLimitStatus(policy.status, Boolean(account));
  const updated = await prisma.spendingLimitPolicy.update({
    where: { spendingLimitPolicyId },
    data: {
      status: nextStatus,
      lastSyncedAt: now,
      metadataJson: {
        ...(isRecordLike(policy.metadataJson) ? policy.metadataJson : {}),
        onchain: account
          ? {
            multisig: account.multisig.toBase58(),
            createKey: account.createKey.toBase58(),
            vaultIndex: account.vaultIndex,
            mint: account.mint.toBase58(),
            amountRaw: account.amount.toString(),
            remainingAmountRaw: account.remainingAmount.toString(),
            period: spendingLimitPeriodName(account.period),
            lastReset: account.lastReset.toString(),
            members: addressesFromPublicKeys(account.members),
            destinations: addressesFromPublicKeys(account.destinations),
            syncedAt: now.toISOString(),
          }
          : null,
      },
    },
    include: spendingLimitPolicyInclude,
  });
  return serializeSpendingLimitPolicy(updated);
}

export async function createSquadsPaymentProposalIntent(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  input: CreateSquadsPaymentProposalInput,
) {
  const creator = await loadActorPersonalWallet(actorUserId, input.creatorPersonalWalletId);
  if (creator.userId !== actorUserId) {
    throw badRequest('creatorPersonalWalletId must belong to the authenticated user.');
  }
  return createSquadsPaymentProposalIntentForCreator({
    organizationId,
    treasuryWalletId,
    actor: {
      actorUserId,
      actorType: 'user',
      actorId: actorUserId,
    },
    creator: {
      walletAddress: creator.walletAddress,
      personalWalletId: creator.userWalletId,
      providerWalletId: creator.providerWalletId,
    },
    input,
  });
}

export async function createAndSubmitSquadsPaymentProposalAsAgent(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string | null,
  input: { paymentOrderId: string; memo?: string | null },
) {
  const defaultAgent = await ensureDefaultAutomationAgentWithWallet(organizationId, {
    force: true,
    failOnError: false,
  });
  if (!defaultAgent.wallet || !defaultAgent.agent) {
    throw badRequest('Default automation agent wallet is not available. Configure Privy or create an agent wallet first.');
  }
  if (!defaultAgent.wallet.providerWalletId) {
    throw badRequest('Default automation agent wallet is missing a provider wallet id and cannot sign.');
  }

  const prepared = await createSquadsPaymentProposalIntentForCreator({
    organizationId,
    treasuryWalletId,
    actor: {
      actorUserId,
      actorType: 'agent',
      actorId: defaultAgent.agent.automationAgentId,
    },
    creator: {
      walletAddress: defaultAgent.wallet.walletAddress,
      personalWalletId: null,
      providerWalletId: defaultAgent.wallet.providerWalletId,
      automationAgentId: defaultAgent.agent.automationAgentId,
      agentWalletId: defaultAgent.wallet.agentWalletId,
      agentName: defaultAgent.agent.name,
    },
    input,
  });

  try {
    const signed = await runtime.signTransaction({
      providerWalletId: defaultAgent.wallet.providerWalletId,
      serializedTransactionBase64: prepared.transaction.serializedTransaction,
    });
    const signature = await runtime.sendRawTransaction(Buffer.from(signed.signedTransactionBase64, 'base64'));
    const visible = await runtime.waitForSignature(signature);
    if (!visible.confirmed) {
      throw badRequest('Agent-submitted Squads proposal transaction is not confirmed yet. Retry after the transaction lands.', {
        signature,
        seen: visible.seen,
      });
    }
    const decimalProposal = await recordDecimalProposalSubmission({
      organizationId,
      decimalProposalId: prepared.decimalProposal.decimalProposalId,
      signature,
      actor: {
        actorUserId,
        actorType: 'agent',
        actorId: defaultAgent.agent.automationAgentId,
      },
    });
    await prisma.agentWallet.update({
      where: { agentWalletId: defaultAgent.wallet.agentWalletId },
      data: { lastUsedAt: new Date() },
    });

    return {
      ...prepared,
      decimalProposal,
      submittedSignature: signature,
      automationAgent: defaultAgent.agent,
      agentWallet: defaultAgent.wallet,
    };
  } catch (error) {
    await markPreparedProposalFailed({
      organizationId,
      decimalProposalId: prepared.decimalProposal.decimalProposalId,
      reason: error instanceof Error ? error.message : 'Agent proposal submission failed',
      actor: {
        actorUserId,
        actorType: 'agent',
        actorId: defaultAgent.agent.automationAgentId,
      },
    });
    throw error;
  }
}

async function createSquadsPaymentProposalIntentForCreator(args: {
  organizationId: string;
  treasuryWalletId: string;
  actor: SquadsProposalActor;
  creator: SquadsProposalCreator;
  input: { paymentOrderId: string; memo?: string | null };
}) {
  const { organizationId, treasuryWalletId, actor, creator, input } = args;
  const { wallet, programId, multisigPda, vaultPda, vaultIndex, multisigAccount } = await loadSquadsTreasury(organizationId, treasuryWalletId);
  assertOnchainMemberPermission(multisigAccount, creator.walletAddress, 'initiate');

  let paymentOrder = await loadPaymentOrderForSquadsProposal(organizationId, input.paymentOrderId);
  if (paymentOrder.sourceTreasuryWalletId && paymentOrder.sourceTreasuryWalletId !== treasuryWalletId) {
    throw badRequest('Payment order is already assigned to a different source treasury.');
  }
  const existingProposal = await findActiveSquadsPaymentProposal(organizationId, paymentOrder.paymentOrderId);
  if (existingProposal) {
    throw conflict('Payment order already has a Squads payment proposal.', {
      decimalProposalId: existingProposal.decimalProposalId,
      status: existingProposal.status,
      transactionIndex: existingProposal.transactionIndex,
      submittedSignature: existingProposal.submittedSignature,
      executedSignature: existingProposal.executedSignature,
    });
  }
  if (!paymentOrder.sourceTreasuryWalletId) {
    await prisma.paymentOrder.update({
      where: { paymentOrderId: paymentOrder.paymentOrderId },
      data: { sourceTreasuryWalletId: treasuryWalletId },
    });
    paymentOrder = await loadPaymentOrderForSquadsProposal(organizationId, input.paymentOrderId);
  }
  if (!paymentOrder.transferRequests.length && paymentOrder.state === 'draft') {
    await submitPaymentOrder({
      organizationId,
      paymentOrderId: paymentOrder.paymentOrderId,
      actorUserId: actor.actorUserId,
      actorType: actor.actorType,
      actorId: actor.actorId,
    });
    paymentOrder = await loadPaymentOrderForSquadsProposal(organizationId, input.paymentOrderId);
  }

  const transferRequest = paymentOrder.transferRequests[0] ?? null;
  if (!transferRequest) {
    throw badRequest('Submit the payment order before creating a Squads payment proposal.');
  }
  if (transferRequest.status === 'pending_approval' || transferRequest.status === 'escalated') {
    throw badRequest('Payment order requires approval before a Squads payment proposal can be created.');
  }
  if (!['approved', 'ready_for_execution'].includes(transferRequest.status)) {
    throw badRequest(`Payment order cannot be proposed while request is ${transferRequest.status}.`);
  }
  if (paymentOrder.asset.toLowerCase() !== USDC_ASSET) {
    throw badRequest(`Squads payment proposals currently support USDC only, received ${paymentOrder.asset}.`);
  }

  const sourceTokenAccount = wallet.usdcAtaAddress ?? deriveUsdcAtaForWallet(vaultPda.toBase58());
  const destinationTokenAccount = paymentOrder.counterpartyWallet.tokenAccountAddress
    ?? deriveUsdcAtaForWallet(paymentOrder.counterpartyWallet.walletAddress);
  // Skip the destination ATA-create here. It can't run inside the vault
  // inner transaction because the vault PDA pays no rent (no native SOL).
  // The wrapping vaultTransactionExecute will prepend a paid-by-executor
  // ATA-create instead. See createDecimalProposalExecuteIntent below.
  const transferInstructions = buildUsdcTransferTransactionInstructions({
    sourceWallet: vaultPda.toBase58(),
    sourceTokenAccount,
    destinationWallet: paymentOrder.counterpartyWallet.walletAddress,
    destinationTokenAccount,
    amountRaw: paymentOrder.amountRaw,
    includeDestinationAtaCreate: false,
  });

  const transactionIndex = BigInt(multisigAccount.transactionIndex.toString()) + 1n;
  const latestBlockhash = await runtime.getLatestBlockhash();
  const creatorPublicKey = new PublicKey(creator.walletAddress);
  const vaultTransactionMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: transferInstructions,
  });
  const instructions = [
    multisig.instructions.vaultTransactionCreate({
      multisigPda,
      transactionIndex,
      creator: creatorPublicKey,
      rentPayer: creatorPublicKey,
      vaultIndex,
      ephemeralSigners: 0,
      transactionMessage: vaultTransactionMessage,
      memo: normalizeOptionalText(input.memo) ?? `Decimal payment ${paymentOrder.paymentOrderId}`,
      programId,
    }),
    multisig.instructions.proposalCreate({
      multisigPda,
      transactionIndex,
      creator: creatorPublicKey,
      rentPayer: creatorPublicKey,
      isDraft: false,
      programId,
    }),
  ];

  const semanticPayload = {
    paymentOrderId: paymentOrder.paymentOrderId,
    transferRequestId: transferRequest.transferRequestId,
    counterpartyWalletId: paymentOrder.counterpartyWalletId,
    destinationWalletAddress: paymentOrder.counterpartyWallet.walletAddress,
    destinationTokenAccountAddress: destinationTokenAccount,
    sourceTreasuryWalletId: treasuryWalletId,
    sourceWalletAddress: vaultPda.toBase58(),
    sourceTokenAccountAddress: sourceTokenAccount,
    amountRaw: paymentOrder.amountRaw.toString(),
    asset: paymentOrder.asset,
    token: {
      symbol: 'USDC',
      mint: USDC_MINT.toBase58(),
      decimals: USDC_DECIMALS,
    },
    reference: paymentOrder.externalReference ?? paymentOrder.invoiceNumber ?? null,
    memo: paymentOrder.memo,
    instructions: transferInstructions.map(serializeSolanaInstruction),
  };

  const response = buildSquadsSignableResponse({
    wallet,
    programId,
    multisigPda,
    transactionIndex,
    signerWalletAddress: creator.walletAddress,
    latestBlockhash,
    instructions,
    kind: 'vault_payment_proposal_create',
    proposalType: 'vault_transaction',
    proposalCategory: 'execution',
    semanticType: 'send_payment',
    actions: [{
      type: 'send_payment',
      asset: paymentOrder.asset,
      amountRaw: paymentOrder.amountRaw.toString(),
      destinationWalletAddress: paymentOrder.counterpartyWallet.walletAddress,
      destinationTokenAccountAddress: destinationTokenAccount,
      paymentOrderId: paymentOrder.paymentOrderId,
    }],
  });

  const decimalProposal = await persistDecimalProposal({
    organizationId,
    treasuryWalletId,
    paymentOrderId: paymentOrder.paymentOrderId,
    createdByUserId: actor.actorUserId,
    creatorPersonalWalletId: creator.personalWalletId,
    creatorWalletAddress: creator.walletAddress,
    requiredSigner: creator.walletAddress,
    proposalType: 'vault_transaction',
    proposalCategory: 'execution',
    semanticType: 'send_payment',
    status: 'prepared',
    response,
    vaultIndex,
    semanticPayload,
    metadataJson: {
      transferRequestId: transferRequest.transferRequestId,
      ...(creator.automationAgentId
        ? {
            createdBy: 'automation_agent',
            automationAgentId: creator.automationAgentId,
            agentWalletId: creator.agentWalletId,
            agentName: creator.agentName,
          }
        : {}),
    },
  });
  await markPaymentOrderSquadsProposalPrepared({
    paymentOrderId: paymentOrder.paymentOrderId,
    organizationId,
    actorUserId: actor.actorUserId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    beforeState: paymentOrder.state,
    transferRequestId: transferRequest.transferRequestId,
    decimalProposalId: decimalProposal.decimalProposalId,
    transactionIndex: response.intent.transactionIndex,
  });

  return {
    ...response,
    decimalProposal,
  };
}

export async function createSquadsPaymentRunProposalIntent(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  input: CreateSquadsPaymentRunProposalInput,
) {
  const creator = await loadActorPersonalWallet(actorUserId, input.creatorPersonalWalletId);
  const { wallet, programId, multisigPda, vaultPda, vaultIndex, multisigAccount } = await loadSquadsTreasury(organizationId, treasuryWalletId);
  if (creator.userId !== actorUserId) {
    throw badRequest('creatorPersonalWalletId must belong to the authenticated user.');
  }
  assertOnchainMemberPermission(multisigAccount, creator.walletAddress, 'initiate');

  let paymentRun = await loadPaymentRunForSquadsProposal(organizationId, input.paymentRunId);
  if (!paymentRun.paymentOrders.length) {
    throw badRequest('Payment run has no payment orders.');
  }
  if (paymentRun.paymentOrders.length > MAX_SQUADS_PAYMENT_RUN_TRANSFERS) {
    throw badRequest(`Payment run has ${paymentRun.paymentOrders.length} orders. Split it into chunks of ${MAX_SQUADS_PAYMENT_RUN_TRANSFERS} or fewer before creating a Squads proposal.`);
  }

  const existingProposal = await findActiveSquadsPaymentRunProposal(organizationId, paymentRun.paymentRunId);
  if (existingProposal) {
    throw conflict('Payment run already has a Squads payment proposal.', {
      decimalProposalId: existingProposal.decimalProposalId,
      status: existingProposal.status,
      transactionIndex: existingProposal.transactionIndex,
      submittedSignature: existingProposal.submittedSignature,
      executedSignature: existingProposal.executedSignature,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentRun.update({
      where: { paymentRunId: paymentRun.paymentRunId },
      data: { sourceTreasuryWalletId: treasuryWalletId },
    });
    for (const order of paymentRun.paymentOrders) {
      if (order.sourceTreasuryWalletId && order.sourceTreasuryWalletId !== treasuryWalletId) {
        throw badRequest(`Payment order ${order.paymentOrderId} already uses a different source treasury.`);
      }
      if (order.counterpartyWallet.walletAddress === wallet.address) {
        throw badRequest(`Source treasury cannot be the same as counterparty wallet "${order.counterpartyWallet.label}".`);
      }
      await tx.paymentOrder.update({
        where: { paymentOrderId: order.paymentOrderId },
        data: { sourceTreasuryWalletId: treasuryWalletId },
      });
      for (const request of order.transferRequests) {
        await tx.transferRequest.update({
          where: { transferRequestId: request.transferRequestId },
          data: { sourceTreasuryWalletId: treasuryWalletId },
        });
      }
    }
  });

  for (const order of paymentRun.paymentOrders) {
    if (!order.transferRequests.length && order.state === 'draft') {
      await submitPaymentOrder({
        organizationId,
        paymentOrderId: order.paymentOrderId,
        actorUserId,
        actorType: 'user',
        actorId: actorUserId,
      });
    }
  }

  paymentRun = await loadPaymentRunForSquadsProposal(organizationId, input.paymentRunId);
  const blocked = paymentRun.paymentOrders.filter((order) => {
    const request = order.transferRequests[0] ?? null;
    return !request || ['pending_approval', 'escalated'].includes(request.status);
  });
  if (blocked.length) {
    throw badRequest(`${blocked.length} payment run row(s) need approval before a Squads proposal can be created.`);
  }

  const invalid = paymentRun.paymentOrders.find((order) => {
    const request = order.transferRequests[0] ?? null;
    return !request || !['approved', 'ready_for_execution'].includes(request.status);
  });
  if (invalid) {
    const status = invalid.transferRequests[0]?.status ?? invalid.state;
    throw badRequest(`Payment order ${invalid.paymentOrderId} cannot be proposed while it is ${status}.`);
  }
  if (paymentRun.paymentOrders.some((order) => order.asset.toLowerCase() !== USDC_ASSET)) {
    throw badRequest('Squads payment run proposals currently support USDC only.');
  }

  const sourceTokenAccount = wallet.usdcAtaAddress ?? deriveUsdcAtaForWallet(vaultPda.toBase58());
  const orderPayloads = paymentRun.paymentOrders.map((order, index) => {
    const transferRequest = order.transferRequests[0]!;
    const destinationTokenAccount = order.counterpartyWallet.tokenAccountAddress
      ?? deriveUsdcAtaForWallet(order.counterpartyWallet.walletAddress);
    const transferInstructions = buildUsdcTransferTransactionInstructions({
      sourceWallet: vaultPda.toBase58(),
      sourceTokenAccount,
      destinationWallet: order.counterpartyWallet.walletAddress,
      destinationTokenAccount,
      amountRaw: order.amountRaw,
      includeDestinationAtaCreate: false,
    });
    return {
      index,
      paymentOrder: order,
      transferRequest,
      destinationTokenAccount,
      transferInstructions,
    };
  });
  const vaultInstructions = orderPayloads.flatMap((item) => item.transferInstructions);

  const transactionIndex = BigInt(multisigAccount.transactionIndex.toString()) + 1n;
  const latestBlockhash = await runtime.getLatestBlockhash();
  const creatorPublicKey = new PublicKey(creator.walletAddress);
  const vaultTransactionMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: vaultInstructions,
  });
  const instructions = [
    multisig.instructions.vaultTransactionCreate({
      multisigPda,
      transactionIndex,
      creator: creatorPublicKey,
      rentPayer: creatorPublicKey,
      vaultIndex,
      ephemeralSigners: 0,
      transactionMessage: vaultTransactionMessage,
      memo: normalizeOptionalText(input.memo) ?? `Decimal payment run ${paymentRun.paymentRunId}`,
      programId,
    }),
    multisig.instructions.proposalCreate({
      multisigPda,
      transactionIndex,
      creator: creatorPublicKey,
      rentPayer: creatorPublicKey,
      isDraft: false,
      programId,
    }),
  ];

  const totalAmountRaw = orderPayloads.reduce((sum, item) => sum + item.paymentOrder.amountRaw, 0n);
  const semanticPayload = {
    paymentRunId: paymentRun.paymentRunId,
    runName: paymentRun.runName,
    sourceTreasuryWalletId: treasuryWalletId,
    sourceWalletAddress: vaultPda.toBase58(),
    sourceTokenAccountAddress: sourceTokenAccount,
    totalAmountRaw: totalAmountRaw.toString(),
    orderCount: orderPayloads.length,
    asset: USDC_ASSET,
    token: {
      symbol: 'USDC',
      mint: USDC_MINT.toBase58(),
      decimals: USDC_DECIMALS,
    },
    orders: orderPayloads.map((item) => ({
      index: item.index,
      paymentOrderId: item.paymentOrder.paymentOrderId,
      transferRequestId: item.transferRequest.transferRequestId,
      counterpartyWalletId: item.paymentOrder.counterpartyWalletId,
      destinationWalletAddress: item.paymentOrder.counterpartyWallet.walletAddress,
      destinationTokenAccountAddress: item.destinationTokenAccount,
      amountRaw: item.paymentOrder.amountRaw.toString(),
      asset: item.paymentOrder.asset,
      reference: item.paymentOrder.externalReference ?? item.paymentOrder.invoiceNumber ?? null,
      memo: item.paymentOrder.memo,
      instructions: item.transferInstructions.map(serializeSolanaInstruction),
    })),
    instructions: vaultInstructions.map(serializeSolanaInstruction),
  };

  const response = buildSquadsSignableResponse({
    wallet,
    programId,
    multisigPda,
    transactionIndex,
    signerWalletAddress: creator.walletAddress,
    latestBlockhash,
    instructions,
    kind: 'vault_payment_run_proposal_create',
    proposalType: 'vault_transaction',
    proposalCategory: 'execution',
    semanticType: 'send_payment_run',
    actions: orderPayloads.map((item) => ({
      type: 'send_payment',
      asset: item.paymentOrder.asset,
      amountRaw: item.paymentOrder.amountRaw.toString(),
      destinationWalletAddress: item.paymentOrder.counterpartyWallet.walletAddress,
      destinationTokenAccountAddress: item.destinationTokenAccount,
      paymentOrderId: item.paymentOrder.paymentOrderId,
      paymentRunId: paymentRun.paymentRunId,
    })),
  });

  const decimalProposal = await persistDecimalProposal({
    organizationId,
    treasuryWalletId,
    paymentOrderId: null,
    paymentRunId: paymentRun.paymentRunId,
    createdByUserId: actorUserId,
    creatorPersonalWalletId: creator.userWalletId,
    creatorWalletAddress: creator.walletAddress,
    requiredSigner: creator.walletAddress,
    proposalType: 'vault_transaction',
    proposalCategory: 'execution',
    semanticType: 'send_payment_run',
    status: 'prepared',
    response,
    vaultIndex,
    semanticPayload,
    metadataJson: {
      paymentRunId: paymentRun.paymentRunId,
      paymentOrderIds: orderPayloads.map((item) => item.paymentOrder.paymentOrderId),
      transferRequestIds: orderPayloads.map((item) => item.transferRequest.transferRequestId),
    },
  });

  await markPaymentRunSquadsProposalPrepared({
    organizationId,
    paymentRunId: paymentRun.paymentRunId,
    actorUserId,
    decimalProposalId: decimalProposal.decimalProposalId,
    transactionIndex: response.intent.transactionIndex,
    items: orderPayloads.map((item) => ({
      paymentOrderId: item.paymentOrder.paymentOrderId,
      beforeState: item.paymentOrder.state,
      transferRequestId: item.transferRequest.transferRequestId,
    })),
  });

  return {
    ...response,
    decimalProposal,
  };
}

export async function createSquadsConfigProposalApprovalIntent(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  input: {
    transactionIndex: string;
    memberPersonalWalletId: string;
    memo?: string | null;
  },
) {
  const member = await loadActorPersonalWallet(actorUserId, input.memberPersonalWalletId);
  const { wallet, programId, multisigPda, multisigAccount } = await loadSquadsTreasury(organizationId, treasuryWalletId);
  assertOnchainMemberPermission(multisigAccount, member.walletAddress, 'vote');
  const transactionIndex = parseTransactionIndex(input.transactionIndex);
  const latestBlockhash = await runtime.getLatestBlockhash();
  const instruction = multisig.instructions.proposalApprove({
    multisigPda,
    transactionIndex,
    member: new PublicKey(member.walletAddress),
    memo: normalizeOptionalText(input.memo) ?? undefined,
    programId,
  });

  return buildSquadsSignableResponse({
    wallet,
    programId,
    multisigPda,
    transactionIndex,
    signerWalletAddress: member.walletAddress,
    latestBlockhash,
    instructions: [instruction],
    kind: 'config_proposal_approval',
    proposalType: 'config_transaction',
    proposalCategory: 'configuration',
    semanticType: 'approve_proposal',
    actions: [],
  });
}

export async function createSquadsConfigProposalExecuteIntent(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  input: {
    transactionIndex: string;
    memberPersonalWalletId: string;
  },
) {
  const member = await loadActorPersonalWallet(actorUserId, input.memberPersonalWalletId);
  const { wallet, programId, multisigPda, multisigAccount } = await loadSquadsTreasury(organizationId, treasuryWalletId);
  assertOnchainMemberPermission(multisigAccount, member.walletAddress, 'execute');
  const transactionIndex = parseTransactionIndex(input.transactionIndex);
  const latestBlockhash = await runtime.getLatestBlockhash();
  const spendingLimits = await loadSpendingLimitPdasForConfigTransaction(programId, multisigPda, transactionIndex);
  const instruction = multisig.instructions.configTransactionExecute({
    multisigPda,
    transactionIndex,
    member: new PublicKey(member.walletAddress),
    rentPayer: new PublicKey(member.walletAddress),
    spendingLimits,
    programId,
  });

  return buildSquadsSignableResponse({
    wallet,
    programId,
    multisigPda,
    transactionIndex,
    signerWalletAddress: member.walletAddress,
    latestBlockhash,
    instructions: [instruction],
    kind: 'config_proposal_execution',
    proposalType: 'config_transaction',
    proposalCategory: 'configuration',
    semanticType: 'execute_proposal',
    actions: [],
  });
}

export async function listSquadsConfigProposals(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  input: ListSquadsConfigProposalsInput = {},
) {
  const { programId, multisigPda, multisigAccount } = await loadSquadsTreasury(organizationId, treasuryWalletId);
  await assertActorIsSquadsMember(organizationId, multisigAccount, actorUserId);

  const statusFilter = input.status ?? 'pending';
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const currentTransactionIndex = parseTransactionIndex(multisigAccount.transactionIndex.toString());
  const items = [];

  // Walk every existing proposal index from newest to oldest. Squads bumps
  // staleTransactionIndex to N after executing the config transaction at
  // index N (to mark earlier *pending* proposals as no longer executable),
  // so we must NOT stop at staleTransactionIndex — that would hide the
  // executed proposal itself. staleTransactionIndex is still surfaced in
  // each proposal's payload as informational metadata.
  for (let index = currentTransactionIndex; index >= 1n && items.length < limit; index -= 1n) {
    const proposal = await loadSquadsConfigProposal(organizationId, treasuryWalletId, programId, multisigPda, multisigAccount, index);
    if (!proposal || !matchesProposalStatusFilter(proposal.status, statusFilter)) {
      continue;
    }
    items.push(proposal);
  }

  return { items };
}

// Aggregates Squads config proposals across every Squads treasury in the
// organization that the actor is a member of. Treasuries the actor isn't
// a member of are skipped silently (403 not_squads_member from the per-
// treasury list is swallowed). Returns each proposal annotated with its
// treasury context so the org-level UI can group / link.
export async function listOrganizationSquadsProposals(
  organizationId: string,
  actorUserId: string,
  input: ListSquadsConfigProposalsInput = {},
) {
  const treasuries = await prisma.treasuryWallet.findMany({
    where: { organizationId, source: SQUADS_SOURCE, isActive: true },
    select: {
      treasuryWalletId: true,
      address: true,
      displayName: true,
      sourceRef: true,
      propertiesJson: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const items: Array<
    Awaited<ReturnType<typeof listSquadsConfigProposals>>['items'][number]
    & { treasuryWallet: { treasuryWalletId: string; address: string; displayName: string | null; multisigPda: string | null } }
  > = [];

  for (const treasury of treasuries) {
    try {
      const result = await listSquadsConfigProposals(
        organizationId,
        treasury.treasuryWalletId,
        actorUserId,
        input,
      );
      for (const proposal of result.items) {
        items.push({
          ...proposal,
          treasuryWallet: {
            treasuryWalletId: treasury.treasuryWalletId,
            address: treasury.address,
            displayName: treasury.displayName,
            multisigPda: treasury.sourceRef,
          },
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_squads_member') {
        continue;
      }
      throw err;
    }
  }

  return { items };
}

export async function getSquadsConfigProposal(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  transactionIndex: string,
) {
  const { programId, multisigPda, multisigAccount } = await loadSquadsTreasury(organizationId, treasuryWalletId);
  await assertActorIsSquadsMember(organizationId, multisigAccount, actorUserId);
  const proposal = await loadSquadsConfigProposal(
    organizationId,
    treasuryWalletId,
    programId,
    multisigPda,
    multisigAccount,
    parseTransactionIndex(transactionIndex),
  );
  if (!proposal) {
    throw notFound('Squads config proposal not found');
  }
  return proposal;
}

export async function listDecimalProposals(
  organizationId: string,
  actorUserId: string,
  input: ListDecimalProposalsInput = {},
) {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const rows = await prisma.decimalProposal.findMany({
    where: {
      organizationId,
      ...(input.proposalType ? { proposalType: input.proposalType } : {}),
      ...(input.treasuryWalletId ? { treasuryWalletId: input.treasuryWalletId } : {}),
      ...(input.status && input.status !== 'all' ? statusFilterWhere(input.status) : {}),
    },
    include: decimalProposalInclude,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const visible = [];
  for (const row of rows) {
    if (row.provider === SQUADS_SOURCE && row.treasuryWalletId) {
      try {
        const { multisigAccount } = await loadSquadsTreasury(organizationId, row.treasuryWalletId);
        await assertActorIsSquadsMember(organizationId, multisigAccount, actorUserId);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not_squads_member') {
          continue;
        }
        throw err;
      }
    }
    visible.push(await serializeDecimalProposal(row));
  }
  return { items: visible };
}

export async function getDecimalProposal(
  organizationId: string,
  actorUserId: string,
  decimalProposalId: string,
) {
  const row = await prisma.decimalProposal.findFirst({
    where: { organizationId, decimalProposalId },
    include: decimalProposalInclude,
  });
  if (!row) {
    throw notFound('Proposal not found');
  }
  if (row.provider === SQUADS_SOURCE && row.treasuryWalletId) {
    const { multisigAccount } = await loadSquadsTreasury(organizationId, row.treasuryWalletId);
    await assertActorIsSquadsMember(organizationId, multisigAccount, actorUserId);
  }
  return serializeDecimalProposal(row);
}

export async function confirmDecimalProposalSubmission(
  organizationId: string,
  actorUserId: string,
  decimalProposalId: string,
  input: ConfirmDecimalProposalSignatureInput,
) {
  await getDecimalProposal(organizationId, actorUserId, decimalProposalId);
  const signature = input.signature.trim();
  await verifyRpcSignatureConfirmed(signature, 'proposal_submission');
  return recordDecimalProposalSubmission({
    organizationId,
    decimalProposalId,
    signature,
    actor: {
      actorUserId,
      actorType: 'user',
      actorId: actorUserId,
    },
  });
}

async function recordDecimalProposalSubmission(args: {
  organizationId: string;
  decimalProposalId: string;
  signature: string;
  actor: SquadsProposalActor;
}) {
  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.decimalProposal.findFirstOrThrow({
      where: { organizationId: args.organizationId, decimalProposalId: args.decimalProposalId },
    });
    const row = await tx.decimalProposal.update({
      where: { decimalProposalId: args.decimalProposalId },
      data: {
        submittedSignature: args.signature,
        submittedAt: new Date(),
        status: current.status === 'executed' ? 'executed' : 'submitted',
      },
      include: decimalProposalInclude,
    });
    if (current.semanticType === 'send_payment' && current.paymentOrderId) {
      await markPaymentOrderSquadsProposalSubmitted(tx, {
        organizationId: args.organizationId,
        actorUserId: args.actor.actorUserId,
        actorType: args.actor.actorType,
        actorId: args.actor.actorId,
        paymentOrderId: current.paymentOrderId,
        decimalProposalId: args.decimalProposalId,
        beforeState: null,
        signature: args.signature,
        transactionIndex: current.transactionIndex,
      });
    }
    if (current.semanticType === 'send_payment_run' && current.paymentRunId) {
      await markPaymentRunSquadsProposalSubmitted(tx, {
        organizationId: args.organizationId,
        actorUserId: args.actor.actorUserId,
        actorType: args.actor.actorType,
        actorId: args.actor.actorId,
        paymentRunId: current.paymentRunId,
        decimalProposalId: args.decimalProposalId,
        signature: args.signature,
        transactionIndex: current.transactionIndex,
      });
    }
    return row;
  });
  return serializeDecimalProposal(updated);
}

async function markPreparedProposalFailed(args: {
  organizationId: string;
  decimalProposalId: string;
  reason: string;
  actor: SquadsProposalActor;
}) {
  await prisma.$transaction(async (tx) => {
    const current = await tx.decimalProposal.findFirst({
      where: { organizationId: args.organizationId, decimalProposalId: args.decimalProposalId },
      select: {
        decimalProposalId: true,
        paymentOrderId: true,
        status: true,
        metadataJson: true,
      },
    });
    if (!current || current.status !== 'prepared') {
      return;
    }
    await tx.decimalProposal.update({
      where: { decimalProposalId: args.decimalProposalId },
      data: {
        status: 'failed',
        metadataJson: {
          ...(isRecordLike(current.metadataJson) ? current.metadataJson : {}),
          failure: {
            reason: args.reason,
            failedAt: new Date().toISOString(),
            actorType: args.actor.actorType,
            actorId: args.actor.actorId,
          },
        },
      },
    });
    if (current.paymentOrderId) {
      const order = await tx.paymentOrder.findFirst({
        where: { organizationId: args.organizationId, paymentOrderId: current.paymentOrderId },
        select: { paymentOrderId: true, state: true },
      });
      if (!order) {
        return;
      }
      await tx.paymentOrderEvent.create({
        data: {
          paymentOrderId: order.paymentOrderId,
          organizationId: args.organizationId,
          eventType: 'squads_payment_proposal_failed',
          actorType: args.actor.actorType,
          actorId: args.actor.actorId,
          beforeState: order.state,
          afterState: order.state,
          payloadJson: {
            decimalProposalId: args.decimalProposalId,
            reason: args.reason,
          },
        },
      });
    }
  });
}

export async function confirmDecimalProposalExecution(
  organizationId: string,
  actorUserId: string,
  decimalProposalId: string,
  input: ConfirmDecimalProposalSignatureInput,
) {
  await getDecimalProposal(organizationId, actorUserId, decimalProposalId);
  const signature = input.signature.trim();
  await verifyRpcSignatureConfirmed(signature, 'proposal_execution');
  const currentForSettlement = await prisma.decimalProposal.findFirstOrThrow({
    where: { organizationId, decimalProposalId },
  });

  // Idempotency: if the proposal is already recorded as executed under a
  // *different* signature, a duplicate Execute click landed two on-chain
  // transactions. The first one wins (Squads enforces this on-chain too —
  // the second submission would fail at the proposal-status check). Surface
  // the conflict so the operator can investigate the rogue signature.
  if (
    currentForSettlement.executedSignature
    && currentForSettlement.executedSignature !== signature
  ) {
    throw conflict('Proposal was already confirmed with a different signature.', {
      decimalProposalId,
      storedSignature: currentForSettlement.executedSignature,
      providedSignature: signature,
    });
  }

  const settlementVerification = await verifySquadsProposalSettlement(currentForSettlement, signature);
  const settled = isSettlementSettled(settlementVerification);

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.decimalProposal.findFirstOrThrow({
      where: { organizationId, decimalProposalId },
    });
    const row = await tx.decimalProposal.update({
      where: { decimalProposalId },
      data: {
        executedSignature: signature,
        // Preserve the original execution timestamp on retries so the
        // "executed at" surface in the UI doesn't drift each time we
        // re-verify.
        executedAt: current.executedAt ?? new Date(),
        status: 'executed',
        metadataJson: mergeJsonObject(current.metadataJson, {
          rpcSettlementVerification: serializeSettlementVerification(settlementVerification),
        }),
      },
      include: decimalProposalInclude,
    });
    if (current.semanticType === 'send_payment' && current.paymentOrderId) {
      await markPaymentOrderSquadsProposalExecuted(tx, {
        organizationId,
        actorUserId,
        paymentOrderId: current.paymentOrderId,
        decimalProposalId,
        signature,
        transactionIndex: current.transactionIndex,
        metadataJson: current.metadataJson,
        settlementVerification,
        settled,
      });
    }
    if (current.semanticType === 'send_payment_run' && current.paymentRunId) {
      await markPaymentRunSquadsProposalExecuted(tx, {
        organizationId,
        actorUserId,
        paymentRunId: current.paymentRunId,
        decimalProposalId,
        signature,
        transactionIndex: current.transactionIndex,
        settlementVerification,
        settled,
      });
    }
    return row;
  });
  return serializeDecimalProposal(updated);
}

export async function createDecimalProposalApprovalIntent(
  organizationId: string,
  actorUserId: string,
  decimalProposalId: string,
  input: {
    memberPersonalWalletId: string;
    memo?: string | null;
  },
) {
  const proposal = await prisma.decimalProposal.findFirst({
    where: { organizationId, decimalProposalId },
  });
  if (!proposal || !proposal.treasuryWalletId || !proposal.transactionIndex) {
    throw notFound('Proposal not found');
  }
  const member = await loadActorPersonalWallet(actorUserId, input.memberPersonalWalletId);
  const { wallet, programId, multisigPda, multisigAccount } = await loadSquadsTreasury(organizationId, proposal.treasuryWalletId);
  assertOnchainMemberPermission(multisigAccount, member.walletAddress, 'vote');
  const transactionIndex = parseTransactionIndex(proposal.transactionIndex);
  const latestBlockhash = await runtime.getLatestBlockhash();
  const instruction = multisig.instructions.proposalApprove({
    multisigPda,
    transactionIndex,
    member: new PublicKey(member.walletAddress),
    memo: normalizeOptionalText(input.memo) ?? undefined,
    programId,
  });
  return buildSquadsSignableResponse({
    wallet,
    programId,
    multisigPda,
    transactionIndex,
    signerWalletAddress: member.walletAddress,
    latestBlockhash,
    instructions: [instruction],
    kind: 'proposal_approval',
    proposalType: proposal.proposalType,
    proposalCategory: proposal.proposalCategory,
    semanticType: 'approve_proposal',
    actions: [],
  });
}

async function verifySquadsProposalSettlement(
  proposal: Prisma.DecimalProposalGetPayload<Record<string, never>>,
  signature: string,
): Promise<SquadsSettlementVerification> {
  const expectedTransfers = extractExpectedUsdcSettlementTransfers(proposal.semanticType, proposal.semanticPayloadJson);
  if (!expectedTransfers) {
    return { status: 'not_applicable' };
  }
  try {
    const verification = await verifyUsdcSettlementFromSignature({
      signature,
      expectedTransfers,
    });
    return {
      status: verification.allSettled ? 'settled' : 'mismatch',
      signature: verification.signature,
      checkedAt: verification.checkedAt,
      items: verification.items,
    };
  } catch (error) {
    return {
      status: 'pending',
      signature,
      checkedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractExpectedUsdcSettlementTransfers(
  semanticType: string | null,
  semanticPayloadJson: Prisma.JsonValue,
): ExpectedUsdcSettlement[] | null {
  if (semanticType !== 'send_payment' && semanticType !== 'send_payment_run') {
    return null;
  }
  if (!isRecordLike(semanticPayloadJson)) {
    throw badRequest('Payment proposal is missing semantic payload for settlement verification.');
  }

  if (semanticType === 'send_payment') {
    const destinationWalletAddress = semanticPayloadJson.destinationWalletAddress;
    const destinationTokenAccountAddress = semanticPayloadJson.destinationTokenAccountAddress;
    const amountRaw = semanticPayloadJson.amountRaw;
    if (
      typeof destinationWalletAddress !== 'string'
      || typeof destinationTokenAccountAddress !== 'string'
      || (typeof amountRaw !== 'string' && typeof amountRaw !== 'number')
    ) {
      throw badRequest('Payment proposal semantic payload is incomplete for settlement verification.');
    }
    return [{
      destinationWalletAddress,
      destinationTokenAccountAddress,
      amountRaw: String(amountRaw),
    }];
  }

  const orders = semanticPayloadJson.orders;
  if (!Array.isArray(orders) || !orders.length) {
    throw badRequest('Payment run proposal semantic payload is missing order settlement expectations.');
  }
  return orders.map((item) => {
    if (!isRecordLike(item)) {
      throw badRequest('Payment run proposal contains an invalid order settlement expectation.');
    }
    const destinationWalletAddress = item.destinationWalletAddress;
    const destinationTokenAccountAddress = item.destinationTokenAccountAddress;
    const amountRaw = item.amountRaw;
    if (
      typeof destinationWalletAddress !== 'string'
      || typeof destinationTokenAccountAddress !== 'string'
      || (typeof amountRaw !== 'string' && typeof amountRaw !== 'number')
    ) {
      throw badRequest('Payment run proposal contains an incomplete order settlement expectation.');
    }
    return {
      destinationWalletAddress,
      destinationTokenAccountAddress,
      amountRaw: String(amountRaw),
    };
  });
}

export async function createDecimalProposalRejectIntent(
  organizationId: string,
  actorUserId: string,
  decimalProposalId: string,
  input: {
    memberPersonalWalletId: string;
    memo?: string | null;
  },
) {
  const proposal = await prisma.decimalProposal.findFirst({
    where: { organizationId, decimalProposalId },
  });
  if (!proposal || !proposal.treasuryWalletId || !proposal.transactionIndex) {
    throw notFound('Proposal not found');
  }
  const member = await loadActorPersonalWallet(actorUserId, input.memberPersonalWalletId);
  const { wallet, programId, multisigPda, multisigAccount } = await loadSquadsTreasury(organizationId, proposal.treasuryWalletId);
  assertOnchainMemberPermission(multisigAccount, member.walletAddress, 'vote');
  const transactionIndex = parseTransactionIndex(proposal.transactionIndex);
  const latestBlockhash = await runtime.getLatestBlockhash();
  const instruction = multisig.instructions.proposalReject({
    multisigPda,
    transactionIndex,
    member: new PublicKey(member.walletAddress),
    memo: normalizeOptionalText(input.memo) ?? undefined,
    programId,
  });
  return buildSquadsSignableResponse({
    wallet,
    programId,
    multisigPda,
    transactionIndex,
    signerWalletAddress: member.walletAddress,
    latestBlockhash,
    instructions: [instruction],
    kind: 'proposal_rejection',
    proposalType: proposal.proposalType,
    proposalCategory: proposal.proposalCategory,
    semanticType: 'reject_proposal',
    actions: [],
  });
}

export async function createDecimalProposalExecuteIntent(
  organizationId: string,
  actorUserId: string,
  decimalProposalId: string,
  input: { memberPersonalWalletId: string },
) {
  const proposal = await prisma.decimalProposal.findFirst({
    where: { organizationId, decimalProposalId },
  });
  if (!proposal || !proposal.treasuryWalletId || !proposal.transactionIndex) {
    throw notFound('Proposal not found');
  }
  const member = await loadActorPersonalWallet(actorUserId, input.memberPersonalWalletId);
  const { wallet, programId, multisigPda, multisigAccount } = await loadSquadsTreasury(organizationId, proposal.treasuryWalletId);
  assertOnchainMemberPermission(multisigAccount, member.walletAddress, 'execute');
  const transactionIndex = parseTransactionIndex(proposal.transactionIndex);
  const latestBlockhash = await runtime.getLatestBlockhash();
  if (proposal.proposalType === 'config_transaction') {
    const spendingLimits = await loadSpendingLimitPdasForConfigTransaction(
      programId,
      multisigPda,
      transactionIndex,
      ['add_spending_limit', 'remove_spending_limit', 'replace_spending_limit'].includes(proposal.semanticType ?? ''),
    );
    const instruction = multisig.instructions.configTransactionExecute({
      multisigPda,
      transactionIndex,
      member: new PublicKey(member.walletAddress),
      rentPayer: new PublicKey(member.walletAddress),
      spendingLimits,
      programId,
    });
    return buildSquadsSignableResponse({
      wallet,
      programId,
      multisigPda,
      transactionIndex,
      signerWalletAddress: member.walletAddress,
      latestBlockhash,
      instructions: [instruction],
      kind: 'proposal_execution',
      proposalType: proposal.proposalType,
      proposalCategory: proposal.proposalCategory,
      semanticType: 'execute_proposal',
      actions: [],
    });
  }

  if (proposal.proposalType !== 'vault_transaction') {
    throw badRequest(`Unsupported executable proposal type: ${proposal.proposalType}`);
  }
  const executable = await multisig.instructions.vaultTransactionExecute({
    connection: getSolanaConnection(),
    multisigPda,
    transactionIndex,
    member: new PublicKey(member.walletAddress),
    programId,
  });
  // For payment proposals, prepend a destination-ATA create instruction
  // payed by the executor. The vault inner transaction omits the ATA create
  // because the vault PDA holds tokens but no native SOL (createATA needs
  // ~0.00204 SOL of rent). The executor's wallet, which signs the wrapping
  // transaction, has SOL and pays the rent. The instruction is idempotent —
  // if the ATA already exists it's a no-op.
  const wrappingInstructions: TransactionInstruction[] = [];
  if (proposal.semanticType === 'send_payment') {
    const semantic = proposal.semanticPayloadJson as
      | { destinationWalletAddress?: string; destinationTokenAccountAddress?: string }
      | null;
    const destinationWalletAddress = semantic?.destinationWalletAddress;
    const destinationTokenAccountAddress = semantic?.destinationTokenAccountAddress;
    if (destinationWalletAddress && destinationTokenAccountAddress) {
      wrappingInstructions.push(
        buildDestinationAtaCreateInstruction({
          payer: member.walletAddress,
          destinationWallet: destinationWalletAddress,
          destinationTokenAccount: destinationTokenAccountAddress,
        }),
      );
    }
  }
  if (proposal.semanticType === 'send_payment_run') {
    const semantic = proposal.semanticPayloadJson as
      | { orders?: Array<{ destinationWalletAddress?: string; destinationTokenAccountAddress?: string }> }
      | null;
    const seenTokenAccounts = new Set<string>();
    for (const order of semantic?.orders ?? []) {
      const destinationWalletAddress = order.destinationWalletAddress;
      const destinationTokenAccountAddress = order.destinationTokenAccountAddress;
      if (!destinationWalletAddress || !destinationTokenAccountAddress || seenTokenAccounts.has(destinationTokenAccountAddress)) {
        continue;
      }
      seenTokenAccounts.add(destinationTokenAccountAddress);
      wrappingInstructions.push(
        buildDestinationAtaCreateInstruction({
          payer: member.walletAddress,
          destinationWallet: destinationWalletAddress,
          destinationTokenAccount: destinationTokenAccountAddress,
        }),
      );
    }
  }
  wrappingInstructions.push(executable.instruction);
  return buildSquadsSignableResponse({
    wallet,
    programId,
    multisigPda,
    transactionIndex,
    signerWalletAddress: member.walletAddress,
    latestBlockhash,
    instructions: wrappingInstructions,
    addressLookupTableAccounts: executable.lookupTableAccounts,
    kind: 'proposal_execution',
    proposalType: proposal.proposalType,
    proposalCategory: proposal.proposalCategory,
    semanticType: 'execute_proposal',
    actions: [],
  });
}

export async function syncSquadsTreasuryMembers(organizationId: string, treasuryWalletId: string) {
  const { wallet, programId, multisigPda, vaultPda, vaultIndex, multisigAccount } = await loadSquadsTreasury(organizationId, treasuryWalletId);
  const onchainMembers = serializeOnchainMembers(multisigAccount.members);
  const linkedMembers = await loadMembersByWalletAddresses(organizationId, onchainMembers.map((member) => member.walletAddress));
  const onchainMemberByAddress = new Map(onchainMembers.map((member) => [member.walletAddress, member]));
  const linkedPersonalMembers = linkedMembers.filter((member) => member.memberType === 'personal');
  const linkedMemberIds = new Set(linkedPersonalMembers.map((member) => member.personalWalletId));

  await prisma.$transaction(async (tx) => {
    for (const member of linkedPersonalMembers) {
      const onchainMember = onchainMemberByAddress.get(member.walletAddress);
      await tx.organizationWalletAuthorization.upsert({
        where: {
          organizationId_treasuryWalletId_userWalletId_role: {
            organizationId,
            treasuryWalletId,
            userWalletId: member.personalWalletId,
            role: 'squads_member',
          },
        },
        create: {
          organizationId,
          treasuryWalletId,
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

    await tx.organizationWalletAuthorization.updateMany({
      where: {
        organizationId,
        treasuryWalletId,
        role: 'squads_member',
        status: 'active',
        userWalletId: { notIn: [...linkedMemberIds] },
      },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
      },
    });

    await tx.treasuryWallet.update({
      where: { treasuryWalletId },
      data: {
        propertiesJson: mergeSquadsMetadata(wallet.propertiesJson, {
          programId: programId.toBase58(),
          multisigPda: multisigPda.toBase58(),
          vaultPda: vaultPda.toBase58(),
          vaultIndex,
          threshold: Number(multisigAccount.threshold),
          timeLockSeconds: Number(multisigAccount.timeLock),
          transactionIndex: multisigAccount.transactionIndex.toString(),
          staleTransactionIndex: multisigAccount.staleTransactionIndex.toString(),
          members: onchainMembers,
        }),
      },
    });
  });

  return getSquadsTreasuryDetail(organizationId, treasuryWalletId);
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
    throw badRequest('Every Squads member must be either an active Decimal personal wallet or an active Decimal agent wallet in this organization.');
  }

  const creatorWallet = linkedMembers.find((member) => member.memberType === 'personal' && member.userId === actorUserId);
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

    for (const member of linkedMembers.filter((linkedMember) => linkedMember.memberType === 'personal')) {
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

  const funding = await fundNewDevnetWalletIfConfigured(wallet.address)
    .catch((error) => {
      const reason = error instanceof Error ? error.message : 'devnet_funding_failed';
      logger.warn('devnet_funding.treasury_wallet_failed', {
        organizationId,
        treasuryWalletId: wallet.treasuryWalletId,
        walletAddress: wallet.address,
        reason,
      });
      return { status: 'skipped' as const, reason };
    });

  if (funding.status === 'funded' || funding.status === 'already_funded') {
    const updatedWallet = await prisma.treasuryWallet.update({
      where: { treasuryWalletId: wallet.treasuryWalletId },
      data: {
        propertiesJson: mergeSquadsMetadata(wallet.propertiesJson, {
          devnetFunding: funding as unknown as Prisma.InputJsonObject,
        }),
      },
    });
    return serializeSquadsTreasuryWallet(updatedWallet);
  }

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

export async function getSquadsTreasuryDetail(organizationId: string, treasuryWalletId: string) {
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
  const onchainMembers = serializeOnchainMembers(multisigAccount.members);
  const linkedMembers = await loadDetailedMembersByWalletAddresses(
    organizationId,
    treasuryWalletId,
    onchainMembers.map((member) => member.walletAddress),
  );

  return {
    treasuryWallet: serializeSquadsTreasuryWallet(wallet),
    squads: {
      provider: SQUADS_SOURCE,
      programId: programId.toBase58(),
      multisigPda: multisigPda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      vaultIndex,
      configAuthority: publicKeysEqual(multisigAccount.configAuthority, PublicKey.default)
        ? null
        : multisigAccount.configAuthority.toBase58(),
      isAutonomous: publicKeysEqual(multisigAccount.configAuthority, PublicKey.default),
      threshold: Number(multisigAccount.threshold),
      timeLockSeconds: Number(multisigAccount.timeLock),
      transactionIndex: multisigAccount.transactionIndex.toString(),
      staleTransactionIndex: multisigAccount.staleTransactionIndex.toString(),
      members: onchainMembers.map((member) => {
        const linked = linkedMembers.get(member.walletAddress);
        return {
          ...member,
          linkStatus: deriveMemberLinkStatus(linked),
          personalWallet: linked?.personalWallet ?? null,
          organizationMembership: linked?.organizationMembership ?? null,
          agentWallet: linked?.agentWallet ?? null,
          automationAgent: linked?.automationAgent ?? null,
          localAuthorization: linked?.localAuthorization ?? null,
        };
      }),
      capabilities: {
        canInitiate: onchainMembers.some((member) => member.permissions.includes('initiate')),
        canVote: onchainMembers.some((member) => member.permissions.includes('vote')),
        canExecute: onchainMembers.some((member) => member.permissions.includes('execute')),
        canCreateConfigProposals: true,
        canCreatePaymentProposals: true,
      },
      localStateMatchesChain:
        wallet.address === vaultPda.toBase58()
        && metadata?.multisigPda === multisigPda.toBase58()
        && metadata?.vaultPda === vaultPda.toBase58(),
    },
  };
}

async function createSquadsConfigProposalIntent(args: {
  organizationId: string;
  treasuryWalletId: string;
  actorUserId: string;
  creator: ActivePersonalWallet;
  actions: multisig.types.ConfigAction[];
  memo: string;
  semanticType: string;
  metadataJson?: Prisma.InputJsonValue;
}) {
  const { wallet, programId, multisigPda, multisigAccount } = await loadSquadsTreasury(args.organizationId, args.treasuryWalletId);
  if (args.creator.userId !== args.actorUserId) {
    throw badRequest('creatorPersonalWalletId must belong to the authenticated user.');
  }
  assertOnchainMemberPermission(multisigAccount, args.creator.walletAddress, 'initiate');
  validateConfigActionsAgainstCurrentMembers(multisigAccount, args.actions);

  const transactionIndex = BigInt(multisigAccount.transactionIndex.toString()) + 1n;
  const latestBlockhash = await runtime.getLatestBlockhash();
  const creatorPublicKey = new PublicKey(args.creator.walletAddress);
  const instructions = [
    multisig.instructions.configTransactionCreate({
      multisigPda,
      transactionIndex,
      creator: creatorPublicKey,
      rentPayer: creatorPublicKey,
      actions: args.actions,
      memo: args.memo,
      programId,
    }),
    multisig.instructions.proposalCreate({
      multisigPda,
      transactionIndex,
      creator: creatorPublicKey,
      rentPayer: creatorPublicKey,
      isDraft: false,
      programId,
    }),
  ];

  const response = buildSquadsSignableResponse({
    wallet,
    programId,
    multisigPda,
    transactionIndex,
    signerWalletAddress: args.creator.walletAddress,
    latestBlockhash,
    instructions,
    kind: 'config_proposal_create',
    proposalType: 'config_transaction',
    proposalCategory: 'configuration',
    semanticType: args.semanticType,
    actions: serializeConfigActions(args.actions),
  });

  const decimalProposal = await persistDecimalProposal({
    organizationId: args.organizationId,
    treasuryWalletId: args.treasuryWalletId,
    paymentOrderId: null,
    createdByUserId: args.actorUserId,
    creatorPersonalWalletId: args.creator.userWalletId,
    creatorWalletAddress: args.creator.walletAddress,
    requiredSigner: args.creator.walletAddress,
    proposalType: 'config_transaction',
    proposalCategory: 'configuration',
    semanticType: args.semanticType,
    status: 'prepared',
    response,
    vaultIndex: null,
    semanticPayload: { actions: serializeConfigActions(args.actions) },
    metadataJson: args.metadataJson ?? {},
  });

  return {
    ...response,
    decimalProposal,
  };
}

function buildSquadsSignableResponse(args: {
  wallet: {
    treasuryWalletId: string;
    organizationId: string;
    sourceRef: string | null;
  };
  programId: PublicKey;
  multisigPda: PublicKey;
  transactionIndex: bigint;
  signerWalletAddress: string;
  latestBlockhash: { blockhash: string; lastValidBlockHeight: number };
  instructions: TransactionInstruction[];
  addressLookupTableAccounts?: AddressLookupTableAccount[];
  kind: string;
  proposalType: string;
  proposalCategory: string;
  semanticType: string | null;
  actions: Array<Record<string, unknown>>;
}) {
  const [transactionPda] = multisig.getTransactionPda({
    multisigPda: args.multisigPda,
    index: args.transactionIndex,
    programId: args.programId,
  });
  const [proposalPda] = multisig.getProposalPda({
    multisigPda: args.multisigPda,
    transactionIndex: args.transactionIndex,
    programId: args.programId,
  });

  const message = new TransactionMessage({
    payerKey: new PublicKey(args.signerWalletAddress),
    recentBlockhash: args.latestBlockhash.blockhash,
    instructions: args.instructions,
  }).compileToV0Message(args.addressLookupTableAccounts);
  const transaction = new VersionedTransaction(message);

  return {
    intent: {
      provider: SQUADS_SOURCE,
      kind: args.kind,
      programId: args.programId.toBase58(),
      treasuryWalletId: args.wallet.treasuryWalletId,
      organizationId: args.wallet.organizationId,
      multisigPda: args.multisigPda.toBase58(),
      transactionIndex: args.transactionIndex.toString(),
      proposalType: args.proposalType,
      proposalCategory: args.proposalCategory,
      semanticType: args.semanticType,
      squadsTransactionPda: transactionPda.toBase58(),
      configTransactionPda: args.proposalType === 'config_transaction' ? transactionPda.toBase58() : null,
      vaultTransactionPda: args.proposalType === 'vault_transaction' ? transactionPda.toBase58() : null,
      proposalPda: proposalPda.toBase58(),
      actions: args.actions,
    },
    transaction: {
      encoding: 'base64',
      serializedTransaction: Buffer.from(transaction.serialize()).toString('base64'),
      requiredSigner: args.signerWalletAddress,
      recentBlockhash: args.latestBlockhash.blockhash,
      lastValidBlockHeight: args.latestBlockhash.lastValidBlockHeight,
    },
  };
}

const decimalProposalInclude = {
  treasuryWallet: {
    select: {
      treasuryWalletId: true,
      address: true,
      displayName: true,
      source: true,
      sourceRef: true,
    },
  },
  paymentOrder: {
    select: {
      paymentOrderId: true,
      state: true,
      amountRaw: true,
      asset: true,
      externalReference: true,
      invoiceNumber: true,
      counterpartyWallet: {
        select: {
          counterpartyWalletId: true,
          label: true,
          walletAddress: true,
          tokenAccountAddress: true,
        },
      },
    },
  },
  paymentRun: {
    select: {
      paymentRunId: true,
      runName: true,
      state: true,
      sourceTreasuryWalletId: true,
    },
  },
  createdByUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
      avatarUrl: true,
    },
  },
} satisfies Prisma.DecimalProposalInclude;

type DecimalProposalWithRelations = Prisma.DecimalProposalGetPayload<{ include: typeof decimalProposalInclude }>;

const spendingLimitPolicyInclude = {
  automationAgent: {
    select: {
      automationAgentId: true,
      name: true,
      agentType: true,
      status: true,
    },
  },
  agentWallet: {
    select: {
      agentWalletId: true,
      walletAddress: true,
      label: true,
      provider: true,
      status: true,
    },
  },
  treasuryWallet: {
    select: {
      treasuryWalletId: true,
      address: true,
      displayName: true,
      source: true,
      sourceRef: true,
    },
  },
  decimalProposal: {
    select: {
      decimalProposalId: true,
      status: true,
      transactionIndex: true,
      squadsProposalPda: true,
      submittedSignature: true,
      executedSignature: true,
    },
  },
  destinations: {
    include: {
      counterpartyWallet: {
        select: {
          counterpartyWalletId: true,
          label: true,
          walletAddress: true,
          tokenAccountAddress: true,
          trustState: true,
          isActive: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.SpendingLimitPolicyInclude;

type SpendingLimitPolicyWithRelations = Prisma.SpendingLimitPolicyGetPayload<{ include: typeof spendingLimitPolicyInclude }>;

function serializeSpendingLimitPolicy(row: SpendingLimitPolicyWithRelations) {
  return {
    spendingLimitPolicyId: row.spendingLimitPolicyId,
    organizationId: row.organizationId,
    treasuryWalletId: row.treasuryWalletId,
    automationAgentId: row.automationAgentId,
    agentWalletId: row.agentWalletId,
    decimalProposalId: row.decimalProposalId,
    policyName: row.policyName,
    policyCode: row.policyCode,
    asset: row.asset,
    mintAddress: row.mintAddress,
    amountRaw: row.amountRaw.toString(),
    period: row.period,
    vaultIndex: row.vaultIndex,
    createKey: row.createKey,
    spendingLimitPda: row.spendingLimitPda,
    destinationPolicy: row.destinationPolicy,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    metadataJson: row.metadataJson,
    automationAgent: row.automationAgent,
    agentWallet: row.agentWallet,
    treasuryWallet: row.treasuryWallet,
    decimalProposal: row.decimalProposal,
    destinations: row.destinations.map((destination) => ({
      spendingLimitPolicyDestinationId: destination.spendingLimitPolicyDestinationId,
      counterpartyWalletId: destination.counterpartyWalletId,
      walletAddress: destination.walletAddress,
      counterpartyWallet: destination.counterpartyWallet,
      createdAt: destination.createdAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadSpendingLimitPolicyForMutation(organizationId: string, spendingLimitPolicyId: string) {
  const policy = await prisma.spendingLimitPolicy.findFirst({
    where: { organizationId, spendingLimitPolicyId },
    include: spendingLimitPolicyInclude,
  });
  if (!policy) {
    throw notFound('Spending limit policy not found');
  }
  if (policy.treasuryWallet.source !== SQUADS_SOURCE || !policy.treasuryWallet.sourceRef) {
    throw badRequest('Spending limit policy is not attached to a programmable treasury.');
  }
  return policy;
}

function resolveSyncedSpendingLimitStatus(currentStatus: string, accountExists: boolean) {
  if (accountExists) {
    if (['revocation_proposed', 'replacement_proposed'].includes(currentStatus)) {
      return currentStatus;
    }
    return ['revoked', 'removed'].includes(currentStatus) ? currentStatus : 'active';
  }
  if (['active', 'revocation_proposed', 'replacement_proposed'].includes(currentStatus)) {
    return 'revoked';
  }
  return currentStatus;
}

async function persistDecimalProposal(args: {
  organizationId: string;
  treasuryWalletId: string | null;
  paymentOrderId: string | null;
  paymentRunId?: string | null;
  createdByUserId: string | null;
  creatorPersonalWalletId: string | null;
  creatorWalletAddress: string | null;
  requiredSigner: string | null;
  proposalType: string;
  proposalCategory: string;
  semanticType: string | null;
  status: string;
  response: ReturnType<typeof buildSquadsSignableResponse>;
  vaultIndex: number | null;
  semanticPayload: Prisma.InputJsonValue;
  metadataJson: Prisma.InputJsonValue;
}) {
  const intent = args.response.intent;
  const row = await prisma.decimalProposal.upsert({
    where: {
      organizationId_provider_squadsMultisigPda_transactionIndex: {
        organizationId: args.organizationId,
        provider: SQUADS_SOURCE,
        squadsMultisigPda: intent.multisigPda,
        transactionIndex: intent.transactionIndex,
      },
    },
    create: {
      organizationId: args.organizationId,
      treasuryWalletId: args.treasuryWalletId,
      paymentOrderId: args.paymentOrderId,
      paymentRunId: args.paymentRunId ?? null,
      provider: SQUADS_SOURCE,
      proposalType: args.proposalType,
      proposalCategory: args.proposalCategory,
      semanticType: args.semanticType,
      status: args.status,
      squadsProgramId: intent.programId,
      squadsMultisigPda: intent.multisigPda,
      squadsProposalPda: intent.proposalPda,
      squadsTransactionPda: intent.squadsTransactionPda,
      transactionIndex: intent.transactionIndex,
      vaultIndex: args.vaultIndex,
      requiredSigner: args.requiredSigner,
      creatorPersonalWalletId: args.creatorPersonalWalletId,
      creatorWalletAddress: args.creatorWalletAddress,
      intentJson: intent as Prisma.InputJsonValue,
      semanticPayloadJson: args.semanticPayload,
      metadataJson: args.metadataJson,
      createdByUserId: args.createdByUserId,
    },
    update: {
      treasuryWalletId: args.treasuryWalletId,
      paymentOrderId: args.paymentOrderId,
      paymentRunId: args.paymentRunId ?? null,
      proposalType: args.proposalType,
      proposalCategory: args.proposalCategory,
      semanticType: args.semanticType,
      squadsProgramId: intent.programId,
      squadsProposalPda: intent.proposalPda,
      squadsTransactionPda: intent.squadsTransactionPda,
      vaultIndex: args.vaultIndex,
      requiredSigner: args.requiredSigner,
      creatorPersonalWalletId: args.creatorPersonalWalletId,
      creatorWalletAddress: args.creatorWalletAddress,
      intentJson: intent as Prisma.InputJsonValue,
      semanticPayloadJson: args.semanticPayload,
      metadataJson: args.metadataJson,
    },
    include: decimalProposalInclude,
  });

  return serializeDecimalProposal(row);
}

async function serializeDecimalProposal(row: DecimalProposalWithRelations) {
  const live = await loadLiveProposalState(row);
  return {
    decimalProposalId: row.decimalProposalId,
    organizationId: row.organizationId,
    treasuryWalletId: row.treasuryWalletId,
    paymentOrderId: row.paymentOrderId,
    paymentRunId: row.paymentRunId,
    provider: row.provider,
    proposalType: row.proposalType,
    proposalCategory: row.proposalCategory,
    semanticType: row.semanticType,
    status: live?.status ?? row.status,
    localStatus: row.status,
    squads: {
      programId: row.squadsProgramId,
      multisigPda: row.squadsMultisigPda,
      proposalPda: row.squadsProposalPda,
      transactionPda: row.squadsTransactionPda,
      batchPda: row.squadsBatchPda,
      transactionIndex: row.transactionIndex,
      vaultIndex: row.vaultIndex,
    },
    voting: live?.voting ?? null,
    requiredSigner: row.requiredSigner,
    creatorPersonalWalletId: row.creatorPersonalWalletId,
    creatorWalletAddress: row.creatorWalletAddress,
    submittedSignature: row.submittedSignature,
    executedSignature: row.executedSignature,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
    intentJson: row.intentJson,
    semanticPayloadJson: row.semanticPayloadJson,
    metadataJson: row.metadataJson,
    treasuryWallet: row.treasuryWallet,
    paymentRun: row.paymentRun,
    paymentOrder: row.paymentOrder
      ? {
        ...row.paymentOrder,
        amountRaw: row.paymentOrder.amountRaw.toString(),
      }
      : null,
    createdByUser: row.createdByUser,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadLiveProposalState(row: DecimalProposalWithRelations) {
  if (!row.squadsProposalPda || !row.treasuryWalletId) {
    return null;
  }
  const proposal = await runtime.loadProposal(new PublicKey(row.squadsProposalPda));
  if (!proposal) {
    return null;
  }
  const { multisigAccount } = await loadSquadsTreasury(row.organizationId, row.treasuryWalletId);
  const approvals = addressesFromPublicKeys(proposal.approved);
  const rejections = addressesFromPublicKeys(proposal.rejected);
  const cancellations = addressesFromPublicKeys(proposal.cancelled);
  const voterMembers = multisigAccount.members
    .filter((member) => (member.permissions.mask & SQUADS_PERMISSION_MAP.vote) === SQUADS_PERMISSION_MAP.vote)
    .map((member) => ({
      walletAddress: member.key.toBase58(),
      permissions: permissionNamesFromMask(member.permissions.mask),
    }));
  const decidedVoters = new Set([...approvals, ...rejections]);
  const pendingVoters = voterMembers.filter((member) => !decidedVoters.has(member.walletAddress));
  const executeMembers = multisigAccount.members
    .filter((member) => (member.permissions.mask & SQUADS_PERMISSION_MAP.execute) === SQUADS_PERMISSION_MAP.execute)
    .map((member) => member.key.toBase58());
  const linkedMembers = await loadDetailedMembersByWalletAddresses(
    row.organizationId,
    row.treasuryWalletId,
    uniqueStrings([
      ...approvals,
      ...rejections,
      ...cancellations,
      ...pendingVoters.map((member) => member.walletAddress),
      ...executeMembers,
    ]),
  );
  return {
    status: normalizeProposalStatus(proposal.status),
    voting: {
      threshold: Number(multisigAccount.threshold),
      approvals: approvals.map((walletAddress) => serializeProposalDecision(walletAddress, linkedMembers)),
      rejections: rejections.map((walletAddress) => serializeProposalDecision(walletAddress, linkedMembers)),
      cancellations: cancellations.map((walletAddress) => serializeProposalDecision(walletAddress, linkedMembers)),
      pendingVoters: pendingVoters.map((member) => ({
        walletAddress: member.walletAddress,
        permissions: member.permissions,
        ...serializeProposalMemberLink(member.walletAddress, linkedMembers),
      })),
      canExecuteWalletAddresses: executeMembers,
    },
  };
}

function statusFilterWhere(status: 'pending' | 'closed') {
  if (status === 'closed') {
    return { status: { in: ['executed', 'cancelled', 'rejected'] } };
  }
  return { status: { notIn: ['executed', 'cancelled', 'rejected'] } };
}

async function loadSquadsConfigProposal(
  organizationId: string,
  treasuryWalletId: string,
  programId: PublicKey,
  multisigPda: PublicKey,
  multisigAccount: SquadsMultisigAccountLike,
  transactionIndex: bigint,
) {
  const [configTransactionPda] = multisig.getTransactionPda({
    multisigPda,
    index: transactionIndex,
    programId,
  });
  const [proposalPda] = multisig.getProposalPda({
    multisigPda,
    transactionIndex,
    programId,
  });
  const [proposal, configTransaction] = await Promise.all([
    runtime.loadProposal(proposalPda),
    runtime.loadConfigTransaction(configTransactionPda),
  ]);
  if (!proposal || !configTransaction) {
    return null;
  }

  const approvals = addressesFromPublicKeys(proposal.approved);
  const rejections = addressesFromPublicKeys(proposal.rejected);
  const cancellations = addressesFromPublicKeys(proposal.cancelled);
  const voterMembers = multisigAccount.members
    .filter((member) => (member.permissions.mask & SQUADS_PERMISSION_MAP.vote) === SQUADS_PERMISSION_MAP.vote)
    .map((member) => ({
      walletAddress: member.key.toBase58(),
      permissions: permissionNamesFromMask(member.permissions.mask),
    }));
  const decidedVoters = new Set([...approvals, ...rejections]);
  const pendingVoters = voterMembers.filter((member) => !decidedVoters.has(member.walletAddress));
  const executeMembers = multisigAccount.members
    .filter((member) => (member.permissions.mask & SQUADS_PERMISSION_MAP.execute) === SQUADS_PERMISSION_MAP.execute)
    .map((member) => member.key.toBase58());
  const allLinkedAddresses = uniqueStrings([
    ...approvals,
    ...rejections,
    ...cancellations,
    ...pendingVoters.map((member) => member.walletAddress),
    ...executeMembers,
    ...configTransaction.actions.flatMap(configActionWalletAddresses),
  ]);
  const linkedMembers = await loadDetailedMembersByWalletAddresses(organizationId, treasuryWalletId, allLinkedAddresses);

  return {
    transactionIndex: transactionIndex.toString(),
    configTransactionPda: configTransactionPda.toBase58(),
    proposalPda: proposalPda.toBase58(),
    status: normalizeProposalStatus(proposal.status),
    threshold: Number(multisigAccount.threshold),
    staleTransactionIndex: multisigAccount.staleTransactionIndex.toString(),
    actions: serializeConfigActions(configTransaction.actions),
    approvals: approvals.map((walletAddress) => serializeProposalDecision(walletAddress, linkedMembers)),
    rejections: rejections.map((walletAddress) => serializeProposalDecision(walletAddress, linkedMembers)),
    cancellations: cancellations.map((walletAddress) => serializeProposalDecision(walletAddress, linkedMembers)),
    pendingVoters: pendingVoters.map((member) => ({
      walletAddress: member.walletAddress,
      permissions: member.permissions,
      ...serializeProposalMemberLink(member.walletAddress, linkedMembers),
    })),
    canExecuteWalletAddresses: executeMembers,
    createdAtSlot: null,
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

function normalizePermissionNames(permissions: SquadsPermissionName[]) {
  const normalized = [...new Set(permissions)];
  if (!normalized.length) {
    throw badRequest('Every Squads member requires at least one permission.');
  }
  for (const permission of normalized) {
    if (!(permission in SQUADS_PERMISSION_MAP)) {
      throw badRequest(`Unsupported Squads permission: ${permission}`);
    }
  }
  return normalized;
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

function normalizePositiveBigInt(value: string | bigint, fieldName: string) {
  try {
    const normalized = typeof value === 'bigint' ? value : BigInt(value);
    if (normalized <= 0n) {
      throw new Error('not positive');
    }
    return normalized;
  } catch {
    throw badRequest(`${fieldName} must be a positive integer string.`);
  }
}

function normalizeSpendingLimitPeriod(period: SquadsSpendingLimitPeriod) {
  switch (period) {
    case 'one_time':
      return multisig.types.Period.OneTime;
    case 'day':
      return multisig.types.Period.Day;
    case 'week':
      return multisig.types.Period.Week;
    case 'month':
      return multisig.types.Period.Month;
    default:
      throw badRequest(`Unsupported spending limit period: ${period}`);
  }
}

function spendingLimitPeriodName(period: multisig.types.Period) {
  switch (period) {
    case multisig.types.Period.OneTime:
      return 'one_time';
    case multisig.types.Period.Day:
      return 'day';
    case multisig.types.Period.Week:
      return 'week';
    case multisig.types.Period.Month:
      return 'month';
    default:
      return String(period);
  }
}

function normalizeRequiredText(value: string, fieldName: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw badRequest(`${fieldName} is required.`);
  }
  return normalized;
}

type ActivePersonalWallet = Awaited<ReturnType<typeof loadActorPersonalWallet>>;
type ValidatedPersonalTreasuryMember = {
  memberType: 'personal';
  personalWalletId: string;
  walletAddress: string;
  userId: string;
  membershipId: string;
  permissions: SquadsPermissionName[];
};
type ValidatedAgentTreasuryMember = {
  memberType: 'agent';
  agentWalletId: string;
  automationAgentId: string;
  walletAddress: string;
  label: string | null;
  permissions: SquadsPermissionName[];
};
type ValidatedTreasuryMember = ValidatedPersonalTreasuryMember | ValidatedAgentTreasuryMember;

async function loadActorPersonalWallet(actorUserId: string, personalWalletId: string) {
  const wallet = await prisma.personalWallet.findFirst({
    where: {
      userWalletId: personalWalletId,
      userId: actorUserId,
      status: 'active',
      chain: SOLANA_CHAIN,
    },
  });
  if (!wallet) {
    throw badRequest('Personal wallet must belong to the authenticated user.');
  }
  return wallet;
}

async function loadOrganizationPersonalWallet(organizationId: string, personalWalletId: string) {
  const wallet = await prisma.personalWallet.findFirst({
    where: {
      userWalletId: personalWalletId,
      status: 'active',
      chain: SOLANA_CHAIN,
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
          memberships: {
            where: { organizationId, status: 'active' },
            select: { membershipId: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!wallet) {
    throw badRequest('newMemberPersonalWalletId must be an active personal wallet owned by an active organization member.');
  }
  return wallet;
}

async function loadOrganizationAgentWallet(organizationId: string, agentWalletId: string) {
  const wallet = await prisma.agentWallet.findFirst({
    where: {
      organizationId,
      agentWalletId,
      status: 'active',
      chain: SOLANA_CHAIN,
    },
    include: {
      automationAgent: {
        select: {
          automationAgentId: true,
          name: true,
          status: true,
        },
      },
    },
  });
  if (!wallet || wallet.automationAgent.status !== 'active') {
    throw badRequest('agentWalletId must be an active automation wallet in this organization.');
  }
  return wallet;
}

async function loadDefaultAgentTreasuryMember(organizationId: string): Promise<ValidatedAgentTreasuryMember | null> {
  const existing = await findDefaultAgentWallet(organizationId);
  if (existing) {
    return serializeAgentTreasuryMember(existing);
  }

  const provisioning = await ensureDefaultAutomationAgentWithWallet(organizationId)
    .catch((error) => {
      logger.warn('squads_treasury.default_agent_provisioning_failed', {
        organizationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  if (!provisioning?.wallet) {
    return null;
  }

  return {
    memberType: 'agent',
    agentWalletId: provisioning.wallet.agentWalletId,
    automationAgentId: provisioning.wallet.automationAgentId,
    walletAddress: provisioning.wallet.walletAddress,
    label: provisioning.wallet.label,
    permissions: ['initiate'],
  };
}

async function findDefaultAgentWallet(organizationId: string) {
  return prisma.agentWallet.findFirst({
    where: {
      organizationId,
      status: 'active',
      chain: SOLANA_CHAIN,
      automationAgent: {
        status: 'active',
        OR: [
          { agentType: 'decimal_operations' },
          { name: 'Decimal operations agent' },
        ],
      },
    },
    include: {
      automationAgent: {
        select: {
          automationAgentId: true,
          name: true,
          status: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

function appendAgentTreasuryMember(
  personalMembers: ValidatedPersonalTreasuryMember[],
  agentMember: ValidatedAgentTreasuryMember | null,
): ValidatedTreasuryMember[] {
  if (!agentMember) {
    return personalMembers;
  }
  if (personalMembers.some((member) => member.walletAddress === agentMember.walletAddress)) {
    return personalMembers;
  }
  return [...personalMembers, agentMember];
}

function serializeAgentTreasuryMember(wallet: Awaited<ReturnType<typeof findDefaultAgentWallet>>): ValidatedAgentTreasuryMember | null {
  if (!wallet) {
    return null;
  }
  return {
    memberType: 'agent',
    agentWalletId: wallet.agentWalletId,
    automationAgentId: wallet.automationAgentId,
    walletAddress: wallet.walletAddress,
    label: wallet.label,
    permissions: ['initiate'],
  };
}

function toSquadsMember(member: ValidatedTreasuryMember) {
  return {
    key: new PublicKey(member.walletAddress),
    permissions: multisig.types.Permissions.fromPermissions(
      member.permissions.map((permission) => SQUADS_PERMISSION_MAP[permission]),
    ),
  };
}

function serializeTreasuryCreateIntentMember(member: ValidatedTreasuryMember) {
  if (member.memberType === 'agent') {
    return {
      memberType: 'agent',
      agentWalletId: member.agentWalletId,
      automationAgentId: member.automationAgentId,
      walletAddress: member.walletAddress,
      label: member.label,
      permissions: member.permissions,
    };
  }
  return {
    memberType: 'personal',
    personalWalletId: member.personalWalletId,
    walletAddress: member.walletAddress,
    userId: member.userId,
    membershipId: member.membershipId,
    permissions: member.permissions,
  };
}

async function loadTrustedSpendingLimitDestinations(organizationId: string, counterpartyWalletIds: string[]) {
  const uniqueIds = uniqueStrings(counterpartyWalletIds);
  if (!uniqueIds.length) {
    throw badRequest('counterpartyWalletIds must include at least one destination.');
  }
  const wallets = await prisma.counterpartyWallet.findMany({
    where: {
      organizationId,
      counterpartyWalletId: { in: uniqueIds },
      isActive: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (wallets.length !== uniqueIds.length) {
    throw badRequest('Every spending-limit destination must be an active counterparty wallet in this organization.');
  }
  const untrusted = wallets.find((wallet) => wallet.trustState !== 'trusted');
  if (untrusted) {
    throw badRequest('Spending-limit destinations must be trusted before they can be delegated to an agent.', {
      counterpartyWalletId: untrusted.counterpartyWalletId,
      trustState: untrusted.trustState,
    });
  }
  return wallets;
}

async function loadPaymentOrderForSquadsProposal(organizationId: string, paymentOrderId: string) {
  const paymentOrder = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    include: {
      counterpartyWallet: true,
      transferRequests: {
        orderBy: { requestedAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!paymentOrder) {
    throw notFound('Payment order not found');
  }
  if (paymentOrder.state === 'cancelled' || paymentOrder.state === 'closed') {
    throw badRequest(`Payment order is ${paymentOrder.state}.`);
  }
  return paymentOrder;
}

async function loadPaymentRunForSquadsProposal(organizationId: string, paymentRunId: string) {
  const paymentRun = await prisma.paymentRun.findFirst({
    where: { organizationId, paymentRunId },
    include: {
      paymentOrders: {
        where: { state: { not: 'cancelled' } },
        include: {
          counterpartyWallet: true,
          transferRequests: {
            orderBy: { requestedAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!paymentRun) {
    throw notFound('Payment run not found');
  }
  if (paymentRun.state === 'cancelled' || paymentRun.state === 'closed') {
    throw badRequest(`Payment run is ${paymentRun.state}.`);
  }
  return paymentRun;
}

async function findActiveSquadsPaymentProposal(organizationId: string, paymentOrderId: string) {
  return prisma.decimalProposal.findFirst({
    where: {
      organizationId,
      paymentOrderId,
      provider: SQUADS_SOURCE,
      semanticType: 'send_payment',
      status: { notIn: ['rejected', 'cancelled', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function findActiveSquadsPaymentRunProposal(organizationId: string, paymentRunId: string) {
  return prisma.decimalProposal.findFirst({
    where: {
      organizationId,
      paymentRunId,
      provider: SQUADS_SOURCE,
      semanticType: 'send_payment_run',
      status: { notIn: ['rejected', 'cancelled', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function verifyRpcSignatureConfirmed(signature: string, purpose: string) {
  if (config.nodeEnv === 'test') {
    return;
  }
  if (!isSolanaSignatureLike(signature)) {
    throw badRequest('Invalid Solana transaction signature.', { signature, purpose });
  }

  let visible: Awaited<ReturnType<typeof waitForSignatureVisible>>;
  try {
    visible = await waitForSignatureVisible(getSolanaConnection(), signature, {
      timeoutMs: 20_000,
      pollIntervalMs: 1_000,
    });
  } catch (error) {
    throw badRequest('Transaction failed on-chain.', {
      signature,
      purpose,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!visible.confirmed) {
    throw badRequest('Transaction signature is not confirmed yet. Retry confirmation after the transaction lands.', {
      signature,
      purpose,
      seen: visible.seen,
    });
  }
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
      memberType: 'personal' as const,
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
  };
}

async function loadMembersByWalletAddresses(organizationId: string, walletAddresses: string[]) {
  const uniqueWalletAddresses = uniqueStrings(walletAddresses);
  const [personalWallets, agentWallets] = await Promise.all([
    prisma.personalWallet.findMany({
      where: {
        chain: SOLANA_CHAIN,
        walletAddress: { in: uniqueWalletAddresses },
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
    }),
    prisma.agentWallet.findMany({
      where: {
        organizationId,
        chain: SOLANA_CHAIN,
        walletAddress: { in: uniqueWalletAddresses },
        status: 'active',
        automationAgent: {
          status: 'active',
        },
      },
      include: {
        automationAgent: {
          select: {
            automationAgentId: true,
            name: true,
            agentType: true,
            status: true,
          },
        },
      },
    }),
  ]);

  const personalMembers = personalWallets
    .filter((wallet) => wallet.user.memberships[0])
    .map((wallet) => ({
      memberType: 'personal' as const,
      personalWalletId: wallet.userWalletId,
      walletAddress: wallet.walletAddress,
      userId: wallet.userId,
      membershipId: wallet.user.memberships[0]!.membershipId,
    }));

  const personalWalletAddresses = new Set(personalMembers.map((member) => member.walletAddress));
  const agentMembers = agentWallets
    .filter((wallet) => !personalWalletAddresses.has(wallet.walletAddress))
    .map((wallet) => ({
      memberType: 'agent' as const,
      agentWalletId: wallet.agentWalletId,
      automationAgentId: wallet.automationAgentId,
      walletAddress: wallet.walletAddress,
      label: wallet.label,
      automationAgent: wallet.automationAgent,
    }));

  return [...personalMembers, ...agentMembers];
}

type DetailedSquadsMemberLink = {
  memberType: 'personal' | 'agent';
  walletStatus: string;
  membershipStatus: string | null;
  authorizationStatus: string | null;
  personalWallet: {
    userWalletId: string;
    userId: string;
    chain: string;
    walletAddress: string;
    walletType: string;
    provider: string | null;
    label: string | null;
    status: string;
    verifiedAt: string | null;
    lastUsedAt: string | null;
  } | null;
  organizationMembership: {
    membershipId: string;
    role: string;
    status: string;
    createdAt: string;
    user: {
      userId: string;
      email: string;
      displayName: string;
      avatarUrl: string | null;
    };
  } | null;
  localAuthorization: {
    walletAuthorizationId: string;
    role: string;
    scope: string;
    status: string;
    revokedAt: string | null;
    metadataJson: Prisma.JsonValue;
    createdAt: string;
  } | null;
  agentWallet: {
    agentWalletId: string;
    automationAgentId: string;
    chain: string;
    walletAddress: string;
    walletType: string;
    provider: string;
    label: string | null;
    status: string;
    verifiedAt: string | null;
    lastUsedAt: string | null;
  } | null;
  automationAgent: {
    automationAgentId: string;
    name: string;
    agentType: string;
    status: string;
  } | null;
};

async function loadDetailedMembersByWalletAddresses(
  organizationId: string,
  treasuryWalletId: string,
  walletAddresses: string[],
) {
  const uniqueWalletAddresses = uniqueStrings(walletAddresses);
  const [wallets, agentWallets] = await Promise.all([
    prisma.personalWallet.findMany({
      where: {
        chain: SOLANA_CHAIN,
        walletAddress: { in: uniqueWalletAddresses },
      },
      include: {
        user: {
          select: {
            userId: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            memberships: {
              where: { organizationId },
              select: {
                membershipId: true,
                role: true,
                status: true,
                createdAt: true,
              },
              take: 1,
            },
          },
        },
        walletAuthorizations: {
          where: {
            organizationId,
            treasuryWalletId,
            role: 'squads_member',
          },
          select: {
            walletAuthorizationId: true,
            role: true,
            scope: true,
            status: true,
            revokedAt: true,
            metadataJson: true,
            createdAt: true,
          },
          take: 1,
        },
      },
    }),
    prisma.agentWallet.findMany({
      where: {
        organizationId,
        chain: SOLANA_CHAIN,
        walletAddress: { in: uniqueWalletAddresses },
      },
      include: {
        automationAgent: {
          select: {
            automationAgentId: true,
            name: true,
            agentType: true,
            status: true,
          },
        },
      },
    }),
  ]);

  const linked = new Map<string, DetailedSquadsMemberLink>(wallets.map((wallet) => {
    const membership = wallet.user.memberships[0] ?? null;
    const authorization = wallet.walletAuthorizations[0] ?? null;
    return [
      wallet.walletAddress,
      {
        memberType: 'personal' as const,
        walletStatus: wallet.status,
        membershipStatus: membership?.status ?? null,
        authorizationStatus: authorization?.status ?? null,
        personalWallet: {
          userWalletId: wallet.userWalletId,
          userId: wallet.userId,
          chain: wallet.chain,
          walletAddress: wallet.walletAddress,
          walletType: wallet.walletType,
          provider: wallet.provider,
          label: wallet.label,
          status: wallet.status,
          verifiedAt: wallet.verifiedAt?.toISOString() ?? null,
          lastUsedAt: wallet.lastUsedAt?.toISOString() ?? null,
        },
        organizationMembership: membership
          ? {
            membershipId: membership.membershipId,
            role: membership.role,
            status: membership.status,
            createdAt: membership.createdAt.toISOString(),
            user: {
              userId: wallet.user.userId,
              email: wallet.user.email,
              displayName: wallet.user.displayName,
              avatarUrl: wallet.user.avatarUrl,
            },
          }
          : null,
        localAuthorization: authorization
          ? {
            walletAuthorizationId: authorization.walletAuthorizationId,
            role: authorization.role,
            scope: authorization.scope,
            status: authorization.status,
            revokedAt: authorization.revokedAt?.toISOString() ?? null,
            metadataJson: authorization.metadataJson,
            createdAt: authorization.createdAt.toISOString(),
          }
          : null,
        agentWallet: null,
        automationAgent: null,
      },
    ] satisfies [string, DetailedSquadsMemberLink];
  }));

  for (const wallet of agentWallets) {
    if (linked.has(wallet.walletAddress)) {
      continue;
    }
    linked.set(wallet.walletAddress, {
      memberType: 'agent' as const,
      walletStatus: wallet.status,
      membershipStatus: wallet.automationAgent.status,
      authorizationStatus: 'active',
      personalWallet: null,
      organizationMembership: null,
      localAuthorization: null,
      agentWallet: {
        agentWalletId: wallet.agentWalletId,
        automationAgentId: wallet.automationAgentId,
        chain: wallet.chain,
        walletAddress: wallet.walletAddress,
        walletType: wallet.walletType,
        provider: wallet.provider,
        label: wallet.label,
        status: wallet.status,
        verifiedAt: wallet.verifiedAt?.toISOString() ?? null,
        lastUsedAt: wallet.lastUsedAt?.toISOString() ?? null,
      },
      automationAgent: wallet.automationAgent,
    });
  }

  return linked;
}

async function loadSquadsTreasury(organizationId: string, treasuryWalletId: string) {
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

  return {
    wallet,
    programId,
    multisigPda,
    vaultPda,
    vaultIndex,
    multisigAccount,
  };
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

function assertOnchainMemberPermission(
  multisigAccount: SquadsMultisigAccountLike,
  walletAddress: string,
  permission: SquadsPermissionName,
) {
  const member = multisigAccount.members.find((item) => item.key.toBase58() === walletAddress);
  if (!member) {
    throw badRequest('Personal wallet is not an onchain member of this Squads treasury.');
  }
  const mask = member.permissions.mask;
  const required = SQUADS_PERMISSION_MAP[permission];
  if ((mask & required) !== required) {
    throw badRequest(`Personal wallet does not have Squads ${permission} permission.`);
  }
}

async function assertActorIsSquadsMember(
  organizationId: string,
  multisigAccount: SquadsMultisigAccountLike,
  actorUserId: string,
) {
  const actorWallets = await prisma.personalWallet.findMany({
    where: {
      userId: actorUserId,
      status: 'active',
      chain: SOLANA_CHAIN,
      user: {
        memberships: {
          some: {
            organizationId,
            status: 'active',
          },
        },
      },
    },
    select: {
      walletAddress: true,
    },
  });
  const actorWalletAddresses = new Set(actorWallets.map((wallet) => wallet.walletAddress));
  const memberAddresses = multisigAccount.members.map((member) => member.key.toBase58());
  const visibleMemberAddresses = memberAddresses.filter((walletAddress) => actorWalletAddresses.has(walletAddress));
  if (!visibleMemberAddresses.length) {
    throw new ApiError(403, 'not_squads_member', "You're not a member of this Squads treasury.");
  }
  return { memberAddresses: visibleMemberAddresses };
}

function validateConfigActionsAgainstCurrentMembers(
  multisigAccount: SquadsMultisigAccountLike,
  actions: multisig.types.ConfigAction[],
) {
  const members = new Map(multisigAccount.members.map((member) => [member.key.toBase58(), member.permissions.mask]));
  let threshold = Number(multisigAccount.threshold);

  for (const action of actions) {
    if (multisig.types.isConfigActionAddMember(action)) {
      const walletAddress = action.newMember.key.toBase58();
      if (members.has(walletAddress)) {
        throw badRequest('New member is already an onchain member of this Squads treasury.');
      }
      members.set(walletAddress, action.newMember.permissions.mask);
    } else if (multisig.types.isConfigActionRemoveMember(action)) {
      const walletAddress = action.oldMember.toBase58();
      if (!members.has(walletAddress)) {
        throw badRequest('Removed member is not an onchain member of this Squads treasury.');
      }
      members.delete(walletAddress);
    } else if (multisig.types.isConfigActionChangeThreshold(action)) {
      threshold = normalizeThreshold(action.newThreshold);
    } else if (multisig.types.isConfigActionAddSpendingLimit(action)) {
      if (BigInt(action.amount.toString()) <= 0n) {
        throw badRequest('Spending limit amount must be positive.');
      }
      if (!action.members.length) {
        throw badRequest('Spending limit must include at least one member.');
      }
      for (const member of action.members) {
        const walletAddress = member.toBase58();
        if (!members.has(walletAddress)) {
          throw badRequest('Spending limit member must already be an onchain Squads member.', {
            walletAddress,
          });
        }
      }
      if (!action.destinations.length) {
        throw badRequest('Spending limit must include at least one destination.');
      }
    }
  }

  if (!members.size) {
    throw badRequest('Config proposal would leave the Squads treasury without members.');
  }
  const masks = [...members.values()];
  const voterCount = masks.filter((mask) => (mask & SQUADS_PERMISSION_MAP.vote) === SQUADS_PERMISSION_MAP.vote).length;
  if (threshold > voterCount) {
    throw badRequest('Config proposal threshold cannot exceed the resulting number of voting members.');
  }
  for (const permission of ['initiate', 'vote', 'execute'] as const) {
    if (!masks.some((mask) => (mask & SQUADS_PERMISSION_MAP[permission]) === SQUADS_PERMISSION_MAP[permission])) {
      throw badRequest(`Config proposal would leave the Squads treasury without a member with ${permission} permission.`);
    }
  }
}

function serializeConfigActions(actions: multisig.types.ConfigAction[]) {
  return actions.map((action) => {
    if (multisig.types.isConfigActionAddMember(action)) {
      return {
        kind: 'add_member',
        walletAddress: action.newMember.key.toBase58(),
        permissionsMask: action.newMember.permissions.mask,
        permissions: permissionNamesFromMask(action.newMember.permissions.mask),
      };
    }
    if (multisig.types.isConfigActionRemoveMember(action)) {
      return {
        kind: 'remove_member',
        walletAddress: action.oldMember.toBase58(),
      };
    }
    if (multisig.types.isConfigActionChangeThreshold(action)) {
      return {
        kind: 'change_threshold',
        newThreshold: action.newThreshold,
      };
    }
    if (multisig.types.isConfigActionAddSpendingLimit(action)) {
      return {
        kind: 'add_spending_limit',
        createKey: action.createKey.toBase58(),
        vaultIndex: action.vaultIndex,
        mintAddress: action.mint.toBase58(),
        amountRaw: action.amount.toString(),
        period: spendingLimitPeriodName(action.period),
        members: addressesFromPublicKeys(action.members),
        destinations: addressesFromPublicKeys(action.destinations),
      };
    }
    if (multisig.types.isConfigActionRemoveSpendingLimit(action)) {
      return {
        kind: 'remove_spending_limit',
        spendingLimitPda: action.spendingLimit.toBase58(),
      };
    }
    return {
      kind: action.__kind,
    };
  });
}

function configActionWalletAddresses(action: multisig.types.ConfigAction) {
  if (multisig.types.isConfigActionAddMember(action)) {
    return [action.newMember.key.toBase58()];
  }
  if (multisig.types.isConfigActionRemoveMember(action)) {
    return [action.oldMember.toBase58()];
  }
  if (multisig.types.isConfigActionAddSpendingLimit(action)) {
    return [
      ...addressesFromPublicKeys(action.members),
      ...addressesFromPublicKeys(action.destinations),
    ];
  }
  return [];
}

async function loadSpendingLimitPdasForConfigTransaction(
  programId: PublicKey,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  requireLoaded = false,
) {
  const [configTransactionPda] = multisig.getTransactionPda({
    multisigPda,
    index: transactionIndex,
    programId,
  });
  const configTransaction = await runtime.loadConfigTransaction(configTransactionPda);
  if (!configTransaction) {
    if (requireLoaded) {
      throw badRequest('Config transaction is not available yet. Retry after the proposal creation transaction lands.');
    }
    return undefined;
  }

  const spendingLimits = spendingLimitPdasForConfigActions(programId, multisigPda, configTransaction.actions);
  return spendingLimits.length ? spendingLimits : undefined;
}

function spendingLimitPdasForConfigActions(
  programId: PublicKey,
  multisigPda: PublicKey,
  actions: multisig.types.ConfigAction[],
) {
  const spendingLimits: PublicKey[] = [];
  for (const action of actions) {
    if (multisig.types.isConfigActionAddSpendingLimit(action)) {
      const [spendingLimitPda] = multisig.getSpendingLimitPda({
        multisigPda,
        createKey: action.createKey,
        programId,
      });
      spendingLimits.push(spendingLimitPda);
      continue;
    }
    if (multisig.types.isConfigActionRemoveSpendingLimit(action)) {
      spendingLimits.push(action.spendingLimit);
    }
  }
  return uniquePublicKeys(spendingLimits);
}

function addressesFromPublicKeys(values: PublicKey[]) {
  return values.map((value) => value.toBase58());
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function uniquePublicKeys(values: PublicKey[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toBase58();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

type DetailedSquadsMemberMap = Awaited<ReturnType<typeof loadDetailedMembersByWalletAddresses>>;

function serializeProposalDecision(walletAddress: string, linkedMembers: DetailedSquadsMemberMap) {
  return {
    walletAddress,
    decidedAtSlot: null,
    ...serializeProposalMemberLink(walletAddress, linkedMembers),
  };
}

function serializeProposalMemberLink(walletAddress: string, linkedMembers: DetailedSquadsMemberMap) {
  const linked = linkedMembers.get(walletAddress);
  return {
    personalWallet: linked?.personalWallet
      ? {
        userWalletId: linked.personalWallet.userWalletId,
        userId: linked.personalWallet.userId,
        label: linked.personalWallet.label,
      }
      : null,
    organizationMembership: linked?.organizationMembership
      ? {
        membershipId: linked.organizationMembership.membershipId,
        role: linked.organizationMembership.role,
        user: linked.organizationMembership.user,
      }
      : null,
    agentWallet: linked?.agentWallet
      ? {
        agentWalletId: linked.agentWallet.agentWalletId,
        automationAgentId: linked.agentWallet.automationAgentId,
        label: linked.agentWallet.label,
      }
      : null,
    automationAgent: linked?.automationAgent ?? null,
  };
}

function normalizeProposalStatus(status: { __kind: string }) {
  switch (status.__kind) {
    case 'Draft':
      return 'draft';
    case 'Active':
      return 'active';
    case 'Approved':
      return 'approved';
    case 'Executed':
      return 'executed';
    case 'Cancelled':
      return 'cancelled';
    case 'Rejected':
      return 'rejected';
    case 'Executing':
      return 'approved';
    default:
      return status.__kind.toLowerCase();
  }
}

function matchesProposalStatusFilter(status: string, filter: 'pending' | 'all' | 'closed') {
  if (filter === 'all') {
    return true;
  }
  const isClosed = status === 'executed' || status === 'cancelled' || status === 'rejected';
  return filter === 'closed' ? isClosed : !isClosed && status !== 'draft';
}

function deriveMemberLinkStatus(linked: {
  walletStatus: string;
  membershipStatus: string | null;
  authorizationStatus: string | null;
} | undefined) {
  if (!linked) {
    return 'unlinked';
  }
  if (linked.walletStatus !== 'active') {
    return 'wallet_inactive';
  }
  if (linked.membershipStatus !== 'active') {
    return 'not_org_member';
  }
  if (linked.authorizationStatus !== 'active') {
    return 'authorization_missing';
  }
  return 'linked';
}

function parseTransactionIndex(value: string) {
  if (!/^\d+$/.test(value)) {
    throw badRequest('transactionIndex must be a non-negative integer string.');
  }
  return BigInt(value);
}

function mergeSquadsMetadata(value: unknown, nextSquads: Prisma.InputJsonObject): Prisma.InputJsonObject {
  const base = isRecordLike(value) ? ({ ...value } as Prisma.InputJsonObject) : {};
  const previousSquads = isRecordLike(base.squads) ? ({ ...base.squads } as Prisma.InputJsonObject) : {};
  return {
    ...base,
    squads: {
      ...previousSquads,
      ...nextSquads,
    },
  } satisfies Prisma.InputJsonObject;
}

function isMissingSquadsAccountError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  // Squads SDK's fromAccountAddress throws "Unable to find <Account> account
  // at <pda>" when the account doesn't exist on chain. Other RPC providers
  // return shapes like "Account not found" or "could not find account" or
  // "no account info". Match all of them so loadProposal /
  // loadConfigTransaction / loadVaultTransaction can return null instead of
  // propagating the raw error — important during proposal creation, where
  // the serializer calls loadLiveProposalState immediately after persisting
  // the row but BEFORE the create transaction has actually landed on chain.
  return /account.*not.*found|could not find account|no account info|unable to find .* account/i.test(error.message);
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
