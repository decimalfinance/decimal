export const PAYMENT_ORDER_STATES = [
  'needs_review',
  'draft',
  'proposed',
  'executed',
  'settled',
  'cancelled',
] as const;

export type PaymentOrderState = (typeof PAYMENT_ORDER_STATES)[number];

export function isPaymentOrderState(value: string): value is PaymentOrderState {
  return PAYMENT_ORDER_STATES.includes(value as PaymentOrderState);
}
