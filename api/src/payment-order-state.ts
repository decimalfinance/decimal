export const PAYMENT_ORDER_STATES = [
  'draft',
  'pending_approval',
  'approved',
  'ready_for_execution',
  'proposal_prepared',
  'proposal_submitted',
  'proposal_approved',
  'proposal_executed',
  'execution_recorded',
  'partially_settled',
  'settled',
  'exception',
  'closed',
  'cancelled',
] as const;

export type PaymentOrderState = (typeof PAYMENT_ORDER_STATES)[number];

export function isPaymentOrderState(value: string): value is PaymentOrderState {
  return PAYMENT_ORDER_STATES.includes(value as PaymentOrderState);
}
