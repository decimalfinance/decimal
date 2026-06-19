import type { Prisma } from '@prisma/client';
import { errorToLogFields, logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { isRecordLike, mergeJsonObject } from '../squads/shared.js';

// A settlement MISMATCH means the execution transaction LANDED on-chain but moved
// the wrong USDC amount (or to the wrong place). It is the most dangerous
// settlement outcome — money already moved, incorrectly — so it must never be
// silent. We log it loudly, stamp the order so the UI can flag it, and write an
// audit event. Best-effort: surfacing must never break the caller's flow.
export async function raiseSettlementMismatch(args: {
  organizationId: string;
  paymentOrderId: string | null;
  signature: string | null;
  source: 'auto_pay' | 'proposal';
}): Promise<void> {
  if (!args.paymentOrderId) {
    logger.warn('settlement.mismatch', {
      organizationId: args.organizationId,
      signature: args.signature,
      source: args.source,
    });
    return;
  }

  try {
    // Idempotent: only stamps + records the event the first time for a given
    // (order, signature), so repeated reconcile/Sync passes don't spam.
    const recorded = await prisma.$transaction(async (tx) => {
      const order = await tx.paymentOrder.findUnique({
        where: { paymentOrderId: args.paymentOrderId! },
        select: { state: true, metadataJson: true },
      });
      if (!order) {
        return false;
      }
      const prior = isRecordLike(order.metadataJson) && isRecordLike(order.metadataJson.settlementMismatch)
        ? order.metadataJson.settlementMismatch
        : null;
      if (prior && prior.signature === args.signature) {
        return false;
      }
      await tx.paymentOrder.update({
        where: { paymentOrderId: args.paymentOrderId! },
        data: {
          metadataJson: mergeJsonObject(order.metadataJson, {
            settlementMismatch: {
              at: new Date().toISOString(),
              source: args.source,
              signature: args.signature,
            },
          }),
        },
      });
      await tx.paymentOrderEvent.create({
        data: {
          paymentOrderId: args.paymentOrderId!,
          organizationId: args.organizationId,
          eventType: 'settlement_mismatch',
          actorType: 'system',
          actorId: null,
          beforeState: order.state,
          afterState: order.state,
          linkedSignature: args.signature,
          payloadJson: { source: args.source } as Prisma.InputJsonValue,
        },
      });
      return true;
    });

    if (recorded) {
      logger.warn('settlement.mismatch', {
        organizationId: args.organizationId,
        paymentOrderId: args.paymentOrderId,
        signature: args.signature,
        source: args.source,
      });
    }
  } catch (error) {
    logger.warn('settlement.mismatch_record_failed', errorToLogFields(error));
  }
}
