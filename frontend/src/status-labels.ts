import type {
  CounterpartyWallet,
  CounterpartyWalletTrustState,
  PaymentOrder,
  PaymentOrderState,
} from './api';

const PAYMENT_STATUS: Record<PaymentOrderState, string> = {
  // Being prepared: read by the machine, not yet finished by a person, and not
  // in the approval engine. Nobody is waiting on it.
  draft: 'Draft',
  // A person confirmed it, so it was handed to approval. Where it is after
  // that is the engine's business — this column only says it left the desk.
  submitted: 'In approval',
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
    case 'submitted':
      return 'neutral';
    case 'proposed':
    case 'executed':
      return 'warning';
    case 'draft':
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