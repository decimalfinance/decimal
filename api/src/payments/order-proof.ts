import { getPaymentOrderDetail, type PaymentOrderState } from './orders.js';
import { buildCanonicalDigest } from '../proof-packet.js';
import { getReconciliationExplanation } from '../transfer-requests/settlement-read-model.js';

type PaymentOrderDetail = Awaited<ReturnType<typeof getPaymentOrderDetail>>;
type LatestExecution = NonNullable<PaymentOrderDetail['reconciliationDetail']> extends { latestExecution: infer Latest }
  ? Latest
  : null;

export async function buildPaymentOrderProofPacket(organizationId: string, paymentOrderId: string) {
  const detail = await getPaymentOrderDetail(organizationId, paymentOrderId);
  const reconciliation = detail.reconciliationDetail;
  const match = reconciliation?.match ?? null;
  const latestExecution = reconciliation?.latestExecution ?? null;
  const reconciliationExplanation = detail.transferRequestId
    ? await getReconciliationExplanation(organizationId, detail.transferRequestId)
    : null;
  const proofStatus = deriveProofStatus(detail.derivedState, reconciliation?.requestDisplayState ?? null);
  const readiness = deriveProofReadiness({
    proofStatus,
    approvalState: reconciliation?.approvalState ?? detail.derivedState,
    derivedState: detail.derivedState,
    latestExecution,
    reconciliationExplanation,
    exceptionCount: reconciliation?.exceptions.length ?? 0,
  });

  const packetBody = {
    packetType: 'stablecoin_payment_proof',
    version: 1,
    organizationId,
    status: proofStatus,
    readiness,
    intent: {
      paymentRequestId: detail.paymentRequestId,
      paymentOrderId: detail.paymentOrderId,
      transferRequestId: detail.transferRequestId,
      reference: detail.externalReference ?? detail.invoiceNumber ?? null,
      reason: detail.paymentRequest?.reason ?? detail.memo ?? null,
      amountRaw: detail.amountRaw,
      amountUsdc: formatRawUsdc(detail.amountRaw),
      asset: detail.asset,
      dueAt: detail.dueAt,
      createdAt: detail.createdAt,
      attachmentUrl: detail.attachmentUrl,
    },
    parties: {
      source: detail.sourceTreasuryWallet ? {
        treasuryWalletId: detail.sourceTreasuryWallet.treasuryWalletId,
        label: detail.sourceTreasuryWallet.displayName,
        walletAddress: detail.sourceTreasuryWallet.address,
        usdcAtaAddress: detail.sourceTreasuryWallet.usdcAtaAddress,
      } : null,
      destination: {
        destinationId: detail.destination.destinationId,
        label: detail.destination.label,
        walletAddress: detail.destination.walletAddress,
        tokenAccountAddress: detail.destination.tokenAccountAddress,
        trustState: detail.destination.trustState,
        isInternal: detail.destination.isInternal,
      },
      counterparty: detail.counterparty ? {
        counterpartyId: detail.counterparty.counterpartyId,
        displayName: detail.counterparty.displayName,
      } : null,
    },
    approval: {
      state: reconciliation?.approvalState ?? detail.derivedState,
      // Pre-Squads approval decisions are no longer recorded — Squads
      // multisig is the on-chain approval ceremony. The proof packet keeps
      // an empty decisions array so the JSON shape stays stable for
      // downstream consumers.
      decisions: [],
    },
    execution: {
      state: latestExecution?.state ?? null,
      executionSource: latestExecution?.executionSource ?? null,
      submittedSignature: latestExecution?.submittedSignature ?? null,
      submittedAt: latestExecution?.submittedAt ?? null,
      externalExecutionReference: getMetadataString(latestExecution?.metadataJson, 'externalExecutionReference'),
      metadataJson: latestExecution?.metadataJson ?? null,
    },
    settlement: {
      state: reconciliation?.requestDisplayState ?? null,
      matchStatus: match?.matchStatus ?? null,
      matchRule: match?.matchRule ?? null,
      matchedAmountRaw: match?.matchedAmountRaw ?? null,
      matchedAmountUsdc: match?.matchedAmountRaw ? formatRawUsdc(match.matchedAmountRaw) : null,
      amountVarianceRaw: match?.amountVarianceRaw ?? null,
      amountVarianceUsdc: match?.amountVarianceRaw ? formatRawUsdc(match.amountVarianceRaw) : null,
      signature: match?.signature ?? latestExecution?.submittedSignature ?? null,
      observedEventTime: match?.observedEventTime ?? null,
      matchedAt: match?.matchedAt ?? null,
      confidenceBand: match?.confidenceBand ?? null,
      reconciliationOutcome: reconciliationExplanation?.outcome ?? null,
      reconciliationSummary: reconciliationExplanation?.summary ?? null,
    },
    exceptions: reconciliation?.exceptions.map((exception) => ({
      exceptionId: exception.exceptionId,
      type: exception.exceptionType,
      reasonCode: exception.reasonCode,
      status: exception.status,
      severity: exception.severity,
      explanation: exception.explanation,
      signature: exception.signature,
    })) ?? [],
    verification: {
      reconciliation: reconciliationExplanation,
      checks: readiness.checks,
    },
    sourceArtifacts: {
      paymentRequest: detail.paymentRequest,
      paymentOrderEvents: detail.events,
      transferRequestEvents: reconciliation?.events ?? [],
      executionRecords: reconciliation?.executionRecords ?? [],
      observedTransfers: reconciliation?.linkedObservedTransfers ?? [],
      observedPayment: reconciliation?.linkedObservedPayment ?? null,
    },
    agentSummary: {
      recommendedAction: reconciliationExplanation?.recommendedAction ?? readiness.recommendedAction,
      canTreatAsFinal: readiness.status === 'complete',
      needsHumanReview: readiness.status === 'needs_review' || readiness.status === 'blocked',
    },
    auditTrail: reconciliation?.timeline ?? [],
  };
  const canonicalDigest = buildCanonicalDigest(packetBody);

  return {
    proofId: `decimal_payment_proof_${canonicalDigest.slice(0, 24)}`,
    canonicalDigest,
    canonicalDigestAlgorithm: 'sha256:stable-json-v1',
    generatedAt: new Date().toISOString(),
    ...packetBody,
  };
}

