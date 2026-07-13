import type {
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

const WALLET_TRUST: Record<CounterpartyWalletTrustState, string> = {
  unreviewed: 'Unreviewed',
  trusted: 'Trusted',
  restricted: 'Restricted',
  blocked: 'Blocked',
};