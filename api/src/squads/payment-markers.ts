import type { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';
import { createTransferRequestEvent } from '../transfer-requests/events.js';
import {
  SQUADS_SOURCE,
  type SquadsSettlementVerification,
  isRecordLike,
  mergeJsonObject,
  serializeSettlementVerification,
} from './shared.js';

// Per-stage state writers triggered from the squads-treasury proposal
// lifecycle. Pulled out of squads-treasury.ts so the file with the public
// API stays readable; these are private helpers that mutate payment_orders,
// payment_runs, transfer_requests, execution_records, and the matching
// event tables in a single Prisma transaction.

export async function markPaymentOrderSquadsProposalPrepared(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  beforeState: string;
  transferRequestId: string;
  decimalProposalId: string;
  transactionIndex: string;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.paymentOrder.update({
      where: { paymentOrderId: args.paymentOrderId },
      data: { state: 'ready' },
    });
    await tx.paymentOrderEvent.create({
      data: {
        paymentOrderId: args.paymentOrderId,
        organizationId: args.organizationId,
        eventType: 'squads_payment_proposal_prepared',
        actorType: 'user',
        actorId: args.actorUserId,
        beforeState: args.beforeState,
        afterState: 'ready',
        linkedTransferRequestId: args.transferRequestId,
        payloadJson: {
          decimalProposalId: args.decimalProposalId,
          transactionIndex: args.transactionIndex,
          provider: SQUADS_SOURCE,
        },
      },
    });
  });
}

export async function markPaymentRunSquadsProposalPrepared(args: {
  organizationId: string;
  paymentRunId: string;
  actorUserId: string;
  decimalProposalId: string;
  transactionIndex: string;
  items: Array<{
    paymentOrderId: string;
    beforeState: string;
    transferRequestId: string;
  }>;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.paymentRun.update({
      where: { paymentRunId: args.paymentRunId },
      data: { state: 'ready' },
    });
    for (const item of args.items) {
      await tx.paymentOrder.update({
        where: { paymentOrderId: item.paymentOrderId },
        data: { state: 'ready' },
      });
      await tx.paymentOrderEvent.create({
        data: {
          paymentOrderId: item.paymentOrderId,
          organizationId: args.organizationId,
          eventType: 'squads_payment_run_proposal_prepared',
          actorType: 'user',
          actorId: args.actorUserId,
          beforeState: item.beforeState,
          afterState: 'ready',
          linkedTransferRequestId: item.transferRequestId,
          payloadJson: {
            paymentRunId: args.paymentRunId,
            decimalProposalId: args.decimalProposalId,
            transactionIndex: args.transactionIndex,
            provider: SQUADS_SOURCE,
          },
        },
      });
    }
  });
}

export async function markPaymentOrderSquadsProposalSubmitted(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    paymentOrderId: string;
    actorUserId: string;
    decimalProposalId: string;
    beforeState: string | null;
    signature: string;
    transactionIndex: string | null;
  },
) {
  const paymentOrder = await tx.paymentOrder.findFirst({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    select: { state: true },
  });
  if (!paymentOrder) {
    return;
  }
  await tx.paymentOrder.update({
    where: { paymentOrderId: args.paymentOrderId },
    data: { state: 'proposed' },
  });
  await tx.paymentOrderEvent.create({
    data: {
      paymentOrderId: args.paymentOrderId,
      organizationId: args.organizationId,
      eventType: 'squads_payment_proposal_submitted',
      actorType: 'user',
      actorId: args.actorUserId,
      beforeState: args.beforeState ?? paymentOrder.state,
      afterState: 'proposed',
      linkedSignature: args.signature,
      payloadJson: {
        decimalProposalId: args.decimalProposalId,
        transactionIndex: args.transactionIndex,
        provider: SQUADS_SOURCE,
      },
    },
  });
}