function deriveProofStatus(derivedState: PaymentOrderState, requestDisplayState: string | null) {
  if (derivedState === 'closed') {
    return 'closed';
  }
  if (requestDisplayState === 'matched' || derivedState === 'settled') {
    return 'complete';
  }
  if (requestDisplayState === 'partial' || derivedState === 'partially_settled') {
    return 'partial';
  }
  if (requestDisplayState === 'exception' || derivedState === 'exception') {
    return 'exception';
  }
  return 'in_progress';
}

type ProofCheckStatus = 'pass' | 'pending' | 'warn' | 'fail';

function deriveProofReadiness(args: {
  proofStatus: ReturnType<typeof deriveProofStatus>;
  approvalState: string;
  derivedState: PaymentOrderState;
  latestExecution: LatestExecution;
  reconciliationExplanation: Awaited<ReturnType<typeof getReconciliationExplanation>> | null;
  exceptionCount: number;
}) {
  const externalExecutionReference = getMetadataString(args.latestExecution?.metadataJson, 'externalExecutionReference');
  const checks = [
    buildProofCheck(
      'intent_captured',
      'Payment intent is captured',
      'pass',
      'Payment request/order fields are present in the proof packet.',
    ),
    buildProofCheck(
      'approval_cleared',
      'Approval is cleared',
      args.approvalState === 'approved' || args.proofStatus === 'complete' || args.proofStatus === 'closed'
        ? 'pass'
        : args.approvalState === 'rejected'
          ? 'fail'
          : 'pending',
      `Approval state is ${args.approvalState}.`,
    ),
    buildProofCheck(
      'execution_evidence_present',
      'Execution evidence is present',
      args.latestExecution?.submittedSignature || externalExecutionReference
        ? 'pass'
        : args.derivedState === 'draft' || args.derivedState === 'approved'
          ? 'pending'
          : 'warn',
      args.latestExecution?.submittedSignature
        ? `Submitted signature ${args.latestExecution.submittedSignature}.`
        : externalExecutionReference
          ? `External execution reference ${externalExecutionReference}.`
          : 'No execution signature or external reference is attached.',
    ),
    buildProofCheck(
      'settlement_reconciled',
      'Settlement is reconciled',
      args.proofStatus === 'complete' || args.proofStatus === 'closed'
        ? 'pass'
        : args.proofStatus === 'partial' || args.proofStatus === 'exception'
          ? 'warn'
          : 'pending',
      args.reconciliationExplanation?.summary ?? 'No reconciliation outcome is final yet.',
    ),
    buildProofCheck(
      'exceptions_resolved',
      'Exceptions are resolved or absent',
      args.exceptionCount === 0
        ? 'pass'
        : args.proofStatus === 'partial' || args.proofStatus === 'exception'
          ? 'warn'
          : 'pending',
      args.exceptionCount === 0 ? 'No exceptions are linked.' : `${args.exceptionCount} exception(s) are linked.`,
    ),
  ];
  const blockers = checks.filter((check) => check.status === 'fail').map((check) => check.id);
  const warnings = checks.filter((check) => check.status === 'warn').map((check) => check.id);
  const pending = checks.filter((check) => check.status === 'pending').map((check) => check.id);
  const status = blockers.length
    ? 'blocked'
    : warnings.length
      ? 'needs_review'
      : pending.length
        ? 'in_progress'
        : 'complete';

  return {
    status,
    blockers,
    warnings,
    pending,
    checks,
    recommendedAction:
      status === 'complete'
        ? 'archive_or_share_proof'
        : args.reconciliationExplanation?.recommendedAction ?? 'continue_payment_workflow',
  };
}

function buildProofCheck(id: string, label: string, status: ProofCheckStatus, detail: string) {
  return {
    id,
    label,
    status,
    detail,
  };
}

function getMetadataString(value: unknown, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

function formatRawUsdc(amountRaw: string) {
  const negative = amountRaw.startsWith('-');
  const digits = negative ? amountRaw.slice(1) : amountRaw;
  const padded = digits.padStart(7, '0');
  const whole = padded.slice(0, -6) || '0';
  const fraction = padded.slice(-6);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
