import type {
  Counterparty,
  CounterpartyWallet,
  DecimalProposal,
  PaymentOrder,
  PaymentOrderEvent,
  Prisma,
  TransferRequest,
  User,
  TreasuryWallet,
} from '@prisma/client';
import { serializeExecutionRecord } from '../transfer-requests/execution-records.js';
import { prisma } from '../infra/prisma.js';
import { getReconciliationDetail } from '../transfer-requests/settlement-read-model.js';
import {
  buildUsdcTransferInstructions,
  deriveUsdcAtaForWallet,
  USDC_DECIMALS,
  USDC_MINT,
} from '../solana.js';
import { createTransferRequestEvent } from '../transfer-requests/events.js';
import { getPrimaryTransferRequest } from '../transfer-requests/helpers.js';
import { loadLiveProposalState } from '../squads/treasury.js';
export { PAYMENT_ORDER_STATES, isPaymentOrderState, type PaymentOrderState } from './order-state.js';
import type { PaymentOrderState } from './order-state.js';

export type PaymentOrderWithRelations = PaymentOrder & {
  organization?: unknown;
  counterpartyWallet: CounterpartyWallet & {
    counterparty: Counterparty | null;
  };
  counterparty: Counterparty | null;
  sourceTreasuryWallet: TreasuryWallet | null;
  createdByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  transferRequests: Array<
    TransferRequest & {
      sourceTreasuryWallet: TreasuryWallet | null;
      counterpartyWallet: (CounterpartyWallet & { counterparty: Counterparty | null }) | null;
    }
  >;
  proposals?: DecimalProposal[];
  events?: PaymentOrderEvent[];
};

type PaymentOrderClient = typeof prisma | Prisma.TransactionClient;
type PaymentActorInput = {
  actorUserId: string | null;
  actorType?: 'user' | 'agent' | 'system';
  actorId?: string | null;
};

