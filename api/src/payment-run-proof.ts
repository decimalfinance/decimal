import { buildPaymentOrderProofPacket } from './payment-order-proof.js';
import { getPaymentRunDetail } from './payment-runs.js';
import { buildCanonicalDigest } from './proof-packet.js';

export async function buildPaymentRunProofPacket(workspaceId: string, paymentRunId: string) {
  const detail = await getPaymentRunDetail(workspaceId, paymentRunId);
  const orderProofs = await Promise.all(
    detail.paymentOrders.map((order) => buildPaymentOrderProofPacket(workspaceId, order.paymentOrderId)),
  );
  const readiness = deriveRunReadiness(orderProofs);
  const packetBody = {
    packetType: 'stablecoin_payment_run_proof',
    version: 1,
    workspaceId,
    paymentRunId,
    runName: detail.runName,
    status: detail.derivedState,
    readiness,
    totals: detail.totals,
    reconciliationSummary: detail.reconciliationSummary,
    orders: detail.paymentOrders.map((order) => ({
      paymentOrderId: order.paymentOrderId,
      paymentRequestId: order.paymentRequestId,
      transferRequestId: order.transferRequestId,
      payee: order.payee,
      destination: order.destination,
      amountRaw: order.amountRaw,
      asset: order.asset,
      reference: order.externalReference ?? order.invoiceNumber,
      state: order.derivedState,
      latestExecution: order.reconciliationDetail?.latestExecution ?? null,
      match: order.reconciliationDetail?.match ?? null,
      exceptions: order.reconciliationDetail?.exceptions ?? [],
      proofStatus: orderProofs.find((proof) => proof.intent.paymentOrderId === order.paymentOrderId)?.status ?? 'in_progress',
      proofId: orderProofs.find((proof) => proof.intent.paymentOrderId === order.paymentOrderId)?.proofId ?? null,
    })),
    orderProofs,
    agentSummary: {
      canTreatAsFinal: readiness.status === 'complete',
      needsHumanReview: readiness.status === 'needs_review' || readiness.status === 'blocked',
      recommendedAction: readiness.recommendedAction,
    },
  };
  const canonicalDigest = buildCanonicalDigest(packetBody);

  return {
    proofId: `axoria_payment_run_proof_${canonicalDigest.slice(0, 24)}`,
    canonicalDigest,
    canonicalDigestAlgorithm: 'sha256:stable-json-v1',
    generatedAt: new Date().toISOString(),
    ...packetBody,
  };
}

function deriveRunReadiness(orderProofs: Awaited<ReturnType<typeof buildPaymentOrderProofPacket>>[]) {
  const counts = orderProofs.reduce(
    (acc, proof) => {
      acc.total += 1;
      acc[proof.readiness.status] += 1;
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
}
