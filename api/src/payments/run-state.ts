export const PAYMENT_RUN_STATES = [
  'draft',
  'approved',
  'ready',
  'proposed',
  'ready_for_execution',
  'executed',
  'execution_recorded',
  'submitted_onchain',
  'partially_settled',
  'settled',
  'exception',
  'closed',
  'cancelled',
] as const;

export type PaymentRunState = (typeof PAYMENT_RUN_STATES)[number];

export function isPaymentRunState(value: string): value is PaymentRunState {
  return PAYMENT_RUN_STATES.includes(value as PaymentRunState);
}

export function derivePaymentRunStateFromRows(
  storedState: string,
  orders: Array<{ derivedState: string }>,
): PaymentRunState | string {
  if (storedState === 'cancelled' || storedState === 'closed') {
    return storedState;
  }
  if (!orders.length) {
    return storedState;
  }
  const actionableOrders = orders.filter((order) => order.derivedState !== 'cancelled');
  if (!actionableOrders.length) {
    return storedState;
  }
  if (actionableOrders.some((order) => order.derivedState === 'exception')) {
    return 'exception';
  }
  if (actionableOrders.every((order) => ['settled', 'closed'].includes(order.derivedState))) {
    return 'settled';
  }
  if (actionableOrders.some((order) => order.derivedState === 'partially_settled')) {
    return 'partially_settled';
  }
  if (storedState === 'submitted_onchain') {
    return 'submitted_onchain';
  }
  if (storedState === 'executed' || actionableOrders.some((order) => order.derivedState === 'executed')) {
    return 'executed';
  }
  if (storedState === 'proposed' || actionableOrders.some((order) => order.derivedState === 'proposed')) {
    return 'proposed';
  }
  if (storedState === 'ready' || actionableOrders.some((order) => order.derivedState === 'ready')) {
    return 'ready';
  }
  if (actionableOrders.some((order) => order.derivedState === 'execution_recorded')) {
    return 'execution_recorded';
  }
  if (actionableOrders.every((order) => ['approved', 'ready_for_execution'].includes(order.derivedState))) {
    return 'ready_for_execution';
  }
  return storedState;
}

export function canCancelPaymentRun(args: {
  storedState: string;
  derivedState: string;
  orders: Array<{ derivedState: string; hasExecutionEvidence?: boolean }>;
}) {
  if (args.storedState === 'cancelled') {
    return { allowed: true, reason: null };
  }
  if (args.derivedState === 'closed' || args.derivedState === 'settled') {
    return { allowed: false, reason: `Payment run ${args.derivedState} cannot be cancelled` };
  }
  const blockedCount = args.orders.filter((order) =>
    order.hasExecutionEvidence
    || ['execution_recorded', 'submitted_onchain', 'settled', 'partially_settled', 'closed'].includes(order.derivedState),
  ).length;
  if (blockedCount) {
    return {
      allowed: false,
      reason: `${blockedCount} payment run row(s) already have execution evidence and cannot be cancelled as a run`,
    };
  }
  return { allowed: true, reason: null };
}

export function canClosePaymentRun(args: {
  derivedState: string;
  orders: Array<{ derivedState: string }>;
}) {
  if (args.derivedState === 'cancelled') {
    return { allowed: false, reason: 'Cancelled payment runs cannot be closed' };
  }
  const actionableOrders = args.orders.filter((order) => order.derivedState !== 'cancelled');
  if (!actionableOrders.length) {
    return { allowed: false, reason: 'Payment run has no actionable rows to close' };
  }
  const unsettledCount = actionableOrders.filter((order) => !['settled', 'closed'].includes(order.derivedState)).length;
  if (unsettledCount) {
    return { allowed: false, reason: `${unsettledCount} payment run row(s) are not settled yet` };
  }
  return { allowed: true, reason: null };
}
