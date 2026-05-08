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
