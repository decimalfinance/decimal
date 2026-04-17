import type {
  Destination,
  PaymentRun,
  Prisma,
  TransferRequest,
  User,
  WorkspaceAddress,
} from '@prisma/client';
import { serializeExecutionRecord } from './execution-records.js';
import { listPaymentOrders, submitPaymentOrder } from './payment-orders.js';
import { importPaymentRequestsFromCsv } from './payment-requests.js';
import { prisma } from './prisma.js';
import {
  buildUsdcTransferInstructions,
  deriveUsdcAtaForWallet,
  USDC_DECIMALS,
  USDC_MINT,
} from './solana.js';

const MAX_BATCH_TRANSFERS_PER_TRANSACTION = 8;

type PaymentRunWithRelations = PaymentRun & {
  sourceWorkspaceAddress: WorkspaceAddress | null;
  createdByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
};

type RunOrderForExecution = {
  paymentOrderId: string;
  workspaceId: string;
  paymentRunId: string | null;
  sourceWorkspaceAddressId: string | null;
  amountRaw: bigint;
  asset: string;
  memo: string | null;
  externalReference: string | null;
  invoiceNumber: string | null;
  state: string;
  destination: Destination & {
    linkedWorkspaceAddress: WorkspaceAddress | null;
  };
  sourceWorkspaceAddress: WorkspaceAddress | null;
  transferRequests: Array<TransferRequest & {
    sourceWorkspaceAddress: WorkspaceAddress | null;
    destinationWorkspaceAddress: WorkspaceAddress | null;
    executionRecords: Array<{
      executionRecordId: string;
      transferRequestId: string;
      workspaceId: string;
      submittedSignature: string | null;
      executionSource: string;
      executorUserId: string | null;
      state: string;
      submittedAt: Date | null;
      metadataJson: Prisma.JsonValue;
      createdAt: Date;
      updatedAt: Date;
      executorUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
    }>;
  }>;
};

