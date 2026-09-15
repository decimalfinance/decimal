/**
 * A bill allowed past the organization's bill ceiling, one bill at a time.
 *
 * The ceiling is the org's standing rule about how big a bill may be. Raising
 * it is the only thing that used to clear the flag, and raising it clears the
 * flag for EVERY bill over the line — which is the wrong instrument when one
 * genuine invoice is large and the rest of the queue is not.
 *
 * So: a named person allows THIS bill, with a reason, and the ceiling stays
 * where it is. The grant is the audit record, exactly as clearing a duplicate
 * is. Primary admin only — the ceiling is the org's hardest money control, and
 * an exception any admin could grant is not a ceiling.
 *
 * The grant is pinned to the amount it was granted for. An exception says "this
 * invoice, for this much, is fine"; it must not silently cover the same bill
 * after somebody edits the total. A changed amount voids it and the bill blocks
 * again, the same way a changed payout destination voids an approval.
 */

export type CeilingException = {
  byUserId: string;
  byName: string;
  reason: string;
  at: string;
  /** The amount this was granted for, minor units, decimal string. */
  amountRaw: string;
  /** The ceiling in force when it was granted, minor units, decimal string. */
  ceilingMinor: string;
};

export function readCeilingException(metadata: unknown): CeilingException | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const o = (metadata as Record<string, unknown>).ceilingException;
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.byUserId !== 'string' || typeof r.reason !== 'string') return null;
  if (typeof r.amountRaw !== 'string') return null;
  return {
    byUserId: r.byUserId,
    byName: typeof r.byName === 'string' ? r.byName : 'an admin',
    reason: r.reason,
    at: typeof r.at === 'string' ? r.at : new Date(0).toISOString(),
    amountRaw: r.amountRaw,
    ceilingMinor: typeof r.ceilingMinor === 'string' ? r.ceilingMinor : '0',
  };
}

/**
 * Does this grant still cover the bill in front of us?
 *
 * Only if the bill is still for the amount somebody signed off on. Anything
 * else — an edited total, a short-pay decision that moved the figure — is a
 * different bill than the one that was excepted.
 */
export function ceilingExceptionCovers(exception: CeilingException, amountRaw: bigint): boolean {
  return exception.amountRaw === amountRaw.toString();
}

/**
 * The one place that answers "may this bill pass the ceiling?", so the draft
 * flag and the release gate cannot drift apart. Returns null when it may not.
 */
export function activeCeilingException(metadata: unknown, amountRaw: bigint): CeilingException | null {
  const exception = readCeilingException(metadata);
  if (!exception) return null;
  return ceilingExceptionCovers(exception, amountRaw) ? exception : null;
}
