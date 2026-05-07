import type {
  Counterparty,
  Destination,
  DecimalProposal,
  PaymentOrder,
  PaymentOrderEvent,
  PaymentRequest,
  Prisma,
  TransferRequest,
  User,
  TreasuryWallet,
} from '@prisma/client';
import { buildApprovalEvaluationSummary, getOrCreateOrganizationApprovalPolicy } from './approval-policy.js';
import { serializeExecutionRecord } from './execution-records.js';
import { prisma } from './prisma.js';
import { getReconciliationDetail } from './reconciliation.js';
import {
  buildUsdcTransferInstructions,
  deriveUsdcAtaForWallet,
  USDC_DECIMALS,
  USDC_MINT,
} from './solana.js';
import { createTransferRequestEvent } from './transfer-request-events.js';
export { PAYMENT_ORDER_STATES, isPaymentOrderState, type PaymentOrderState } from './payment-order-state.js';
import type { PaymentOrderState } from './payment-order-state.js';

export type PaymentOrderWithRelations = PaymentOrder & {
  organization?: unknown;
  paymentRequest: (PaymentRequest & { requestedByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null }) | null;
  destination: Destination & {
    counterparty: Counterparty | null;
  };
  counterparty: Counterparty | null;
  sourceTreasuryWallet: TreasuryWallet | null;
  createdByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  transferRequests: Array<
    TransferRequest & {
      sourceTreasuryWallet: TreasuryWallet | null;
      destination: (Destination & { counterparty: Counterparty | null }) | null;
    }
  >;
  proposals?: DecimalProposal[];
  events?: PaymentOrderEvent[];
};

type PaymentOrderClient = typeof prisma | Prisma.TransactionClient;
type PaymentActorInput = {
  actorUserId: string | null;
  actorType?: 'user';
  actorId?: string | null;
};

export async function createPaymentOrder(
  args: PaymentActorInput & {
    organizationId: string;
    destinationId: string;
    sourceTreasuryWalletId?: string | null;
    amountRaw: string | bigint;
    asset?: string;
    memo?: string | null;
    externalReference?: string | null;
    invoiceNumber?: string | null;
    attachmentUrl?: string | null;
    dueAt?: Date | null;
    sourceBalanceSnapshotJson?: Prisma.InputJsonValue;
    metadataJson?: Prisma.InputJsonValue;
    paymentRequestId?: string | null;
    paymentRunId?: string | null;
    submitNow?: boolean;
  },
) {
  const [destination, sourceTreasuryWallet] = await Promise.all([
    prisma.destination.findFirst({
      where: {
        organizationId: args.organizationId,
        destinationId: args.destinationId,
        isActive: true,
      },
      include: {
        counterparty: true,
      },
    }),
    args.sourceTreasuryWalletId
      ? prisma.treasuryWallet.findFirst({
          where: {
            organizationId: args.organizationId,
            treasuryWalletId: args.sourceTreasuryWalletId,
            isActive: true,
          },
        })
      : Promise.resolve(null),
  ]);

  if (!destination) {
    throw new Error('Destination not found');
  }

  if (args.sourceTreasuryWalletId && !sourceTreasuryWallet) {
    throw new Error('Source wallet not found');
  }

  validateSourceAndDestination({
    sourceTreasuryWallet,
    destination,
  });

  await enforceDuplicatePaymentOrder({
    organizationId: args.organizationId,
    destinationId: destination.destinationId,
    amountRaw: args.amountRaw,
    reference: normalizeReference(args.externalReference ?? args.invoiceNumber ?? null),
  });

  const created = await prisma.$transaction(async (tx) => {
    const paymentOrder = await tx.paymentOrder.create({
      data: {
        organizationId: args.organizationId,
        paymentRequestId: args.paymentRequestId ?? null,
        paymentRunId: args.paymentRunId ?? null,
        destinationId: destination.destinationId,
        counterpartyId: destination.counterpartyId,
        sourceTreasuryWalletId: sourceTreasuryWallet?.treasuryWalletId,
        amountRaw: BigInt(args.amountRaw),
        asset: args.asset ?? 'usdc',
        memo: normalizeOptionalText(args.memo),
        externalReference: normalizeOptionalText(args.externalReference),
        invoiceNumber: normalizeOptionalText(args.invoiceNumber),
        attachmentUrl: normalizeOptionalText(args.attachmentUrl),
        dueAt: args.dueAt ?? undefined,
        state: 'draft',
        sourceBalanceSnapshotJson: (args.sourceBalanceSnapshotJson ?? { status: 'unknown' }) as Prisma.InputJsonValue,
        metadataJson: (args.metadataJson ?? {}) as Prisma.InputJsonValue,
        createdByUserId: args.actorUserId ?? undefined,
      },
    });

    await createPaymentOrderEvent(tx, {
      paymentOrderId: paymentOrder.paymentOrderId,
      organizationId: args.organizationId,
      eventType: 'payment_order_created',
      ...buildPaymentEventActor(args),
      beforeState: null,
      afterState: paymentOrder.state,
      payloadJson: {
        destinationId: paymentOrder.destinationId,
        sourceTreasuryWalletId: paymentOrder.sourceTreasuryWalletId,
        amountRaw: paymentOrder.amountRaw.toString(),
        asset: paymentOrder.asset,
        paymentRequestId: paymentOrder.paymentRequestId,
        paymentRunId: paymentOrder.paymentRunId,
      },
    });

    return paymentOrder;
  });

  if (args.submitNow) {
    return submitPaymentOrder({
      organizationId: args.organizationId,
      paymentOrderId: created.paymentOrderId,
      actorUserId: args.actorUserId,
      actorType: args.actorType,
      actorId: args.actorId,
    });
  }

  return getPaymentOrderDetail(args.organizationId, created.paymentOrderId);
}