export async function createPaymentOrder(
  args: PaymentActorInput & {
    organizationId: string;
    counterpartyWalletId: string;
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
    inputBatchId?: string | null;
    inputBatchLabel?: string | null;
    initialState?: Extract<PaymentOrderState, 'draft' | 'needs_review'>;
    submitNow?: boolean;
  },
) {
  const [counterpartyWallet, sourceTreasuryWallet] = await Promise.all([
    prisma.counterpartyWallet.findFirst({
      where: {
        organizationId: args.organizationId,
        counterpartyWalletId: args.counterpartyWalletId,
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

  if (!counterpartyWallet) {
    throw new Error('Counterparty wallet not found');
  }

  if (args.sourceTreasuryWalletId && !sourceTreasuryWallet) {
    throw new Error('Source wallet not found');
  }

  validateSourceAndCounterpartyWallet({
    sourceTreasuryWallet,
    counterpartyWallet,
  });

  await enforceDuplicatePaymentOrder({
    organizationId: args.organizationId,
    counterpartyWalletId: counterpartyWallet.counterpartyWalletId,
    amountRaw: args.amountRaw,
    reference: normalizeReference(args.externalReference ?? args.invoiceNumber ?? null),
  });

  const created = await prisma.$transaction(async (tx) => {
    const paymentOrder = await tx.paymentOrder.create({
      data: {
        organizationId: args.organizationId,
        inputBatchId: args.inputBatchId ?? null,
        inputBatchLabel: normalizeOptionalText(args.inputBatchLabel),
        counterpartyWalletId: counterpartyWallet.counterpartyWalletId,
        counterpartyId: counterpartyWallet.counterpartyId,
        sourceTreasuryWalletId: sourceTreasuryWallet?.treasuryWalletId,
        amountRaw: BigInt(args.amountRaw),
        asset: args.asset ?? 'usdc',
        memo: normalizeOptionalText(args.memo),
        externalReference: normalizeOptionalText(args.externalReference),
        invoiceNumber: normalizeOptionalText(args.invoiceNumber),
        attachmentUrl: normalizeOptionalText(args.attachmentUrl),
        dueAt: args.dueAt ?? undefined,
        state: args.initialState ?? 'draft',
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
        counterpartyWalletId: paymentOrder.counterpartyWalletId,
        sourceTreasuryWalletId: paymentOrder.sourceTreasuryWalletId,
        amountRaw: paymentOrder.amountRaw.toString(),
        asset: paymentOrder.asset,
        inputBatchId: paymentOrder.inputBatchId,
        inputBatchLabel: paymentOrder.inputBatchLabel,
      },
    });

    return paymentOrder;
  });

  if (args.submitNow) {
    if (created.state === 'needs_review') {
      throw new Error('Payment orders that need review must be cleared before submission');
    }
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
    inputBatchId?: string;
  },
) {
  const paymentOrders = await prisma.paymentOrder.findMany({
    where: {
      organizationId,
      ...(options?.state ? { state: options.state } : {}),
      ...(options?.inputBatchId ? { inputBatchId: options.inputBatchId } : {}),
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

  if (!['draft', 'needs_review'].includes(current.state)) {
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

  validateSourceAndCounterpartyWallet({
    sourceTreasuryWallet,
    counterpartyWallet: current.counterpartyWallet,
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
    counterpartyWalletId: current.counterpartyWalletId,
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
): Promise<Awaited<ReturnType<typeof getPaymentOrderDetail>>> {
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

  if (current.state === 'needs_review') {
    throw new Error('Payment orders that need review must be cleared before submission');
  }

  if (current.state !== 'draft') {
    throw new Error(`Payment order ${current.state} cannot be submitted`);
  }

  validateCounterpartyWalletForPaymentOrder(current.counterpartyWallet);
  validateSourceAndCounterpartyWallet({
    sourceTreasuryWallet: current.sourceTreasuryWallet,
    counterpartyWallet: current.counterpartyWallet,
  });

  await prisma.$transaction(async (tx) => {
    // This is the internal audit row used by proposal/execution/proof code.
    // The user-facing PaymentOrder state remains `draft` until a Squads
    // proposal exists; the actual approval ceremony happens in Squads.
    const transferRequest = await tx.transferRequest.create({
      data: {
        organizationId: args.organizationId,
        paymentOrderId: current.paymentOrderId,
        sourceTreasuryWalletId: current.sourceTreasuryWalletId,
        counterpartyWalletId: current.counterpartyWalletId,
        requestType: 'payment_order',
        asset: current.asset,
        amountRaw: current.amountRaw,
        requestedByUserId: args.actorUserId ?? undefined,
        reason: current.memo,
        externalReference: current.externalReference ?? current.invoiceNumber,
        status: 'approved',
        dueAt: current.dueAt,
        propertiesJson: {
          paymentOrderId: current.paymentOrderId,
          inputBatchId: current.inputBatchId,
          inputBatchLabel: current.inputBatchLabel,
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
      afterState: 'approved',
      payloadJson: {
        source: 'payment_order',
        paymentOrderId: current.paymentOrderId,
        inputBatchId: current.inputBatchId,
        inputBatchLabel: current.inputBatchLabel,
        amountRaw: transferRequest.amountRaw.toString(),
        asset: transferRequest.asset,
      },
    });

    await createPaymentOrderEvent(tx, {
      paymentOrderId: current.paymentOrderId,
      organizationId: args.organizationId,
      eventType: 'payment_order_transfer_request_recorded',
      actorType: 'system',
      beforeState: current.state,
      afterState: current.state,
      linkedTransferRequestId: transferRequest.transferRequestId,
      payloadJson: {},
    });
  });

  return getPaymentOrderDetail(args.organizationId, args.paymentOrderId);
}

export async function clearPaymentOrderReview(args: PaymentActorInput & {
  organizationId: string;
  paymentOrderId: string;
  reviewNote?: string | null;
  trustCounterpartyWallet?: boolean;
  submitAfterClear?: boolean;
}): Promise<Awaited<ReturnType<typeof getPaymentOrderDetail>>> {
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

  if (current.state !== 'needs_review') {
    throw new Error(`Payment order ${current.state} does not need review`);
  }

  if (current.counterpartyWallet.trustState === 'blocked') {
    throw new Error(`Counterparty wallet "${current.counterpartyWallet.label}" is blocked and cannot be cleared`);
  }

  if (current.counterpartyWallet.trustState === 'restricted') {
    throw new Error(
      `Counterparty wallet "${current.counterpartyWallet.label}" is restricted. Mark it trusted in the address book before clearing this payment.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    const nextMetadata = {
      ...(isRecordLike(current.metadataJson) ? current.metadataJson : {}),
      humanReview: {
        status: 'cleared',
        clearedAt: new Date().toISOString(),
        clearedByUserId: args.actorUserId,
        note: normalizeOptionalText(args.reviewNote),
      },
    };

    if (args.trustCounterpartyWallet !== false && current.counterpartyWallet.trustState === 'unreviewed') {
      await tx.counterpartyWallet.update({
        where: { counterpartyWalletId: current.counterpartyWalletId },
        data: {
          trustState: 'trusted',
          metadataJson: {
            ...(isRecordLike(current.counterpartyWallet.metadataJson) ? current.counterpartyWallet.metadataJson : {}),
            reviewClearedFromPaymentOrderId: current.paymentOrderId,
            reviewedAt: new Date().toISOString(),
            reviewedByUserId: args.actorUserId,
          },
        },
      });
    }

    await tx.paymentOrder.update({
      where: { paymentOrderId: current.paymentOrderId },
      data: {
        state: 'draft',
        metadataJson: nextMetadata as Prisma.InputJsonValue,
      },
    });

    await createPaymentOrderEvent(tx, {
      paymentOrderId: current.paymentOrderId,
      organizationId: args.organizationId,
      eventType: 'payment_order_review_cleared',
      ...buildPaymentEventActor(args),
      beforeState: current.state,
      afterState: 'draft',
      payloadJson: {
        reviewNote: normalizeOptionalText(args.reviewNote),
        trustedCounterpartyWallet:
          args.trustCounterpartyWallet !== false && current.counterpartyWallet.trustState === 'unreviewed',
      },
    });
  });

  if (args.submitAfterClear ?? true) {
    return submitPaymentOrder({
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
      actorUserId: args.actorUserId,
      actorType: args.actorType,
      actorId: args.actorId,
    });
  }

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

  if (current.state === 'settled') {
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

    validateSourceAndCounterpartyWallet({
      sourceTreasuryWallet,
      counterpartyWallet: current.counterpartyWallet,
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
      afterState: current.state,
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

    const nextPaymentOrderState = hasSubmittedSignature ? 'executed' : current.state;
    if (hasSubmittedSignature && current.state !== 'executed') {
      await tx.paymentOrder.update({
        where: { paymentOrderId: current.paymentOrderId },
        data: { state: nextPaymentOrderState },
      });
    }

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
      afterState: nextPaymentOrderState,
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
  const liveProposalState = latestSquadsPaymentProposal
    ? await loadLiveProposalState(latestSquadsPaymentProposal)
    : null;
  const squadsLifecycle = deriveSquadsPaymentLifecycle(latestSquadsPaymentProposal, liveProposalState);
  const derivedState = derivePaymentOrderState(order, reconciliationDetail, squadsLifecycle);
  const productLifecycle = derivePaymentProductLifecycle(order, derivedState, squadsLifecycle);
  const balanceWarning = deriveBalanceWarning(order);

  return {
    paymentOrderId: order.paymentOrderId,
    organizationId: order.organizationId,
    inputBatchId: order.inputBatchId,
    inputBatchLabel: order.inputBatchLabel,
    counterpartyWalletId: order.counterpartyWalletId,
    destinationId: order.counterpartyWalletId,
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
    productLifecycle,
    sourceBalanceSnapshotJson: order.sourceBalanceSnapshotJson,
    balanceWarning,
    metadataJson: order.metadataJson,
    createdByUserId: order.createdByUserId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    counterpartyWallet: serializePaymentOrderCounterpartyWallet(order.counterpartyWallet),
    counterparty: order.counterparty ? serializeCounterparty(order.counterparty) : null,
    sourceTreasuryWallet: order.sourceTreasuryWallet ? serializeTreasuryWallet(order.sourceTreasuryWallet) : null,
    createdByUser: serializeUserRef(order.createdByUser),
    transferRequests: order.transferRequests.map((request) => ({
      transferRequestId: request.transferRequestId,
      status: request.status,
      counterpartyWalletId: request.counterpartyWalletId,
      destinationId: request.counterpartyWalletId,
      amountRaw: request.amountRaw.toString(),
      requestedAt: request.requestedAt,
    })),
    squadsLifecycle,
    squadsPaymentProposal: latestSquadsPaymentProposal ? serializePaymentOrderProposal(latestSquadsPaymentProposal, liveProposalState) : null,
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
  if (order.state === 'cancelled') {
    return 'cancelled';
  }

  if (!reconciliationDetail) {
    if (squadsLifecycle) {
      return squadsLifecycle.paymentState;
    }
    return order.state as PaymentOrderState;
  }

  if (reconciliationDetail.requestDisplayState === 'matched') {
    return 'settled';
  }

  if (squadsLifecycle) {
    return squadsLifecycle.productState;
  }

  if (order.sourceTreasuryWallet?.source === 'squads_v4') {
    return mapInternalPaymentStateToSquadsProductState(order.state);
  }

  if (reconciliationDetail.latestExecution) {
    const latest = reconciliationDetail.latestExecution;
    const hasSignature = Boolean(latest.submittedSignature?.trim());
    const awaitingWallet =
      !hasSignature
      && (latest.state === 'ready_for_execution' || latest.state === 'broadcast_failed');
    if (awaitingWallet) {
      return 'draft';
    }
    return 'executed';
  }

  if (reconciliationDetail.status === 'approved' || reconciliationDetail.status === 'ready_for_execution') {
    return 'draft';
  }

  if (reconciliationDetail.status === 'rejected') {
    return 'cancelled';
  }

  return order.state as PaymentOrderState;
}

function derivePaymentProductLifecycle(
  order: PaymentOrderWithRelations,
  derivedState: PaymentOrderState,
  squadsLifecycle: ReturnType<typeof deriveSquadsPaymentLifecycle>,
) {
  const isSquadsPayment = order.sourceTreasuryWallet?.source === 'squads_v4' || Boolean(squadsLifecycle);
  const terminalSettlementState = ['settled', 'cancelled'].includes(derivedState)
    ? derivedState
    : null;
  const productState = terminalSettlementState ?? (isSquadsPayment
    ? (squadsLifecycle?.productState ?? mapInternalPaymentStateToSquadsProductState(order.state))
    : derivedState);

  return {
    productState,
    source: isSquadsPayment ? 'squads_v4' : 'legacy',
    steps: ['needs_review', 'draft', 'proposed', 'executed', 'settled', 'proof'],
  };
}

function getLatestSquadsPaymentProposal(order: PaymentOrderWithRelations) {
  return (order.proposals ?? [])
    .filter((proposal) => proposal.provider === 'squads_v4' && proposal.semanticType === 'send_payment')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

type LiveProposalState = Awaited<ReturnType<typeof loadLiveProposalState>>;

function deriveSquadsPaymentLifecycle(proposal: DecimalProposal | null, live: LiveProposalState) {
  if (!proposal) {
    return null;
  }

  const effectiveStatus = live?.status ?? proposal.status;
  const productState = mapSquadsProposalStatusToPaymentState(proposal, effectiveStatus);
  return {
    provider: proposal.provider,
    decimalProposalId: proposal.decimalProposalId,
    proposalStatus: effectiveStatus,
    productState,
    paymentState: productState,
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

function mapSquadsProposalStatusToPaymentState(proposal: DecimalProposal, status: string): PaymentOrderState {
  if (proposal.executedSignature || status === 'executed') {
    return 'executed';
  }
  if (
    proposal.submittedSignature
    || status === 'prepared'
    || status === 'submitted'
    || status === 'active'
    || status === 'approved'
  ) {
    return 'proposed';
  }
  if (status === 'rejected' || status === 'cancelled' || status === 'failed') {
    return 'cancelled';
  }
  return 'draft';
}

function mapInternalPaymentStateToSquadsProductState(state: string): PaymentOrderState {
  switch (state) {
    case 'needs_review':
      return 'needs_review';
    case 'draft':
      return 'draft';
    case 'proposed':
      return 'proposed';
    case 'executed':
      return 'executed';
    case 'settled':
      return 'settled';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'draft';
  }
}

function isTerminalSquadsPaymentProposal(proposal: DecimalProposal) {
  return ['rejected', 'cancelled', 'failed'].includes(proposal.status);
}

function serializePaymentOrderProposal(proposal: DecimalProposal, live: LiveProposalState) {
  return {
    decimalProposalId: proposal.decimalProposalId,
    provider: proposal.provider,
    proposalType: proposal.proposalType,
    proposalCategory: proposal.proposalCategory,
    semanticType: proposal.semanticType,
    status: live?.status ?? proposal.status,
    localStatus: proposal.status,
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
    voting: live?.voting ?? null,
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
  const destinationTokenAccount = args.current.counterpartyWallet.tokenAccountAddress
    ?? deriveUsdcAtaForWallet(args.current.counterpartyWallet.walletAddress);
  const instructions = buildUsdcTransferInstructions({
    sourceWallet: source.address,
    sourceTokenAccount,
    destinationWallet: args.current.counterpartyWallet.walletAddress,
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
      counterpartyWalletId: args.current.counterpartyWallet.counterpartyWalletId,
      label: args.current.counterpartyWallet.label,
      walletAddress: args.current.counterpartyWallet.walletAddress,
      tokenAccountAddress: destinationTokenAccount,
      counterpartyName: args.current.counterparty?.displayName ?? args.current.counterpartyWallet.counterparty?.displayName ?? null,
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
  counterpartyWallet: {
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
      counterpartyWallet: {
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

function validateCounterpartyWalletForPaymentOrder(wallet: Pick<CounterpartyWallet, 'label' | 'trustState' | 'isActive'>) {
  if (!wallet.isActive) {
    throw new Error(`Counterparty wallet "${wallet.label}" is inactive and cannot be used for payment orders`);
  }

  if (wallet.trustState === 'blocked') {
    throw new Error(`Counterparty wallet "${wallet.label}" is blocked and cannot be used for payment orders`);
  }

  // Squads multisig is the approval ceremony — pre-Squads we require the
  // counterparty wallet to be reviewed and trusted before any payment can
  // be routed to it. Operators promote wallets to "trusted" from the
  // Counterparty Wallets page.
  if (wallet.trustState !== 'trusted') {
    throw new Error(
      `Counterparty wallet "${wallet.label}" is ${wallet.trustState ?? 'unreviewed'} — review and mark it as trusted before submitting a payment to it.`,
    );
  }
}

function validateSourceAndCounterpartyWallet(args: {
  sourceTreasuryWallet: Pick<TreasuryWallet, 'address'> | null;
  counterpartyWallet: Pick<CounterpartyWallet, 'walletAddress' | 'label'>;
}) {
  if (!args.sourceTreasuryWallet) {
    return;
  }

  if (args.sourceTreasuryWallet.address === args.counterpartyWallet.walletAddress) {
    throw new Error(`Source wallet cannot be the same as counterparty wallet "${args.counterpartyWallet.label}"`);
  }
}

async function enforceDuplicatePaymentOrder(args: {
  organizationId: string;
  counterpartyWalletId: string;
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
      counterpartyWalletId: args.counterpartyWalletId,
      amountRaw: BigInt(args.amountRaw),
      state: {
        notIn: ['settled', 'cancelled'],
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
    throw new Error(`Active payment order with reference "${args.reference}" already exists for this counterparty wallet and amount`);
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
    actorType: 'user' | 'system' | 'agent';
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

function serializePaymentOrderCounterpartyWallet(
  wallet: CounterpartyWallet & {
    counterparty: Counterparty | null;
  },
) {
  return {
    destinationId: wallet.counterpartyWalletId,
    counterpartyWalletId: wallet.counterpartyWalletId,
    organizationId: wallet.organizationId,
    counterpartyId: wallet.counterpartyId,
    chain: wallet.chain,
    asset: wallet.asset,
    walletAddress: wallet.walletAddress,
    tokenAccountAddress: wallet.tokenAccountAddress,
    walletType: wallet.walletType,
    destinationType: wallet.walletType,
    trustState: wallet.trustState,
    label: wallet.label,
    notes: wallet.notes,
    isInternal: wallet.isInternal,
    isActive: wallet.isActive,
    metadataJson: wallet.metadataJson,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
    counterparty: wallet.counterparty ? serializeCounterparty(wallet.counterparty) : null,
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