export async function markPaymentRunSquadsProposalSubmitted(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    paymentRunId: string;
    actorUserId: string;
    decimalProposalId: string;
    signature: string;
    transactionIndex: string | null;
  },
) {
  const paymentRun = await tx.paymentRun.findFirst({
    where: { organizationId: args.organizationId, paymentRunId: args.paymentRunId },
    include: {
      paymentOrders: {
        where: { state: { not: 'cancelled' } },
        include: {
          transferRequests: {
            orderBy: { requestedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });
  if (!paymentRun) {
    return;
  }

  await tx.paymentRun.update({
    where: { paymentRunId: args.paymentRunId },
    data: { state: 'proposed' },
  });
  for (const order of paymentRun.paymentOrders) {
    await tx.paymentOrder.update({
      where: { paymentOrderId: order.paymentOrderId },
      data: { state: 'proposed' },
    });
    await tx.paymentOrderEvent.create({
      data: {
        paymentOrderId: order.paymentOrderId,
        organizationId: args.organizationId,
        eventType: 'squads_payment_run_proposal_submitted',
        actorType: 'user',
        actorId: args.actorUserId,
        beforeState: order.state,
        afterState: 'proposed',
        linkedTransferRequestId: order.transferRequests[0]?.transferRequestId ?? null,
        linkedSignature: args.signature,
        payloadJson: {
          paymentRunId: args.paymentRunId,
          decimalProposalId: args.decimalProposalId,
          transactionIndex: args.transactionIndex,
          provider: SQUADS_SOURCE,
        },
      },
    });
  }
}

// Idempotent. Safe to call repeatedly with the same signature: each call
// only writes for state transitions that haven't happened yet, so a retry
// after a transient verification failure cleanly upgrades from
// 'submitted_onchain' / 'executed' to 'matched' / 'settled' without
// duplicating events. Two event types differentiate the transitions:
//   squads_payment_proposal_executed → first time the proposal landed
//   squads_payment_proposal_settled  → settlement verified after the fact
export async function markPaymentOrderSquadsProposalExecuted(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    paymentOrderId: string;
    actorUserId: string;
    decimalProposalId: string;
    signature: string;
    transactionIndex: string | null;
    metadataJson: Prisma.JsonValue;
    settlementVerification: SquadsSettlementVerification;
    settled: boolean;
  },
) {
  const paymentOrder = await tx.paymentOrder.findFirst({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    select: { state: true },
  });
  if (!paymentOrder) {
    return;
  }

  const transferRequestIdFromMetadata = isRecordLike(args.metadataJson) && typeof args.metadataJson.transferRequestId === 'string'
    ? args.metadataJson.transferRequestId
    : null;
  const transferRequest = transferRequestIdFromMetadata
    ? await tx.transferRequest.findFirst({
        where: {
          organizationId: args.organizationId,
          paymentOrderId: args.paymentOrderId,
          transferRequestId: transferRequestIdFromMetadata,
        },
      })
    : await tx.transferRequest.findFirst({
        where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
        orderBy: { requestedAt: 'desc' },
      });

  const targetTransferStatus = args.settled ? 'matched' : 'submitted_onchain';
  const targetExecutionState = args.settled ? 'settled' : 'submitted_onchain';
  const targetOrderState = args.settled ? 'settled' : 'executed';
  const verificationJson = serializeSettlementVerification(args.settlementVerification);

  let executionRecordId: string | null = null;
  if (transferRequest) {
    const previousTransferStatus = transferRequest.status;
    if (previousTransferStatus !== targetTransferStatus) {
      await tx.transferRequest.update({
        where: { transferRequestId: transferRequest.transferRequestId },
        data: { status: targetTransferStatus },
      });
    }

    const existingRecord = await tx.executionRecord.findFirst({
      where: {
        transferRequestId: transferRequest.transferRequestId,
        submittedSignature: args.signature,
      },
    });
    if (!existingRecord) {
      const created = await tx.executionRecord.create({
        data: {
          transferRequestId: transferRequest.transferRequestId,
          organizationId: args.organizationId,
          submittedSignature: args.signature,
          executionSource: SQUADS_SOURCE,
          executorUserId: args.actorUserId,
          state: targetExecutionState,
          submittedAt: new Date(),
          metadataJson: {
            paymentOrderId: args.paymentOrderId,
            decimalProposalId: args.decimalProposalId,
            transactionIndex: args.transactionIndex,
            provider: SQUADS_SOURCE,
            rpcSettlementVerification: verificationJson,
          },
        },
      });
      executionRecordId = created.executionRecordId;
    } else {
      executionRecordId = existingRecord.executionRecordId;
      if (existingRecord.state !== targetExecutionState) {
        await tx.executionRecord.update({
          where: { executionRecordId: existingRecord.executionRecordId },
          data: {
            state: targetExecutionState,
            metadataJson: mergeJsonObject(existingRecord.metadataJson, {
              rpcSettlementVerification: verificationJson,
            }),
          },
        });
      } else {
        // Same state, just refresh the verification payload so the latest
        // checkedAt/reason is visible to the UI.
        await tx.executionRecord.update({
          where: { executionRecordId: existingRecord.executionRecordId },
          data: {
            metadataJson: mergeJsonObject(existingRecord.metadataJson, {
              rpcSettlementVerification: verificationJson,
            }),
          },
        });
      }
    }

    if (previousTransferStatus !== targetTransferStatus) {
      const upgradingToSettled = args.settled && previousTransferStatus !== 'matched';
      await createTransferRequestEvent(tx, {
        transferRequestId: transferRequest.transferRequestId,
        organizationId: args.organizationId,
        eventType: upgradingToSettled && previousTransferStatus === 'submitted_onchain'
          ? 'squads_payment_proposal_settled'
          : 'squads_payment_proposal_executed',
        actorType: 'user',
        actorId: args.actorUserId,
        eventSource: 'user',
        beforeState: previousTransferStatus,
        afterState: targetTransferStatus,
        linkedSignature: args.signature,
        payloadJson: {
          paymentOrderId: args.paymentOrderId,
          decimalProposalId: args.decimalProposalId,
          executionRecordId,
          transactionIndex: args.transactionIndex,
          provider: SQUADS_SOURCE,
          rpcSettlementVerification: verificationJson,
        },
      });
    }
  }

  if (paymentOrder.state !== targetOrderState) {
    const previousOrderState = paymentOrder.state;
    await tx.paymentOrder.update({
      where: { paymentOrderId: args.paymentOrderId },
      data: { state: targetOrderState },
    });
    const upgradingToSettled = args.settled && previousOrderState !== 'settled';
    await tx.paymentOrderEvent.create({
      data: {
        paymentOrderId: args.paymentOrderId,
        organizationId: args.organizationId,
        eventType: upgradingToSettled && previousOrderState === 'executed'
          ? 'squads_payment_proposal_settled'
          : 'squads_payment_proposal_executed',
        actorType: 'user',
        actorId: args.actorUserId,
        beforeState: previousOrderState,
        afterState: targetOrderState,
        linkedTransferRequestId: transferRequest?.transferRequestId ?? null,
        linkedExecutionRecordId: executionRecordId,
        linkedSignature: args.signature,
        payloadJson: {
          decimalProposalId: args.decimalProposalId,
          transactionIndex: args.transactionIndex,
          provider: SQUADS_SOURCE,
          rpcSettlementVerification: verificationJson,
        },
      },
    });
  }
}

// Idempotent. See markPaymentOrderSquadsProposalExecuted for the contract.
export async function markPaymentRunSquadsProposalExecuted(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    paymentRunId: string;
    actorUserId: string;
    decimalProposalId: string;
    signature: string;
    transactionIndex: string | null;
    settlementVerification: SquadsSettlementVerification;
    settled: boolean;
  },
) {
  const paymentRun = await tx.paymentRun.findFirst({
    where: { organizationId: args.organizationId, paymentRunId: args.paymentRunId },
    include: {
      paymentOrders: {
        where: { state: { not: 'cancelled' } },
        include: {
          transferRequests: {
            orderBy: { requestedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });
  if (!paymentRun) {
    return;
  }

  const targetTransferStatus = args.settled ? 'matched' : 'submitted_onchain';
  const targetExecutionState = args.settled ? 'settled' : 'submitted_onchain';
  const targetOrderState = args.settled ? 'settled' : 'executed';
  const targetRunState = args.settled ? 'settled' : 'executed';
  const verificationJson = serializeSettlementVerification(args.settlementVerification);

  if (paymentRun.state !== targetRunState) {
    await tx.paymentRun.update({
      where: { paymentRunId: args.paymentRunId },
      data: { state: targetRunState },
    });
  }

  for (const order of paymentRun.paymentOrders) {
    const transferRequest = order.transferRequests[0] ?? null;
    let executionRecordId: string | null = null;
    if (transferRequest) {
      const previousTransferStatus = transferRequest.status;
      if (previousTransferStatus !== targetTransferStatus) {
        await tx.transferRequest.update({
          where: { transferRequestId: transferRequest.transferRequestId },
          data: { status: targetTransferStatus },
        });
      }

      const existingRecord = await tx.executionRecord.findFirst({
        where: {
          transferRequestId: transferRequest.transferRequestId,
          submittedSignature: args.signature,
        },
      });
      if (!existingRecord) {
        const created = await tx.executionRecord.create({
          data: {
            transferRequestId: transferRequest.transferRequestId,
            organizationId: args.organizationId,
            submittedSignature: args.signature,
            executionSource: SQUADS_SOURCE,
            executorUserId: args.actorUserId,
            state: targetExecutionState,
            submittedAt: new Date(),
            metadataJson: {
              paymentRunId: args.paymentRunId,
              paymentOrderId: order.paymentOrderId,
              decimalProposalId: args.decimalProposalId,
              transactionIndex: args.transactionIndex,
              provider: SQUADS_SOURCE,
              rpcSettlementVerification: verificationJson,
            },
          },
        });
        executionRecordId = created.executionRecordId;
      } else {
        executionRecordId = existingRecord.executionRecordId;
        if (existingRecord.state !== targetExecutionState) {
          await tx.executionRecord.update({
            where: { executionRecordId: existingRecord.executionRecordId },
            data: {
              state: targetExecutionState,
              metadataJson: mergeJsonObject(existingRecord.metadataJson, {
                rpcSettlementVerification: verificationJson,
              }),
            },
          });
        } else {
          await tx.executionRecord.update({
            where: { executionRecordId: existingRecord.executionRecordId },
            data: {
              metadataJson: mergeJsonObject(existingRecord.metadataJson, {
                rpcSettlementVerification: verificationJson,
              }),
            },
          });
        }
      }

      if (previousTransferStatus !== targetTransferStatus) {
        const upgradingToSettled = args.settled && previousTransferStatus === 'submitted_onchain';
        await createTransferRequestEvent(tx, {
          transferRequestId: transferRequest.transferRequestId,
          organizationId: args.organizationId,
          eventType: upgradingToSettled
            ? 'squads_payment_run_proposal_settled'
            : 'squads_payment_run_proposal_executed',
          actorType: 'user',
          actorId: args.actorUserId,
          eventSource: 'user',
          beforeState: previousTransferStatus,
          afterState: targetTransferStatus,
          linkedSignature: args.signature,
          payloadJson: {
            paymentRunId: args.paymentRunId,
            paymentOrderId: order.paymentOrderId,
            decimalProposalId: args.decimalProposalId,
            executionRecordId,
            transactionIndex: args.transactionIndex,
            provider: SQUADS_SOURCE,
            rpcSettlementVerification: verificationJson,
          },
        });
      }
    }

    if (order.state !== targetOrderState) {
      const previousOrderState = order.state;
      await tx.paymentOrder.update({
        where: { paymentOrderId: order.paymentOrderId },
        data: { state: targetOrderState },
      });
      const upgradingToSettled = args.settled && previousOrderState === 'executed';
      await tx.paymentOrderEvent.create({
        data: {
          paymentOrderId: order.paymentOrderId,
          organizationId: args.organizationId,
          eventType: upgradingToSettled
            ? 'squads_payment_run_proposal_settled'
            : 'squads_payment_run_proposal_executed',
          actorType: 'user',
          actorId: args.actorUserId,
          beforeState: previousOrderState,
          afterState: targetOrderState,
          linkedTransferRequestId: transferRequest?.transferRequestId ?? null,
          linkedExecutionRecordId: executionRecordId,
          linkedSignature: args.signature,
          payloadJson: {
            paymentRunId: args.paymentRunId,
            decimalProposalId: args.decimalProposalId,
            transactionIndex: args.transactionIndex,
            provider: SQUADS_SOURCE,
            rpcSettlementVerification: verificationJson,
          },
        },
      });
    }
  }
}

