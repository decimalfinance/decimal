import { Prisma } from '@prisma/client';
import * as multisig from '@sqds/multisig';
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { badRequest, conflict, notFound } from '../infra/api-errors.js';
import { prisma } from '../infra/prisma.js';
import { ensurePaymentOrderAuditRequest } from '../payments/orders.js';
import {
  buildDestinationAtaCreateInstruction,
  deriveUsdcAtaForWallet,
  getSolanaConnection,
  USDC_ASSET,
  USDC_DECIMALS,
  USDC_MINT,
  verifyUsdcSettlementFromSignature,
  waitForSignatureVisible,
} from '../solana.js';
import { config } from '../config.js';
import { signPrivySolanaTransaction } from '../wallets/personal.js';
import { SQUADS_SOURCE, isRecordLike } from '../squads/shared.js';

type SpendingLimitExecutionRuntime = {
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  signTransaction: typeof signPrivySolanaTransaction;
  sendRawTransaction: (rawTransaction: Buffer) => Promise<string>;
  waitForSignature: (signature: string) => Promise<{ confirmed: boolean; seen: boolean }>;
  verifySettlement: typeof verifyUsdcSettlementFromSignature;
  loadSpendingLimit: (spendingLimitPda: PublicKey) => Promise<{
    amount: { toString(): string };
    remainingAmount: { toString(): string };
    members: PublicKey[];
    destinations: PublicKey[];
  } | null>;
};

