import { getCollectionRequestDetail, getCollectionRunDetail } from './requests.js';
import { buildCanonicalDigest } from '../proof-packet.js';
import { getReconciliationExplanation } from '../transfer-requests/settlement-read-model.js';

type CollectionRequestDetail = Awaited<ReturnType<typeof getCollectionRequestDetail>>;
type CollectionProofDetail = 'summary' | 'compact' | 'full';
type ProofCheckStatus = 'pass' | 'pending' | 'warn' | 'fail';

export async function buildCollectionProofPacket(organizationId: string, collectionRequestId: string) {
  const detail = await getCollectionRequestDetail(organizationId, collectionRequestId);
  const reconciliation = detail.reconciliationDetail;
  const match = reconciliation?.match ?? null;
  const reconciliationExplanation = detail.transferRequestId
    ? await getReconciliationExplanation(organizationId, detail.transferRequestId)
    : null;
  const sourceReview = deriveSourceReview(detail);
  const proofStatus = deriveCollectionProofStatus(detail.derivedState, reconciliation?.requestDisplayState ?? null);
  const readiness = deriveCollectionProofReadiness({
    proofStatus,
    sourceReview,
    reconciliationExplanation,
    exceptionCount: reconciliation?.exceptions.length ?? 0,
  });

  const packetBody = {
    packetType: 'stablecoin_collection_proof',
    version: 1,
    organizationId,
    status: proofStatus,
    readiness,
    intent: {
      collectionRequestId: detail.collectionRequestId,
      collectionRunId: detail.collectionRunId,
      transferRequestId: detail.transferRequestId,
      reference: detail.externalReference,
      reason: detail.reason,
      amountRaw: detail.amountRaw,
      amountUsdc: formatRawUsdc(detail.amountRaw),
      asset: detail.asset,
      dueAt: detail.dueAt,
      createdAt: detail.createdAt,
    },
    parties: {
      payer: detail.collectionSource ? {
        collectionSourceId: detail.collectionSource.collectionSourceId,
        label: detail.collectionSource.label,
        walletAddress: detail.collectionSource.walletAddress,
        tokenAccountAddress: detail.collectionSource.tokenAccountAddress,
        trustState: detail.collectionSource.trustState,
        sourceType: detail.collectionSource.sourceType,
      } : detail.payerWalletAddress ? {
        collectionSourceId: null,
        label: null,
        walletAddress: detail.payerWalletAddress,
        tokenAccountAddress: detail.payerTokenAccountAddress,
        trustState: 'unreviewed',
        sourceType: 'ad_hoc_payer_wallet',
      } : null,
      receiver: {
        treasuryWalletId: detail.receivingTreasuryWallet.treasuryWalletId,
        label: detail.receivingTreasuryWallet.displayName,
        walletAddress: detail.receivingTreasuryWallet.address,
        usdcAtaAddress: detail.receivingTreasuryWallet.usdcAtaAddress,
      },
      counterparty: detail.counterparty ? {
        counterpartyId: detail.counterparty.counterpartyId,
        displayName: detail.counterparty.displayName,
      } : null,
    },
    collectionSourceReview: sourceReview,
    settlement: {
      state: reconciliation?.requestDisplayState ?? null,
      matchStatus: match?.matchStatus ?? null,
      matchRule: match?.matchRule ?? null,
      matchedAmountRaw: match?.matchedAmountRaw ?? null,
      matchedAmountUsdc: match?.matchedAmountRaw ? formatRawUsdc(match.matchedAmountRaw) : null,
      amountVarianceRaw: match?.amountVarianceRaw ?? null,
      amountVarianceUsdc: match?.amountVarianceRaw ? formatRawUsdc(match.amountVarianceRaw) : null,
      signature: match?.signature ?? null,
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
      collectionRequestEvents: detail.events,
      transferRequestEvents: reconciliation?.events ?? [],
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
    proofId: `decimal_collection_proof_${canonicalDigest.slice(0, 24)}`,
    canonicalDigest,
    canonicalDigestAlgorithm: 'sha256:stable-json-v1',
    generatedAt: new Date().toISOString(),
    ...packetBody,
  };
}

export async function buildCollectionRunProofPacket(
  organizationId: string,
  collectionRunId: string,
  options: { detail?: CollectionProofDetail } = {},
) {
  const detailLevel = options.detail ?? 'summary';
  const detail = await getCollectionRunDetail(organizationId, collectionRunId);
  const collectionProofs = await Promise.all(
    detail.collectionRequests.map((collection) =>
      buildCollectionProofPacket(organizationId, collection.collectionRequestId),
    ),
  );
  const proofByCollectionId = new Map(collectionProofs.map((proof) => [proof.intent.collectionRequestId, proof]));
  const readiness = deriveRunReadiness(collectionProofs);
  const collections = detail.collectionRequests.map((collection) => {
    const proof = proofByCollectionId.get(collection.collectionRequestId);
    return {
      collectionRequestId: collection.collectionRequestId,
      transferRequestId: collection.transferRequestId,
      receivingTreasuryWalletId: collection.receivingTreasuryWalletId,
      payer: collection.collectionSource ? {
        collectionSourceId: collection.collectionSource.collectionSourceId,
        label: collection.collectionSource.label,
        walletAddress: collection.collectionSource.walletAddress,
        trustState: collection.collectionSource.trustState,
      } : collection.payerWalletAddress ? {
        collectionSourceId: null,
        label: null,
        walletAddress: collection.payerWalletAddress,
        trustState: 'unreviewed',
      } : null,
      receiver: {
        treasuryWalletId: collection.receivingTreasuryWallet.treasuryWalletId,
        label: collection.receivingTreasuryWallet.displayName,
        walletAddress: collection.receivingTreasuryWallet.address,
      },
      amountRaw: collection.amountRaw,
      asset: collection.asset,
      reference: collection.externalReference,
      state: collection.derivedState,
      settlementState: collection.reconciliationDetail?.requestDisplayState ?? null,
      matchStatus: collection.reconciliationDetail?.match?.matchStatus ?? null,
      matchedAmountRaw: collection.reconciliationDetail?.match?.matchedAmountRaw ?? null,
      exceptionCount: collection.reconciliationDetail?.exceptions.length ?? 0,
      sourceReviewStatus: proof?.collectionSourceReview.status ?? null,
      proofStatus: proof?.status ?? 'in_progress',
      proofId: proof?.proofId ?? null,
      proofDigest: proof?.canonicalDigest ?? null,
      fullProofEndpoint: proof
        ? `/organizations/${organizationId}/collections/${collection.collectionRequestId}/proof`
        : null,
    };
  });
  const packetBody = {
    packetType: 'stablecoin_collection_run_proof',
    version: 1,
    detailLevel,
    organizationId,
    collectionRunId,
    runName: detail.runName,
    status: detail.derivedState,
    readiness,
    summary: detail.summary,
    collections,
    collectionProofs: detailLevel === 'summary'
      ? []
      : detailLevel === 'full'
        ? collectionProofs
        : collectionProofs.map(buildCollectionProofRef),
    agentSummary: {
      canTreatAsFinal: readiness.status === 'complete',
      needsHumanReview: readiness.status === 'needs_review' || readiness.status === 'blocked',
      recommendedAction: readiness.recommendedAction,
    },
  };
  const canonicalDigest = buildCanonicalDigest(packetBody);

  return {
    proofId: `decimal_collection_run_proof_${canonicalDigest.slice(0, 24)}`,
    canonicalDigest,
    canonicalDigestAlgorithm: 'sha256:stable-json-v1',
    generatedAt: new Date().toISOString(),
    ...packetBody,
  };
}

function deriveSourceReview(detail: CollectionRequestDetail) {
  const expectedSourceWallet =
    detail.collectionSource?.walletAddress
    ?? detail.payerWalletAddress
    ?? null;
  const expectedTrustState = detail.collectionSource?.trustState ?? (expectedSourceWallet ? 'unreviewed' : null);
  const observedSourceWallet = null;

  if (!expectedSourceWallet) {
    return {
      status: 'unspecified_source',
      severity: 'warning',
      expectedSourceWallet: null,
      observedSourceWallet,
      trustState: null,
      message: observedSourceWallet
        ? 'No payer source was specified. Proof includes the observed payer, but the payer was not pre-approved.'
        : 'No payer source was specified and no settlement source has been observed yet.',
    };
  }

  if (expectedTrustState === 'blocked' || expectedTrustState === 'restricted') {
    return {
      status: 'source_restricted',
      severity: expectedTrustState === 'blocked' ? 'error' : 'warning',
      expectedSourceWallet,
      observedSourceWallet,
      trustState: expectedTrustState,
      message: `Expected payer source is ${expectedTrustState}. Human review is required before treating this collection as final.`,
    };
  }

  if (!observedSourceWallet) {
    return {
      status: expectedTrustState === 'trusted' ? 'awaiting_observation' : 'source_needs_review',
      severity: expectedTrustState === 'trusted' ? 'info' : 'warning',
      expectedSourceWallet,
      observedSourceWallet: null,
      trustState: expectedTrustState,
      message: expectedTrustState === 'trusted'
        ? 'Trusted payer source is defined. Waiting for observed settlement.'
        : 'Payer source is defined but not trusted yet. Review it before relying on the collection proof.',
    };
  }

  if (observedSourceWallet !== expectedSourceWallet) {
    return {
      status: 'source_mismatch',
      severity: 'error',
      expectedSourceWallet,
      observedSourceWallet,
      trustState: expectedTrustState,
      message: 'Observed payer does not match the expected collection source.',
    };
  }

  return {
    status: expectedTrustState === 'trusted' ? 'pass' : 'source_needs_review',
    severity: expectedTrustState === 'trusted' ? 'none' : 'warning',
    expectedSourceWallet,
    observedSourceWallet,
    trustState: expectedTrustState,
    message: expectedTrustState === 'trusted'
      ? 'Observed payer matches a trusted collection source.'
      : 'Observed payer matches the expected source, but that source is not trusted yet.',
  };
}

function deriveCollectionProofStatus(derivedState: string, requestDisplayState: string | null) {
  if (derivedState === 'closed') {
    return 'closed';
  }
  if (requestDisplayState === 'matched' || derivedState === 'collected') {
    return 'complete';
  }
  if (requestDisplayState === 'partial' || derivedState === 'partially_collected') {
    return 'partial';
  }
  if (requestDisplayState === 'exception' || derivedState === 'exception') {
    return 'exception';
  }
  if (derivedState === 'cancelled') {
    return 'cancelled';
  }
  return 'in_progress';
}

function deriveCollectionProofReadiness(args: {
  proofStatus: ReturnType<typeof deriveCollectionProofStatus>;
  sourceReview: ReturnType<typeof deriveSourceReview>;
  reconciliationExplanation: Awaited<ReturnType<typeof getReconciliationExplanation>> | null;
  exceptionCount: number;
}) {
  const sourceStatus = args.sourceReview.status;
  const sourceCheckStatus: ProofCheckStatus =
    sourceStatus === 'pass' ? 'pass'
      : sourceStatus === 'source_mismatch' || sourceStatus === 'source_restricted' ? 'fail'
        : sourceStatus === 'awaiting_observation' ? 'pending'
          : 'warn';
  const checks = [
    buildProofCheck(
      'collection_intent_captured',
      'Collection intent is captured',
      'pass',
      'Expected receiver, amount, reason, and reference are present in the proof packet.',
    ),
    buildProofCheck(
      'payer_source_reviewed',
      'Payer source is reviewed',
      sourceCheckStatus,
      args.sourceReview.message,
    ),
    buildProofCheck(
      'settlement_reconciled',
      'Settlement is reconciled',
      args.proofStatus === 'complete' || args.proofStatus === 'closed'
        ? 'pass'
        : args.proofStatus === 'partial' || args.proofStatus === 'exception'
          ? 'warn'
          : args.proofStatus === 'cancelled'
            ? 'fail'
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
        ? 'archive_or_share_collection_proof'
        : args.reconciliationExplanation?.recommendedAction ?? 'continue_collection_workflow',
  };
}

function buildCollectionProofRef(proof: Awaited<ReturnType<typeof buildCollectionProofPacket>>) {
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
    intent: proof.intent,
    parties: proof.parties,
    collectionSourceReview: proof.collectionSourceReview,
    settlement: proof.settlement,
    exceptions: proof.exceptions.map((exception) => ({
      exceptionId: exception.exceptionId,
      type: exception.type,
      reasonCode: exception.reasonCode,
      status: exception.status,
      severity: exception.severity,
    })),
    agentSummary: proof.agentSummary,
    fullProofEndpoint: `/organizations/${proof.organizationId}/collections/${proof.intent.collectionRequestId}/proof`,
  };
}

function deriveRunReadiness(collectionProofs: Awaited<ReturnType<typeof buildCollectionProofPacket>>[]) {
  type RunReadinessStatus = 'complete' | 'in_progress' | 'needs_review' | 'blocked';
  const counts = collectionProofs.reduce(
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
        ? 'archive_or_share_collection_run_proof'
        : status === 'needs_review'
          ? 'review_collection_sources_or_exceptions'
          : status === 'blocked'
            ? 'fix_blocked_collections'
            : 'continue_collection_run_workflow',
  };

  function isRunReadinessStatus(value: string): value is RunReadinessStatus {
    return value === 'complete' || value === 'in_progress' || value === 'needs_review' || value === 'blocked';
  }
}

function buildProofCheck(id: string, label: string, status: ProofCheckStatus, detail: string) {
  return { id, label, status, detail };
}

function formatRawUsdc(amountRaw: string) {
  const negative = amountRaw.startsWith('-');
  const digits = negative ? amountRaw.slice(1) : amountRaw;
  const padded = digits.padStart(7, '0');
  const whole = padded.slice(0, -6) || '0';
  const fraction = padded.slice(-6);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
