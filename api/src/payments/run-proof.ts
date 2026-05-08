import { buildPaymentOrderProofPacket } from './order-proof.js';
import { getPaymentRunDetail } from './runs.js';
import { buildCanonicalDigest } from '../proof-packet.js';

type PaymentRunProofDetail = 'summary' | 'compact' | 'full';

export async function buildPaymentRunProofPacket(
  organizationId: string,
  paymentRunId: string,
  options: { detail?: PaymentRunProofDetail } = {},
) {
  const detailLevel = options.detail ?? 'summary';
  const detail = await getPaymentRunDetail(organizationId, paymentRunId);
  const orderProofs = await Promise.all(
    detail.paymentOrders.map((order) => buildPaymentOrderProofPacket(organizationId, order.paymentOrderId)),
  );
  const proofByOrderId = new Map(orderProofs.map((proof) => [proof.intent.paymentOrderId, proof]));
  const readiness = deriveRunReadiness(orderProofs);
  const orders = detail.paymentOrders.map((order) => {
    const proof = proofByOrderId.get(order.paymentOrderId);
    return {
      paymentOrderId: order.paymentOrderId,
      paymentRequestId: order.paymentRequestId,
      transferRequestId: order.transferRequestId,
      destination: {
        destinationId: order.destination.destinationId,
        label: order.destination.label,
        walletAddress: order.destination.walletAddress,
        trustState: order.destination.trustState,
        isInternal: order.destination.isInternal,
      },
      amountRaw: order.amountRaw,
      asset: order.asset,
      reference: order.externalReference ?? order.invoiceNumber,
      state: order.derivedState,
      approvalState: order.reconciliationDetail?.approvalState ?? null,
      executionState: order.reconciliationDetail?.latestExecution?.state ?? null,
      settlementState: order.reconciliationDetail?.requestDisplayState ?? null,
      submittedSignature: order.reconciliationDetail?.latestExecution?.submittedSignature ?? null,
      matchStatus: order.reconciliationDetail?.match?.matchStatus ?? null,
      matchedAmountRaw: order.reconciliationDetail?.match?.matchedAmountRaw ?? null,
      exceptionCount: order.reconciliationDetail?.exceptions.length ?? 0,
      proofStatus: proof?.status ?? 'in_progress',
      proofId: proof?.proofId ?? null,
      proofDigest: proof?.canonicalDigest ?? null,
      fullProofEndpoint: proof ? `/organizations/${organizationId}/payment-orders/${order.paymentOrderId}/proof` : null,
    };
  });
  const orderProofRefs = orderProofs.map((proof) => buildOrderProofRef(proof));
  const packetBody = {
    packetType: 'stablecoin_payment_run_proof',
    version: 1,
    detailLevel,
    organizationId,
    paymentRunId,
    runName: detail.runName,
    status: detail.derivedState,
    readiness,
    totals: detail.totals,
    reconciliationSummary: detail.reconciliationSummary,
    orders,
    orderProofs: detailLevel === 'summary'
      ? []
      : detailLevel === 'full'
        ? orderProofs
        : orderProofRefs,
    agentSummary: {
      canTreatAsFinal: readiness.status === 'complete',
      needsHumanReview: readiness.status === 'needs_review' || readiness.status === 'blocked',
      recommendedAction: readiness.recommendedAction,
    },
  };
  const canonicalDigest = buildCanonicalDigest(packetBody);

  return {
    proofId: `decimal_payment_run_proof_${canonicalDigest.slice(0, 24)}`,
    canonicalDigest,
    canonicalDigestAlgorithm: 'sha256:stable-json-v1',
    generatedAt: new Date().toISOString(),
    ...packetBody,
  };
}

function buildOrderProofRef(proof: Awaited<ReturnType<typeof buildPaymentOrderProofPacket>>) {
  return {
    proofId: proof.proofId,
    canonicalDigest: proof.canonicalDigest,
    canonicalDigestAlgorithm: proof.canonicalDigestAlgorithm,
    generatedAt: proof.generatedAt,
    packetType: proof.packetType,
    version: proof.version,
    status: proof.status,
    readiness: {
      status: proof.readiness.status,
      blockers: proof.readiness.blockers,
      warnings: proof.readiness.warnings,
      pending: proof.readiness.pending,
      recommendedAction: proof.readiness.recommendedAction,
    },
    intent: {
      paymentRequestId: proof.intent.paymentRequestId,
      paymentOrderId: proof.intent.paymentOrderId,
      transferRequestId: proof.intent.transferRequestId,
      reference: proof.intent.reference,
      reason: proof.intent.reason,
      amountRaw: proof.intent.amountRaw,
      amountUsdc: proof.intent.amountUsdc,
      asset: proof.intent.asset,
    },
    parties: proof.parties,
    approval: {
      state: proof.approval.state,
      decisionCount: proof.approval.decisions.length,
      latestDecision: proof.approval.decisions.at(-1) ?? null,
    },
    execution: proof.execution,
    settlement: proof.settlement,
    exceptions: proof.exceptions.map((exception) => ({
      exceptionId: exception.exceptionId,
      type: exception.type,
      reasonCode: exception.reasonCode,
      status: exception.status,
      severity: exception.severity,
    })),
    agentSummary: proof.agentSummary,
    fullProofEndpoint: `/organizations/${proof.organizationId}/payment-orders/${proof.intent.paymentOrderId}/proof`,
  };
}

function deriveRunReadiness(orderProofs: Awaited<ReturnType<typeof buildPaymentOrderProofPacket>>[]) {
  type RunReadinessStatus = 'complete' | 'in_progress' | 'needs_review' | 'blocked';
  const counts = orderProofs.reduce(
    (acc, proof) => {
      acc.total += 1;
      if (isRunReadinessStatus(proof.readiness.status)) {
        acc[proof.readiness.status] += 1;
      }
      return acc;
    },
    {
      total: 0,
      complete: 0,
      in_progress: 0,
      needs_review: 0,
      blocked: 0,
    },
  );
  const status = counts.blocked
    ? 'blocked'
    : counts.needs_review
      ? 'needs_review'
      : counts.in_progress
        ? 'in_progress'
        : 'complete';

  return {
    status,
    counts,
    recommendedAction:
      status === 'complete'
        ? 'archive_or_share_run_proof'
        : status === 'needs_review'
          ? 'resolve_order_exceptions'
          : status === 'blocked'
            ? 'fix_blocked_orders'
            : 'continue_payment_run_workflow',
  };

  function isRunReadinessStatus(value: string): value is RunReadinessStatus {
    return value === 'complete' || value === 'in_progress' || value === 'needs_review' || value === 'blocked';
  }
}
