import type {
  Counterparty,
  Destination,
  Payee,
  PaymentOrder,
  PaymentOrderEvent,
  PaymentRequest,
  Prisma,
  TransferRequest,
  User,
  WorkspaceAddress,
} from '@prisma/client';
import { buildApprovalEvaluationSummary, getOrCreateWorkspaceApprovalPolicy } from './approval-policy.js';
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
import { serializePayee } from './payees.js';
export { PAYMENT_ORDER_STATES, isPaymentOrderState, type PaymentOrderState } from './payment-order-state.js';
import type { PaymentOrderState } from './payment-order-state.js';

export type PaymentOrderWithRelations = PaymentOrder & {
  workspace?: unknown;
  paymentRequest: (PaymentRequest & { requestedByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null }) | null;
  payee: (Payee & { defaultDestination: Destination | null }) | null;
  destination: Destination & {
    counterparty: Counterparty | null;
    linkedWorkspaceAddress: WorkspaceAddress | null;
  };
  counterparty: Counterparty | null;
  sourceWorkspaceAddress: WorkspaceAddress | null;
  createdByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  transferRequests: Array<
    TransferRequest & {
      sourceWorkspaceAddress: WorkspaceAddress | null;
      destinationWorkspaceAddress: WorkspaceAddress | null;
      destination: (Destination & { counterparty: Counterparty | null }) | null;
    }
  >;
  events?: PaymentOrderEvent[];
};

type PaymentOrderClient = typeof prisma | Prisma.TransactionClient;
type PaymentActorInput = {
  actorUserId: string | null;
  actorType?: 'user' | 'api_key';
  actorId?: string | null;
};

