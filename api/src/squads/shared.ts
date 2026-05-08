import type { Prisma } from '@prisma/client';
import type { verifyUsdcSettlementFromSignature } from '../solana.js';

// Provider tag used wherever payment / proposal records record their on-
// chain origin. Centralized here so both squads-treasury and the marker
// helpers reference the same string without needing a circular import.
export const SQUADS_SOURCE = 'squads_v4';

// Discriminated union returned by verifySquadsProposalSettlement. The
// helper never throws — the caller decides what to persist for each
// status. 'settled' = on-chain deltas match expectations. 'mismatch' =
// tx confirmed but USDC deltas don't match (alarming, surface to user
// but still persist signature). 'pending' = RPC hasn't yet indexed the
// parsed tx (transient, retry later). 'not_applicable' = the proposal
// isn't a USDC settlement (e.g. config_transaction).
export type SquadsSettlementVerification =
  | {
      status: 'settled';
      signature: string;
      checkedAt: string;
      items: Awaited<ReturnType<typeof verifyUsdcSettlementFromSignature>>['items'];
    }
  | {
      status: 'mismatch';
      signature: string;
      checkedAt: string;
      items: Awaited<ReturnType<typeof verifyUsdcSettlementFromSignature>>['items'];
    }
  | {
      status: 'pending';
      signature: string;
      checkedAt: string;
      reason: string;
    }
  | { status: 'not_applicable' };

export function isSettlementSettled(verification: SquadsSettlementVerification) {
  return verification.status === 'settled' || verification.status === 'not_applicable';
}

export function serializeSettlementVerification(
  verification: SquadsSettlementVerification,
): Prisma.InputJsonValue {
  return verification as unknown as Prisma.InputJsonValue;
}

export function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeJsonObject(value: unknown, next: Prisma.InputJsonObject): Prisma.InputJsonObject {
  const base = isRecordLike(value) ? ({ ...value } as Prisma.InputJsonObject) : {};
  return {
    ...base,
    ...next,
  } satisfies Prisma.InputJsonObject;
}
