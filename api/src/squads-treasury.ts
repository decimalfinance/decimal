import type { Prisma } from '@prisma/client';
import * as multisig from '@sqds/multisig';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type TransactionInstruction } from '@solana/web3.js';
import { ApiError, badRequest, conflict, notFound } from './api-errors.js';
import { config } from './config.js';
import { prisma } from './prisma.js';
import { submitPaymentOrder } from './payment-orders.js';
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
  waitForSignatureVisible,
} from './solana.js';
import { createTransferRequestEvent } from './transfer-request-events.js';

const SQUADS_SOURCE = 'squads_v4';
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

type SquadsTreasuryRuntime = {
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getProgramTreasury: (programId: PublicKey) => Promise<PublicKey>;
  loadMultisig: (multisigPda: PublicKey) => Promise<SquadsMultisigAccountLike>;
  loadProposal: (proposalPda: PublicKey) => Promise<SquadsProposalAccountLike | null>;
  loadConfigTransaction: (configTransactionPda: PublicKey) => Promise<SquadsConfigTransactionAccountLike | null>;
  loadVaultTransaction: (vaultTransactionPda: PublicKey) => Promise<SquadsVaultTransactionAccountLike | null>;
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

export type CreateSquadsChangeThresholdProposalInput = {
  creatorPersonalWalletId: string;
  newThreshold: number;
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

export async function createSquadsPaymentProposalIntent(
  organizationId: string,
  treasuryWalletId: string,
  actorUserId: string,
  input: CreateSquadsPaymentProposalInput,
) {
  const creator = await loadActorPersonalWallet(actorUserId, input.creatorPersonalWalletId);
  const { wallet, programId, multisigPda, vaultPda, vaultIndex, multisigAccount } = await loadSquadsTreasury(organizationId, treasuryWalletId);
  if (creator.userId !== actorUserId) {
    throw badRequest('creatorPersonalWalletId must belong to the authenticated user.');
  }
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
      actorUserId,
      actorType: 'user',
      actorId: actorUserId,
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
  const destinationTokenAccount = paymentOrder.destination.tokenAccountAddress
    ?? deriveUsdcAtaForWallet(paymentOrder.destination.walletAddress);
  // Skip the destination ATA-create here. It can't run inside the vault
  // inner transaction because the vault PDA pays no rent (no native SOL).
  // The wrapping vaultTransactionExecute will prepend a paid-by-executor
  // ATA-create instead. See createDecimalProposalExecuteIntent below.
  const transferInstructions = buildUsdcTransferTransactionInstructions({
    sourceWallet: vaultPda.toBase58(),
    sourceTokenAccount,
    destinationWallet: paymentOrder.destination.walletAddress,
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
    destinationId: paymentOrder.destinationId,
    destinationWalletAddress: paymentOrder.destination.walletAddress,
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
      destinationWalletAddress: paymentOrder.destination.walletAddress,
      destinationTokenAccountAddress: destinationTokenAccount,
      paymentOrderId: paymentOrder.paymentOrderId,
    }],
  });

  const decimalProposal = await persistDecimalProposal({
    organizationId,
    treasuryWalletId,
    paymentOrderId: paymentOrder.paymentOrderId,
    createdByUserId: actorUserId,
    creatorPersonalWalletId: creator.userWalletId,
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
    },
  });
  await markPaymentOrderSquadsProposalPrepared({
    paymentOrderId: paymentOrder.paymentOrderId,
    organizationId,
    actorUserId,
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
      if (order.destination.walletAddress === wallet.address) {
        throw badRequest(`Source treasury cannot be the same as destination "${order.destination.label}".`);
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
    const destinationTokenAccount = order.destination.tokenAccountAddress
      ?? deriveUsdcAtaForWallet(order.destination.walletAddress);
    const transferInstructions = buildUsdcTransferTransactionInstructions({
      sourceWallet: vaultPda.toBase58(),
      sourceTokenAccount,
      destinationWallet: order.destination.walletAddress,
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
      destinationId: item.paymentOrder.destinationId,
      destinationWalletAddress: item.paymentOrder.destination.walletAddress,
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
      destinationWalletAddress: item.paymentOrder.destination.walletAddress,
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
  const instruction = multisig.instructions.configTransactionExecute({
    multisigPda,
    transactionIndex,
    member: new PublicKey(member.walletAddress),
    rentPayer: new PublicKey(member.walletAddress),
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
  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.decimalProposal.findFirstOrThrow({
      where: { organizationId, decimalProposalId },
    });
    const row = await tx.decimalProposal.update({
      where: { decimalProposalId },
      data: {
        submittedSignature: signature,
        submittedAt: new Date(),
        status: current.status === 'executed' ? 'executed' : 'submitted',
      },
      include: decimalProposalInclude,
    });
    if (current.semanticType === 'send_payment' && current.paymentOrderId) {
      await markPaymentOrderSquadsProposalSubmitted(tx, {
        organizationId,
        actorUserId,
        paymentOrderId: current.paymentOrderId,
        decimalProposalId,
        beforeState: null,
        signature,
        transactionIndex: current.transactionIndex,
      });
    }
    if (current.semanticType === 'send_payment_run' && current.paymentRunId) {
      await markPaymentRunSquadsProposalSubmitted(tx, {
        organizationId,
        actorUserId,
        paymentRunId: current.paymentRunId,
        decimalProposalId,
        signature,
        transactionIndex: current.transactionIndex,
      });
    }
    return row;
  });
  return serializeDecimalProposal(updated);
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
  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.decimalProposal.findFirstOrThrow({
      where: { organizationId, decimalProposalId },
    });
    const row = await tx.decimalProposal.update({
      where: { decimalProposalId },
      data: {
        executedSignature: signature,
        executedAt: new Date(),
        status: 'executed',
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
    const instruction = multisig.instructions.configTransactionExecute({
      multisigPda,
      transactionIndex,
      member: new PublicKey(member.walletAddress),
      rentPayer: new PublicKey(member.walletAddress),
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
  const linkedMemberIds = new Set(linkedMembers.map((member) => member.personalWalletId));

  await prisma.$transaction(async (tx) => {
    for (const member of linkedMembers) {
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
    metadataJson: {},
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
      destination: {
        select: {
          destinationId: true,
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

type ActivePersonalWallet = Awaited<ReturnType<typeof loadActorPersonalWallet>>;

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

async function loadPaymentOrderForSquadsProposal(organizationId: string, paymentOrderId: string) {
  const paymentOrder = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    include: {
      destination: true,
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
          destination: true,
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

async function markPaymentOrderSquadsProposalPrepared(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  beforeState: string;
  transferRequestId: string;
  decimalProposalId: string;
  transactionIndex: string;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.paymentOrder.update({
      where: { paymentOrderId: args.paymentOrderId },
      data: { state: 'ready' },
    });
    await tx.paymentOrderEvent.create({
      data: {
        paymentOrderId: args.paymentOrderId,
        organizationId: args.organizationId,
        eventType: 'squads_payment_proposal_prepared',
        actorType: 'user',
        actorId: args.actorUserId,
        beforeState: args.beforeState,
        afterState: 'ready',
        linkedTransferRequestId: args.transferRequestId,
        payloadJson: {
          decimalProposalId: args.decimalProposalId,
          transactionIndex: args.transactionIndex,
          provider: SQUADS_SOURCE,
        },
      },
    });
  });
}

async function markPaymentRunSquadsProposalPrepared(args: {
  organizationId: string;
  paymentRunId: string;
  actorUserId: string;
  decimalProposalId: string;
  transactionIndex: string;
  items: Array<{
    paymentOrderId: string;
    beforeState: string;
    transferRequestId: string;
  }>;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.paymentRun.update({
      where: { paymentRunId: args.paymentRunId },
      data: { state: 'ready' },
    });
    for (const item of args.items) {
      await tx.paymentOrder.update({
        where: { paymentOrderId: item.paymentOrderId },
        data: { state: 'ready' },
      });
      await tx.paymentOrderEvent.create({
        data: {
          paymentOrderId: item.paymentOrderId,
          organizationId: args.organizationId,
          eventType: 'squads_payment_run_proposal_prepared',
          actorType: 'user',
          actorId: args.actorUserId,
          beforeState: item.beforeState,
          afterState: 'ready',
          linkedTransferRequestId: item.transferRequestId,
          payloadJson: {
            paymentRunId: args.paymentRunId,
            decimalProposalId: args.decimalProposalId,
            transactionIndex: args.transactionIndex,
            provider: SQUADS_SOURCE,
          },
        },
      });
    }
  });
}

async function markPaymentOrderSquadsProposalSubmitted(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    paymentOrderId: string;
    actorUserId: string;
    decimalProposalId: string;
    beforeState: string | null;
    signature: string;
    transactionIndex: string | null;
  },
) {
  const paymentOrder = await tx.paymentOrder.findFirst({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    select: { state: true },
  });
  if (!paymentOrder) {
    return;
  }
  await tx.paymentOrder.update({
    where: { paymentOrderId: args.paymentOrderId },
    data: { state: 'proposed' },
  });
  await tx.paymentOrderEvent.create({
    data: {
      paymentOrderId: args.paymentOrderId,
      organizationId: args.organizationId,
      eventType: 'squads_payment_proposal_submitted',
      actorType: 'user',
      actorId: args.actorUserId,
      beforeState: args.beforeState ?? paymentOrder.state,
      afterState: 'proposed',
      linkedSignature: args.signature,
      payloadJson: {
        decimalProposalId: args.decimalProposalId,
        transactionIndex: args.transactionIndex,
        provider: SQUADS_SOURCE,
      },
    },
  });
}

async function markPaymentRunSquadsProposalSubmitted(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    paymentRunId: string;
    actorUserId: string;
    decimalProposalId: string;
    signature: string;
    transactionIndex: string | null;
  },
) {
  const paymentRun = await tx.paymentRun.findFirst({
    where: { organizationId: args.organizationId, paymentRunId: args.paymentRunId },
    include: {
      paymentOrders: {
        where: { state: { not: 'cancelled' } },
        include: {
          transferRequests: {
            orderBy: { requestedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });
  if (!paymentRun) {
    return;
  }

  await tx.paymentRun.update({
    where: { paymentRunId: args.paymentRunId },
    data: { state: 'proposed' },
  });
  for (const order of paymentRun.paymentOrders) {
    await tx.paymentOrder.update({
      where: { paymentOrderId: order.paymentOrderId },
      data: { state: 'proposed' },
    });
    await tx.paymentOrderEvent.create({
      data: {
        paymentOrderId: order.paymentOrderId,
        organizationId: args.organizationId,
        eventType: 'squads_payment_run_proposal_submitted',
        actorType: 'user',
        actorId: args.actorUserId,
        beforeState: order.state,
        afterState: 'proposed',
        linkedTransferRequestId: order.transferRequests[0]?.transferRequestId ?? null,
        linkedSignature: args.signature,
        payloadJson: {
          paymentRunId: args.paymentRunId,
          decimalProposalId: args.decimalProposalId,
          transactionIndex: args.transactionIndex,
          provider: SQUADS_SOURCE,
        },
      },
    });
  }
}

async function markPaymentOrderSquadsProposalExecuted(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    paymentOrderId: string;
    actorUserId: string;
    decimalProposalId: string;
    signature: string;
    transactionIndex: string | null;
    metadataJson: Prisma.JsonValue;
  },
) {
  const paymentOrder = await tx.paymentOrder.findFirst({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    select: { state: true },
  });
  if (!paymentOrder) {
    return;
  }

  const transferRequestIdFromMetadata = isRecordLike(args.metadataJson) && typeof args.metadataJson.transferRequestId === 'string'
    ? args.metadataJson.transferRequestId
    : null;
  const transferRequest = transferRequestIdFromMetadata
    ? await tx.transferRequest.findFirst({
        where: {
          organizationId: args.organizationId,
          paymentOrderId: args.paymentOrderId,
          transferRequestId: transferRequestIdFromMetadata,
        },
      })
    : await tx.transferRequest.findFirst({
        where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
        orderBy: { requestedAt: 'desc' },
      });

  let executionRecordId: string | null = null;
  if (transferRequest) {
    await tx.transferRequest.update({
      where: { transferRequestId: transferRequest.transferRequestId },
      data: { status: 'submitted_onchain' },
    });
    const existingRecord = await tx.executionRecord.findFirst({
      where: {
        transferRequestId: transferRequest.transferRequestId,
        submittedSignature: args.signature,
      },
    });
    const executionRecord = existingRecord ?? await tx.executionRecord.create({
      data: {
        transferRequestId: transferRequest.transferRequestId,
        organizationId: args.organizationId,
        submittedSignature: args.signature,
        executionSource: SQUADS_SOURCE,
        executorUserId: args.actorUserId,
        state: 'submitted_onchain',
        submittedAt: new Date(),
        metadataJson: {
          paymentOrderId: args.paymentOrderId,
          decimalProposalId: args.decimalProposalId,
          transactionIndex: args.transactionIndex,
          provider: SQUADS_SOURCE,
        },
      },
    });
    executionRecordId = executionRecord.executionRecordId;
    await createTransferRequestEvent(tx, {
      transferRequestId: transferRequest.transferRequestId,
      organizationId: args.organizationId,
      eventType: 'squads_payment_proposal_executed',
      actorType: 'user',
      actorId: args.actorUserId,
      eventSource: 'user',
      beforeState: transferRequest.status,
      afterState: 'submitted_onchain',
      linkedSignature: args.signature,
      payloadJson: {
        paymentOrderId: args.paymentOrderId,
        decimalProposalId: args.decimalProposalId,
        executionRecordId,
        transactionIndex: args.transactionIndex,
        provider: SQUADS_SOURCE,
      },
    });
  }

  await tx.paymentOrder.update({
    where: { paymentOrderId: args.paymentOrderId },
    data: { state: 'executed' },
  });
  await tx.paymentOrderEvent.create({
    data: {
      paymentOrderId: args.paymentOrderId,
      organizationId: args.organizationId,
      eventType: 'squads_payment_proposal_executed',
      actorType: 'user',
      actorId: args.actorUserId,
      beforeState: paymentOrder.state,
      afterState: 'executed',
      linkedTransferRequestId: transferRequest?.transferRequestId ?? null,
      linkedExecutionRecordId: executionRecordId,
      linkedSignature: args.signature,
      payloadJson: {
        decimalProposalId: args.decimalProposalId,
        transactionIndex: args.transactionIndex,
        provider: SQUADS_SOURCE,
      },
    },
  });
}

async function markPaymentRunSquadsProposalExecuted(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    paymentRunId: string;
    actorUserId: string;
    decimalProposalId: string;
    signature: string;
    transactionIndex: string | null;
  },
) {
  const paymentRun = await tx.paymentRun.findFirst({
    where: { organizationId: args.organizationId, paymentRunId: args.paymentRunId },
    include: {
      paymentOrders: {
        where: { state: { not: 'cancelled' } },
        include: {
          transferRequests: {
            orderBy: { requestedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });
  if (!paymentRun) {
    return;
  }

  await tx.paymentRun.update({
    where: { paymentRunId: args.paymentRunId },
    data: { state: 'executed' },
  });

  for (const order of paymentRun.paymentOrders) {
    const transferRequest = order.transferRequests[0] ?? null;
    let executionRecordId: string | null = null;
    if (transferRequest) {
      const beforeStatus = transferRequest.status;
      await tx.transferRequest.update({
        where: { transferRequestId: transferRequest.transferRequestId },
        data: { status: 'submitted_onchain' },
      });
      const existingRecord = await tx.executionRecord.findFirst({
        where: {
          transferRequestId: transferRequest.transferRequestId,
          submittedSignature: args.signature,
        },
      });
      const executionRecord = existingRecord ?? await tx.executionRecord.create({
        data: {
          transferRequestId: transferRequest.transferRequestId,
          organizationId: args.organizationId,
          submittedSignature: args.signature,
          executionSource: SQUADS_SOURCE,
          executorUserId: args.actorUserId,
          state: 'submitted_onchain',
          submittedAt: new Date(),
          metadataJson: {
            paymentRunId: args.paymentRunId,
            paymentOrderId: order.paymentOrderId,
            decimalProposalId: args.decimalProposalId,
            transactionIndex: args.transactionIndex,
            provider: SQUADS_SOURCE,
          },
        },
      });
      executionRecordId = executionRecord.executionRecordId;
      await createTransferRequestEvent(tx, {
        transferRequestId: transferRequest.transferRequestId,
        organizationId: args.organizationId,
        eventType: 'squads_payment_run_proposal_executed',
        actorType: 'user',
        actorId: args.actorUserId,
        eventSource: 'user',
        beforeState: beforeStatus,
        afterState: 'submitted_onchain',
        linkedSignature: args.signature,
        payloadJson: {
          paymentRunId: args.paymentRunId,
          paymentOrderId: order.paymentOrderId,
          decimalProposalId: args.decimalProposalId,
          executionRecordId,
          transactionIndex: args.transactionIndex,
          provider: SQUADS_SOURCE,
        },
      });
    }

    await tx.paymentOrder.update({
      where: { paymentOrderId: order.paymentOrderId },
      data: { state: 'executed' },
    });
    await tx.paymentOrderEvent.create({
      data: {
        paymentOrderId: order.paymentOrderId,
        organizationId: args.organizationId,
        eventType: 'squads_payment_run_proposal_executed',
        actorType: 'user',
        actorId: args.actorUserId,
        beforeState: order.state,
        afterState: 'executed',
        linkedTransferRequestId: transferRequest?.transferRequestId ?? null,
        linkedExecutionRecordId: executionRecordId,
        linkedSignature: args.signature,
        payloadJson: {
          paymentRunId: args.paymentRunId,
          decimalProposalId: args.decimalProposalId,
          transactionIndex: args.transactionIndex,
          provider: SQUADS_SOURCE,
        },
      },
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

async function loadDetailedMembersByWalletAddresses(
  organizationId: string,
  treasuryWalletId: string,
  walletAddresses: string[],
) {
  const wallets = await prisma.personalWallet.findMany({
    where: {
      chain: SOLANA_CHAIN,
      walletAddress: { in: walletAddresses },
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
  });

  return new Map(wallets.map((wallet) => {
    const membership = wallet.user.memberships[0] ?? null;
    const authorization = wallet.walletAuthorizations[0] ?? null;
    return [
      wallet.walletAddress,
      {
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
      },
    ];
  }));
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
  return [];
}

function addressesFromPublicKeys(values: PublicKey[]) {
  return values.map((value) => value.toBase58());
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
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

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