export async function listPaymentOrders(
  organizationId: string,
  options?: {
    limit?: number;
    state?: string;
    paymentRunId?: string;
  },
) {
  const paymentOrders = await prisma.paymentOrder.findMany({
    where: {
      organizationId,
      ...(options?.state ? { state: options.state } : {}),
      ...(options?.paymentRunId ? { paymentRunId: options.paymentRunId } : {}),
    },
    include: paymentOrderInclude,
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  const items = await Promise.all(paymentOrders.map((order) => buildPaymentOrderReadModel(order)));
  return { items };
}

export async function getPaymentOrderDetail(organizationId: string, paymentOrderId: string) {
  const paymentOrder = await prisma.paymentOrder.findFirstOrThrow({
    where: { organizationId, paymentOrderId },
    include: paymentOrderIncludeWithEvents,
  });

  return buildPaymentOrderReadModel(paymentOrder);
}

export async function updatePaymentOrder(
  args: PaymentActorInput & {
    organizationId: string;
    paymentOrderId: string;
    input: {
      sourceTreasuryWalletId?: string | null;
      memo?: string | null;
      externalReference?: string | null;
      invoiceNumber?: string | null;
      attachmentUrl?: string | null;
      dueAt?: Date | null;
      sourceBalanceSnapshotJson?: Prisma.InputJsonValue;
      metadataJson?: Prisma.InputJsonValue;
    };
  },
) {
  const current = await prisma.paymentOrder.findFirstOrThrow({
    where: {
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
    },
    include: paymentOrderInclude,
  });

  if (!['draft', 'pending_approval', 'approved'].includes(current.state)) {
    throw new Error(`Payment order ${current.state} cannot be edited`);
  }

  const sourceTreasuryWallet = args.input.sourceTreasuryWalletId
    ? await prisma.treasuryWallet.findFirst({
        where: {
          organizationId: args.organizationId,
          treasuryWalletId: args.input.sourceTreasuryWalletId,
          isActive: true,
        },
      })
    : args.input.sourceTreasuryWalletId === null
      ? null
      : current.sourceTreasuryWallet;

  if (args.input.sourceTreasuryWalletId && !sourceTreasuryWallet) {
    throw new Error('Source wallet not found');
  }

  validateSourceAndDestination({
    sourceTreasuryWallet,
    destination: current.destination,
  });

  const nextReference = normalizeReference(
    args.input.externalReference
    ?? args.input.invoiceNumber
    ?? current.externalReference
    ?? current.invoiceNumber
    ?? null,
  );
  await enforceDuplicatePaymentOrder({
    organizationId: args.organizationId,
    destinationId: current.destinationId,
    amountRaw: current.amountRaw,
    reference: nextReference,
    excludePaymentOrderId: current.paymentOrderId,
  });

  await prisma.$transaction(async (tx) => {
    const nextMetadata = {
      ...(isRecordLike(current.metadataJson) ? current.metadataJson : {}),
      ...(isRecordLike(args.input.metadataJson) ? args.input.metadataJson : {}),
    };

    await tx.paymentOrder.update({
      where: { paymentOrderId: current.paymentOrderId },
      data: {
        sourceTreasuryWalletId:
          args.input.sourceTreasuryWalletId === undefined
            ? undefined
            : sourceTreasuryWallet?.treasuryWalletId ?? null,
        memo: args.input.memo === undefined ? undefined : normalizeOptionalText(args.input.memo),
        externalReference:
          args.input.externalReference === undefined ? undefined : normalizeOptionalText(args.input.externalReference),
        invoiceNumber:
          args.input.invoiceNumber === undefined ? undefined : normalizeOptionalText(args.input.invoiceNumber),
        attachmentUrl:
          args.input.attachmentUrl === undefined ? undefined : normalizeOptionalText(args.input.attachmentUrl),
        dueAt: args.input.dueAt === undefined ? undefined : args.input.dueAt,
        sourceBalanceSnapshotJson:
          args.input.sourceBalanceSnapshotJson === undefined
            ? undefined
            : args.input.sourceBalanceSnapshotJson,
        metadataJson: nextMetadata as Prisma.InputJsonValue,
      },
    });

    await createPaymentOrderEvent(tx, {
      paymentOrderId: current.paymentOrderId,
      organizationId: args.organizationId,
      eventType: 'payment_order_updated',
      ...buildPaymentEventActor(args),
      beforeState: current.state,
      afterState: current.state,
      payloadJson: {
        changedFields: Object.keys(args.input),
      },
    });
  });

  return getPaymentOrderDetail(args.organizationId, args.paymentOrderId);
}

export async function submitPaymentOrder(
  args: PaymentActorInput & {
    organizationId: string;
    paymentOrderId: string;
  },
) {
  const current = await prisma.paymentOrder.findFirstOrThrow({
    where: {
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
    },
    include: paymentOrderInclude,
  });

  if (current.transferRequests.length) {
    return getPaymentOrderDetail(args.organizationId, args.paymentOrderId);
  }

  if (current.state !== 'draft') {
    throw new Error(`Payment order ${current.state} cannot be submitted`);
  }

  validateDestinationForPaymentOrder(current.destination);
  validateSourceAndDestination({
    sourceTreasuryWallet: current.sourceTreasuryWallet,
    destination: current.destination,
  });

  await prisma.$transaction(async (tx) => {
    const approvalPolicy = await getOrCreateOrganizationApprovalPolicy(args.organizationId, tx);
    const approvalEvaluation = buildApprovalEvaluationSummary({
      policy: approvalPolicy,
      amountRaw: current.amountRaw,
      destination: {
        label: current.destination.label,
        trustState: current.destination.trustState,
        isInternal: current.destination.isInternal,
      },
    });
    const finalRequestStatus = approvalEvaluation.requiresApproval ? 'pending_approval' : 'approved';
    const finalPaymentOrderState = approvalEvaluation.requiresApproval ? 'pending_approval' : 'approved';

    const transferRequest = await tx.transferRequest.create({
      data: {
        organizationId: args.organizationId,
        paymentOrderId: current.paymentOrderId,
        sourceTreasuryWalletId: current.sourceTreasuryWalletId,
        destinationId: current.destinationId,
        requestType: 'payment_order',
        asset: current.asset,
        amountRaw: current.amountRaw,
        requestedByUserId: args.actorUserId ?? undefined,
        reason: current.memo,
        externalReference: current.externalReference ?? current.invoiceNumber,
        status: finalRequestStatus,
        dueAt: current.dueAt,
        propertiesJson: {
          paymentOrderId: current.paymentOrderId,
          paymentRunId: current.paymentRunId,
          invoiceNumber: current.invoiceNumber,
          attachmentUrl: current.attachmentUrl,
        },
      },
    });

    await createTransferRequestEvent(tx, {
      transferRequestId: transferRequest.transferRequestId,
      organizationId: args.organizationId,
      eventType: 'request_created',
      ...buildTransferEventActor(args),
      beforeState: null,
      afterState: finalRequestStatus,
      payloadJson: {
        source: 'payment_order',
        paymentOrderId: current.paymentOrderId,
        paymentRunId: current.paymentRunId,
        amountRaw: transferRequest.amountRaw.toString(),
        asset: transferRequest.asset,
      },
    });

    await tx.approvalDecision.create({
      data: {
        approvalPolicyId: approvalPolicy.approvalPolicyId,
        transferRequestId: transferRequest.transferRequestId,
        organizationId: args.organizationId,
        actorType: 'system',
        action: approvalEvaluation.requiresApproval ? 'routed_for_approval' : 'auto_approved',
        payloadJson: approvalEvaluation as Prisma.InputJsonValue,
      },
    });

    await createTransferRequestEvent(tx, {
      transferRequestId: transferRequest.transferRequestId,
      organizationId: args.organizationId,
      eventType: approvalEvaluation.requiresApproval ? 'approval_required' : 'approval_auto_approved',
      actorType: 'system',
      eventSource: 'system',
      beforeState: 'submitted',
      afterState: finalRequestStatus,
      payloadJson: approvalEvaluation as Prisma.InputJsonValue,
    });

    await tx.paymentOrder.update({
      where: { paymentOrderId: current.paymentOrderId },
      data: {
        state: finalPaymentOrderState,
      },
    });

    await createPaymentOrderEvent(tx, {
      paymentOrderId: current.paymentOrderId,
      organizationId: args.organizationId,
      eventType: approvalEvaluation.requiresApproval ? 'payment_order_approval_required' : 'payment_order_auto_approved',
      actorType: 'system',
      beforeState: current.state,
      afterState: finalPaymentOrderState,
      linkedTransferRequestId: transferRequest.transferRequestId,
      payloadJson: approvalEvaluation as Prisma.InputJsonValue,
    });
  });

  return getPaymentOrderDetail(args.organizationId, args.paymentOrderId);
}

export async function cancelPaymentOrder(args: PaymentActorInput & {
  organizationId: string;
  paymentOrderId: string;
}) {
  const current = await prisma.paymentOrder.findFirstOrThrow({
    where: {
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
    },
  });

  if (current.state === 'cancelled') {
    return getPaymentOrderDetail(args.organizationId, args.paymentOrderId);
  }

  if (['settled', 'closed'].includes(current.state)) {
    throw new Error(`Payment order ${current.state} cannot be cancelled`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentOrder.update({
      where: { paymentOrderId: current.paymentOrderId },
      data: { state: 'cancelled' },
    });

    await createPaymentOrderEvent(tx, {
      paymentOrderId: current.paymentOrderId,
      organizationId: args.organizationId,
      eventType: 'payment_order_cancelled',
      ...buildPaymentEventActor(args),
      beforeState: current.state,
      afterState: 'cancelled',
      payloadJson: {},
    });
  });

  return getPaymentOrderDetail(args.organizationId, args.paymentOrderId);
}

export async function createPaymentOrderExecution(args: PaymentActorInput & {
  organizationId: string;
  paymentOrderId: string;
  executionSource: string;
  externalReference?: string | null;
  metadataJson?: Prisma.InputJsonValue;
}) {
  const current = await prisma.paymentOrder.findFirstOrThrow({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    include: paymentOrderInclude,
  });
  const transferRequest = getPrimaryTransferRequest(current);

  if (!transferRequest) {
    throw new Error('Submit the payment order before creating execution evidence');
  }

  if (!['approved', 'ready_for_execution', 'submitted_onchain'].includes(transferRequest.status)) {
    throw new Error('Execution records can only be created after payment approval');
  }

  const executionRecord = await prisma.$transaction(async (tx) => {
    const record = await tx.executionRecord.create({
      data: {
        transferRequestId: transferRequest.transferRequestId,
        organizationId: args.organizationId,
        executionSource: args.executionSource,
        executorUserId: args.actorUserId ?? undefined,
        state: 'ready_for_execution',
        metadataJson: {
          ...(isRecordLike(args.metadataJson) ? args.metadataJson : {}),
          paymentOrderId: current.paymentOrderId,
          externalExecutionReference: args.externalReference ?? null,
        },
      },
      include: {
        executorUser: {
          select: {
            userId: true,
            email: true,
            displayName: true,
          },
        },
      },
    });

    if (transferRequest.status === 'approved') {
      await tx.transferRequest.update({
        where: { transferRequestId: transferRequest.transferRequestId },
        data: { status: 'ready_for_execution' },
      });
    }

    await tx.paymentOrder.update({
      where: { paymentOrderId: current.paymentOrderId },
      data: { state: 'execution_recorded' },
    });

    await createTransferRequestEvent(tx, {
      transferRequestId: transferRequest.transferRequestId,
      organizationId: args.organizationId,
      eventType: 'execution_created',
      ...buildTransferEventActor(args),
      beforeState: transferRequest.status,
      afterState: transferRequest.status === 'approved' ? 'ready_for_execution' : transferRequest.status,
      payloadJson: {
        executionRecordId: record.executionRecordId,
        executionSource: record.executionSource,
        paymentOrderId: current.paymentOrderId,
        externalExecutionReference: args.externalReference ?? null,
      },
    });

    await createPaymentOrderEvent(tx, {
      paymentOrderId: current.paymentOrderId,
      organizationId: args.organizationId,
      eventType: 'payment_order_execution_created',
      ...buildPaymentEventActor(args),
      beforeState: current.state,
      afterState: 'execution_recorded',
      linkedTransferRequestId: transferRequest.transferRequestId,
      linkedExecutionRecordId: record.executionRecordId,
      payloadJson: {
        executionSource: record.executionSource,
        externalExecutionReference: args.externalReference ?? null,
      },
    });

    return record;
  });

  return serializeExecutionRecord(executionRecord);
}

export async function preparePaymentOrderExecution(args: PaymentActorInput & {
  organizationId: string;
  paymentOrderId: string;
  sourceTreasuryWalletId?: string | null;
}) {
  let current = await prisma.paymentOrder.findFirstOrThrow({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    include: paymentOrderInclude,
  });

  if (args.sourceTreasuryWalletId && args.sourceTreasuryWalletId !== current.sourceTreasuryWalletId) {
    const sourceTreasuryWallet = await prisma.treasuryWallet.findFirst({
      where: {
        organizationId: args.organizationId,
        treasuryWalletId: args.sourceTreasuryWalletId,
        isActive: true,
      },
    });

    if (!sourceTreasuryWallet) {
      throw new Error('Source wallet not found');
    }

    validateSourceAndDestination({
      sourceTreasuryWallet,
      destination: current.destination,
    });

    await prisma.$transaction(async (tx) => {
      await tx.paymentOrder.update({
        where: { paymentOrderId: current.paymentOrderId },
        data: { sourceTreasuryWalletId: sourceTreasuryWallet.treasuryWalletId },
      });

      for (const request of current.transferRequests) {
        await tx.transferRequest.update({
          where: { transferRequestId: request.transferRequestId },
          data: { sourceTreasuryWalletId: sourceTreasuryWallet.treasuryWalletId },
        });
      }

      await createPaymentOrderEvent(tx, {
        paymentOrderId: current.paymentOrderId,
        organizationId: args.organizationId,
        eventType: 'payment_order_source_selected',
        ...buildPaymentEventActor(args),
        beforeState: current.state,
        afterState: current.state,
        payloadJson: {
          sourceTreasuryWalletId: sourceTreasuryWallet.treasuryWalletId,
        },
      });
    });

    current = await prisma.paymentOrder.findFirstOrThrow({
      where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
      include: paymentOrderInclude,
    });
  }

  if (!current.sourceTreasuryWallet) {
    throw new Error('Choose a source wallet before preparing execution');
  }

  if (!current.transferRequests.length && current.state === 'draft') {
    await submitPaymentOrder({
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
      actorUserId: args.actorUserId,
      actorType: args.actorType,
      actorId: args.actorId,
    });
    current = await prisma.paymentOrder.findFirstOrThrow({
      where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
      include: paymentOrderInclude,
    });
  }

  const transferRequest = getPrimaryTransferRequest(current);
  if (!transferRequest) {
    throw new Error('Submit the payment order before preparing execution');
  }

  if (transferRequest.status === 'pending_approval' || transferRequest.status === 'escalated') {
    throw new Error('Payment order requires approval before execution can be prepared');
  }

  if (!['approved', 'ready_for_execution'].includes(transferRequest.status)) {
    throw new Error(`Payment order cannot prepare execution while request is ${transferRequest.status}`);
  }

  if (current.asset.toLowerCase() !== 'usdc') {
    throw new Error(`Execution preparation only supports USDC orders, received ${current.asset}`);
  }

  const packetBase = buildPaymentExecutionPacketBase({
    current,
    transferRequestId: transferRequest.transferRequestId,
  });

  const reusableExecutionRecord = await findReusablePreparedExecution({
    organizationId: args.organizationId,
    transferRequestId: transferRequest.transferRequestId,
    executionSource: 'prepared_solana_transfer',
  });
  const reusableExecutionPacket = reusableExecutionRecord
    ? getPreparedExecutionPacket(reusableExecutionRecord.metadataJson)
    : null;

  if (
    reusableExecutionRecord
    && reusableExecutionPacket
    && preparedExecutionPacketUsesSource(reusableExecutionPacket, current.sourceTreasuryWallet)
  ) {
    return {
      executionRecord: serializeExecutionRecord(reusableExecutionRecord),
      executionPacket: reusableExecutionPacket,
      paymentOrder: await getPaymentOrderDetail(args.organizationId, args.paymentOrderId),
    };
  }

  const executionRecord = await prisma.$transaction(async (tx) => {
    const record = await tx.executionRecord.create({
      data: {
        transferRequestId: transferRequest.transferRequestId,
        organizationId: args.organizationId,
        executionSource: 'prepared_solana_transfer',
        executorUserId: args.actorUserId ?? undefined,
        state: 'ready_for_execution',
        metadataJson: {
          paymentOrderId: current.paymentOrderId,
          externalExecutionReference: `prepared:${current.paymentOrderId}`,
        },
      },
      include: {
        executorUser: {
          select: {
            userId: true,
            email: true,
            displayName: true,
          },
        },
      },
    });

    const preparedExecution = {
      ...packetBase,
      executionRecordId: record.executionRecordId,
    };

    const updatedRecord = await tx.executionRecord.update({
      where: { executionRecordId: record.executionRecordId },
      data: {
        metadataJson: {
          paymentOrderId: current.paymentOrderId,
          externalExecutionReference: `prepared:${current.paymentOrderId}`,
          preparedExecution,
        },
      },
      include: executionRecordWithExecutorInclude,
    });

    if (transferRequest.status === 'approved') {
      await tx.transferRequest.update({
        where: { transferRequestId: transferRequest.transferRequestId },
        data: { status: 'ready_for_execution' },
      });
    }

    await tx.paymentOrder.update({
      where: { paymentOrderId: current.paymentOrderId },
      data: { state: 'execution_recorded' },
    });

    await createTransferRequestEvent(tx, {
      transferRequestId: transferRequest.transferRequestId,
      organizationId: args.organizationId,
      eventType: 'execution_prepared',
      ...buildTransferEventActor(args),
      beforeState: transferRequest.status,
      afterState: transferRequest.status === 'approved' ? 'ready_for_execution' : transferRequest.status,
      payloadJson: {
        executionRecordId: record.executionRecordId,
        paymentOrderId: current.paymentOrderId,
        executionSource: 'prepared_solana_transfer',
        sourceWallet: packetBase.source.walletAddress,
        destinationWallet: packetBase.destination.walletAddress,
        amountRaw: packetBase.amountRaw,
      },
    });

    await createPaymentOrderEvent(tx, {
      paymentOrderId: current.paymentOrderId,
      organizationId: args.organizationId,
      eventType: 'payment_order_execution_prepared',
      ...buildPaymentEventActor(args),
      beforeState: current.state,
      afterState: 'execution_recorded',
      linkedTransferRequestId: transferRequest.transferRequestId,
      linkedExecutionRecordId: record.executionRecordId,
      payloadJson: {
        executionSource: 'prepared_solana_transfer',
        sourceWallet: packetBase.source.walletAddress,
        destinationWallet: packetBase.destination.walletAddress,
        amountRaw: packetBase.amountRaw,
      },
    });

    return updatedRecord;
  });
  const executionPacket = getPreparedExecutionPacket(executionRecord.metadataJson);
  if (!executionPacket) {
    throw new Error('Prepared execution packet was not persisted');
  }

  return {
    executionRecord: serializeExecutionRecord(executionRecord),
    executionPacket,
    paymentOrder: await getPaymentOrderDetail(args.organizationId, args.paymentOrderId),
  };
}

export async function attachPaymentOrderSignature(args: PaymentActorInput & {
  organizationId: string;
  paymentOrderId: string;
  submittedSignature?: string | null;
  externalReference?: string | null;
  submittedAt?: Date | null;
  metadataJson?: Prisma.InputJsonValue;
}) {
  const current = await prisma.paymentOrder.findFirstOrThrow({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    include: {
      ...paymentOrderInclude,
      transferRequests: {
        ...paymentOrderInclude.transferRequests,
        include: {
          ...paymentOrderInclude.transferRequests.include,
          executionRecords: {
            include: {
              executorUser: {
                select: {
                  userId: true,
                  email: true,
                  displayName: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });
  const transferRequest = getPrimaryTransferRequest(current);

  if (!transferRequest) {
    throw new Error('Submit the payment order before attaching execution evidence');
  }

  let latestExecution = await prisma.executionRecord.findFirst({
    where: {
      organizationId: args.organizationId,
      transferRequestId: transferRequest.transferRequestId,
    },
    include: {
      executorUser: {
        select: {
          userId: true,
          email: true,
          displayName: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!latestExecution) {
    latestExecution = await createExecutionRecordForSignature(args, transferRequest.transferRequestId);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const nextMetadata = {
      ...(isRecordLike(latestExecution.metadataJson) ? latestExecution.metadataJson : {}),
      ...(isRecordLike(args.metadataJson) ? args.metadataJson : {}),
      paymentOrderId: current.paymentOrderId,
      externalExecutionReference: args.externalReference ?? getMetadataString(latestExecution.metadataJson, 'externalExecutionReference'),
    };

    const hasSubmittedSignature = Boolean(args.submittedSignature?.trim());
    const record = await tx.executionRecord.update({
      where: { executionRecordId: latestExecution.executionRecordId },
      data: {
        submittedSignature: hasSubmittedSignature ? args.submittedSignature!.trim() : latestExecution.submittedSignature,
        state: hasSubmittedSignature ? 'submitted_onchain' : latestExecution.state,
        submittedAt: hasSubmittedSignature ? args.submittedAt ?? latestExecution.submittedAt ?? new Date() : latestExecution.submittedAt,
        metadataJson: nextMetadata as Prisma.InputJsonValue,
      },
      include: {
        executorUser: {
          select: {
            userId: true,
            email: true,
            displayName: true,
          },
        },
      },
    });

    if (hasSubmittedSignature && transferRequest.status !== 'submitted_onchain') {
      await tx.transferRequest.update({
        where: { transferRequestId: transferRequest.transferRequestId },
        data: { status: 'submitted_onchain' },
      });
    }

    await tx.paymentOrder.update({
      where: { paymentOrderId: current.paymentOrderId },
      data: { state: 'execution_recorded' },
    });

    await createTransferRequestEvent(tx, {
      transferRequestId: transferRequest.transferRequestId,
      organizationId: args.organizationId,
      eventType: hasSubmittedSignature ? 'execution_signature_attached' : 'execution_reference_attached',
      ...buildTransferEventActor(args),
      beforeState: transferRequest.status,
      afterState: hasSubmittedSignature ? 'submitted_onchain' : transferRequest.status,
      linkedSignature: hasSubmittedSignature ? args.submittedSignature!.trim() : null,
      payloadJson: {
        executionRecordId: record.executionRecordId,
        paymentOrderId: current.paymentOrderId,
        externalExecutionReference: args.externalReference ?? null,
      },
    });

    await createPaymentOrderEvent(tx, {
      paymentOrderId: current.paymentOrderId,
      organizationId: args.organizationId,
      eventType: hasSubmittedSignature ? 'payment_order_signature_attached' : 'payment_order_execution_reference_attached',
      ...buildPaymentEventActor(args),
      beforeState: current.state,
      afterState: 'execution_recorded',
      linkedTransferRequestId: transferRequest.transferRequestId,
      linkedExecutionRecordId: record.executionRecordId,
      linkedSignature: hasSubmittedSignature ? args.submittedSignature!.trim() : null,
      payloadJson: {
        externalExecutionReference: args.externalReference ?? null,
      },
    });

    return record;
  });

  return serializeExecutionRecord(updated);
}

async function createExecutionRecordForSignature(
  args: PaymentActorInput & {
    organizationId: string;
    paymentOrderId: string;
    externalReference?: string | null;
    metadataJson?: Prisma.InputJsonValue;
  },
  transferRequestId: string,
) {
  return prisma.executionRecord.create({
    data: {
      transferRequestId,
      organizationId: args.organizationId,
      executionSource: args.externalReference ? 'external_proposal' : 'manual_signature',
      executorUserId: args.actorUserId ?? undefined,
      state: 'ready_for_execution',
      metadataJson: {
        ...(isRecordLike(args.metadataJson) ? args.metadataJson : {}),
        paymentOrderId: args.paymentOrderId,
        externalExecutionReference: args.externalReference ?? null,
      },
    },
    include: {
      executorUser: {
        select: {
          userId: true,
          email: true,
          displayName: true,
        },
      },
    },
  });
}

async function buildPaymentOrderReadModel(order: PaymentOrderWithRelations) {
  const primaryTransferRequest = getPrimaryTransferRequest(order);
  const reconciliationDetail = primaryTransferRequest
    ? await getReconciliationDetail(order.organizationId, primaryTransferRequest.transferRequestId)
    : null;
  const latestSquadsPaymentProposal = getLatestSquadsPaymentProposal(order);
  const squadsLifecycle = deriveSquadsPaymentLifecycle(latestSquadsPaymentProposal);
  const derivedState = derivePaymentOrderState(order, reconciliationDetail, squadsLifecycle);
  const balanceWarning = deriveBalanceWarning(order);

  return {
    paymentOrderId: order.paymentOrderId,
    organizationId: order.organizationId,
    paymentRequestId: order.paymentRequestId,
    paymentRunId: order.paymentRunId,
    destinationId: order.destinationId,
    counterpartyId: order.counterpartyId,
    sourceTreasuryWalletId: order.sourceTreasuryWalletId,
    transferRequestId: primaryTransferRequest?.transferRequestId ?? null,
    amountRaw: order.amountRaw.toString(),
    asset: order.asset,
    memo: order.memo,
    externalReference: order.externalReference,
    invoiceNumber: order.invoiceNumber,
    attachmentUrl: order.attachmentUrl,
    dueAt: order.dueAt,
    state: order.state,
    derivedState,
    sourceBalanceSnapshotJson: order.sourceBalanceSnapshotJson,
    balanceWarning,
    metadataJson: order.metadataJson,
    createdByUserId: order.createdByUserId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    destination: serializePaymentOrderDestination(order.destination),
    counterparty: order.counterparty ? serializeCounterparty(order.counterparty) : null,
    sourceTreasuryWallet: order.sourceTreasuryWallet ? serializeTreasuryWallet(order.sourceTreasuryWallet) : null,
    createdByUser: serializeUserRef(order.createdByUser),
    paymentRequest: order.paymentRequest ? serializePaymentRequestRef(order.paymentRequest) : null,
    transferRequests: order.transferRequests.map((request) => ({
      transferRequestId: request.transferRequestId,
      status: request.status,
      amountRaw: request.amountRaw.toString(),
      requestedAt: request.requestedAt,
    })),
    squadsLifecycle,
    squadsPaymentProposal: latestSquadsPaymentProposal ? serializePaymentOrderProposal(latestSquadsPaymentProposal) : null,
    canCreateSquadsPaymentProposal: !latestSquadsPaymentProposal || isTerminalSquadsPaymentProposal(latestSquadsPaymentProposal),
    events: (order.events ?? []).map(serializePaymentOrderEvent),
    reconciliationDetail,
  };
}

function derivePaymentOrderState(
  order: PaymentOrderWithRelations,
  reconciliationDetail: Awaited<ReturnType<typeof getReconciliationDetail>> | null,
  squadsLifecycle: ReturnType<typeof deriveSquadsPaymentLifecycle>,
): PaymentOrderState {
  if (order.state === 'cancelled' || order.state === 'closed') {
    return order.state;
  }

  if (!reconciliationDetail) {
    if (squadsLifecycle) {
      return squadsLifecycle.paymentState;
    }
    return order.state as PaymentOrderState;
  }

  if (reconciliationDetail.requestDisplayState === 'exception') {
    return 'exception';
  }

  if (reconciliationDetail.requestDisplayState === 'partial') {
    return 'partially_settled';
  }

  if (reconciliationDetail.requestDisplayState === 'matched') {
    return 'settled';
  }

  if (squadsLifecycle) {
    return squadsLifecycle.paymentState;
  }

  if (reconciliationDetail.latestExecution) {
    const latest = reconciliationDetail.latestExecution;
    const hasSignature = Boolean(latest.submittedSignature?.trim());
    const awaitingWallet =
      !hasSignature
      && (latest.state === 'ready_for_execution' || latest.state === 'broadcast_failed');
    if (awaitingWallet) {
      return 'ready_for_execution';
    }
    return 'execution_recorded';
  }

  if (reconciliationDetail.status === 'approved' || reconciliationDetail.status === 'ready_for_execution') {
    return 'ready_for_execution';
  }

  if (reconciliationDetail.status === 'pending_approval' || reconciliationDetail.status === 'escalated') {
    return 'pending_approval';
  }

  if (reconciliationDetail.status === 'rejected') {
    return 'cancelled';
  }

  return order.state as PaymentOrderState;
}

function getLatestSquadsPaymentProposal(order: PaymentOrderWithRelations) {
  return (order.proposals ?? [])
    .filter((proposal) => proposal.provider === 'squads_v4' && proposal.semanticType === 'send_payment')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

function deriveSquadsPaymentLifecycle(proposal: DecimalProposal | null) {
  if (!proposal) {
    return null;
  }

  const localStatus = proposal.status;
  const paymentState = mapSquadsProposalStatusToPaymentState(proposal);
  return {
    provider: proposal.provider,
    decimalProposalId: proposal.decimalProposalId,
    proposalStatus: localStatus,
    paymentState,
    hasSubmittedSignature: Boolean(proposal.submittedSignature?.trim()),
    hasExecutedSignature: Boolean(proposal.executedSignature?.trim()),
    submittedSignature: proposal.submittedSignature,
    executedSignature: proposal.executedSignature,
    submittedAt: proposal.submittedAt,
    executedAt: proposal.executedAt,
    transactionIndex: proposal.transactionIndex,
    treasuryWalletId: proposal.treasuryWalletId,
  };
}

function mapSquadsProposalStatusToPaymentState(proposal: DecimalProposal): PaymentOrderState {
  if (proposal.executedSignature || proposal.status === 'executed') {
    return 'proposal_executed';
  }
  if (proposal.status === 'approved') {
    return 'proposal_approved';
  }
  if (proposal.submittedSignature || proposal.status === 'submitted' || proposal.status === 'active') {
    return 'proposal_submitted';
  }
  if (proposal.status === 'rejected' || proposal.status === 'cancelled' || proposal.status === 'failed') {
    return 'cancelled';
  }
  return 'proposal_prepared';
}

function isTerminalSquadsPaymentProposal(proposal: DecimalProposal) {
  return ['rejected', 'cancelled', 'failed'].includes(proposal.status);
}

function serializePaymentOrderProposal(proposal: DecimalProposal) {
  return {
    decimalProposalId: proposal.decimalProposalId,
    provider: proposal.provider,
    proposalType: proposal.proposalType,
    proposalCategory: proposal.proposalCategory,
    semanticType: proposal.semanticType,
    status: proposal.status,
    submittedSignature: proposal.submittedSignature,
    executedSignature: proposal.executedSignature,
    submittedAt: proposal.submittedAt,
    executedAt: proposal.executedAt,
    squads: {
      programId: proposal.squadsProgramId,
      multisigPda: proposal.squadsMultisigPda,
      proposalPda: proposal.squadsProposalPda,
      transactionPda: proposal.squadsTransactionPda,
      transactionIndex: proposal.transactionIndex,
      vaultIndex: proposal.vaultIndex,
    },
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

function deriveBalanceWarning(order: PaymentOrder) {
  const snapshot = order.sourceBalanceSnapshotJson;
  if (!isRecordLike(snapshot)) {
    return { status: 'unknown' as const, message: 'Source wallet balance is unknown' };
  }

  const balanceRaw = typeof snapshot.balanceRaw === 'string' && /^\d+$/.test(snapshot.balanceRaw)
    ? BigInt(snapshot.balanceRaw)
    : null;

  if (balanceRaw === null) {
    return { status: 'unknown' as const, message: 'Source wallet balance is unknown' };
  }

  if (balanceRaw < order.amountRaw) {
    return {
      status: 'insufficient' as const,
      message: `Source wallet snapshot is below requested amount`,
      balanceRaw: balanceRaw.toString(),
    };
  }

  return {
    status: 'sufficient' as const,
    message: 'Source wallet snapshot covers requested amount',
    balanceRaw: balanceRaw.toString(),
  };
}

function buildPaymentExecutionPacketBase(args: {
  current: PaymentOrderWithRelations;
  transferRequestId: string;
}) {
  const source = args.current.sourceTreasuryWallet;
  if (!source) {
    throw new Error('Choose a source wallet before preparing execution');
  }

  const sourceTokenAccount = source.usdcAtaAddress ?? deriveUsdcAtaForWallet(source.address);
  const destinationTokenAccount = args.current.destination.tokenAccountAddress
    ?? deriveUsdcAtaForWallet(args.current.destination.walletAddress);
  const instructions = buildUsdcTransferInstructions({
    sourceWallet: source.address,
    sourceTokenAccount,
    destinationWallet: args.current.destination.walletAddress,
    destinationTokenAccount,
    amountRaw: args.current.amountRaw,
  });

  return {
    kind: 'solana_spl_usdc_transfer',
    version: 1,
    network: 'solana-mainnet',
    paymentOrderId: args.current.paymentOrderId,
    transferRequestId: args.transferRequestId,
    createdAt: new Date().toISOString(),
    source: {
      treasuryWalletId: source.treasuryWalletId,
      walletAddress: source.address,
      tokenAccountAddress: sourceTokenAccount,
      label: source.displayName,
    },
    destination: {
      destinationId: args.current.destination.destinationId,
      label: args.current.destination.label,
      walletAddress: args.current.destination.walletAddress,
      tokenAccountAddress: destinationTokenAccount,
      counterpartyName: args.current.counterparty?.displayName ?? args.current.destination.counterparty?.displayName ?? null,
    },
    token: {
      symbol: 'USDC',
      mint: USDC_MINT.toBase58(),
      decimals: USDC_DECIMALS,
    },
    amountRaw: args.current.amountRaw.toString(),
    memo: args.current.memo,
    reference: args.current.externalReference ?? args.current.invoiceNumber ?? null,
    signerWallet: source.address,
    feePayer: source.address,
    requiredSigners: [source.address],
    instructions,
    signing: {
      mode: 'wallet_adapter_or_external_signer',
      requiresRecentBlockhash: true,
      note: 'Client must add a recent blockhash, sign with the source wallet, and submit to Solana. The API never receives private keys.',
    },
  };
}

function getPrimaryTransferRequest(order: {
  transferRequests: Array<TransferRequest & { createdAt: Date }>;
}) {
  return [...order.transferRequests].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  )[0] ?? null;
}

async function findReusablePreparedExecution(args: {
  organizationId: string;
  transferRequestId: string;
  executionSource: string;
}) {
  return prisma.executionRecord.findFirst({
    where: {
      organizationId: args.organizationId,
      transferRequestId: args.transferRequestId,
      executionSource: args.executionSource,
      state: 'ready_for_execution',
      submittedSignature: null,
    },
    include: executionRecordWithExecutorInclude,
    orderBy: { createdAt: 'desc' },
  });
}

function getPreparedExecutionPacket(metadataJson: unknown) {
  if (!isRecordLike(metadataJson)) {
    return null;
  }

  return metadataJson.preparedExecution ?? null;
}

function preparedExecutionPacketUsesSource(packet: unknown, source: TreasuryWallet | null) {
  if (!source || !isRecordLike(packet) || !isRecordLike(packet.source)) {
    return false;
  }

  return packet.source.walletAddress === source.address;
}

const executionRecordWithExecutorInclude = {
  executorUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.ExecutionRecordInclude;

const paymentOrderInclude = {
  paymentRequest: {
    include: {
      requestedByUser: {
        select: {
          userId: true,
          email: true,
          displayName: true,
        },
      },
    },
  },
  destination: {
    include: {
      counterparty: true,
    },
  },
  counterparty: true,
  sourceTreasuryWallet: true,
  createdByUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
    },
  },
  transferRequests: {
    include: {
      sourceTreasuryWallet: true,
      destination: {
        include: {
          counterparty: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' as const },
  },
  proposals: {
    where: {
      provider: 'squads_v4',
      semanticType: 'send_payment',
    },
    orderBy: { createdAt: 'desc' as const },
  },
} satisfies Prisma.PaymentOrderInclude;

const paymentOrderIncludeWithEvents = {
  ...paymentOrderInclude,
  events: {
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.PaymentOrderInclude;

function validateDestinationForPaymentOrder(destination: Pick<Destination, 'label' | 'trustState' | 'isActive'>) {
  if (!destination.isActive) {
    throw new Error(`Destination "${destination.label}" is inactive and cannot be used for payment orders`);
  }

  if (destination.trustState === 'blocked') {
    throw new Error(`Destination "${destination.label}" is blocked and cannot be used for payment orders`);
  }
}

function validateSourceAndDestination(args: {
  sourceTreasuryWallet: Pick<TreasuryWallet, 'address'> | null;
  destination: Pick<Destination, 'walletAddress' | 'label'>;
}) {
  if (!args.sourceTreasuryWallet) {
    return;
  }

  if (args.sourceTreasuryWallet.address === args.destination.walletAddress) {
    throw new Error(`Source wallet cannot be the same as destination "${args.destination.label}"`);
  }
}

async function enforceDuplicatePaymentOrder(args: {
  organizationId: string;
  destinationId: string;
  amountRaw: string | bigint;
  reference: string | null;
  excludePaymentOrderId?: string;
}) {
  if (!args.reference) {
    return;
  }

  const duplicate = await prisma.paymentOrder.findFirst({
    where: {
      organizationId: args.organizationId,
      destinationId: args.destinationId,
      amountRaw: BigInt(args.amountRaw),
      state: {
        notIn: ['closed', 'cancelled'],
      },
      OR: [
        { externalReference: { equals: args.reference, mode: 'insensitive' } },
        { invoiceNumber: { equals: args.reference, mode: 'insensitive' } },
      ],
      ...(args.excludePaymentOrderId
        ? {
            paymentOrderId: {
              not: args.excludePaymentOrderId,
            },
          }
        : {}),
    },
  });

  if (duplicate) {
    throw new Error(`Active payment order with reference "${args.reference}" already exists for this destination and amount`);
  }
}

function normalizeReference(value: string | null) {
  const normalized = normalizeOptionalText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function createPaymentOrderEvent(
  client: PaymentOrderClient,
  args: {
    paymentOrderId: string;
    organizationId: string;
    eventType: string;
    actorType: 'user' | 'system' | 'worker';
    actorId?: string | null;
    beforeState?: string | null;
    afterState?: string | null;
    linkedTransferRequestId?: string | null;
    linkedExecutionRecordId?: string | null;
    linkedSignature?: string | null;
    payloadJson: Prisma.InputJsonValue;
  },
) {
  await client.paymentOrderEvent.create({
    data: {
      paymentOrderId: args.paymentOrderId,
      organizationId: args.organizationId,
      eventType: args.eventType,
      actorType: args.actorType,
      actorId: args.actorId ?? null,
      beforeState: args.beforeState ?? null,
      afterState: args.afterState ?? null,
      linkedTransferRequestId: args.linkedTransferRequestId ?? null,
      linkedExecutionRecordId: args.linkedExecutionRecordId ?? null,
      linkedSignature: args.linkedSignature ?? null,
      payloadJson: args.payloadJson,
    },
  });
}

function buildPaymentEventActor(args: PaymentActorInput) {
  return {
    actorType: args.actorType ?? 'user',
    actorId: args.actorId ?? args.actorUserId,
  };
}

function buildTransferEventActor(args: PaymentActorInput) {
  const actor = buildPaymentEventActor(args);
  return {
    ...actor,
    eventSource: actor.actorType,
  };
}

function serializePaymentOrderEvent(event: PaymentOrderEvent) {
  return {
    paymentOrderEventId: event.paymentOrderEventId,
    paymentOrderId: event.paymentOrderId,
    organizationId: event.organizationId,
    eventType: event.eventType,
    actorType: event.actorType,
    actorId: event.actorId,
    beforeState: event.beforeState,
    afterState: event.afterState,
    linkedTransferRequestId: event.linkedTransferRequestId,
    linkedExecutionRecordId: event.linkedExecutionRecordId,
    linkedSignature: event.linkedSignature,
    payloadJson: event.payloadJson,
    createdAt: event.createdAt,
  };
}

function serializePaymentRequestRef(
  request: PaymentRequest & { requestedByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null },
) {
  return {
    paymentRequestId: request.paymentRequestId,
    organizationId: request.organizationId,
    destinationId: request.destinationId,
    counterpartyId: request.counterpartyId,
    requestedByUserId: request.requestedByUserId,
    amountRaw: request.amountRaw.toString(),
    asset: request.asset,
    reason: request.reason,
    externalReference: request.externalReference,
    dueAt: request.dueAt,
    state: request.state,
    metadataJson: request.metadataJson,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    requestedByUser: serializeUserRef(request.requestedByUser),
  };
}

function serializePaymentOrderDestination(
  destination: Destination & {
    counterparty: Counterparty | null;
  },
) {
  return {
    destinationId: destination.destinationId,
    organizationId: destination.organizationId,
    counterpartyId: destination.counterpartyId,
    chain: destination.chain,
    asset: destination.asset,
    walletAddress: destination.walletAddress,
    tokenAccountAddress: destination.tokenAccountAddress,
    destinationType: destination.destinationType,
    trustState: destination.trustState,
    label: destination.label,
    notes: destination.notes,
    isInternal: destination.isInternal,
    isActive: destination.isActive,
    metadataJson: destination.metadataJson,
    createdAt: destination.createdAt,
    updatedAt: destination.updatedAt,
    counterparty: destination.counterparty ? serializeCounterparty(destination.counterparty) : null,
  };
}

function serializeCounterparty(counterparty: Counterparty) {
  return {
    counterpartyId: counterparty.counterpartyId,
    organizationId: counterparty.organizationId,
    displayName: counterparty.displayName,
    category: counterparty.category,
    externalReference: counterparty.externalReference,
    status: counterparty.status,
    metadataJson: counterparty.metadataJson,
    createdAt: counterparty.createdAt,
    updatedAt: counterparty.updatedAt,
  };
}

function serializeTreasuryWallet(address: TreasuryWallet) {
  return {
    treasuryWalletId: address.treasuryWalletId,
    organizationId: address.organizationId,
    chain: address.chain,
    address: address.address,
    assetScope: address.assetScope,
    usdcAtaAddress: address.usdcAtaAddress,
    isActive: address.isActive,
    source: address.source,
    sourceRef: address.sourceRef,
    displayName: address.displayName,
    notes: address.notes,
    propertiesJson: address.propertiesJson,
    createdAt: address.createdAt,
    updatedAt: address.updatedAt,
  };
}

function serializeUserRef(user: Pick<User, 'userId' | 'email' | 'displayName'> | null | undefined) {
  return user
    ? {
        userId: user.userId,
        email: user.email,
        displayName: user.displayName,
      }
    : null;
}

function getMetadataString(value: unknown, key: string) {
  if (!isRecordLike(value)) {
    return null;
  }

  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : null;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
