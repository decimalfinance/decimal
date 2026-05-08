import type {
  Destination,
  PaymentRun,
  Prisma,
  TransferRequest,
  User,
  TreasuryWallet,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { serializeExecutionRecord } from '../transfer-requests/execution-records.js';
import { listPaymentOrders, submitPaymentOrder } from './orders.js';
import { importPaymentRequestsFromCsv, previewPaymentRequestsCsv } from './requests.js';
import {
  canCancelPaymentRun,
  canClosePaymentRun,
  derivePaymentRunStateFromRows,
} from './run-state.js';
import { prisma } from '../infra/prisma.js';
import {
  buildUsdcTransferInstructions,
  deriveUsdcAtaForWallet,
  USDC_DECIMALS,
  USDC_MINT,
} from '../solana.js';
import { getPrimaryTransferRequest } from '../transfer-requests/helpers.js';

const MAX_BATCH_TRANSFERS_PER_TRANSACTION = 8;

type PaymentRunWithRelations = PaymentRun & {
  sourceTreasuryWallet: TreasuryWallet | null;
  createdByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
};

type RunOrderForExecution = {
  paymentOrderId: string;
  organizationId: string;
  paymentRunId: string | null;
  sourceTreasuryWalletId: string | null;
  amountRaw: bigint;
  asset: string;
  memo: string | null;
  externalReference: string | null;
  invoiceNumber: string | null;
  state: string;
  destination: Destination;
  sourceTreasuryWallet: TreasuryWallet | null;
  transferRequests: Array<TransferRequest & {
    sourceTreasuryWallet: TreasuryWallet | null;
    executionRecords: Array<{
      executionRecordId: string;
      transferRequestId: string;
      organizationId: string;
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

export async function listPaymentRuns(organizationId: string) {
  const runs = await prisma.paymentRun.findMany({
    where: { organizationId },
    include: paymentRunInclude,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return { items: await Promise.all(runs.map(serializePaymentRunSummary)) };
}

export async function getPaymentRunDetail(organizationId: string, paymentRunId: string) {
  const run = await prisma.paymentRun.findFirstOrThrow({
    where: { organizationId, paymentRunId },
    include: paymentRunInclude,
  });

  const orders = await listPaymentOrders(organizationId, {
    paymentRunId,
    limit: 250,
  });

  return {
    ...(await serializePaymentRunSummary(run)),
    paymentOrders: orders.items,
  };
}

export async function deletePaymentRun(organizationId: string, paymentRunId: string) {
  const existing = await prisma.paymentRun.findFirst({
    where: { organizationId, paymentRunId },
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

export async function previewPaymentRunCsv(args: {
  organizationId: string;
  csv: string;
}) {
  const preview = await previewPaymentRequestsCsv({
    organizationId: args.organizationId,
    csv: args.csv,
  });
  return {
    csvFingerprint: buildCsvFingerprint(args.csv),
    ...preview,
  };
}

export async function importPaymentRunFromCsv(args: {
  organizationId: string;
  actorUserId: string;
  csv: string;
  runName?: string | null;
  sourceTreasuryWalletId?: string | null;
  submitOrderNow?: boolean;
  importKey?: string | null;
}) {
  const csvFingerprint = buildCsvFingerprint(args.csv);
  const importKey = normalizeOptionalText(args.importKey);
  const existingRun = await findExistingImportedPaymentRun({
    organizationId: args.organizationId,
    importKey,
    csvFingerprint,
  });
  if (existingRun) {
    return {
      paymentRun: await getPaymentRunDetail(args.organizationId, existingRun.paymentRunId),
      importResult: {
        idempotentReplay: true,
        imported: 0,
        failed: 0,
        items: [],
      },
    };
  }

  const preview = await previewPaymentRunCsv({
    organizationId: args.organizationId,
    csv: args.csv,
  });
  const failedRows = preview.items.filter((item) => item.status === 'failed');
  if (failedRows.length) {
    const detail = failedRows
      .slice(0, 3)
      .map((item) => `row ${item.rowNumber}: ${'error' in item ? item.error : 'Invalid row'}`)
      .join(' | ');
    throw new Error(`CSV import preview failed. Fix ${failedRows.length} row(s) before creating a payment run. ${detail}`);
  }

  const run = await prisma.paymentRun.create({
    data: {
      organizationId: args.organizationId,
      sourceTreasuryWalletId: args.sourceTreasuryWalletId ?? null,
      runName: normalizeOptionalText(args.runName) ?? `CSV payment run ${new Date().toISOString().slice(0, 10)}`,
      inputSource: 'csv_import',
      state: 'draft',
      metadataJson: {
        inputSource: 'csv_import',
        csvFingerprint,
        importKey,
      },
      createdByUserId: args.actorUserId,
    },
  });

  const importResult = await importPaymentRequestsFromCsv({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    csv: args.csv,
    createOrderNow: true,
    submitOrderNow: args.submitOrderNow ?? false,
    sourceTreasuryWalletId: args.sourceTreasuryWalletId,
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

  await refreshPersistedRunState(args.organizationId, run.paymentRunId);

  return {
    paymentRun: await getPaymentRunDetail(args.organizationId, run.paymentRunId),
    importResult,
  };
}

export async function cancelPaymentRun(args: {
  organizationId: string;
  paymentRunId: string;
  actorUserId: string;
}) {
  const detail = await getPaymentRunDetail(args.organizationId, args.paymentRunId);
  if (detail.state === 'cancelled') {
    return detail;
  }
  const cancelCheck = canCancelPaymentRun({
    storedState: detail.state,
    derivedState: detail.derivedState,
    orders: detail.paymentOrders.map((order) => ({
      derivedState: order.derivedState,
      hasExecutionEvidence: Boolean(order.reconciliationDetail?.latestExecution?.submittedSignature),
    })),
  });
  if (!cancelCheck.allowed) {
    throw new Error(cancelCheck.reason ?? 'Payment run cannot be cancelled');
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentRun.update({
      where: { paymentRunId: args.paymentRunId },
      data: {
        state: 'cancelled',
        metadataJson: mergeJsonObject(detail.metadataJson, {
          cancelledAt: new Date().toISOString(),
          cancelledByUserId: args.actorUserId,
        }),
      },
    });

    for (const order of detail.paymentOrders) {
      if (order.derivedState === 'cancelled') {
        continue;
      }
      await tx.paymentOrder.update({
        where: { paymentOrderId: order.paymentOrderId },
        data: { state: 'cancelled' },
      });
      await tx.paymentOrderEvent.create({
        data: {
          paymentOrderId: order.paymentOrderId,
          organizationId: args.organizationId,
          eventType: 'payment_run_row_cancelled',
          actorType: 'user',
          actorId: args.actorUserId,
          beforeState: order.state,
          afterState: 'cancelled',
          linkedTransferRequestId: order.transferRequestId ?? null,
          payloadJson: {
            paymentRunId: args.paymentRunId,
          },
        },
      });
      for (const request of order.transferRequests) {
        if (['submitted_onchain', 'matched', 'closed', 'rejected'].includes(request.status)) {
          continue;
        }
        await tx.transferRequest.update({
          where: { transferRequestId: request.transferRequestId },
          data: { status: 'rejected' },
        });
      }
      if (order.paymentRequestId) {
        await tx.paymentRequest.updateMany({
          where: {
            paymentRequestId: order.paymentRequestId,
            state: { not: 'cancelled' },
          },
          data: { state: 'cancelled' },
        });
      }
    }
  });

  return getPaymentRunDetail(args.organizationId, args.paymentRunId);
}

export async function closePaymentRun(args: {
  organizationId: string;
  paymentRunId: string;
  actorUserId: string;
}) {
  const detail = await getPaymentRunDetail(args.organizationId, args.paymentRunId);
  if (detail.state === 'closed') {
    return detail;
  }
  const actionableOrders = detail.paymentOrders.filter((order) => order.derivedState !== 'cancelled');
  const closeCheck = canClosePaymentRun({
    derivedState: detail.derivedState,
    orders: detail.paymentOrders.map((order) => ({ derivedState: order.derivedState })),
  });
  if (!closeCheck.allowed) {
    throw new Error(closeCheck.reason ?? 'Payment run cannot be closed');
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentRun.update({
      where: { paymentRunId: args.paymentRunId },
      data: {
        state: 'closed',
        metadataJson: mergeJsonObject(detail.metadataJson, {
          closedAt: new Date().toISOString(),
          closedByUserId: args.actorUserId,
        }),
      },
    });

    for (const order of actionableOrders) {
      if (order.state !== 'closed') {
        await tx.paymentOrder.update({
          where: { paymentOrderId: order.paymentOrderId },
          data: { state: 'closed' },
        });
        await tx.paymentOrderEvent.create({
          data: {
            paymentOrderId: order.paymentOrderId,
            organizationId: args.organizationId,
            eventType: 'payment_run_row_closed',
            actorType: 'user',
            actorId: args.actorUserId,
            beforeState: order.state,
            afterState: 'closed',
            linkedTransferRequestId: order.transferRequestId ?? null,
            payloadJson: {
              paymentRunId: args.paymentRunId,
            },
          },
        });
      }
      for (const request of order.transferRequests) {
        if (request.status !== 'closed') {
          await tx.transferRequest.update({
            where: { transferRequestId: request.transferRequestId },
            data: { status: 'closed' },
          });
        }
      }
    }
  });

  return getPaymentRunDetail(args.organizationId, args.paymentRunId);
}

export async function preparePaymentRunExecution(args: {
  organizationId: string;
  paymentRunId: string;
  actorUserId: string;
  sourceTreasuryWalletId?: string | null;
}) {
  const run = await prisma.paymentRun.findFirstOrThrow({
    where: { organizationId: args.organizationId, paymentRunId: args.paymentRunId },
    include: paymentRunInclude,
  });

  const sourceTreasuryWalletId = args.sourceTreasuryWalletId ?? run.sourceTreasuryWalletId;
  if (!sourceTreasuryWalletId) {
    throw new Error('Choose a source wallet before preparing a payment run');
  }

  const source = await prisma.treasuryWallet.findFirst({
    where: {
      organizationId: args.organizationId,
      treasuryWalletId: sourceTreasuryWalletId,
      isActive: true,
    },
  });

  if (!source) {
    throw new Error('Source wallet not found');
  }

  const initialOrders = await loadRunOrdersForExecution(args.organizationId, args.paymentRunId);
  if (!initialOrders.length) {
    throw new Error('Payment run has no payment orders');
  }
  if (initialOrders.length > MAX_BATCH_TRANSFERS_PER_TRANSACTION) {
    throw new Error(`Payment run has ${initialOrders.length} orders. Split into chunks of ${MAX_BATCH_TRANSFERS_PER_TRANSACTION} before preparing execution.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentRun.update({
      where: { paymentRunId: args.paymentRunId },
      data: { sourceTreasuryWalletId: source.treasuryWalletId },
    });

    for (const order of initialOrders) {
      if (order.sourceTreasuryWalletId && order.sourceTreasuryWalletId !== source.treasuryWalletId) {
        throw new Error(`Payment order ${order.paymentOrderId} already uses a different source wallet`);
      }
      if (order.destination.walletAddress === source.address) {
        throw new Error(`Source wallet cannot be the same as destination "${order.destination.label}"`);
      }
      await tx.paymentOrder.update({
        where: { paymentOrderId: order.paymentOrderId },
        data: { sourceTreasuryWalletId: source.treasuryWalletId },
      });
      for (const request of order.transferRequests) {
        await tx.transferRequest.update({
          where: { transferRequestId: request.transferRequestId },
          data: { sourceTreasuryWalletId: source.treasuryWalletId },
        });
      }
    }
  });

  for (const order of initialOrders) {
    if (order.state === 'draft') {
      await submitPaymentOrder({
        organizationId: args.organizationId,
        paymentOrderId: order.paymentOrderId,
        actorUserId: args.actorUserId,
      });
    }
  }

  const orders = await loadRunOrdersForExecution(args.organizationId, args.paymentRunId);
  const alreadySubmitted = orders.filter((order) => hasSubmittedExecution(order));
  const rejected = orders.filter((order) => {
    const request = getPrimaryTransferRequest(order);
    return request?.status === 'rejected';
  });
  const unsubmitted = orders.filter((order) => !getPrimaryTransferRequest(order));
  if (unsubmitted.length) {
    await refreshPersistedRunState(args.organizationId, args.paymentRunId);
    throw new Error(`${unsubmitted.length} payment run row(s) have not been submitted yet`);
  }

  const executableOrders = orders.filter((order) => {
    if (hasSubmittedExecution(order)) return false;
    const request = getPrimaryTransferRequest(order);
    return request !== null && ['approved', 'ready_for_execution'].includes(request.status);
  });

  if (!executableOrders.length) {
    await refreshPersistedRunState(args.organizationId, args.paymentRunId);
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
            organizationId: args.organizationId,
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
            organizationId: args.organizationId,
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
    paymentRun: await getPaymentRunDetail(args.organizationId, args.paymentRunId),
  };
}

export async function attachPaymentRunSignature(args: {
  organizationId: string;
  paymentRunId: string;
  actorUserId: string;
  submittedSignature: string;
  submittedAt?: Date | null;
}) {
  const signature = normalizeOptionalText(args.submittedSignature);
  if (!signature) {
    throw new Error('Submitted signature is required');
  }

  const orders = await loadRunOrdersForExecution(args.organizationId, args.paymentRunId);
  if (!orders.length) {
    throw new Error('Payment run has no payment orders');
  }
  const executableOrders = orders.filter((order) => {
    if (hasSubmittedExecution(order)) return false;
    const request = getPrimaryTransferRequest(order);
    return request !== null && ['approved', 'ready_for_execution', 'submitted_onchain'].includes(request.status);
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
            organizationId: args.organizationId,
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
          organizationId: args.organizationId,
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
    paymentRun: await getPaymentRunDetail(args.organizationId, args.paymentRunId),
  };
}

async function serializePaymentRunSummary(run: PaymentRunWithRelations) {
  const orders = await listPaymentOrders(run.organizationId, {
    paymentRunId: run.paymentRunId,
    limit: 250,
  });
  const totals = summarizeRunOrders(orders.items);
  const reconciliationSummary = summarizeRunReconciliation(orders.items);
  const derivedState = derivePaymentRunState(run.state, orders.items);

  return {
    paymentRunId: run.paymentRunId,
    organizationId: run.organizationId,
    sourceTreasuryWalletId: run.sourceTreasuryWalletId,
    runName: run.runName,
    inputSource: run.inputSource,
    state: run.state,
    derivedState,
    metadataJson: run.metadataJson,
    createdByUserId: run.createdByUserId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    sourceTreasuryWallet: run.sourceTreasuryWallet ? serializeTreasuryWallet(run.sourceTreasuryWallet) : null,
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
    pendingApprovalCount: 0,
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
  return derivePaymentRunStateFromRows(storedState, orders);
}

async function refreshPersistedRunState(organizationId: string, paymentRunId: string) {
  const detail = await getPaymentRunDetail(organizationId, paymentRunId);
  await prisma.paymentRun.update({
    where: { paymentRunId },
    data: { state: detail.derivedState },
  });
}

async function loadRunOrdersForExecution(organizationId: string, paymentRunId: string) {
  return prisma.paymentOrder.findMany({
    where: {
      organizationId,
      paymentRunId,
      state: { not: 'cancelled' },
    },
    include: {
      destination: true,
      sourceTreasuryWallet: true,
      transferRequests: {
        include: {
          sourceTreasuryWallet: true,
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

function buildBatchTransferDraft(order: RunOrderForExecution, source: TreasuryWallet) {
  const request = getPrimaryTransferRequest(order);
  if (!request) {
    throw new Error(`Payment order ${order.paymentOrderId} has no submitted transfer request`);
  }
  const sourceTokenAccount = source.usdcAtaAddress ?? deriveUsdcAtaForWallet(source.address);
  const destinationTokenAccount = order.destination.tokenAccountAddress
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
  source: TreasuryWallet;
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
      treasuryWalletId: args.source.treasuryWalletId,
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
    || ['submitted_onchain', 'settled'].includes(latest.state)
    || request.status === 'submitted_onchain';
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

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildCsvFingerprint(csv: string) {
  return createHash('sha256')
    .update(csv.replaceAll(/\r\n/g, '\n').trim())
    .digest('hex');
}

async function findExistingImportedPaymentRun(args: {
  organizationId: string;
  importKey: string | null;
  csvFingerprint: string;
}) {
  const metadataMatchers: Prisma.PaymentRunWhereInput[] = [
    {
      metadataJson: {
        path: ['csvFingerprint'],
        equals: args.csvFingerprint,
      },
    },
  ];
  if (args.importKey) {
    metadataMatchers.unshift({
      metadataJson: {
        path: ['importKey'],
        equals: args.importKey,
      },
    });
  }

  return prisma.paymentRun.findFirst({
    where: {
      organizationId: args.organizationId,
      inputSource: 'csv_import',
      state: { not: 'cancelled' },
      OR: metadataMatchers,
    },
    orderBy: { createdAt: 'desc' },
    select: { paymentRunId: true },
  });
}

function mergeJsonObject(current: unknown, patch: Record<string, unknown>): Prisma.InputJsonObject {
  return {
    ...(isRecordLike(current) ? current : {}),
    ...patch,
  } as Prisma.InputJsonObject;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const paymentRunInclude = {
  sourceTreasuryWallet: true,
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
