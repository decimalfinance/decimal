import type {
  CollectionRequest,
  CollectionRequestState,
  CollectionRunSummary,
  CollectionSourceTrustState,
  Destination,
  PaymentOrder,
  PaymentOrderState,
  PaymentRun,
} from './api';

const PAYMENT_STATUS: Record<PaymentOrderState, string> = {
  draft: 'Draft',
  pending_approval: 'Needs approval',
  approved: 'Approved',
  ready: 'Ready',
  proposed: 'Proposed',
  ready_for_execution: 'Ready to sign',
  proposal_prepared: 'Proposal prepared',
  proposal_submitted: 'Proposal active',
  proposal_approved: 'Proposal approved',
  proposal_executed: 'Executed',
  execution_recorded: 'Executed',
  executed: 'Executed',
  partially_settled: 'Partial',
  settled: 'Completed',
  exception: 'Needs review',
  closed: 'Completed',
  cancelled: 'Cancelled',
};

export function displayPaymentStatus(state: string): string {
  if (state in PAYMENT_STATUS) return PAYMENT_STATUS[state as PaymentOrderState];
  return state.replaceAll('_', ' ');
}

export function statusToneForPayment(derivedState: string): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (derivedState) {
    case 'settled':
    case 'closed':
      return 'success';
    case 'approved':
    case 'ready':
    case 'draft':
      return 'neutral';
    case 'pending_approval':
    case 'proposed':
    case 'ready_for_execution':
    case 'proposal_prepared':
    case 'proposal_submitted':
    case 'proposal_approved':
    case 'execution_recorded':
      return 'warning';
    case 'partially_settled':
      return 'warning';
    case 'exception':
    case 'cancelled':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function nextPaymentAction(order: PaymentOrder): string {
  switch (order.derivedState) {
    case 'draft':
      return 'Complete request';
    case 'pending_approval':
      return 'Approve or reject';
    case 'approved':
      return order.sourceTreasuryWalletId ? 'Prepare transaction' : 'Choose source wallet';
    case 'ready_for_execution':
      return 'Sign and submit';
    case 'ready':
      return order.sourceTreasuryWallet?.source === 'squads_v4' ? 'Create proposal' : 'Sign and submit';
    case 'proposed':
      return 'Approve proposal';
    case 'proposal_prepared':
      return 'Submit proposal';
    case 'proposal_submitted':
      return 'Approve proposal';
    case 'proposal_approved':
      return 'Execute proposal';
    case 'proposal_executed':
    case 'executed':
      return 'Wait for settlement';
    case 'execution_recorded':
      return 'Wait for settlement';
    case 'partially_settled':
    case 'exception':
      return 'Review exception';
    case 'settled':
    case 'closed':
      return 'Export proof';
    case 'cancelled':
      return '—';
    default:
      return 'Review';
  }
}

export type ExecutionBucket =
  | 'needs_source'
  | 'ready_to_prepare'
  | 'ready_to_sign'
  | 'executed'
  | 'needs_review';

export const EXECUTION_BUCKETS: ExecutionBucket[] = ['needs_source', 'ready_to_prepare', 'ready_to_sign', 'executed', 'needs_review'];

export function paymentExecutionBucket(order: PaymentOrder): ExecutionBucket | null {
  const s = order.derivedState;
  if (s === 'exception' || s === 'partially_settled') return 'needs_review';
  if (s === 'execution_recorded' || s === 'proposal_executed' || s === 'executed') return 'executed';
  if (s === 'proposed') return 'ready_to_sign';
  if (s === 'proposal_prepared' || s === 'proposal_submitted' || s === 'proposal_approved') return 'ready_to_sign';
  if (s === 'ready_for_execution') return 'ready_to_sign';
  if (s === 'approved') {
    return order.sourceTreasuryWalletId ? 'ready_to_prepare' : 'needs_source';
  }
  return null;
}

export function executionBucketTitle(bucket: ExecutionBucket): string {
  switch (bucket) {
    case 'needs_source':
      return 'Needs source wallet';
    case 'ready_to_prepare':
      return 'Ready to prepare';
    case 'ready_to_sign':
      return 'Ready to sign';
    case 'executed':
      return 'Executed — settling';
    case 'needs_review':
      return 'Needs execution review';
    default:
      return bucket;
  }
}

const RUN_STATUS: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'In approval',
  approved: 'Approved',
  ready: 'Ready',
  proposed: 'Proposed',
  ready_for_execution: 'Ready to sign',
  proposal_prepared: 'Proposal prepared',
  proposal_submitted: 'Proposal active',
  proposal_approved: 'Proposal approved',
  proposal_executed: 'Executed',
  execution_recorded: 'Executed',
  executed: 'Executed',
  partially_settled: 'Partial',
  settled: 'Completed',
  exception: 'Needs review',
  closed: 'Completed',
  cancelled: 'Cancelled',
};

export function displayRunStatus(derivedState: string): string {
  return RUN_STATUS[derivedState] ?? derivedState.replaceAll('_', ' ');
}

export function runProgressLine(run: PaymentRun): string {
  const t = run.totals;
  return `${t.settledCount}/${t.orderCount} settled · ${t.exceptionCount} exc · ${t.pendingApprovalCount} in approval`;
}

