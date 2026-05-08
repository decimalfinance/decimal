import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type { DecimalProposal } from '../types';

export type SettlementVerificationStatus =
  | 'settled'
  | 'pending'
  | 'mismatch'
  | 'not_applicable';

// Reads the RPC settlement verification status that the backend persists in
// proposal.metadataJson.rpcSettlementVerification.status. Returns null if
// the proposal has not yet been verified (e.g. proposal is still
// approved/submitted, or the backend hasn't run verification yet).
export function readSettlementVerificationStatus(
  proposal: DecimalProposal | null | undefined,
): SettlementVerificationStatus | null {
  if (!proposal) return null;
  const meta = proposal.metadataJson;
  if (!meta || typeof meta !== 'object') return null;
  const verification = (meta as Record<string, unknown>).rpcSettlementVerification;
  if (!verification || typeof verification !== 'object') return null;
  const status = (verification as Record<string, unknown>).status;
  if (
    status === 'settled'
    || status === 'pending'
    || status === 'mismatch'
    || status === 'not_applicable'
  ) {
    return status;
  }
  return null;
}

export function readSettlementVerificationReason(
  proposal: DecimalProposal | null | undefined,
): string | null {
  if (!proposal) return null;
  const meta = proposal.metadataJson;
  if (!meta || typeof meta !== 'object') return null;
  const verification = (meta as Record<string, unknown>).rpcSettlementVerification;
  if (!verification || typeof verification !== 'object') return null;
  const reason = (verification as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : null;
}

// Detects the backend's retryable confirmation errors:
//   - "Transaction signature is not confirmed yet." (verifyRpcSignatureConfirmed)
//   - "Execution transaction was confirmed, but USDC settlement could not be
//      verified from RPC yet." (verifySquadsProposalSettlement, transient)
// Both cases mean the on-chain side may already have happened — the user
// should stay on a retry banner rather than recreate the proposal.
export function isRetryableConfirmationError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 400) return false;
  return /(not confirmed yet|could not be verified from RPC yet)/i.test(err.message);
}

// Auto-retry settlement verification while the proposal has an executed
// signature stored but RPC settlement could not yet be verified.
// confirm-execution is idempotent on the backend for the same signature: it
// only re-runs verification and upgrades downstream state if verification
// now passes.
//
// Pass `invalidationKeys` so the hook knows which react-query caches to
// refresh after a successful retry.
export function useAutoRetryProposalVerification(args: {
  organizationId: string | undefined;
  proposal: DecimalProposal | null | undefined;
  invalidationKeys: ReadonlyArray<readonly unknown[]>;
  intervalMs?: number;
}) {
  const queryClient = useQueryClient();
  const status = readSettlementVerificationStatus(args.proposal);
  const proposalId = args.proposal?.decimalProposalId;
  const signature = args.proposal?.executedSignature;
  const intervalMs = args.intervalMs ?? 6_000;
  // Pre-stringify so the dep array stays stable across renders even when the
  // caller constructs a fresh array each time.
  const invalidationKey = JSON.stringify(args.invalidationKeys);

  useEffect(() => {
    if (!args.organizationId) return;
    if (!proposalId) return;
    if (!signature) return;
    if (status !== 'pending') return;
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      if (cancelled) return;
      try {
        await api.confirmProposalExecution(args.organizationId!, proposalId, { signature });
        for (const key of args.invalidationKeys) {
          await queryClient.invalidateQueries({ queryKey: key as readonly unknown[] });
        }
      } catch {
        // Stay on pending; the next render schedules another retry.
      }
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
    // invalidationKey is the stable serialization of args.invalidationKeys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.organizationId, proposalId, signature, status, intervalMs, invalidationKey, queryClient]);
}
