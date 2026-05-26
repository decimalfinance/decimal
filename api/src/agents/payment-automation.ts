import { ApiError } from '../infra/api-errors.js';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { USDC_ASSET } from '../solana.js';
import { createAndSubmitSquadsPaymentProposalAsAgent } from '../squads/treasury.js';
import { SQUADS_SOURCE } from '../squads/shared.js';

export type PaymentOrderAgentAdvanceResult =
  | {
      status: 'proposal_submitted';
      paymentOrderId: string;
      treasuryWalletId: string;
      decimalProposalId: string;
      submittedSignature: string;
      reason: null;
      decimalProposal: unknown;
    }
  | {
      status:
        | 'already_has_proposal'
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
  const paymentOrder = await prisma.paymentOrder.findFirst({
    where: {
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
    },
    include: {
      counterpartyWallet: true,
      sourceTreasuryWallet: true,
    },
  });
  if (!paymentOrder) {
    throw new ApiError(404, 'not_found', 'Payment order not found');
  }

  const existingProposal = await prisma.decimalProposal.findFirst({
    where: {
      organizationId: args.organizationId,
      paymentOrderId: paymentOrder.paymentOrderId,
      provider: SQUADS_SOURCE,
      semanticType: 'send_payment',
      status: { notIn: ['rejected', 'cancelled', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existingProposal) {
    return {
      status: 'already_has_proposal',
      paymentOrderId: paymentOrder.paymentOrderId,
      treasuryWalletId: existingProposal.treasuryWalletId,
      decimalProposalId: existingProposal.decimalProposalId,
      submittedSignature: existingProposal.submittedSignature,
      reason: 'Payment order already has an active Squads proposal.',
    };
  }

  if (paymentOrder.paymentRunId) {
    return {
      status: 'not_applicable',
      paymentOrderId: paymentOrder.paymentOrderId,
      treasuryWalletId: paymentOrder.sourceTreasuryWalletId,
      reason: 'Payment order belongs to a payment run. Create a batch proposal for the run instead.',
    };
  }

  if (['cancelled', 'closed', 'settled'].includes(paymentOrder.state)) {
    return {
      status: 'not_applicable',
      paymentOrderId: paymentOrder.paymentOrderId,
      treasuryWalletId: paymentOrder.sourceTreasuryWalletId,
      reason: `Payment order is ${paymentOrder.state}.`,
    };
  }

  if (paymentOrder.state === 'needs_review' || paymentOrder.state === 'agent_flagged') {
    return {
      status: 'needs_review',
      paymentOrderId: paymentOrder.paymentOrderId,
      treasuryWalletId: paymentOrder.sourceTreasuryWalletId,
      reason: 'Payment order requires human review before the agent can create a proposal.',
    };
  }

  if (paymentOrder.counterpartyWallet.trustState !== 'trusted') {
    return {
      status: 'needs_review',
      paymentOrderId: paymentOrder.paymentOrderId,
      treasuryWalletId: paymentOrder.sourceTreasuryWalletId,
      reason: `Counterparty wallet is ${paymentOrder.counterpartyWallet.trustState}; it must be trusted first.`,
    };
  }

  if (paymentOrder.asset.toLowerCase() !== USDC_ASSET) {
    return {
      status: 'blocked',
      paymentOrderId: paymentOrder.paymentOrderId,
      treasuryWalletId: paymentOrder.sourceTreasuryWalletId,
      reason: `Agent proposal automation supports USDC only, received ${paymentOrder.asset}.`,
    };
  }

  const treasuryWallet = await resolveSourceTreasuryWallet({
    organizationId: args.organizationId,
    requestedTreasuryWalletId: args.sourceTreasuryWalletId ?? paymentOrder.sourceTreasuryWalletId,
  });
  if (!treasuryWallet) {
    return {
      status: 'needs_source_treasury',
      paymentOrderId: paymentOrder.paymentOrderId,
      treasuryWalletId: null,
      reason: 'No active programmable treasury is available for agent proposal creation.',
    };
  }
  if (treasuryWallet.source !== SQUADS_SOURCE || !treasuryWallet.sourceRef) {
    return {
      status: 'unsupported_source_treasury',
      paymentOrderId: paymentOrder.paymentOrderId,
      treasuryWalletId: treasuryWallet.treasuryWalletId,
      reason: 'Agent proposal automation currently requires a Squads programmable treasury.',
    };
  }

  const proposal = await createAndSubmitSquadsPaymentProposalAsAgent(
    args.organizationId,
    treasuryWallet.treasuryWalletId,
    args.actorUserId,
    {
      paymentOrderId: paymentOrder.paymentOrderId,
      memo: paymentOrder.memo ?? paymentOrder.externalReference ?? paymentOrder.invoiceNumber,
    },
  );

  logger.info('payment_automation.proposal_submitted', {
    organizationId: args.organizationId,
    paymentOrderId: paymentOrder.paymentOrderId,
    treasuryWalletId: treasuryWallet.treasuryWalletId,
    decimalProposalId: proposal.decimalProposal.decimalProposalId,
    submittedSignature: proposal.submittedSignature,
  });

  return {
    status: 'proposal_submitted',
    paymentOrderId: paymentOrder.paymentOrderId,
    treasuryWalletId: treasuryWallet.treasuryWalletId,
    decimalProposalId: proposal.decimalProposal.decimalProposalId,
    submittedSignature: proposal.submittedSignature,
    reason: null,
    decimalProposal: proposal.decimalProposal,
  };
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