export function trustDisplay(trust: Destination['trustState']): string {
  switch (trust) {
    case 'trusted':
      return 'Trusted';
    case 'restricted':
      return 'Restricted';
    case 'blocked':
      return 'Blocked';
    default:
      return 'Unreviewed';
  }
}

export function approvalReasonLine(order: PaymentOrder): string {
  const reasons = order.reconciliationDetail?.approvalEvaluation?.reasons ?? [];
  if (!reasons.length) return '—';
  return reasons
    .map((r) => r.message.replace(/\s+and cannot skip approval\.?$/i, '.'))
    .join(' · ');
}

export function humanizeExceptionReason(code: string): string {
  return code.replaceAll('_', ' ');
}

export function isPaymentOrderState(s: string): boolean {
  return (
    s === 'draft' ||
    s === 'pending_approval' ||
    s === 'approved' ||
    s === 'ready_for_execution' ||
    s === 'execution_recorded' ||
    s === 'partially_settled' ||
    s === 'settled' ||
    s === 'exception' ||
    s === 'closed' ||
    s === 'cancelled'
  );
}

export function displayReconciliationState(state: string): string {
  const map: Record<string, string> = {
    pending: 'Pending',
    matched: 'Matched',
    partial: 'Partial',
    exception: 'Exception',
  };
  return map[state] ?? state.replaceAll('_', ' ');
}

const COLLECTION_STATUS: Record<CollectionRequestState, string> = {
  open: 'Awaiting payment',
  partially_collected: 'Partial',
  collected: 'Collected',
  exception: 'Needs review',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export function displayCollectionStatus(state: string): string {
  if (state in COLLECTION_STATUS) return COLLECTION_STATUS[state as CollectionRequestState];
  return state.replaceAll('_', ' ');
}

export function statusToneForCollection(
  derivedState: string,
): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (derivedState) {
    case 'collected':
    case 'closed':
      return 'success';
    case 'open':
      return 'warning';
    case 'partially_collected':
      return 'warning';
    case 'exception':
    case 'cancelled':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function nextCollectionAction(collection: CollectionRequest): string {
  switch (collection.derivedState) {
    case 'open':
      return 'Awaiting payer';
    case 'partially_collected':
      return 'Review partial receipt';
    case 'exception':
      return 'Review exception';
    case 'collected':
    case 'closed':
      return 'Collected';
    case 'cancelled':
      return '—';
    default:
      return 'Review';
  }
}

export function collectionRunProgressLine(run: CollectionRunSummary): string {
  const s = run.summary;
  return `${s.collected}/${s.total} collected · ${s.exception} exc · ${s.partiallyCollected} partial`;
}

const COLLECTION_SOURCE_TRUST: Record<CollectionSourceTrustState, string> = {
  unreviewed: 'Unreviewed',
  trusted: 'Trusted',
  restricted: 'Restricted',
  blocked: 'Blocked',
};

export function displayCollectionSourceTrust(trust: string): string {
  if (trust in COLLECTION_SOURCE_TRUST) {
    return COLLECTION_SOURCE_TRUST[trust as CollectionSourceTrustState];
  }
  return trust.replaceAll('_', ' ');
}

export function collectionSourceTrustTone(
  trust: string,
): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (trust) {
    case 'trusted':
      return 'success';
    case 'unreviewed':
      return 'warning';
    case 'restricted':
    case 'blocked':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function isAutoGeneratedSourceLabel(label: string, walletAddress: string): boolean {
  // Backend fallback uses `${wallet.slice(0,6)}...${wallet.slice(-6)}` when no name is provided
  return label === `${walletAddress.slice(0, 6)}...${walletAddress.slice(-6)}`;
}

export function displayCollectionSourceName(label: string, walletAddress: string): string {
  return isAutoGeneratedSourceLabel(label, walletAddress) ? 'Unknown' : label;
}

export function hasRealDestinationName(label: string, walletAddress: string): boolean {
  return !isAutoGeneratedSourceLabel(label, walletAddress);
}

export function displayPaymentRequestState(state: string): string {
  const map: Record<string, string> = {
    submitted: 'Submitted',
    converted_to_order: 'Converted',
    cancelled: 'Cancelled',
  };
  return map[state] ?? state.replaceAll('_', ' ');
}

export function toneForGenericState(state: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const normalized = state.toLowerCase();
  if (normalized.includes('settled') || normalized.includes('complete') || normalized.includes('approved') || normalized.includes('matched') || normalized.includes('sufficient') || normalized.includes('trusted')) {
    return 'success';
  }
  if (normalized.includes('partial') || normalized.includes('waiting') || normalized.includes('ready') || normalized.includes('pending') || normalized.includes('unknown') || normalized.includes('unreviewed')) {
    return 'warning';
  }
  if (
    normalized.includes('exception') ||
    normalized.includes('review') ||
    normalized.includes('cancel') ||
    normalized.includes('reject') ||
    normalized.includes('insufficient') ||
    normalized.includes('blocked') ||
    normalized.includes('restricted')
  ) {
    return 'danger';
  }
  return 'neutral';
}
