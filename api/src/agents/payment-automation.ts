import type { CounterpartyWallet, PaymentOrder, Prisma, TreasuryWallet } from '@prisma/client';
import { ApiError } from '../infra/api-errors.js';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { USDC_ASSET } from '../solana.js';
import { createAndSubmitSquadsPaymentProposalAsAgent } from '../squads/treasury.js';
import { SQUADS_SOURCE } from '../squads/shared.js';
import {
  routePayment,
  type ExistingPaymentRoute,
  type PaymentReviewDecision,
  type PaymentReviewReason,
  type PaymentRoutingContext,
  type SpendingLimitFitDecision,
} from '../payments/algorithm.js';
import { executePaymentOrderWithSpendingLimit } from './spending-limit-execution.js';

type AgentPaymentOrder = PaymentOrder & {
  counterpartyWallet: CounterpartyWallet;
  sourceTreasuryWallet: TreasuryWallet | null;
};

type ExistingAgentRoute =
  | {
      kind: 'proposal';
      treasuryWalletId: string | null;
      decimalProposalId: string;
      submittedSignature: string | null;
    }
  | {
      kind: 'spending_limit_execution';
      treasuryWalletId: string;
      spendingLimitPolicyId: string | null;
      spendingLimitExecutionId: string;
      signature: string | null;
      status: string;
    };

type AgentRoutingContext = PaymentRoutingContext & {
  sourceTreasuryWalletId?: string | null;
};

export type PaymentOrderAgentAdvanceResult =
  | {
      status: 'proposal_submitted';
      paymentOrderId: string;
      treasuryWalletId: string | null;
      decimalProposalId: string;
      submittedSignature: string;
      reason: null;
      decimalProposal: unknown;
    }
  | {
      status: 'spending_limit_executed';
      paymentOrderId: string;
      treasuryWalletId: string;
      spendingLimitPolicyId: string | null;
      spendingLimitExecutionId: string;
      signature: string | null;
      reason: null;
      execution: unknown;
    }
  | {
      status:
        | 'already_has_proposal'
        | 'already_has_spending_limit_execution'
        | 'needs_review'
        | 'needs_source_treasury'
        | 'unsupported_source_treasury'
        | 'not_applicable'
        | 'blocked'
        | 'failed';
      paymentOrderId: string;
      treasuryWalletId: string | null;
      decimalProposalId?: string | null;
      submittedSignature?: string | null;
      reason: string;
      details?: unknown;
    };

export async function tryAdvancePaymentOrderWithAgent(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string | null;
  sourceTreasuryWalletId?: string | null;
}): Promise<PaymentOrderAgentAdvanceResult> {
  try {
    return await advancePaymentOrderWithAgent(args);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Agent payment automation failed.';
    logger.warn('payment_automation.advance_failed', {
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
      reason,
      code: error instanceof ApiError ? error.code : undefined,
    });
    return {
      status: 'failed',
      paymentOrderId: args.paymentOrderId,
      treasuryWalletId: args.sourceTreasuryWalletId ?? null,
      reason,
      details: error instanceof ApiError ? error.details : undefined,
    };
  }
}