export async function listPaymentRuns(workspaceId: string) {
  const runs = await prisma.paymentRun.findMany({
    where: { workspaceId },
    include: paymentRunInclude,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return { items: await Promise.all(runs.map(serializePaymentRunSummary)) };
}

export async function getPaymentRunDetail(workspaceId: string, paymentRunId: string) {
  const run = await prisma.paymentRun.findFirstOrThrow({
    where: { workspaceId, paymentRunId },
    include: paymentRunInclude,
  });

  const orders = await listPaymentOrders(workspaceId, {
    paymentRunId,
    limit: 250,
  });

  return {
    ...(await serializePaymentRunSummary(run)),
    paymentOrders: orders.items,
  };
}

export async function deletePaymentRun(workspaceId: string, paymentRunId: string) {
  const existing = await prisma.paymentRun.findFirst({
    where: { workspaceId, paymentRunId },
    select: { paymentRunId: true },
  });
  if (!existing) {
    throw new Error('Payment run not found');
  }
  await prisma.paymentRun.delete({
    where: { paymentRunId },
  });
  return { deleted: true, paymentRunId };
}

export async function importPaymentRunFromCsv(args: {
  workspaceId: string;
  actorUserId: string;
  csv: string;
  runName?: string | null;
  sourceWorkspaceAddressId?: string | null;
  submitOrderNow?: boolean;
}) {
  const run = await prisma.paymentRun.create({
    data: {
      workspaceId: args.workspaceId,
      sourceWorkspaceAddressId: args.sourceWorkspaceAddressId ?? null,
      runName: normalizeOptionalText(args.runName) ?? `CSV payment run ${new Date().toISOString().slice(0, 10)}`,
      inputSource: 'csv_import',
      state: 'draft',
      metadataJson: {
        inputSource: 'csv_import',
      },
      createdByUserId: args.actorUserId,
    },
  });

  const importResult = await importPaymentRequestsFromCsv({
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    csv: args.csv,
    createOrderNow: true,
    submitOrderNow: args.submitOrderNow ?? false,
    sourceWorkspaceAddressId: args.sourceWorkspaceAddressId,
    paymentRunId: run.paymentRunId,
  });

  if (importResult.imported === 0) {
    await prisma.paymentRun.delete({
      where: { paymentRunId: run.paymentRunId },
    });
    const failedRows = importResult.items
      .filter((item) => item.status === 'failed')
      .slice(0, 3)
      .map((item) => `row ${item.rowNumber}: ${item.error ?? 'Import failed'}`);
    const detail = failedRows.length ? ` ${failedRows.join(' | ')}` : '';
    throw new Error(`CSV import had no valid rows, so no payment run was created.${detail}`);
  }

  await refreshPersistedRunState(args.workspaceId, run.paymentRunId);

  return {
    paymentRun: await getPaymentRunDetail(args.workspaceId, run.paymentRunId),
    importResult,
  };
}

export async function preparePaymentRunExecution(args: {
  workspaceId: string;
  paymentRunId: string;
  actorUserId: string;
  sourceWorkspaceAddressId?: string | null;
}) {
  const run = await prisma.paymentRun.findFirstOrThrow({
    where: { workspaceId: args.workspaceId, paymentRunId: args.paymentRunId },
    include: paymentRunInclude,
  });

  const sourceWorkspaceAddressId = args.sourceWorkspaceAddressId ?? run.sourceWorkspaceAddressId;
  if (!sourceWorkspaceAddressId) {
    throw new Error('Choose a source wallet before preparing a payment run');
  }

  const source = await prisma.workspaceAddress.findFirst({
    where: {
      workspaceId: args.workspaceId,
      workspaceAddressId: sourceWorkspaceAddressId,
      isActive: true,
    },
  });

  if (!source) {
    throw new Error('Source wallet not found');
  }

  const initialOrders = await loadRunOrdersForExecution(args.workspaceId, args.paymentRunId);
  if (!initialOrders.length) {
    throw new Error('Payment run has no payment orders');
  }
  if (initialOrders.length > MAX_BATCH_TRANSFERS_PER_TRANSACTION) {
    throw new Error(`Payment run has ${initialOrders.length} orders. Split into chunks of ${MAX_BATCH_TRANSFERS_PER_TRANSACTION} before preparing execution.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentRun.update({
      where: { paymentRunId: args.paymentRunId },
      data: { sourceWorkspaceAddressId: source.workspaceAddressId },
    });

    for (const order of initialOrders) {
      if (order.sourceWorkspaceAddressId && order.sourceWorkspaceAddressId !== source.workspaceAddressId) {
        throw new Error(`Payment order ${order.paymentOrderId} already uses a different source wallet`);
      }
      if (order.destination.walletAddress === source.address) {
        throw new Error(`Source wallet cannot be the same as destination "${order.destination.label}"`);
      }
      await tx.paymentOrder.update({
        where: { paymentOrderId: order.paymentOrderId },
        data: { sourceWorkspaceAddressId: source.workspaceAddressId },
      });
      for (const request of order.transferRequests) {
        await tx.transferRequest.update({
          where: { transferRequestId: request.transferRequestId },
          data: { sourceWorkspaceAddressId: source.workspaceAddressId },
        });
      }
    }
  });

  for (const order of initialOrders) {
    if (order.state === 'draft') {
      await submitPaymentOrder({
        workspaceId: args.workspaceId,
        paymentOrderId: order.paymentOrderId,
        actorUserId: args.actorUserId,
      });
    }
  }

  const orders = await loadRunOrdersForExecution(args.workspaceId, args.paymentRunId);
  const alreadySubmitted = orders.filter((order) => hasSubmittedExecution(order));
  const rejected = orders.filter((order) => {
    const request = getPrimaryTransferRequest(order);
    return request?.status === 'rejected';
  });
  const blocked = orders.filter((order) => {
    const request = getPrimaryTransferRequest(order);
    return !request || ['pending_approval', 'escalated'].includes(request.status);
  });

  if (blocked.length) {
    await refreshPersistedRunState(args.workspaceId, args.paymentRunId);
    throw new Error(`${blocked.length} payment run row(s) need approval before batch execution can be prepared`);
  }

  const executableOrders = orders.filter((order) => {
    if (hasSubmittedExecution(order)) return false;
    const request = getPrimaryTransferRequest(order);
    return Boolean(request) && ['approved', 'ready_for_execution'].includes(request.status);
  });

  if (!executableOrders.length) {
    await refreshPersistedRunState(args.workspaceId, args.paymentRunId);
    throw new Error(
      rejected.length
        ? 'No executable rows in this run. Rejected rows are excluded from batch execution.'
        : alreadySubmitted.length
          ? 'No executable rows in this run. Existing submitted/settled rows are excluded.'
          : 'No executable rows in this run.',
    );
  }

  const invalid = orders.find((order) => {
    if (hasSubmittedExecution(order)) return false;
    const request = getPrimaryTransferRequest(order);
    if (request?.status === 'rejected') return false;
    return !request || !['approved', 'ready_for_execution'].includes(request.status);
  });

  if (invalid) {
    const status = getPrimaryTransferRequest(invalid)?.status ?? invalid.state;
    throw new Error(`Payment order ${invalid.paymentOrderId} cannot be prepared while it is ${status}`);
  }

  if (executableOrders.some((order) => order.asset.toLowerCase() !== 'usdc')) {
    throw new Error('Batch execution currently supports USDC payment runs only');
  }

  const transferDrafts = executableOrders.map((order) => buildBatchTransferDraft(order, source));
  const reusableRecordsByTransferRequestId = new Map(
    executableOrders
      .map((order) => {
        const request = getPrimaryTransferRequest(order);
        const record = request ? getReusableRunPreparedExecution(request, args.paymentRunId) : null;
        return request && record ? [request.transferRequestId, record] as const : null;
      })
      .filter((item): item is readonly [string, NonNullable<ReturnType<typeof getReusableRunPreparedExecution>>] =>
        Boolean(item),
      ),
  );
  const executionRecords = await prisma.$transaction(async (tx) => {
    const records = [];
    for (const draft of transferDrafts) {
      const reusableRecord = reusableRecordsByTransferRequestId.get(draft.transferRequestId) ?? null;
      const record = reusableRecord
        ?? await tx.executionRecord.create({
          data: {
            transferRequestId: draft.transferRequestId,
            workspaceId: args.workspaceId,
            executionSource: 'prepared_solana_batch_transfer',
            executorUserId: args.actorUserId,
            state: 'ready_for_execution',
            metadataJson: {
              paymentRunId: args.paymentRunId,
              paymentOrderId: draft.paymentOrderId,
              externalExecutionReference: `prepared-run:${args.paymentRunId}`,
            },
          },
          include: executionRecordInclude,
        });

      if (draft.transferRequestStatus === 'approved') {
        await tx.transferRequest.update({
          where: { transferRequestId: draft.transferRequestId },
          data: { status: 'ready_for_execution' },
        });
      }

      await tx.paymentOrder.update({
        where: { paymentOrderId: draft.paymentOrderId },
        data: { state: 'execution_recorded' },
      });

      if (!reusableRecord) {
        await tx.paymentOrderEvent.create({
          data: {
            paymentOrderId: draft.paymentOrderId,
            workspaceId: args.workspaceId,
            eventType: 'payment_run_execution_prepared',
            actorType: 'user',
            actorId: args.actorUserId,
            beforeState: draft.paymentOrderState,
            afterState: 'execution_recorded',
            linkedTransferRequestId: draft.transferRequestId,
            linkedExecutionRecordId: record.executionRecordId,
            payloadJson: {
              paymentRunId: args.paymentRunId,
              sourceWallet: source.address,
              destinationWallet: draft.destination.walletAddress,
              amountRaw: draft.amountRaw,
            },
          },
        });
      }

      records.push(record);
    }

    await tx.paymentRun.update({
      where: { paymentRunId: args.paymentRunId },
      data: { state: 'execution_recorded' },
    });

    return records;
  });

  const executionPacket = buildPaymentRunExecutionPacket({
    run,
    source,
    transferDrafts,
    executionRecordIds: executionRecords.map((record) => record.executionRecordId),
  });

  return {
    executionRecords: executionRecords.map(serializeExecutionRecord),
    executionPacket,
    paymentRun: await getPaymentRunDetail(args.workspaceId, args.paymentRunId),
  };
}

export async function attachPaymentRunSignature(args: {
  workspaceId: string;
  paymentRunId: string;
  actorUserId: string;
  submittedSignature: string;
  submittedAt?: Date | null;
}) {
  const signature = normalizeOptionalText(args.submittedSignature);
  if (!signature) {
    throw new Error('Submitted signature is required');
  }

  const orders = await loadRunOrdersForExecution(args.workspaceId, args.paymentRunId);
  if (!orders.length) {
    throw new Error('Payment run has no payment orders');
  }
  const executableOrders = orders.filter((order) => {
    if (hasSubmittedExecution(order)) return false;
    const request = getPrimaryTransferRequest(order);
    return Boolean(request) && ['approved', 'ready_for_execution', 'submitted_onchain'].includes(request.status);
  });
  if (!executableOrders.length) {
    throw new Error('No executable rows in this run. Rejected rows are excluded from batch execution.');
  }

  const now = args.submittedAt ?? new Date();
  const updatedRecords = await prisma.$transaction(async (tx) => {
    const records = [];
    for (const order of executableOrders) {
      const request = getPrimaryTransferRequest(order);
      if (!request) {
        throw new Error(`Payment order ${order.paymentOrderId} has no submitted transfer request`);
      }

      const latest = request.executionRecords[0]
        ?? await tx.executionRecord.create({
          data: {
            transferRequestId: request.transferRequestId,
            workspaceId: args.workspaceId,
            executionSource: 'prepared_solana_batch_transfer',
            executorUserId: args.actorUserId,
            state: 'ready_for_execution',
            metadataJson: {
              paymentRunId: args.paymentRunId,
              paymentOrderId: order.paymentOrderId,
              externalExecutionReference: `submitted-run:${args.paymentRunId}`,
            },
          },
          include: executionRecordInclude,
        });

      const record = await tx.executionRecord.update({
        where: { executionRecordId: latest.executionRecordId },
        data: {
          submittedSignature: signature,
          state: 'submitted_onchain',
          submittedAt: now,
          metadataJson: {
            ...(isRecordLike(latest.metadataJson) ? latest.metadataJson : {}),
            paymentRunId: args.paymentRunId,
            paymentOrderId: order.paymentOrderId,
            submittedAsBatch: true,
          },
        },
        include: executionRecordInclude,
      });

      await tx.transferRequest.update({
        where: { transferRequestId: request.transferRequestId },
        data: { status: 'submitted_onchain' },
      });

      await tx.paymentOrder.update({
        where: { paymentOrderId: order.paymentOrderId },
        data: { state: 'execution_recorded' },
      });

      await tx.paymentOrderEvent.create({
        data: {
          paymentOrderId: order.paymentOrderId,
          workspaceId: args.workspaceId,
          eventType: 'payment_run_signature_attached',
          actorType: 'user',
          actorId: args.actorUserId,
          beforeState: order.state,
          afterState: 'execution_recorded',
          linkedTransferRequestId: request.transferRequestId,
          linkedExecutionRecordId: record.executionRecordId,
          linkedSignature: signature,
          payloadJson: {
            paymentRunId: args.paymentRunId,
          },
        },
      });

      records.push(record);
    }

    await tx.paymentRun.update({
      where: { paymentRunId: args.paymentRunId },
      data: { state: 'submitted_onchain' },
    });

    return records;
  });

  return {
    executionRecords: updatedRecords.map(serializeExecutionRecord),
    paymentRun: await getPaymentRunDetail(args.workspaceId, args.paymentRunId),
  };
}

async function serializePaymentRunSummary(run: PaymentRunWithRelations) {
  const orders = await listPaymentOrders(run.workspaceId, {
    paymentRunId: run.paymentRunId,
    limit: 250,
  });
  const totals = summarizeRunOrders(orders.items);
  const reconciliationSummary = summarizeRunReconciliation(orders.items);
  const derivedState = derivePaymentRunState(run.state, orders.items);

  return {
    paymentRunId: run.paymentRunId,
    workspaceId: run.workspaceId,
    sourceWorkspaceAddressId: run.sourceWorkspaceAddressId,
    runName: run.runName,
    inputSource: run.inputSource,
    state: run.state,
    derivedState,
    metadataJson: run.metadataJson,
    createdByUserId: run.createdByUserId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    sourceWorkspaceAddress: run.sourceWorkspaceAddress ? serializeWorkspaceAddress(run.sourceWorkspaceAddress) : null,
    createdByUser: run.createdByUser ? {
      userId: run.createdByUser.userId,
      email: run.createdByUser.email,
      displayName: run.createdByUser.displayName,
    } : null,
    totals,
    reconciliationSummary,
  };
}

function summarizeRunOrders(orders: Array<{ amountRaw: string; derivedState: string }>) {
  const actionableOrders = orders.filter((order) => !['cancelled'].includes(order.derivedState));
  const totalAmountRaw = orders.reduce((sum, order) => sum + BigInt(order.amountRaw), 0n).toString();
  return {
    orderCount: orders.length,
    actionableCount: actionableOrders.length,
    cancelledCount: orders.filter((order) => order.derivedState === 'cancelled').length,
    totalAmountRaw,
    settledCount: actionableOrders.filter((order) => ['settled', 'closed'].includes(order.derivedState)).length,
    exceptionCount: orders.filter((order) => order.derivedState === 'exception').length,
    pendingApprovalCount: actionableOrders.filter((order) => order.derivedState === 'pending_approval').length,
    approvedCount: actionableOrders.filter((order) => [
      'approved',
      'ready_for_execution',
      'execution_recorded',
      'settled',
      'closed',
      'partially_settled',
      'exception',
    ].includes(order.derivedState)).length,
    readyCount: actionableOrders.filter((order) => ['approved', 'ready_for_execution', 'execution_recorded'].includes(order.derivedState)).length,
  };
}

function summarizeRunReconciliation(orders: Array<{
  amountRaw: string;
  derivedState: string;
  reconciliationDetail: {
    requestDisplayState: string;
    match: {
      matchedAmountRaw: string;
      amountVarianceRaw: string;
    } | null;
    exceptions: Array<{
      status: string;
    }>;
  } | null;
}>) {
  const settlementCounts = {
    pending: 0,
    matched: 0,
    partial: 0,
    exception: 0,
    closed: 0,
    none: 0,
  };
  let requestedAmountRaw = 0n;
  let matchedAmountRaw = 0n;
  let varianceAmountRaw = 0n;
  let openExceptionCount = 0;

  for (const order of orders) {
    requestedAmountRaw += BigInt(order.amountRaw);
    const displayState = order.derivedState === 'closed'
      ? 'closed'
      : order.reconciliationDetail?.requestDisplayState ?? 'none';

    if (isSettlementCountKey(displayState)) {
      settlementCounts[displayState] += 1;
    } else {
      settlementCounts.none += 1;
    }

    if (order.reconciliationDetail?.match) {
      matchedAmountRaw += BigInt(order.reconciliationDetail.match.matchedAmountRaw);
      varianceAmountRaw += BigInt(order.reconciliationDetail.match.amountVarianceRaw);
    } else {
      varianceAmountRaw += BigInt(order.amountRaw);
    }

    openExceptionCount += order.reconciliationDetail?.exceptions.filter(
      (exception) => exception.status !== 'dismissed' && exception.status !== 'expected',
    ).length ?? 0;
  }

  const actionableCount = orders.filter((order) => order.derivedState !== 'cancelled').length;
  const completedCount = settlementCounts.matched + settlementCounts.closed;

  return {
    requestedAmountRaw: requestedAmountRaw.toString(),
    matchedAmountRaw: matchedAmountRaw.toString(),
    varianceAmountRaw: varianceAmountRaw.toString(),
    settlementCounts,
    openExceptionCount,
    completedCount,
    completionRatio: actionableCount ? completedCount / actionableCount : 0,
    needsReview:
      openExceptionCount > 0
      || settlementCounts.partial > 0
      || settlementCounts.exception > 0,
  };
}

function isSettlementCountKey(value: string): value is 'pending' | 'matched' | 'partial' | 'exception' | 'closed' | 'none' {
  return value === 'pending'
    || value === 'matched'
    || value === 'partial'
    || value === 'exception'
    || value === 'closed'
    || value === 'none';
}

function derivePaymentRunState(storedState: string, orders: Array<{ derivedState: string }>) {
  if (storedState === 'cancelled' || storedState === 'closed') {
    return storedState;
  }
  if (!orders.length) {
    return storedState;
  }
  const actionableOrders = orders.filter((order) => order.derivedState !== 'cancelled');
  if (!actionableOrders.length) {
    return storedState;
  }
  if (actionableOrders.some((order) => order.derivedState === 'exception')) {
    return 'exception';
  }
  if (actionableOrders.every((order) => ['settled', 'closed'].includes(order.derivedState))) {
    return 'settled';
  }
  if (actionableOrders.some((order) => order.derivedState === 'partially_settled')) {
    return 'partially_settled';
  }
  if (storedState === 'submitted_onchain') {
    return 'submitted_onchain';
  }
  if (actionableOrders.some((order) => order.derivedState === 'execution_recorded')) {
    return 'execution_recorded';
  }
  if (actionableOrders.some((order) => order.derivedState === 'pending_approval')) {
    return 'pending_approval';
  }
  if (actionableOrders.every((order) => ['approved', 'ready_for_execution'].includes(order.derivedState))) {
    return 'ready_for_execution';
  }
  return storedState;
}

async function refreshPersistedRunState(workspaceId: string, paymentRunId: string) {
  const detail = await getPaymentRunDetail(workspaceId, paymentRunId);
  await prisma.paymentRun.update({
    where: { paymentRunId },
    data: { state: detail.derivedState },
  });
}

async function loadRunOrdersForExecution(workspaceId: string, paymentRunId: string) {
  return prisma.paymentOrder.findMany({
    where: {
      workspaceId,
      paymentRunId,
      state: { not: 'cancelled' },
    },
    include: {
      destination: {
        include: {
          linkedWorkspaceAddress: true,
        },
      },
      sourceWorkspaceAddress: true,
      transferRequests: {
        include: {
          sourceWorkspaceAddress: true,
          destinationWorkspaceAddress: true,
          executionRecords: {
            include: executionRecordInclude,
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  }) as Promise<RunOrderForExecution[]>;
}

function buildBatchTransferDraft(order: RunOrderForExecution, source: WorkspaceAddress) {
  const request = getPrimaryTransferRequest(order);
  if (!request) {
    throw new Error(`Payment order ${order.paymentOrderId} has no submitted transfer request`);
  }
  const sourceTokenAccount = source.usdcAtaAddress ?? deriveUsdcAtaForWallet(source.address);
  const destinationTokenAccount = order.destination.tokenAccountAddress
    ?? order.destination.linkedWorkspaceAddress?.usdcAtaAddress
    ?? deriveUsdcAtaForWallet(order.destination.walletAddress);

  return {
    paymentOrderId: order.paymentOrderId,
    paymentOrderState: order.state,
    transferRequestId: request.transferRequestId,
    transferRequestStatus: request.status,
    destination: {
      destinationId: order.destination.destinationId,
      label: order.destination.label,
      walletAddress: order.destination.walletAddress,
      tokenAccountAddress: destinationTokenAccount,
    },
    amountRaw: order.amountRaw.toString(),
    memo: order.memo,
    reference: order.externalReference ?? order.invoiceNumber,
    instructions: buildUsdcTransferInstructions({
      sourceWallet: source.address,
      sourceTokenAccount,
      destinationWallet: order.destination.walletAddress,
      destinationTokenAccount,
      amountRaw: order.amountRaw,
    }),
  };
}

function buildPaymentRunExecutionPacket(args: {
  run: PaymentRun;
  source: WorkspaceAddress;
  transferDrafts: ReturnType<typeof buildBatchTransferDraft>[];
  executionRecordIds: string[];
}) {
  const sourceTokenAccount = args.source.usdcAtaAddress ?? deriveUsdcAtaForWallet(args.source.address);
  return {
    kind: 'solana_spl_usdc_transfer_batch',
    version: 1,
    network: 'solana-mainnet',
    paymentRunId: args.run.paymentRunId,
    runName: args.run.runName,
    paymentOrderIds: args.transferDrafts.map((draft) => draft.paymentOrderId),
    transferRequestIds: args.transferDrafts.map((draft) => draft.transferRequestId),
    executionRecordIds: args.executionRecordIds,
    createdAt: new Date().toISOString(),
    source: {
      workspaceAddressId: args.source.workspaceAddressId,
      walletAddress: args.source.address,
      tokenAccountAddress: sourceTokenAccount,
      label: args.source.displayName,
    },
    transfers: args.transferDrafts.map((draft, index) => ({
      paymentOrderId: draft.paymentOrderId,
      transferRequestId: draft.transferRequestId,
      executionRecordId: args.executionRecordIds[index],
      destination: draft.destination,
      amountRaw: draft.amountRaw,
      memo: draft.memo,
      reference: draft.reference,
    })),
    token: {
      symbol: 'USDC',
      mint: USDC_MINT.toBase58(),
      decimals: USDC_DECIMALS,
    },
    amountRaw: args.transferDrafts.reduce((sum, draft) => sum + BigInt(draft.amountRaw), 0n).toString(),
    signerWallet: args.source.address,
    feePayer: args.source.address,
    requiredSigners: [args.source.address],
    instructions: args.transferDrafts.flatMap((draft) => draft.instructions),
    signing: {
      mode: 'wallet_adapter_or_external_signer',
      requiresRecentBlockhash: true,
      note: 'Client must add a recent blockhash, sign with the source wallet, and submit to Solana. The API never receives private keys.',
    },
  };
}

function getPrimaryTransferRequest(order: { transferRequests: RunOrderForExecution['transferRequests'] }) {
  return [...order.transferRequests].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  )[0] ?? null;
}

function getReusableRunPreparedExecution(
  request: RunOrderForExecution['transferRequests'][number],
  paymentRunId: string,
) {
  const latest = request.executionRecords[0] ?? null;
  if (
    !latest
    || latest.executionSource !== 'prepared_solana_batch_transfer'
    || latest.state !== 'ready_for_execution'
    || latest.submittedSignature
    || !isRecordLike(latest.metadataJson)
    || latest.metadataJson.paymentRunId !== paymentRunId
  ) {
    return null;
  }

  return latest;
}

function hasSubmittedExecution(order: RunOrderForExecution) {
  const request = getPrimaryTransferRequest(order);
  if (!request) return false;
  const latest = request.executionRecords[0] ?? null;
  if (!latest) return false;
  return Boolean(latest.submittedSignature)
    || ['submitted_onchain', 'observed', 'settled'].includes(latest.state)
    || request.status === 'submitted_onchain';
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

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const paymentRunInclude = {
  sourceWorkspaceAddress: true,
  createdByUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.PaymentRunInclude;

const executionRecordInclude = {
  executorUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.ExecutionRecordInclude;
