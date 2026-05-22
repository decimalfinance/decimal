import type {
  CollectionRequest,
  CollectionRequestState,
  CollectionRunSummary,
  CounterpartyWallet,
  CounterpartyWalletTrustState,
  PaymentOrder,
  PaymentOrderState,
} from './api';

const PAYMENT_STATUS: Record<PaymentOrderState, string> = {
  needs_review: 'Needs review',
  // Internally approved, agent will propose next. Display as "Reviewing"
  // because from the user's perspective the system is still working on it.
  draft: 'Reviewing',
  proposed: 'Proposal active',
  executed: 'Executed',
  settled: 'Completed',
  cancelled: 'Cancelled',
};

export function displayPaymentStatus(state: string): string {
  if (state in PAYMENT_STATUS) return PAYMENT_STATUS[state as PaymentOrderState];
  return state.replaceAll('_', ' ');
}

export function statusToneForPayment(derivedState: string): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (derivedState) {
    case 'settled':
      return 'success';
    case 'draft':
      return 'neutral';
    case 'proposed':
    case 'executed':
      return 'warning';
    case 'needs_review':
      return 'warning';
    case 'cancelled':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function nextPaymentAction(order: PaymentOrder): string {
  switch (order.derivedState) {
    case 'needs_review':
      return 'Approve or reject';
    case 'draft':
      return order.sourceTreasuryWalletId ? 'Submit for approval' : 'Choose source wallet';
    case 'proposed':
      return 'Approve proposal';
    case 'executed':
      return 'Wait for settlement';
    case 'settled':
      return 'Export proof';
    case 'cancelled':
      return '—';
    default:
      return 'Review';
  }
}

export function trustDisplay(trust: CounterpartyWallet['trustState']): string {
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

export function humanizeExceptionReason(code: string): string {
  return code.replaceAll('_', ' ');
}

// Maps the 4-tone palette used by status labels to the 4-tone palette used
// by the rd-pill UI primitive. 'neutral' becomes 'info' on the pill side.
export function toneToPill(
  tone: 'success' | 'warning' | 'danger' | 'neutral',
): 'success' | 'warning' | 'danger' | 'info' {
  return tone === 'success'
    ? 'success'
    : tone === 'danger'
      ? 'danger'
      : tone === 'warning'
        ? 'warning'
        : 'info';
}

export function isPaymentOrderState(s: string): boolean {
  return (
    s === 'needs_review' ||
    s === 'draft' ||
    s === 'proposed' ||
    s === 'executed' ||
    s === 'settled' ||
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

const WALLET_TRUST: Record<CounterpartyWalletTrustState, string> = {
  unreviewed: 'Unreviewed',
  trusted: 'Trusted',
  restricted: 'Restricted',
  blocked: 'Blocked',
};

export function displayWalletTrust(trust: string): string {
  if (trust in WALLET_TRUST) {
    return WALLET_TRUST[trust as CounterpartyWalletTrustState];
  }
  return trust.replaceAll('_', ' ');
}

export function walletTrustTone(
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

export function isAutoGeneratedWalletLabel(label: string, walletAddress: string): boolean {
  // Backend fallback uses `${wallet.slice(0,6)}...${wallet.slice(-6)}` when no name is provided
  return label === `${walletAddress.slice(0, 6)}...${walletAddress.slice(-6)}`;
}

export function displayWalletLabel(label: string, walletAddress: string): string {
  return isAutoGeneratedWalletLabel(label, walletAddress) ? 'Unknown' : label;
}

export function hasRealWalletLabel(label: string, walletAddress: string): boolean {
  return !isAutoGeneratedWalletLabel(label, walletAddress);
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