export async function advancePaymentOrderWithAgent(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string | null;
  sourceTreasuryWalletId?: string | null;
}): Promise<PaymentOrderAgentAdvanceResult> {
  const routingContext: AgentRoutingContext = {
    organizationId: args.organizationId,
    paymentOrderId: args.paymentOrderId,
    actorUserId: args.actorUserId,
    sourceTreasuryWalletId: args.sourceTreasuryWalletId,
  };
  const decision = await routePayment<AgentPaymentOrder, string, Awaited<ReturnType<typeof executePaymentOrderWithSpendingLimit>>, Awaited<ReturnType<typeof createAndSubmitSquadsPaymentProposalAsAgent>>, ExistingAgentRoute, { updated: boolean }>(
    routingContext,
    {
      loadPaymentOrder,
      findExistingRoute,
      evaluateReviewGate,
      markNeedsReview,
      findBestMatchingSpendingLimit,
      canUseSpendingLimit,
      executeWithSpendingLimit: async (paymentOrder, spendingLimitPolicyId, context) => {
        if (!context.actorUserId) {
          throw new ApiError(400, 'actor_required', 'Agent payment routing requires a user actor for audit.');
        }
        return executePaymentOrderWithSpendingLimit(
          paymentOrder.organizationId,
          context.actorUserId,
          paymentOrder.paymentOrderId,
          { spendingLimitPolicyId },
        );
      },
      createSquadsProposal: async (paymentOrder, context) => {
        const treasuryWallet = await resolveSourceTreasuryWallet({
          organizationId: paymentOrder.organizationId,
          requestedTreasuryWalletId: (context as AgentRoutingContext).sourceTreasuryWalletId ?? paymentOrder.sourceTreasuryWalletId,
        });
        if (!treasuryWallet) {
          throw new ApiError(400, 'needs_source_treasury', 'No active programmable treasury is available for agent proposal creation.');
        }
        if (treasuryWallet.source !== SQUADS_SOURCE || !treasuryWallet.sourceRef) {
          throw new ApiError(400, 'unsupported_source_treasury', 'Agent proposal automation currently requires a Squads programmable treasury.');
        }
        return createAndSubmitSquadsPaymentProposalAsAgent(
          paymentOrder.organizationId,
          treasuryWallet.treasuryWalletId,
          context.actorUserId,
          {
            paymentOrderId: paymentOrder.paymentOrderId,
            memo: paymentOrder.memo ?? paymentOrder.externalReference ?? paymentOrder.invoiceNumber,
          },
        );
      },
    },
  );

  return serializeRoutingDecision(decision);
}