export async function createPaymentOrder(
  args: PaymentActorInput & {
    workspaceId: string;
    destinationId: string;
    sourceWorkspaceAddressId?: string | null;
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
    payeeId?: string | null;
    submitNow?: boolean;
  },
) {
  const [destination, sourceWorkspaceAddress] = await Promise.all([
    prisma.destination.findFirst({
      where: {
        workspaceId: args.workspaceId,
        destinationId: args.destinationId,
        isActive: true,
      },
      include: {
        counterparty: true,
        linkedWorkspaceAddress: true,
      },
    }),
    args.sourceWorkspaceAddressId
      ? prisma.workspaceAddress.findFirst({
          where: {
            workspaceId: args.workspaceId,
            workspaceAddressId: args.sourceWorkspaceAddressId,
            isActive: true,
          },
        })
      : Promise.resolve(null),
  ]);

  if (!destination) {
    throw new Error('Destination not found');
  }

  if (args.payeeId) {
    const payee = await prisma.payee.findFirst({
      where: {
        workspaceId: args.workspaceId,
        payeeId: args.payeeId,
        status: 'active',
      },
    });
    if (!payee) {
      throw new Error('Payee not found');
    }
  }

  if (args.sourceWorkspaceAddressId && !sourceWorkspaceAddress) {
    throw new Error('Source wallet not found');
  }

  validateSourceAndDestination({
    sourceWorkspaceAddress,
    destination,
  });

  await enforceDuplicatePaymentOrder({
    workspaceId: args.workspaceId,
    destinationId: destination.destinationId,
    amountRaw: args.amountRaw,
    reference: normalizeReference(args.externalReference ?? args.invoiceNumber ?? null),
  });

  const created = await prisma.$transaction(async (tx) => {
    const paymentOrder = await tx.paymentOrder.create({
      data: {
        workspaceId: args.workspaceId,
        paymentRequestId: args.paymentRequestId ?? null,
        paymentRunId: args.paymentRunId ?? null,
        payeeId: args.payeeId ?? null,
        destinationId: destination.destinationId,
        counterpartyId: destination.counterpartyId,
        sourceWorkspaceAddressId: sourceWorkspaceAddress?.workspaceAddressId,
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
      workspaceId: args.workspaceId,
      eventType: 'payment_order_created',
      ...buildPaymentEventActor(args),
      beforeState: null,
      afterState: paymentOrder.state,
      payloadJson: {
        destinationId: paymentOrder.destinationId,
        sourceWorkspaceAddressId: paymentOrder.sourceWorkspaceAddressId,
        amountRaw: paymentOrder.amountRaw.toString(),
        asset: paymentOrder.asset,
        paymentRequestId: paymentOrder.paymentRequestId,
        paymentRunId: paymentOrder.paymentRunId,
        payeeId: paymentOrder.payeeId,
      },
    });

    return paymentOrder;
  });

  if (args.submitNow) {
    return submitPaymentOrder({
      workspaceId: args.workspaceId,
      paymentOrderId: created.paymentOrderId,
      actorUserId: args.actorUserId,
      actorType: args.actorType,
      actorId: args.actorId,
    });
  }

  return getPaymentOrderDetail(args.workspaceId, created.paymentOrderId);
}

export async function listPaymentOrders(
  workspaceId: string,
  options?: {
    limit?: number;
    state?: string;
    paymentRunId?: string;
  },
) {
  const paymentOrders = await prisma.paymentOrder.findMany({
    where: {
      workspaceId,
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

export async function getPaymentOrderDetail(workspaceId: string, paymentOrderId: string) {
  const paymentOrder = await prisma.paymentOrder.findFirstOrThrow({
    where: { workspaceId, paymentOrderId },
    include: paymentOrderIncludeWithEvents,
  });

  return buildPaymentOrderReadModel(paymentOrder);
}

export async function updatePaymentOrder(
  args: PaymentActorInput & {
    workspaceId: string;
    paymentOrderId: string;
    input: {
      sourceWorkspaceAddressId?: string | null;
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
      workspaceId: args.workspaceId,
      paymentOrderId: args.paymentOrderId,
    },
    include: paymentOrderInclude,
  });

  if (!['draft', 'pending_approval', 'approved'].includes(current.state)) {
    throw new Error(`Payment order ${current.state} cannot be edited`);
  }

  const sourceWorkspaceAddress = args.input.sourceWorkspaceAddressId
    ? await prisma.workspaceAddress.findFirst({
        where: {
          workspaceId: args.workspaceId,
          workspaceAddressId: args.input.sourceWorkspaceAddressId,
          isActive: true,
        },
      })
    : args.input.sourceWorkspaceAddressId === null
      ? null
      : current.sourceWorkspaceAddress;

  if (args.input.sourceWorkspaceAddressId && !sourceWorkspaceAddress) {
    throw new Error('Source wallet not found');
  }

  validateSourceAndDestination({
    sourceWorkspaceAddress,
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
    workspaceId: args.workspaceId,
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
        sourceWorkspaceAddressId:
          args.input.sourceWorkspaceAddressId === undefined
            ? undefined
            : sourceWorkspaceAddress?.workspaceAddressId ?? null,
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
      workspaceId: args.workspaceId,
      eventType: 'payment_order_updated',
      ...buildPaymentEventActor(args),
      beforeState: current.state,
      afterState: current.state,
      payloadJson: {
        changedFields: Object.keys(args.input),
      },
    });
  });

  return getPaymentOrderDetail(args.workspaceId, args.paymentOrderId);
}

export async function submitPaymentOrder(
  args: PaymentActorInput & {
    workspaceId: string;
    paymentOrderId: string;
  },
) {
  const current = await prisma.paymentOrder.findFirstOrThrow({
    where: {
      workspaceId: args.workspaceId,
      paymentOrderId: args.paymentOrderId,
    },
    include: paymentOrderInclude,
  });

  if (current.transferRequests.length) {
    return getPaymentOrderDetail(args.workspaceId, args.paymentOrderId);
  }

  if (current.state !== 'draft') {
    throw new Error(`Payment order ${current.state} cannot be submitted`);
  }

  validateDestinationForPaymentOrder(current.destination);
  validateSourceAndDestination({
    sourceWorkspaceAddress: current.sourceWorkspaceAddress,
    destination: current.destination,
  });

  await prisma.$transaction(async (tx) => {
    const approvalPolicy = await getOrCreateWorkspaceApprovalPolicy(args.workspaceId, tx);
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
        workspaceId: args.workspaceId,
        paymentOrderId: current.paymentOrderId,
        sourceWorkspaceAddressId: current.sourceWorkspaceAddressId,
        destinationWorkspaceAddressId: requireLinkedDestinationAddress(current.destination),
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
          payeeId: current.payeeId,
          invoiceNumber: current.invoiceNumber,
          attachmentUrl: current.attachmentUrl,
        },
      },
    });

    await createTransferRequestEvent(tx, {
      transferRequestId: transferRequest.transferRequestId,
      workspaceId: args.workspaceId,
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
        workspaceId: args.workspaceId,
        actorType: 'system',
        action: approvalEvaluation.requiresApproval ? 'routed_for_approval' : 'auto_approved',
        payloadJson: approvalEvaluation as Prisma.InputJsonValue,
      },
    });

    await createTransferRequestEvent(tx, {
      transferRequestId: transferRequest.transferRequestId,
      workspaceId: args.workspaceId,
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
      workspaceId: args.workspaceId,
      eventType: approvalEvaluation.requiresApproval ? 'payment_order_approval_required' : 'payment_order_auto_approved',
      actorType: 'system',
      beforeState: current.state,
      afterState: finalPaymentOrderState,
      linkedTransferRequestId: transferRequest.transferRequestId,
      payloadJson: approvalEvaluation as Prisma.InputJsonValue,
    });
  });

  return getPaymentOrderDetail(args.workspaceId, args.paymentOrderId);
}

