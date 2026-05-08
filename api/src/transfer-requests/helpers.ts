// Shared helpers for navigating ordered transfer-request lists across
// payment-orders.ts and payment-runs.ts.

/**
 * Pick the most recently created transfer request from an order. The
 * generic shape lets callers pass any include-shape that exposes
 * createdAt (Date or ISO string) without imposing a specific Prisma
 * payload type.
 */
export function getPrimaryTransferRequest<T extends { createdAt: Date | string }>(
  order: { transferRequests: T[] },
): T | null {
  return [...order.transferRequests].sort((left, right) => {
    const leftMs = left.createdAt instanceof Date ? left.createdAt.getTime() : new Date(left.createdAt).getTime();
    const rightMs = right.createdAt instanceof Date ? right.createdAt.getTime() : new Date(right.createdAt).getTime();
    return rightMs - leftMs;
  })[0] ?? null;
}