async function resolveSourceTreasuryWallet(args: {
  organizationId: string;
  requestedTreasuryWalletId?: string | null;
}) {
  if (args.requestedTreasuryWalletId) {
    return prisma.treasuryWallet.findFirst({
      where: {
        organizationId: args.organizationId,
        treasuryWalletId: args.requestedTreasuryWalletId,
        isActive: true,
      },
    });
  }

  return prisma.treasuryWallet.findFirst({
    where: {
      organizationId: args.organizationId,
      source: SQUADS_SOURCE,
      isActive: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function loadPaymentOrder(context: PaymentRoutingContext): Promise<AgentPaymentOrder> {
  const paymentOrder = await prisma.paymentOrder.findFirst({
    where: {
      organizationId: context.organizationId,
      paymentOrderId: context.paymentOrderId,
    },
    include: {
      counterpartyWallet: true,
      sourceTreasuryWallet: true,
    },
  });
  if (!paymentOrder) {
    throw new ApiError(404, 'not_found', 'Payment order not found');
  }
  return paymentOrder;
}

async function findExistingRoute(paymentOrder: AgentPaymentOrder): Promise<ExistingPaymentRoute<ExistingAgentRoute>> {
  const existingProposal = await prisma.decimalProposal.findFirst({
    where: {
      organizationId: paymentOrder.organizationId,
      paymentOrderId: paymentOrder.paymentOrderId,
      provider: SQUADS_SOURCE,
      semanticType: 'send_payment',
      status: { notIn: ['rejected', 'cancelled', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existingProposal) {
    return {
      status: 'exists',
      route: {
        kind: 'proposal',
        treasuryWalletId: existingProposal.treasuryWalletId,
        decimalProposalId: existingProposal.decimalProposalId,
        submittedSignature: existingProposal.submittedSignature,
      },
    };
  }

  const existingExecution = await prisma.spendingLimitExecution.findFirst({
    where: {
      organizationId: paymentOrder.organizationId,
      paymentOrderId: paymentOrder.paymentOrderId,
      status: { in: ['submitted', 'settled'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existingExecution) {
    return {
      status: 'exists',
      route: {
        kind: 'spending_limit_execution',
        treasuryWalletId: existingExecution.treasuryWalletId,
        spendingLimitPolicyId: existingExecution.spendingLimitPolicyId,
        spendingLimitExecutionId: existingExecution.spendingLimitExecutionId,
        signature: existingExecution.signature,
        status: existingExecution.status,
      },
    };
  }

  return { status: 'none' };
}

async function evaluateReviewGate(paymentOrder: AgentPaymentOrder): Promise<PaymentReviewDecision> {
  const reasons: PaymentReviewReason[] = [];

  if (paymentOrder.state === 'needs_review') {
    reasons.push({
      code: 'payment_order_needs_review',
      message: 'Payment order requires human review before automation.',
    });
  }

  if (paymentOrder.counterpartyWallet.trustState !== 'trusted') {
    reasons.push({
      code: 'counterparty_wallet_not_trusted',
      message: `Counterparty wallet is ${paymentOrder.counterpartyWallet.trustState}; it must be trusted first.`,
    });
  }

  if (paymentOrder.asset.toLowerCase() !== USDC_ASSET) {
    reasons.push({
      code: 'unsupported_asset',
      message: `Payment automation supports USDC only, received ${paymentOrder.asset}.`,
    });
  }

  return reasons.length ? { status: 'needs_review', reasons } : { status: 'pass' };
}

async function markNeedsReview(
  paymentOrder: AgentPaymentOrder,
  decision: Extract<PaymentReviewDecision, { status: 'needs_review' }>,
  context: PaymentRoutingContext,
) {
  if (paymentOrder.state === 'needs_review') {
    return { updated: false };
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentOrder.update({
      where: { paymentOrderId: paymentOrder.paymentOrderId },
      data: {
        state: 'needs_review',
        metadataJson: {
          ...(isRecordLike(paymentOrder.metadataJson) ? paymentOrder.metadataJson : {}),
          automationReview: {
            status: 'needs_review',
            reasons: decision.reasons.map(serializeReviewReason),
            markedAt: new Date().toISOString(),
          },
        } satisfies Prisma.InputJsonValue,
      },
    });
    await tx.paymentOrderEvent.create({
      data: {
        paymentOrderId: paymentOrder.paymentOrderId,
        organizationId: paymentOrder.organizationId,
        eventType: 'payment_order_needs_review',
        actorType: 'agent',
        actorId: context.actorUserId,
        beforeState: paymentOrder.state,
        afterState: 'needs_review',
        payloadJson: { reasons: decision.reasons.map(serializeReviewReason) },
      },
    });
  });

  return { updated: true };
}

async function findBestMatchingSpendingLimit(paymentOrder: AgentPaymentOrder, context: PaymentRoutingContext) {
  const sourceTreasuryWalletId = (context as AgentRoutingContext).sourceTreasuryWalletId ?? paymentOrder.sourceTreasuryWalletId;
  const policy = await prisma.spendingLimitPolicy.findFirst({
    where: {
      organizationId: paymentOrder.organizationId,
      status: 'active',
      asset: { equals: paymentOrder.asset, mode: 'insensitive' },
      amountRaw: { gte: paymentOrder.amountRaw },
      ...(sourceTreasuryWalletId ? { treasuryWalletId: sourceTreasuryWalletId } : {}),
      treasuryWallet: {
        isActive: true,
        source: SQUADS_SOURCE,
      },
      automationAgent: {
        status: 'active',
      },
      agentWallet: {
        status: 'active',
        providerWalletId: { not: null },
      },
      destinations: {
        some: {
          counterpartyWalletId: paymentOrder.counterpartyWalletId,
          walletAddress: paymentOrder.counterpartyWallet.walletAddress,
        },
      },
    },
    orderBy: [
      { amountRaw: 'asc' },
      { createdAt: 'asc' },
    ],
  });

  return policy?.spendingLimitPolicyId ?? null;
}

async function canUseSpendingLimit(paymentOrder: AgentPaymentOrder, spendingLimitPolicyId: string): Promise<SpendingLimitFitDecision> {
  const policy = await prisma.spendingLimitPolicy.findFirst({
    where: {
      organizationId: paymentOrder.organizationId,
      spendingLimitPolicyId,
    },
    include: {
      destinations: true,
      agentWallet: true,
      automationAgent: true,
    },
  });

  if (!policy || policy.status !== 'active') {
    return {
      status: 'not_applicable',
      reason: { code: 'spending_limit_not_active', message: 'Spending limit policy is not active.' },
    };
  }
  if (paymentOrder.amountRaw > policy.amountRaw) {
    return {
      status: 'does_not_fit',
      reason: { code: 'amount_exceeds_limit', message: 'Payment amount exceeds the spending limit amount.' },
    };
  }
  if (!policy.destinations.some((destination) => destination.counterpartyWalletId === paymentOrder.counterpartyWalletId)) {
    return {
      status: 'does_not_fit',
      reason: { code: 'destination_not_allowlisted', message: 'Payment destination is not allowlisted on this spending limit.' },
    };
  }
  if (!policy.agentWallet.providerWalletId || policy.agentWallet.status !== 'active' || policy.automationAgent.status !== 'active') {
    return {
      status: 'not_applicable',
      reason: { code: 'agent_wallet_unavailable', message: 'Spending limit agent wallet is not available for signing.' },
    };
  }
  return { status: 'pass' };
}

function serializeRoutingDecision(
  decision: Awaited<ReturnType<typeof routePayment<AgentPaymentOrder, string, Awaited<ReturnType<typeof executePaymentOrderWithSpendingLimit>>, Awaited<ReturnType<typeof createAndSubmitSquadsPaymentProposalAsAgent>>, ExistingAgentRoute, { updated: boolean }>>>,
): PaymentOrderAgentAdvanceResult {
  if (decision.status === 'already_routed') {
    if (decision.existingRoute.kind === 'proposal') {
      return {
        status: 'already_has_proposal',
        paymentOrderId: decision.payment.paymentOrderId,
        treasuryWalletId: decision.existingRoute.treasuryWalletId,
        decimalProposalId: decision.existingRoute.decimalProposalId,
        submittedSignature: decision.existingRoute.submittedSignature,
        reason: 'Payment order already has an active Squads proposal.',
      };
    }
    return {
      status: 'already_has_spending_limit_execution',
      paymentOrderId: decision.payment.paymentOrderId,
      treasuryWalletId: decision.existingRoute.treasuryWalletId,
      reason: `Payment order already has a ${decision.existingRoute.status} spending-limit execution.`,
      details: {
        spendingLimitPolicyId: decision.existingRoute.spendingLimitPolicyId,
        spendingLimitExecutionId: decision.existingRoute.spendingLimitExecutionId,
        signature: decision.existingRoute.signature,
      },
    };
  }

  if (decision.status === 'skipped') {
    return {
      status: 'not_applicable',
      paymentOrderId: decision.payment.paymentOrderId,
      treasuryWalletId: decision.payment.sourceTreasuryWalletId,
      reason: `Payment order is ${decision.reason}.`,
    };
  }

  if (decision.status === 'needs_review') {
    return {
      status: decision.reasons.some((reason) => reason.code === 'unsupported_asset') ? 'blocked' : 'needs_review',
      paymentOrderId: decision.payment.paymentOrderId,
      treasuryWalletId: decision.payment.sourceTreasuryWalletId,
      reason: decision.reasons.map((reason) => reason.message).join(' '),
      details: { reasons: decision.reasons },
    };
  }

  if (decision.status === 'agent_executed') {
    logger.info('payment_automation.spending_limit_executed', {
      organizationId: decision.payment.organizationId,
      paymentOrderId: decision.payment.paymentOrderId,
      treasuryWalletId: decision.execution.treasuryWalletId,
      spendingLimitPolicyId: decision.execution.spendingLimitPolicyId,
      spendingLimitExecutionId: decision.execution.spendingLimitExecutionId,
      signature: decision.execution.signature,
    });
    return {
      status: 'spending_limit_executed',
      paymentOrderId: decision.payment.paymentOrderId,
      treasuryWalletId: decision.execution.treasuryWalletId,
      spendingLimitPolicyId: decision.execution.spendingLimitPolicyId,
      spendingLimitExecutionId: decision.execution.spendingLimitExecutionId,
      signature: decision.execution.signature,
      reason: null,
      execution: decision.execution,
    };
  }

  logger.info('payment_automation.proposal_submitted', {
    organizationId: decision.payment.organizationId,
    paymentOrderId: decision.payment.paymentOrderId,
    treasuryWalletId: decision.proposal.decimalProposal.treasuryWalletId,
    decimalProposalId: decision.proposal.decimalProposal.decimalProposalId,
    submittedSignature: decision.proposal.submittedSignature,
    fallback: decision.fallback,
  });

  return {
    status: 'proposal_submitted',
    paymentOrderId: decision.payment.paymentOrderId,
    treasuryWalletId: decision.proposal.decimalProposal.treasuryWalletId,
    decimalProposalId: decision.proposal.decimalProposal.decimalProposalId,
    submittedSignature: decision.proposal.submittedSignature,
    reason: null,
    decimalProposal: decision.proposal.decimalProposal,
  };
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializeReviewReason(reason: PaymentReviewReason): Prisma.InputJsonObject {
  return {
    code: reason.code,
    message: reason.message,
    ...(reason.details === undefined ? {} : { details: reason.details as Prisma.InputJsonValue }),
  };
}