export async function cancelPaymentOrder(args: PaymentActorInput & {
  workspaceId: string;
  paymentOrderId: string;
}) {
  const current = await prisma.paymentOrder.findFirstOrThrow({
    where: {
      workspaceId: args.workspaceId,
      paymentOrderId: args.paymentOrderId,
    },
  });

  if (current.state === 'cancelled') {
    return getPaymentOrderDetail(args.workspaceId, args.paymentOrderId);
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
      workspaceId: args.workspaceId,
      eventType: 'payment_order_cancelled',
      ...buildPaymentEventActor(args),
      beforeState: current.state,
      afterState: 'cancelled',
      payloadJson: {},
    });
  });

  return getPaymentOrderDetail(args.workspaceId, args.paymentOrderId);
}

export async function createPaymentOrderExecution(args: PaymentActorInput & {
  workspaceId: string;
  paymentOrderId: string;
  executionSource: string;
  externalReference?: string | null;
  metadataJson?: Prisma.InputJsonValue;
}) {
  const current = await prisma.paymentOrder.findFirstOrThrow({
    where: { workspaceId: args.workspaceId, paymentOrderId: args.paymentOrderId },
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
        workspaceId: args.workspaceId,
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
      workspaceId: args.workspaceId,
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
      workspaceId: args.workspaceId,
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
  workspaceId: string;
  paymentOrderId: string;
  sourceWorkspaceAddressId?: string | null;
}) {
  let current = await prisma.paymentOrder.findFirstOrThrow({
    where: { workspaceId: args.workspaceId, paymentOrderId: args.paymentOrderId },
    include: paymentOrderInclude,
  });

  if (args.sourceWorkspaceAddressId && args.sourceWorkspaceAddressId !== current.sourceWorkspaceAddressId) {
    const sourceWorkspaceAddress = await prisma.workspaceAddress.findFirst({
      where: {
        workspaceId: args.workspaceId,
        workspaceAddressId: args.sourceWorkspaceAddressId,
        isActive: true,
      },
    });

    if (!sourceWorkspaceAddress) {
      throw new Error('Source wallet not found');
    }

    validateSourceAndDestination({
      sourceWorkspaceAddress,
      destination: current.destination,
    });

    await prisma.$transaction(async (tx) => {
      await tx.paymentOrder.update({
        where: { paymentOrderId: current.paymentOrderId },
        data: { sourceWorkspaceAddressId: sourceWorkspaceAddress.workspaceAddressId },
      });

      for (const request of current.transferRequests) {
        await tx.transferRequest.update({
          where: { transferRequestId: request.transferRequestId },
          data: { sourceWorkspaceAddressId: sourceWorkspaceAddress.workspaceAddressId },
        });
      }

      await createPaymentOrderEvent(tx, {
        paymentOrderId: current.paymentOrderId,
        workspaceId: args.workspaceId,
        eventType: 'payment_order_source_selected',
        ...buildPaymentEventActor(args),
        beforeState: current.state,
        afterState: current.state,
        payloadJson: {
          sourceWorkspaceAddressId: sourceWorkspaceAddress.workspaceAddressId,
        },
      });
    });

    current = await prisma.paymentOrder.findFirstOrThrow({
      where: { workspaceId: args.workspaceId, paymentOrderId: args.paymentOrderId },
      include: paymentOrderInclude,
    });
  }

  if (!current.sourceWorkspaceAddress) {
    throw new Error('Choose a source wallet before preparing execution');
  }

  if (!current.transferRequests.length && current.state === 'draft') {
    await submitPaymentOrder({
      workspaceId: args.workspaceId,
      paymentOrderId: args.paymentOrderId,
      actorUserId: args.actorUserId,
      actorType: args.actorType,
      actorId: args.actorId,
    });
    current = await prisma.paymentOrder.findFirstOrThrow({
      where: { workspaceId: args.workspaceId, paymentOrderId: args.paymentOrderId },
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
    workspaceId: args.workspaceId,
    transferRequestId: transferRequest.transferRequestId,
    executionSource: 'prepared_solana_transfer',
  });
  const reusableExecutionPacket = reusableExecutionRecord
    ? getPreparedExecutionPacket(reusableExecutionRecord.metadataJson)
    : null;

  if (
    reusableExecutionRecord
    && reusableExecutionPacket
    && preparedExecutionPacketUsesSource(reusableExecutionPacket, current.sourceWorkspaceAddress)
  ) {
    return {
      executionRecord: serializeExecutionRecord(reusableExecutionRecord),
      executionPacket: reusableExecutionPacket,
      paymentOrder: await getPaymentOrderDetail(args.workspaceId, args.paymentOrderId),
    };
  }

  const executionRecord = await prisma.$transaction(async (tx) => {
    const record = await tx.executionRecord.create({
      data: {
        transferRequestId: transferRequest.transferRequestId,
        workspaceId: args.workspaceId,
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
      workspaceId: args.workspaceId,
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
      workspaceId: args.workspaceId,
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
    paymentOrder: await getPaymentOrderDetail(args.workspaceId, args.paymentOrderId),
  };
}

export async function attachPaymentOrderSignature(args: PaymentActorInput & {
  workspaceId: string;
  paymentOrderId: string;
  submittedSignature?: string | null;
  externalReference?: string | null;
  submittedAt?: Date | null;
  metadataJson?: Prisma.InputJsonValue;
}) {
  const current = await prisma.paymentOrder.findFirstOrThrow({
    where: { workspaceId: args.workspaceId, paymentOrderId: args.paymentOrderId },
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
      workspaceId: args.workspaceId,
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
      workspaceId: args.workspaceId,
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
      workspaceId: args.workspaceId,
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
    workspaceId: string;
    paymentOrderId: string;
    externalReference?: string | null;
    metadataJson?: Prisma.InputJsonValue;
  },
  transferRequestId: string,
) {
  return prisma.executionRecord.create({
    data: {
      transferRequestId,
      workspaceId: args.workspaceId,
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
    ? await getReconciliationDetail(order.workspaceId, primaryTransferRequest.transferRequestId)
    : null;
  const derivedState = derivePaymentOrderState(order, reconciliationDetail);
  const balanceWarning = deriveBalanceWarning(order);

  return {
    paymentOrderId: order.paymentOrderId,
    workspaceId: order.workspaceId,
    paymentRequestId: order.paymentRequestId,
    paymentRunId: order.paymentRunId,
    payeeId: order.payeeId,
    destinationId: order.destinationId,
    counterpartyId: order.counterpartyId,
    sourceWorkspaceAddressId: order.sourceWorkspaceAddressId,
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
    payee: order.payee ? serializePayee(order.payee) : null,
    counterparty: order.counterparty ? serializeCounterparty(order.counterparty) : null,
    sourceWorkspaceAddress: order.sourceWorkspaceAddress ? serializeWorkspaceAddress(order.sourceWorkspaceAddress) : null,
    createdByUser: serializeUserRef(order.createdByUser),
    paymentRequest: order.paymentRequest ? serializePaymentRequestRef(order.paymentRequest) : null,
    transferRequests: order.transferRequests.map((request) => ({
      transferRequestId: request.transferRequestId,
      status: request.status,
      amountRaw: request.amountRaw.toString(),
      requestedAt: request.requestedAt,
    })),
    events: (order.events ?? []).map(serializePaymentOrderEvent),
    reconciliationDetail,
  };
}

function derivePaymentOrderState(
  order: PaymentOrderWithRelations,
  reconciliationDetail: Awaited<ReturnType<typeof getReconciliationDetail>> | null,
): PaymentOrderState {
  if (order.state === 'cancelled' || order.state === 'closed') {
    return order.state;
  }

  if (!reconciliationDetail) {
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
  const source = args.current.sourceWorkspaceAddress;
  if (!source) {
    throw new Error('Choose a source wallet before preparing execution');
  }

  const sourceTokenAccount = source.usdcAtaAddress ?? deriveUsdcAtaForWallet(source.address);
  const destinationTokenAccount = args.current.destination.tokenAccountAddress
    ?? args.current.destination.linkedWorkspaceAddress?.usdcAtaAddress
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
      workspaceAddressId: source.workspaceAddressId,
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
  workspaceId: string;
  transferRequestId: string;
  executionSource: string;
}) {
  return prisma.executionRecord.findFirst({
    where: {
      workspaceId: args.workspaceId,
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

function preparedExecutionPacketUsesSource(packet: unknown, source: WorkspaceAddress | null) {
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
  payee: {
    include: {
      defaultDestination: true,
    },
  },
  destination: {
    include: {
      counterparty: true,
      linkedWorkspaceAddress: true,
    },
  },
  counterparty: true,
  sourceWorkspaceAddress: true,
  createdByUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
    },
  },
  transferRequests: {
    include: {
      sourceWorkspaceAddress: true,
      destinationWorkspaceAddress: true,
      destination: {
        include: {
          counterparty: true,
        },
      },
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
  sourceWorkspaceAddress: Pick<WorkspaceAddress, 'address'> | null;
  destination: Pick<Destination, 'walletAddress' | 'label'>;
}) {
  if (!args.sourceWorkspaceAddress) {
    return;
  }

  if (args.sourceWorkspaceAddress.address === args.destination.walletAddress) {
    throw new Error(`Source wallet cannot be the same as destination "${args.destination.label}"`);
  }
}

function requireLinkedDestinationAddress(
  destination: Pick<Destination, 'label' | 'linkedWorkspaceAddressId'>,
) {
  if (!destination.linkedWorkspaceAddressId) {
    throw new Error(`Destination "${destination.label}" must be linked to a saved wallet before creating a payment order transfer`);
  }
  return destination.linkedWorkspaceAddressId;
}

async function enforceDuplicatePaymentOrder(args: {
  workspaceId: string;
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
      workspaceId: args.workspaceId,
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
    workspaceId: string;
    eventType: string;
    actorType: 'user' | 'system' | 'worker' | 'api_key';
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
      workspaceId: args.workspaceId,
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
    workspaceId: event.workspaceId,
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
    workspaceId: request.workspaceId,
    payeeId: request.payeeId,
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
    linkedWorkspaceAddress: WorkspaceAddress | null;
  },
) {
  return {
    destinationId: destination.destinationId,
    workspaceId: destination.workspaceId,
    counterpartyId: destination.counterpartyId,
    linkedWorkspaceAddressId: destination.linkedWorkspaceAddressId,
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
    linkedWorkspaceAddress: destination.linkedWorkspaceAddress ? serializeWorkspaceAddress(destination.linkedWorkspaceAddress) : null,
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

function serializeWorkspaceAddress(address: WorkspaceAddress) {
  return {
    workspaceAddressId: address.workspaceAddressId,
    workspaceId: address.workspaceId,
    chain: address.chain,
    address: address.address,
    addressKind: address.addressKind,
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