const defaultRuntime: SpendingLimitExecutionRuntime = {
  getLatestBlockhash: () => getSolanaConnection().getLatestBlockhash(),
  signTransaction: signPrivySolanaTransaction,
  sendRawTransaction: (rawTransaction) => getSolanaConnection().sendRawTransaction(rawTransaction),
  waitForSignature: (signature) => waitForSignatureVisible(getSolanaConnection(), signature, {
    timeoutMs: 20_000,
    pollIntervalMs: 1_000,
  }),
  verifySettlement: verifyUsdcSettlementFromSignature,
  loadSpendingLimit: async (spendingLimitPda) => {
    try {
      return await multisig.accounts.SpendingLimit.fromAccountAddress(getSolanaConnection(), spendingLimitPda);
    } catch (error) {
      if (error instanceof Error && /account.*not.*found|unable to find .* account|no account info/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  },
};

let runtime: SpendingLimitExecutionRuntime = defaultRuntime;

export function setSpendingLimitExecutionRuntimeForTests(nextRuntime: Partial<SpendingLimitExecutionRuntime> | null) {
  runtime = nextRuntime ? { ...defaultRuntime, ...nextRuntime } : defaultRuntime;
}

/**
 * Read the live on-chain remaining amount for a spending limit's current period.
 * Returns null when the on-chain account does not exist yet (for example, the config
 * proposal has not executed/synced). Other RPC errors propagate to the caller.
 *
 * Used by the routing fit-check so a payment that exceeds the remaining period budget
 * falls back to a Squads proposal instead of hard-failing at execution time.
 */
export async function loadOnchainSpendingLimitRemaining(spendingLimitPda: string): Promise<bigint | null> {
  const account = await runtime.loadSpendingLimit(new PublicKey(spendingLimitPda));
  if (!account) {
    return null;
  }
  return BigInt(account.remainingAmount.toString());
}

const spendingLimitExecutionInclude = {
  spendingLimitPolicy: {
    select: {
      spendingLimitPolicyId: true,
      policyName: true,
      policyCode: true,
      status: true,
      amountRaw: true,
      period: true,
      spendingLimitPda: true,
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
      status: true,
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
    },
  },
  counterpartyWallet: {
    select: {
      counterpartyWalletId: true,
      walletAddress: true,
      label: true,
      trustState: true,
    },
  },
} satisfies Prisma.SpendingLimitExecutionInclude;

type SpendingLimitExecutionWithRelations = Prisma.SpendingLimitExecutionGetPayload<{
  include: typeof spendingLimitExecutionInclude;
}>;

export async function listSpendingLimitExecutions(
  organizationId: string,
  input: {
    spendingLimitPolicyId?: string;
    treasuryWalletId?: string;
    automationAgentId?: string;
    agentWalletId?: string;
    paymentOrderId?: string;
    status?: string;
    limit?: number;
  } = {},
) {
  const executions = await prisma.spendingLimitExecution.findMany({
    where: {
      organizationId,
      ...(input.spendingLimitPolicyId ? { spendingLimitPolicyId: input.spendingLimitPolicyId } : {}),
      ...(input.treasuryWalletId ? { treasuryWalletId: input.treasuryWalletId } : {}),
      ...(input.automationAgentId ? { automationAgentId: input.automationAgentId } : {}),
      ...(input.agentWalletId ? { agentWalletId: input.agentWalletId } : {}),
      ...(input.paymentOrderId ? { paymentOrderId: input.paymentOrderId } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    include: spendingLimitExecutionInclude,
    orderBy: { createdAt: 'desc' },
    take: input.limit ?? 100,
  });
  return { items: executions.map(serializeSpendingLimitExecution) };
}

export async function executePaymentOrderWithSpendingLimit(
  organizationId: string,
  actorUserId: string,
  paymentOrderId: string,
  input: { spendingLimitPolicyId: string; memo?: string | null },
) {
  let paymentOrder = await loadPaymentOrder(organizationId, paymentOrderId);
  const policy = await loadPolicy(organizationId, input.spendingLimitPolicyId);
  if (policy.status !== 'active') {
    throw badRequest('Spending limit policy is not active. Execute and sync the Squads config proposal first.');
  }
  if (paymentOrder.sourceTreasuryWalletId && paymentOrder.sourceTreasuryWalletId !== policy.treasuryWalletId) {
    throw badRequest('Payment order source treasury does not match spending limit treasury.');
  }
  if (!paymentOrder.sourceTreasuryWalletId) {
    await prisma.paymentOrder.update({
      where: { paymentOrderId: paymentOrder.paymentOrderId },
      data: { sourceTreasuryWalletId: policy.treasuryWalletId },
    });
    paymentOrder = await loadPaymentOrder(organizationId, paymentOrderId);
  }
  if (paymentOrder.asset.toLowerCase() !== USDC_ASSET) {
    throw badRequest('Spending-limit execution currently supports USDC payment orders only.');
  }
  if (paymentOrder.amountRaw > policy.amountRaw) {
    throw badRequest('Payment amount exceeds the configured spending limit amount.');
  }
  const destination = policy.destinations.find((candidate) => candidate.counterpartyWalletId === paymentOrder.counterpartyWalletId);
  if (!destination) {
    throw badRequest('Payment destination is not allowlisted on this spending limit policy.');
  }
  if (!policy.agentWallet.providerWalletId) {
    throw badRequest('Agent wallet is missing a provider wallet id and cannot sign.');
  }

  const account = await runtime.loadSpendingLimit(new PublicKey(policy.spendingLimitPda));
  if (!account) {
    throw badRequest('Onchain spending limit account is not available yet. Sync after the config proposal executes.');
  }
  if (!account.members.some((member) => member.toBase58() === policy.agentWallet.walletAddress)) {
    throw badRequest('Agent wallet is not an onchain member of this spending limit.');
  }
  if (!account.destinations.some((member) => member.toBase58() === destination.walletAddress)) {
    throw badRequest('Destination is not present on the onchain spending limit.');
  }
  const remainingAmount = BigInt(account.remainingAmount.toString());
  if (paymentOrder.amountRaw > remainingAmount) {
    throw badRequest('Payment amount exceeds the remaining onchain spending limit for the current period.');
  }

  const existing = await prisma.spendingLimitExecution.findFirst({
    where: {
      organizationId,
      paymentOrderId,
      status: { in: ['prepared', 'submitted', 'settled', 'mismatch'] },
    },
  });
  if (existing) {
    throw conflict('Payment order already has a spending-limit execution.', {
      spendingLimitExecutionId: existing.spendingLimitExecutionId,
      status: existing.status,
      signature: existing.signature,
    });
  }

  if (!paymentOrder.transferRequests.length && paymentOrder.state === 'draft') {
    await ensurePaymentOrderAuditRequest({
      organizationId,
      paymentOrderId,
      actorUserId,
      actorType: 'user',
      actorId: actorUserId,
    });
    paymentOrder = await loadPaymentOrder(organizationId, paymentOrderId);
  }
  const transferRequest = paymentOrder.transferRequests[0] ?? null;
  if (!transferRequest) {
    throw badRequest('Submit the payment order before agent execution.');
  }
  if (!['approved', 'ready_for_execution', 'submitted_onchain'].includes(transferRequest.status)) {
    throw badRequest(`Payment order cannot be executed while transfer request is ${transferRequest.status}.`);
  }

  // Reservation / double-pay guard. Claim this payment order with a 'prepared' row BEFORE
  // any on-chain send. A racing concurrent advance hits the unique partial index
  // (uq_spending_limit_executions_active_payment_order) on this insert and is rejected
  // here, so a second payment is never sent.
  const now = new Date();
  const reservation = await prisma.spendingLimitExecution
    .create({
      data: {
        organizationId,
        spendingLimitPolicyId: policy.spendingLimitPolicyId,
        treasuryWalletId: policy.treasuryWalletId,
        automationAgentId: policy.automationAgentId,
        agentWalletId: policy.agentWalletId,
        paymentOrderId: paymentOrder.paymentOrderId,
        counterpartyWalletId: paymentOrder.counterpartyWalletId,
        amountRaw: paymentOrder.amountRaw,
        asset: paymentOrder.asset,
        destinationWalletAddress: paymentOrder.counterpartyWallet.walletAddress,
        status: 'prepared',
        metadataJson: {
          transferRequestId: transferRequest.transferRequestId,
          actorUserId,
          provider: SQUADS_SOURCE,
        },
      },
    })
    .catch((error: unknown) => {
      if (isUniqueConstraintError(error)) {
        throw conflict('Payment order already has a spending-limit execution in progress.', {
          paymentOrderId: paymentOrder.paymentOrderId,
        });
      }
      throw error;
    });

  const latestBlockhash = await runtime.getLatestBlockhash();
  const agentPublicKey = new PublicKey(policy.agentWallet.walletAddress);
  const multisigPda = new PublicKey(policy.treasuryWallet.sourceRef ?? '');
  const destinationTokenAccount = paymentOrder.counterpartyWallet.tokenAccountAddress
    ?? deriveUsdcAtaForWallet(paymentOrder.counterpartyWallet.walletAddress);
  const instructions = [
    buildDestinationAtaCreateInstruction({
      payer: policy.agentWallet.walletAddress,
      destinationWallet: paymentOrder.counterpartyWallet.walletAddress,
      destinationTokenAccount,
    }),
    multisig.instructions.spendingLimitUse({
      multisigPda,
      member: agentPublicKey,
      spendingLimit: new PublicKey(policy.spendingLimitPda),
      mint: USDC_MINT,
      vaultIndex: policy.vaultIndex,
      amount: safeNumber(paymentOrder.amountRaw, 'amountRaw'),
      decimals: USDC_DECIMALS,
      destination: new PublicKey(paymentOrder.counterpartyWallet.walletAddress),
      tokenProgram: TOKEN_PROGRAM_ID,
      memo: input.memo?.trim() || paymentOrder.memo || paymentOrder.externalReference || undefined,
      programId: new PublicKey(config.squadsProgramId),
    }),
  ];
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: agentPublicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message(),
  );
  let sentSignature: string;
  try {
    const signed = await runtime.signTransaction({
      providerWalletId: policy.agentWallet.providerWalletId,
      serializedTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
    });
    sentSignature = await runtime.sendRawTransaction(Buffer.from(signed.signedTransactionBase64, 'base64'));
  } catch (error) {
    // Pre-send failure: no money moved, so release the claim and let the order be retried.
    await prisma.spendingLimitExecution
      .update({
        where: { spendingLimitExecutionId: reservation.spendingLimitExecutionId },
        data: { status: 'failed' },
      })
      .catch(() => { /* best-effort release */ });
    throw error;
  }

  // Money has moved. Record the signature immediately, before verification, so a crash
  // here cannot orphan the payment: the reconciler finalizes any 'submitted' row by its
  // signature, and the claim is never released once a payment exists.
  await prisma.spendingLimitExecution.update({
    where: { spendingLimitExecutionId: reservation.spendingLimitExecutionId },
    data: { signature: sentSignature, status: 'submitted', submittedAt: now },
  });

  await runtime.waitForSignature(sentSignature);

  const verification = await verifySettlementSoft(sentSignature, {
    destinationWalletAddress: paymentOrder.counterpartyWallet.walletAddress,
    destinationTokenAccountAddress: destinationTokenAccount,
    amountRaw: paymentOrder.amountRaw,
  });
  const finalStatus = verification.status === 'settled'
    ? 'settled'
    : verification.status === 'mismatch'
      ? 'mismatch'
      : 'submitted';
  const execution = await prisma.$transaction(async (tx) => {
    const row = await tx.spendingLimitExecution.update({
      where: { spendingLimitExecutionId: reservation.spendingLimitExecutionId },
      data: {
        signature: sentSignature,
        status: finalStatus,
        verificationJson: verification as Prisma.InputJsonValue,
        submittedAt: now,
        executedAt: verification.status === 'settled' ? now : null,
      },
    });

    await tx.paymentOrder.update({
      where: { paymentOrderId: paymentOrder.paymentOrderId },
      data: { state: finalStatus === 'settled' ? 'settled' : 'executed' },
    });
    await tx.transferRequest.update({
      where: { transferRequestId: transferRequest.transferRequestId },
      data: { status: finalStatus === 'settled' ? 'matched' : 'submitted_onchain' },
    });
    await tx.paymentOrderEvent.create({
      data: {
        paymentOrderId: paymentOrder.paymentOrderId,
        organizationId,
        eventType: finalStatus === 'settled' ? 'agent_spending_limit_settled' : 'agent_spending_limit_submitted',
        actorType: 'agent',
        actorId: policy.automationAgentId,
        beforeState: paymentOrder.state,
        afterState: finalStatus === 'settled' ? 'settled' : 'executed',
        linkedTransferRequestId: transferRequest.transferRequestId,
        linkedSignature: sentSignature,
        payloadJson: {
          spendingLimitPolicyId: policy.spendingLimitPolicyId,
          agentWalletId: policy.agentWalletId,
          verification,
        },
      },
    });
    await tx.transferRequestEvent.create({
      data: {
        transferRequestId: transferRequest.transferRequestId,
        organizationId,
        eventType: finalStatus === 'settled' ? 'agent_spending_limit_settled' : 'agent_spending_limit_submitted',
        actorType: 'agent',
        actorId: policy.automationAgentId,
        eventSource: 'agent',
        beforeState: transferRequest.status,
        afterState: finalStatus === 'settled' ? 'matched' : 'submitted_onchain',
        linkedSignature: sentSignature,
        linkedPaymentId: paymentOrder.paymentOrderId,
        linkedTransferIds: [],
        payloadJson: {
          spendingLimitPolicyId: policy.spendingLimitPolicyId,
          agentWalletId: policy.agentWalletId,
          verification,
        },
      },
    });
    await tx.agentWallet.update({
      where: { agentWalletId: policy.agentWalletId },
      data: { lastUsedAt: now },
    });
    await tx.spendingLimitPolicy.update({
      where: { spendingLimitPolicyId: policy.spendingLimitPolicyId },
      data: {
        lastSyncedAt: now,
        metadataJson: {
          ...(isRecordLike(policy.metadataJson) ? policy.metadataJson : {}),
          lastExecutionSignature: sentSignature,
          onchain: {
            ...(readRecord(policy.metadataJson, 'onchain')),
            preExecutionRemainingAmountRaw: account.remainingAmount.toString(),
            estimatedPostExecutionRemainingAmountRaw: (remainingAmount - paymentOrder.amountRaw).toString(),
            lastExecutionCheckedAt: now.toISOString(),
          },
        },
      },
    });
    return row;
  });

  return {
    ...serializeSpendingLimitExecution({
      ...execution,
      spendingLimitPolicy: {
        spendingLimitPolicyId: policy.spendingLimitPolicyId,
        policyName: policy.policyName,
        policyCode: policy.policyCode,
        status: policy.status,
        amountRaw: policy.amountRaw,
        period: policy.period,
        spendingLimitPda: policy.spendingLimitPda,
      },
      treasuryWallet: {
        treasuryWalletId: policy.treasuryWallet.treasuryWalletId,
        address: policy.treasuryWallet.address,
        displayName: policy.treasuryWallet.displayName,
        source: policy.treasuryWallet.source,
        sourceRef: policy.treasuryWallet.sourceRef,
      },
      automationAgent: {
        automationAgentId: policy.automationAgent.automationAgentId,
        name: policy.automationAgent.name,
        agentType: policy.automationAgent.agentType,
        status: policy.automationAgent.status,
      },
      agentWallet: {
        agentWalletId: policy.agentWallet.agentWalletId,
        walletAddress: policy.agentWallet.walletAddress,
        label: policy.agentWallet.label,
        status: policy.agentWallet.status,
      },
      paymentOrder: {
        paymentOrderId: paymentOrder.paymentOrderId,
        state: finalStatus === 'settled' ? 'settled' : 'executed',
        amountRaw: paymentOrder.amountRaw,
        asset: paymentOrder.asset,
        externalReference: paymentOrder.externalReference,
        invoiceNumber: paymentOrder.invoiceNumber,
      },
      counterpartyWallet: {
        counterpartyWalletId: paymentOrder.counterpartyWallet.counterpartyWalletId,
        walletAddress: paymentOrder.counterpartyWallet.walletAddress,
        label: paymentOrder.counterpartyWallet.label,
        trustState: paymentOrder.counterpartyWallet.trustState,
      },
    }),
    verification,
  };
}

function serializeSpendingLimitExecution(execution: SpendingLimitExecutionWithRelations) {
  return {
    spendingLimitExecutionId: execution.spendingLimitExecutionId,
    organizationId: execution.organizationId,
    spendingLimitPolicyId: execution.spendingLimitPolicyId,
    treasuryWalletId: execution.treasuryWalletId,
    automationAgentId: execution.automationAgentId,
    agentWalletId: execution.agentWalletId,
    paymentOrderId: execution.paymentOrderId,
    counterpartyWalletId: execution.counterpartyWalletId,
    amountRaw: execution.amountRaw.toString(),
    asset: execution.asset,
    destinationWalletAddress: execution.destinationWalletAddress,
    signature: execution.signature,
    status: execution.status,
    verificationJson: execution.verificationJson,
    metadataJson: execution.metadataJson,
    submittedAt: execution.submittedAt?.toISOString() ?? null,
    executedAt: execution.executedAt?.toISOString() ?? null,
    createdAt: execution.createdAt.toISOString(),
    updatedAt: execution.updatedAt.toISOString(),
    spendingLimitPolicy: execution.spendingLimitPolicy
      ? {
        ...execution.spendingLimitPolicy,
        amountRaw: execution.spendingLimitPolicy.amountRaw.toString(),
      }
      : null,
    treasuryWallet: execution.treasuryWallet,
    automationAgent: execution.automationAgent,
    agentWallet: execution.agentWallet,
    paymentOrder: execution.paymentOrder
      ? {
        ...execution.paymentOrder,
        amountRaw: execution.paymentOrder.amountRaw.toString(),
      }
      : null,
    counterpartyWallet: execution.counterpartyWallet,
  };
}

async function loadPaymentOrder(organizationId: string, paymentOrderId: string) {
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
  if (paymentOrder.state === 'cancelled' || paymentOrder.state === 'settled') {
    throw badRequest(`Payment order is ${paymentOrder.state}.`);
  }
  return paymentOrder;
}

async function loadPolicy(organizationId: string, spendingLimitPolicyId: string) {
  const policy = await prisma.spendingLimitPolicy.findFirst({
    where: { organizationId, spendingLimitPolicyId },
    include: {
      automationAgent: true,
      agentWallet: true,
      treasuryWallet: true,
      destinations: true,
    },
  });
  if (!policy) {
    throw notFound('Spending limit policy not found');
  }
  if (policy.treasuryWallet.source !== SQUADS_SOURCE || !policy.treasuryWallet.sourceRef) {
    throw badRequest('Spending limit policy is not attached to a Squads treasury.');
  }
  if (policy.agentWallet.status !== 'active' || policy.automationAgent.status !== 'active') {
    throw badRequest('Spending limit agent wallet is not active.');
  }
  return policy;
}

async function verifySettlementSoft(
  signature: string,
  expectedTransfer: {
    destinationWalletAddress: string;
    destinationTokenAccountAddress: string;
    amountRaw: bigint;
  },
) {
  try {
    const verification = await runtime.verifySettlement({
      signature,
      expectedTransfers: [expectedTransfer],
    });
    return {
      status: verification.allSettled ? 'settled' : 'mismatch',
      checkedAt: verification.checkedAt,
      verification,
    } as const;
  } catch (error) {
    return {
      status: 'pending',
      checkedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message : 'Settlement verification unavailable',
    } as const;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function safeNumber(value: bigint, fieldName: string) {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber) || asNumber < 0) {
    throw badRequest(`${fieldName} exceeds JavaScript safe integer bounds for Squads SDK transaction building.`);
  }
  return asNumber;
}

function readRecord(value: unknown, key: string): Prisma.InputJsonObject {
  if (!isRecordLike(value)) {
    return {};
  }
  const nested = value[key];
  return isRecordLike(nested) ? ({ ...nested } as Prisma.InputJsonObject) : {};
}
