import type { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { errorToLogFields, logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { deriveUsdcAtaForWallet, verifyUsdcSettlementFromSignature } from '../solana.js';

// Background settlement reconciler.
//
// Auto-pay verification is best-effort at execution time: if the RPC is slow, the execution
// is recorded as 'submitted' and returned, rather than blocking the request. Without this
// reconciler those payments would stay 'submitted' forever even though they settled on-chain
// — the "stuck verifying" symptom. This loop re-verifies submitted executions by signature
// and promotes them, and reclaims stale never-sent reservations so they stop blocking retries.
//
// Scope: spending-limit (auto-pay) executions. Proposal-path settlement reconciliation is a
// natural follow-up that would reuse the same verify-by-signature primitive.

export type SettlementReconcilerDeps = {
  verifySettlement: typeof verifyUsdcSettlementFromSignature;
  now: () => Date;
};

const defaultDeps: SettlementReconcilerDeps = {
  verifySettlement: verifyUsdcSettlementFromSignature,
  now: () => new Date(),
};

// A 'prepared' reservation with no signature older than this never completed its send and is
// safe to release for retry. Conservative on purpose: the window between a successful send and
// recording its signature is sub-second, so a stale signature-less reservation is
// overwhelmingly a pre-send crash where no money moved.
const STALE_RESERVATION_MS = 10 * 60_000;
const BATCH = 25;

export type ReconcileSummary = {
  settled: number;
  mismatch: number;
  failed: number;
  reclaimed: number;
  pending: number;
};

/** tx landed and deltas matched → settled; tx landed, deltas wrong → mismatch. */
export function classifySettlementResult(result: { allSettled: boolean }): 'settled' | 'mismatch' {
  return result.allSettled ? 'settled' : 'mismatch';
}

/**
 * The verifier throws for two different reasons: the transaction is not visible yet (retry
 * later) or it failed on-chain (no money moved → release). Distinguish them by message.
 */
export function classifySettlementError(error: unknown): 'tx_failed' | 'pending' {
  const message = error instanceof Error ? error.message : '';
  return /failed on-chain/i.test(message) ? 'tx_failed' : 'pending';
}

export async function reconcilePendingSettlements(
  deps: SettlementReconcilerDeps = defaultDeps,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { settled: 0, mismatch: 0, failed: 0, reclaimed: 0, pending: 0 };

  const submitted = await prisma.spendingLimitExecution.findMany({
    where: { status: 'submitted', signature: { not: null } },
    include: { counterpartyWallet: true },
    orderBy: { submittedAt: 'asc' },
    take: BATCH,
  });

  for (const exec of submitted) {
    if (!exec.signature) {
      continue;
    }
    const destinationTokenAccount =
      exec.counterpartyWallet?.tokenAccountAddress ?? deriveUsdcAtaForWallet(exec.destinationWalletAddress);
    try {
      const verification = await deps.verifySettlement({
        signature: exec.signature,
        expectedTransfers: [
          {
            destinationWalletAddress: exec.destinationWalletAddress,
            destinationTokenAccountAddress: destinationTokenAccount,
            amountRaw: exec.amountRaw,
          },
        ],
      });
      if (classifySettlementResult(verification) === 'settled') {
        await applyExecutionSettled(exec.spendingLimitExecutionId, verification, deps.now());
        summary.settled += 1;
      } else {
        await applyExecutionStatus(exec.spendingLimitExecutionId, 'mismatch', verification);
        summary.mismatch += 1;
      }
    } catch (error) {
      if (classifySettlementError(error) === 'tx_failed') {
        await applyExecutionStatus(exec.spendingLimitExecutionId, 'failed', { error: errorMessage(error) });
        summary.failed += 1;
      } else {
        summary.pending += 1;
      }
    }
  }

  // Release stale, never-sent reservations so a retry can proceed.
  const staleBefore = new Date(deps.now().getTime() - STALE_RESERVATION_MS);
  const reclaimed = await prisma.spendingLimitExecution.updateMany({
    where: { status: 'prepared', signature: null, createdAt: { lt: staleBefore } },
    data: { status: 'failed' },
  });
  summary.reclaimed = reclaimed.count;

  return summary;
}

async function applyExecutionSettled(
  spendingLimitExecutionId: string,
  verification: unknown,
  now: Date,
): Promise<void> {
  const exec = await prisma.spendingLimitExecution.findUnique({ where: { spendingLimitExecutionId } });
  if (!exec || exec.status !== 'submitted') {
    return; // already finalized elsewhere; idempotent
  }
  const transferRequestId = readTransferRequestId(exec.metadataJson);

  await prisma.$transaction(async (tx) => {
    await tx.spendingLimitExecution.update({
      where: { spendingLimitExecutionId },
      data: { status: 'settled', executedAt: now, verificationJson: verification as Prisma.InputJsonValue },
    });

    if (exec.paymentOrderId) {
      const order = await tx.paymentOrder.findUnique({ where: { paymentOrderId: exec.paymentOrderId } });
      if (order && order.state !== 'settled') {
        await tx.paymentOrder.update({ where: { paymentOrderId: order.paymentOrderId }, data: { state: 'settled' } });
        await tx.paymentOrderEvent.create({
          data: {
            paymentOrderId: order.paymentOrderId,
            organizationId: exec.organizationId,
            eventType: 'agent_spending_limit_settled',
            actorType: 'agent',
            actorId: exec.automationAgentId,
            beforeState: order.state,
            afterState: 'settled',
            linkedTransferRequestId: transferRequestId,
            linkedSignature: exec.signature,
            payloadJson: { reconciler: true, verification: verification as Prisma.InputJsonValue },
          },
        });
      }
    }

    if (transferRequestId) {
      const request = await tx.transferRequest.findUnique({ where: { transferRequestId } });
      if (request && request.status !== 'matched') {
        await tx.transferRequest.update({ where: { transferRequestId }, data: { status: 'matched' } });
      }
    }
  });
}

async function applyExecutionStatus(
  spendingLimitExecutionId: string,
  status: 'mismatch' | 'failed',
  payload: unknown,
): Promise<void> {
  await prisma.spendingLimitExecution.update({
    where: { spendingLimitExecutionId },
    data: { status, verificationJson: payload as Prisma.InputJsonValue },
  });
}

function readTransferRequestId(metadataJson: unknown): string | undefined {
  if (typeof metadataJson !== 'object' || metadataJson === null || Array.isArray(metadataJson)) {
    return undefined;
  }
  const value = (metadataJson as Record<string, unknown>).transferRequestId;
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the reconciler loop. Returns a stop function. No-op (returns a no-op stopper) when
 * disabled by config. Ticks never overlap, and a failing tick is logged and retried.
 */
export function startSettlementReconciler(deps: SettlementReconcilerDeps = defaultDeps): () => void {
  if (!config.settlementReconcilerEnabled) {
    logger.info('settlement_reconciler.disabled');
    return () => {};
  }
  const intervalMs = Math.max(5_000, config.settlementReconcilerIntervalMs);
  logger.info('settlement_reconciler.started', { intervalMs });

  timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void reconcilePendingSettlements(deps)
      .then((summary) => {
        if (summary.settled || summary.mismatch || summary.failed || summary.reclaimed) {
          logger.info('settlement_reconciler.tick', summary);
        }
      })
      .catch((error) => {
        logger.warn('settlement_reconciler.tick_failed', errorToLogFields(error));
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
