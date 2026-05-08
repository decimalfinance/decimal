import type {
  CollectionRequest,
  CollectionRequestEvent,
  CollectionRun,
  CollectionSource,
  Counterparty,
  Prisma,
  TreasuryWallet,
  TransferRequest,
  User,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { getReconciliationDetail } from './settlement-read-model.js';
import { createTransferRequestEvent } from './transfer-request-events.js';
import { prisma } from './prisma.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET } from './solana.js';
import { findOrCreateCollectionSourceForPayer, serializeCollectionSource } from './collection-sources.js';

export const COLLECTION_REQUEST_STATES = [
  'open',
  'partially_collected',
  'collected',
  'exception',
  'closed',
  'cancelled',
] as const;

export type CollectionRequestState = (typeof COLLECTION_REQUEST_STATES)[number];

type CollectionRequestWithRelations = CollectionRequest & {
  collectionRun: Pick<CollectionRun, 'collectionRunId' | 'runName' | 'state' | 'createdAt'> | null;
  receivingTreasuryWallet: TreasuryWallet;
  collectionSource: (CollectionSource & { counterparty?: Counterparty | null }) | null;
  counterparty: Counterparty | null;
  transferRequest: Pick<
    TransferRequest,
    'transferRequestId' | 'requestType' | 'status' | 'amountRaw' | 'externalReference' | 'destinationId'
  > | null;
  createdByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  events?: CollectionRequestEvent[];
};

type CollectionRunWithRelations = CollectionRun & {
  receivingTreasuryWallet: TreasuryWallet | null;
  createdByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
};

export function isCollectionRequestState(value: string): value is CollectionRequestState {
  return COLLECTION_REQUEST_STATES.includes(value as CollectionRequestState);
}

export async function listCollectionRequests(
  organizationId: string,
  options?: {
    limit?: number;
    state?: string;
    collectionRunId?: string;
  },
) {
  const requests = await prisma.collectionRequest.findMany({
    where: {
      organizationId,
      ...(options?.state ? { state: options.state } : {}),
      ...(options?.collectionRunId ? { collectionRunId: options.collectionRunId } : {}),
    },
    include: collectionRequestInclude,
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return { items: await Promise.all(requests.map(serializeCollectionRequest)) };
}

export async function getCollectionRequestDetail(organizationId: string, collectionRequestId: string) {
  const request = await prisma.collectionRequest.findFirstOrThrow({
    where: { organizationId, collectionRequestId },
    include: {
      ...collectionRequestInclude,
      events: { orderBy: { createdAt: 'asc' } },
    },
  });

  return serializeCollectionRequest(request);
}

export async function createCollectionRequest(args: {
  organizationId: string;
  actorUserId: string;
  collectionRunId?: string | null;
  receivingTreasuryWalletId: string;
  collectionSourceId?: string | null;
  counterpartyId?: string | null;
  payerWalletAddress?: string | null;
  payerTokenAccountAddress?: string | null;
  amountRaw: string | bigint;
  asset?: string;
  reason: string;
  externalReference?: string | null;
  dueAt?: Date | null;
  metadataJson?: Prisma.InputJsonValue;
}) {
  const receivingWallet = await prisma.treasuryWallet.findFirst({
    where: {
      organizationId: args.organizationId,
      treasuryWalletId: args.receivingTreasuryWalletId,
      isActive: true,
    },
  });
  if (!receivingWallet) {
    throw new Error('Receiving treasury wallet not found');
  }

  const counterparty = args.counterpartyId
    ? await prisma.counterparty.findFirst({
        where: {
          counterpartyId: args.counterpartyId,
          organizationId: args.organizationId,
          status: 'active',
        },
      })
    : null;
  if (args.counterpartyId && !counterparty) {
    throw new Error('Counterparty not found');
  }

  const collectionSource = await resolveCollectionSource({
    organizationId: args.organizationId,
    collectionSourceId: args.collectionSourceId,
    counterpartyId: counterparty?.counterpartyId ?? null,
    payerWalletAddress: args.payerWalletAddress,
    payerTokenAccountAddress: args.payerTokenAccountAddress,
    reason: args.reason,
    inputSource: args.collectionRunId ? 'collection_run' : 'manual_collection',
  });
  const resolvedCounterpartyId = counterparty?.counterpartyId ?? collectionSource?.counterpartyId ?? null;
  const payerWalletAddress = collectionSource?.walletAddress ?? normalizeOptionalText(args.payerWalletAddress);
  const payerTokenAccountAddress = collectionSource?.tokenAccountAddress ?? normalizeOptionalText(args.payerTokenAccountAddress);

  await enforceDuplicateCollectionRequest({
    organizationId: args.organizationId,
    receivingTreasuryWalletId: receivingWallet.treasuryWalletId,
    amountRaw: args.amountRaw,
    externalReference: normalizeOptionalText(args.externalReference),
  });

  const receivingDestination = await getOrCreateInternalReceivingDestination({
    organizationId: args.organizationId,
    receivingWallet,
  });

  const created = await prisma.$transaction(async (tx) => {
    const request = await tx.collectionRequest.create({
      data: {
        organizationId: args.organizationId,
        collectionRunId: args.collectionRunId ?? null,
        receivingTreasuryWalletId: receivingWallet.treasuryWalletId,
        collectionSourceId: collectionSource?.collectionSourceId ?? null,
        counterpartyId: resolvedCounterpartyId,
        payerWalletAddress,
        payerTokenAccountAddress,
        amountRaw: BigInt(args.amountRaw),
        asset: args.asset ?? 'usdc',
        reason: normalizeRequiredText(args.reason, 'Reason is required'),
        externalReference: normalizeOptionalText(args.externalReference),
        dueAt: args.dueAt ?? undefined,
        state: 'open',
        metadataJson: (args.metadataJson ?? {}) as Prisma.InputJsonValue,
        createdByUserId: args.actorUserId,
      },
    });

    const transferRequest = await tx.transferRequest.create({
      data: {
        organizationId: args.organizationId,
        sourceTreasuryWalletId: null,
        destinationId: receivingDestination.destinationId,
        requestType: 'collection_request',
        asset: args.asset ?? 'usdc',
        amountRaw: BigInt(args.amountRaw),
        requestedByUserId: args.actorUserId,
        reason: request.reason,
        externalReference: request.externalReference,
        status: 'approved',
        dueAt: request.dueAt,
        propertiesJson: {
          direction: 'inbound',
          collectionRequestId: request.collectionRequestId,
          collectionRunId: request.collectionRunId,
          receivingTreasuryWalletId: receivingWallet.treasuryWalletId,
          receivingWalletAddress: receivingWallet.address,
          collectionSourceId: request.collectionSourceId,
          payerWalletAddress: request.payerWalletAddress,
          payerTokenAccountAddress: request.payerTokenAccountAddress,
        },
      },
    });

    await tx.collectionRequest.update({
      where: { collectionRequestId: request.collectionRequestId },
      data: { transferRequestId: transferRequest.transferRequestId },
    });

    await createCollectionRequestEvent(tx, {
      collectionRequestId: request.collectionRequestId,
      organizationId: args.organizationId,
      eventType: 'collection_created',
      actorType: 'user',
      actorId: args.actorUserId,
      beforeState: null,
      afterState: 'open',
      linkedTransferRequestId: transferRequest.transferRequestId,
      payloadJson: {
        amountRaw: transferRequest.amountRaw.toString(),
        asset: transferRequest.asset,
        receivingTreasuryWalletId: receivingWallet.treasuryWalletId,
        collectionSourceId: request.collectionSourceId,
        payerWalletAddress: request.payerWalletAddress,
      },
    });

    await createTransferRequestEvent(tx, {
      transferRequestId: transferRequest.transferRequestId,
      organizationId: args.organizationId,
      eventType: 'collection_expected',
      actorType: 'user',
      actorId: args.actorUserId,
      eventSource: 'user',
      beforeState: null,
      afterState: 'approved',
      payloadJson: {
        source: 'collection_request',
        collectionRequestId: request.collectionRequestId,
        collectionRunId: request.collectionRunId,
        receivingTreasuryWalletId: receivingWallet.treasuryWalletId,
        collectionSourceId: request.collectionSourceId,
        amountRaw: transferRequest.amountRaw.toString(),
        asset: transferRequest.asset,
      },
    });

    return request;
  });

  return getCollectionRequestDetail(args.organizationId, created.collectionRequestId);
}

export async function cancelCollectionRequest(args: {
  organizationId: string;
  collectionRequestId: string;
  actorUserId: string;
}) {
  const current = await prisma.collectionRequest.findFirstOrThrow({
    where: { organizationId: args.organizationId, collectionRequestId: args.collectionRequestId },
  });
  if (current.state === 'cancelled') {
    return getCollectionRequestDetail(args.organizationId, args.collectionRequestId);
  }
  if (['collected', 'closed'].includes(current.state)) {
    throw new Error(`Collection request ${current.state} cannot be cancelled`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.collectionRequest.update({
      where: { collectionRequestId: args.collectionRequestId },
      data: { state: 'cancelled' },
    });
    if (current.transferRequestId) {
      await tx.transferRequest.update({
        where: { transferRequestId: current.transferRequestId },
        data: { status: 'rejected' },
      });
      await createTransferRequestEvent(tx, {
        transferRequestId: current.transferRequestId,
        organizationId: args.organizationId,
        eventType: 'collection_cancelled',
        actorType: 'user',
        actorId: args.actorUserId,
        eventSource: 'user',
        beforeState: 'approved',
        afterState: 'rejected',
        payloadJson: { collectionRequestId: args.collectionRequestId },
      });
    }
    await createCollectionRequestEvent(tx, {
      collectionRequestId: args.collectionRequestId,
      organizationId: args.organizationId,
      eventType: 'collection_cancelled',
      actorType: 'user',
      actorId: args.actorUserId,
      beforeState: current.state,
      afterState: 'cancelled',
      linkedTransferRequestId: current.transferRequestId,
      payloadJson: {},
    });
  });

  return getCollectionRequestDetail(args.organizationId, args.collectionRequestId);
}

export async function listCollectionRuns(organizationId: string) {
  const runs = await prisma.collectionRun.findMany({
    where: { organizationId },
    include: collectionRunInclude,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return { items: await Promise.all(runs.map(serializeCollectionRunSummary)) };
}

export async function getCollectionRunDetail(organizationId: string, collectionRunId: string) {
  const run = await prisma.collectionRun.findFirstOrThrow({
    where: { organizationId, collectionRunId },
    include: collectionRunInclude,
  });
  const collections = await listCollectionRequests(organizationId, {
    collectionRunId,
    limit: 250,
  });
  return {
    ...(await serializeCollectionRunSummary(run)),
    collectionRequests: collections.items,
  };
}

export async function previewCollectionRunCsv(args: {
  organizationId: string;
  csv: string;
  receivingTreasuryWalletId?: string | null;
}) {
  return {
    csvFingerprint: buildCsvFingerprint(args.csv),
    ...(await previewCollectionRequestsCsv({
      organizationId: args.organizationId,
      csv: args.csv,
      defaultReceivingTreasuryWalletId: args.receivingTreasuryWalletId,
    })),
  };
}

export async function importCollectionRunFromCsv(args: {
  organizationId: string;
  actorUserId: string;
  csv: string;
  runName?: string | null;
  receivingTreasuryWalletId?: string | null;
  importKey?: string | null;
}) {
  const csvFingerprint = buildCsvFingerprint(args.csv);
  const importKey = normalizeOptionalText(args.importKey);
  const existingRun = await findExistingImportedCollectionRun({
    organizationId: args.organizationId,
    importKey,
    csvFingerprint,
  });
  if (existingRun) {
    return {
      collectionRun: await getCollectionRunDetail(args.organizationId, existingRun.collectionRunId),
      importResult: {
        idempotentReplay: true,
        imported: 0,
        failed: 0,
        items: [],
      },
    };
  }

  const preview = await previewCollectionRunCsv({
    organizationId: args.organizationId,
    csv: args.csv,
    receivingTreasuryWalletId: args.receivingTreasuryWalletId,
  });
  const failedRows = preview.items.filter((item) => item.status === 'failed');
  if (failedRows.length) {
    const detail = failedRows
      .slice(0, 3)
      .map((item) => `row ${item.rowNumber}: ${'error' in item ? item.error : 'Invalid row'}`)
      .join(' | ');
    throw new Error(`Collection CSV import preview failed. Fix ${failedRows.length} row(s). ${detail}`);
  }

  const run = await prisma.collectionRun.create({
    data: {
      organizationId: args.organizationId,
      receivingTreasuryWalletId: args.receivingTreasuryWalletId ?? null,
      runName: normalizeOptionalText(args.runName) ?? `CSV collection run ${new Date().toISOString().slice(0, 10)}`,
      inputSource: 'csv_import',
      state: 'open',
      metadataJson: {
        inputSource: 'csv_import',
        csvFingerprint,
        importKey,
      },
      createdByUserId: args.actorUserId,
    },
  });

  const importResult = await importCollectionRequestsFromCsv({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    csv: args.csv,
    collectionRunId: run.collectionRunId,
    defaultReceivingTreasuryWalletId: args.receivingTreasuryWalletId,
  });

  if (importResult.imported === 0) {
    await prisma.collectionRun.delete({ where: { collectionRunId: run.collectionRunId } });
    const failedRows = importResult.items
      .filter((item) => item.status === 'failed')
      .slice(0, 3)
      .map((item) => `row ${item.rowNumber}: ${item.error ?? 'Import failed'}`);
    const detail = failedRows.length ? ` ${failedRows.join(' | ')}` : '';
    throw new Error(`Collection CSV import had no valid rows, so no collection run was created.${detail}`);
  }

  return {
    collectionRun: await getCollectionRunDetail(args.organizationId, run.collectionRunId),
    importResult,
  };
}

export async function importCollectionRequestsFromCsv(args: {
  organizationId: string;
  actorUserId: string;
  csv: string;
  collectionRunId?: string | null;
  defaultReceivingTreasuryWalletId?: string | null;
}) {
  const rows = parseCsv(args.csv);
  if (!rows.length) {
    throw new Error('CSV import is empty');
  }

  const headers = rows[0].map((header) => normalizeHeader(header));
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => normalizeOptionalText(cell)));
  const items = [];
  const seenImportKeys = new Map<string, number>();

  for (const [index, row] of dataRows.entries()) {
    const rowNumber = index + 2;
    const record = Object.fromEntries(headers.map((header, cellIndex) => [header, row[cellIndex]?.trim() ?? '']));

    try {
      const parsed = await parseCollectionCsvRecord({
        organizationId: args.organizationId,
        record,
        rowNumber,
        defaultReceivingTreasuryWalletId: args.defaultReceivingTreasuryWalletId,
      });
      const importKey = buildCollectionCsvImportRowKey(parsed);
      const firstSeenRow = seenImportKeys.get(importKey);
      if (firstSeenRow) {
        throw new Error(`Duplicate CSV row. Same receiver, amount, and reference already appeared on row ${firstSeenRow}`);
      }
      seenImportKeys.set(importKey, rowNumber);

      const collectionRequest = await createCollectionRequest({
        organizationId: args.organizationId,
        actorUserId: args.actorUserId,
        collectionRunId: args.collectionRunId,
        receivingTreasuryWalletId: parsed.receivingTreasuryWalletId,
        collectionSourceId: parsed.collectionSourceId,
        counterpartyId: parsed.counterpartyId,
        payerWalletAddress: parsed.payerWalletAddress,
        payerTokenAccountAddress: parsed.payerTokenAccountAddress,
        amountRaw: parsed.amountRaw,
        asset: parsed.asset,
        reason: parsed.reason,
        externalReference: parsed.externalReference,
        dueAt: parsed.dueAt,
        metadataJson: {
          inputSource: 'csv_import',
          csvRowNumber: rowNumber,
          collectionRunId: args.collectionRunId ?? null,
          counterpartyName: parsed.counterpartyName,
        },
      });

      items.push({ rowNumber, status: 'imported', collectionRequest });
    } catch (error) {
      items.push({
        rowNumber,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Import failed',
      });
    }
  }

  return {
    imported: items.filter((item) => item.status === 'imported').length,
    failed: items.filter((item) => item.status === 'failed').length,
    items,
  };
}

export async function previewCollectionRequestsCsv(args: {
  organizationId: string;
  csv: string;
  defaultReceivingTreasuryWalletId?: string | null;
}) {
  const rows = parseCsv(args.csv);
  if (!rows.length) {
    throw new Error('CSV import is empty');
  }
  const headers = rows[0].map((header) => normalizeHeader(header));
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => normalizeOptionalText(cell)));
  const items = [];
  const seenImportKeys = new Map<string, number>();

  for (const [index, row] of dataRows.entries()) {
    const rowNumber = index + 2;
    const record = Object.fromEntries(headers.map((header, cellIndex) => [header, row[cellIndex]?.trim() ?? '']));
    try {
      const parsed = await parseCollectionCsvRecord({
        organizationId: args.organizationId,
        record,
        rowNumber,
        defaultReceivingTreasuryWalletId: args.defaultReceivingTreasuryWalletId,
      });
      const importKey = buildCollectionCsvImportRowKey(parsed);
      const duplicateRowNumber = seenImportKeys.get(importKey) ?? null;
      seenImportKeys.set(importKey, duplicateRowNumber ?? rowNumber);
      const duplicate = await findActiveCollectionDuplicate({
        organizationId: args.organizationId,
        receivingTreasuryWalletId: parsed.receivingTreasuryWalletId,
        amountRaw: parsed.amountRaw,
        externalReference: parsed.externalReference,
      });
      const warnings = [
        duplicateRowNumber ? `Duplicate CSV row. Same receiver, amount, and reference already appeared on row ${duplicateRowNumber}` : null,
        duplicate ? `Active collection with this receiving wallet, amount, and reference already exists` : null,
        !parsed.payerWalletAddress ? 'No payer wallet supplied; matching will rely on receiving wallet, amount, and timing' : null,
      ].filter((warning): warning is string => Boolean(warning));
      items.push({
        rowNumber,
        status: warnings.length ? 'warning' : 'ready',
        warnings,
        parsed,
        duplicate,
      });
    } catch (error) {
      items.push({
        rowNumber,
        status: 'failed',
        error: error instanceof Error ? error.message : 'CSV row is invalid',
      });
    }
  }

  return {
    totalRows: items.length,
    ready: items.filter((item) => item.status === 'ready').length,
    warnings: items.filter((item) => item.status === 'warning').length,
    failed: items.filter((item) => item.status === 'failed').length,
    canImport: items.every((item) => item.status !== 'failed'),
    items,
  };
}

const collectionRequestInclude = {
  collectionRun: {
    select: {
      collectionRunId: true,
      runName: true,
      state: true,
      createdAt: true,
    },
  },
  receivingTreasuryWallet: true,
  collectionSource: {
    include: {
      counterparty: true,
    },
  },
  counterparty: true,
  transferRequest: {
    select: {
      transferRequestId: true,
      requestType: true,
      status: true,
      amountRaw: true,
      externalReference: true,
      destinationId: true,
    },
  },
  createdByUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.CollectionRequestInclude;

const collectionRunInclude = {
  receivingTreasuryWallet: true,
  createdByUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.CollectionRunInclude;

async function serializeCollectionRequest(request: CollectionRequestWithRelations) {
  const reconciliationDetail = request.transferRequestId
    ? await safeGetReconciliationDetail(request.organizationId, request.transferRequestId)
    : null;

  const derivedState = deriveCollectionState(request.state, reconciliationDetail);
  return {
    collectionRequestId: request.collectionRequestId,
    organizationId: request.organizationId,
    collectionRunId: request.collectionRunId,
    receivingTreasuryWalletId: request.receivingTreasuryWalletId,
    collectionSourceId: request.collectionSourceId,
    counterpartyId: request.counterpartyId,
    transferRequestId: request.transferRequestId,
    payerWalletAddress: request.payerWalletAddress,
    payerTokenAccountAddress: request.payerTokenAccountAddress,
    amountRaw: request.amountRaw.toString(),
    asset: request.asset,
    reason: request.reason,
    externalReference: request.externalReference,
    dueAt: request.dueAt,
    state: request.state,
    derivedState,
    metadataJson: request.metadataJson,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    collectionRun: request.collectionRun,
    receivingTreasuryWallet: serializeTreasuryWallet(request.receivingTreasuryWallet),
    collectionSource: request.collectionSource ? serializeCollectionSource(request.collectionSource) : null,
    counterparty: request.counterparty ? serializeCounterparty(request.counterparty) : null,
    transferRequest: request.transferRequest
      ? {
          ...request.transferRequest,
          amountRaw: request.transferRequest.amountRaw.toString(),
        }
      : null,
    createdByUser: serializeUserRef(request.createdByUser),
    reconciliationDetail,
    events: (request.events ?? []).map(serializeCollectionRequestEvent),
  };
}

async function serializeCollectionRunSummary(run: CollectionRunWithRelations) {
  const collections = await listCollectionRequests(run.organizationId, {
    collectionRunId: run.collectionRunId,
    limit: 250,
  });
  const derivedState = deriveCollectionRunState(run.state, collections.items);
  return {
    collectionRunId: run.collectionRunId,
    organizationId: run.organizationId,
    receivingTreasuryWalletId: run.receivingTreasuryWalletId,
    runName: run.runName,
    inputSource: run.inputSource,
    state: run.state,
    derivedState,
    metadataJson: run.metadataJson,
    createdByUserId: run.createdByUserId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    receivingTreasuryWallet: run.receivingTreasuryWallet ? serializeTreasuryWallet(run.receivingTreasuryWallet) : null,
    createdByUser: serializeUserRef(run.createdByUser),
    summary: {
      total: collections.items.length,
      open: collections.items.filter((item) => item.derivedState === 'open').length,
      partiallyCollected: collections.items.filter((item) => item.derivedState === 'partially_collected').length,
      collected: collections.items.filter((item) => item.derivedState === 'collected').length,
      exception: collections.items.filter((item) => item.derivedState === 'exception').length,
      totalAmountRaw: collections.items.reduce((sum, item) => sum + BigInt(item.amountRaw), 0n).toString(),
    },
  };
}

function deriveCollectionState(storedState: string, reconciliationDetail: Awaited<ReturnType<typeof safeGetReconciliationDetail>>) {
  if (storedState === 'cancelled' || storedState === 'closed') {
    return storedState;
  }
  if (!reconciliationDetail) {
    return storedState;
  }
  if (reconciliationDetail.requestDisplayState === 'matched') {
    return 'collected';
  }
  if (reconciliationDetail.requestDisplayState === 'partial') {
    return 'partially_collected';
  }
  if (reconciliationDetail.requestDisplayState === 'exception') {
    return 'exception';
  }
  return storedState;
}

function deriveCollectionRunState(storedState: string, collections: Array<{ derivedState: string }>) {
  if (storedState === 'cancelled' || storedState === 'closed') {
    return storedState;
  }
  if (!collections.length) {
    return storedState;
  }
  if (collections.some((item) => item.derivedState === 'exception')) {
    return 'exception';
  }
  if (collections.every((item) => item.derivedState === 'collected' || item.derivedState === 'closed')) {
    return 'collected';
  }
  if (collections.some((item) => item.derivedState === 'collected' || item.derivedState === 'partially_collected')) {
    return 'partially_collected';
  }
  return storedState;
}

async function safeGetReconciliationDetail(organizationId: string, transferRequestId: string) {
  try {
    return await getReconciliationDetail(organizationId, transferRequestId);
  } catch {
    return null;
  }
}

async function getOrCreateInternalReceivingDestination(args: {
  organizationId: string;
  receivingWallet: TreasuryWallet;
}) {
  const tokenAccountAddress = args.receivingWallet.usdcAtaAddress ?? deriveUsdcAtaForWallet(args.receivingWallet.address);
  const label = args.receivingWallet.displayName
    ? `${args.receivingWallet.displayName} collections`
    : `${shortenAddress(args.receivingWallet.address)} collections`;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.destination.findUnique({
      where: {
        organizationId_walletAddress: {
          organizationId: args.organizationId,
          walletAddress: args.receivingWallet.address,
        },
      },
    });
    if (existing) {
      return tx.destination.update({
        where: { destinationId: existing.destinationId },
        data: {
          isActive: true,
          isInternal: true,
          trustState: existing.trustState === 'blocked' ? 'trusted' : existing.trustState,
          tokenAccountAddress: existing.tokenAccountAddress ?? tokenAccountAddress,
          metadataJson: mergeJsonObject(existing.metadataJson, {
            internalReceivingTreasuryWalletId: args.receivingWallet.treasuryWalletId,
            internalUse: 'collections',
          }) as Prisma.InputJsonValue,
        },
      });
    }
    return tx.destination.create({
      data: {
        organizationId: args.organizationId,
        chain: SOLANA_CHAIN,
        asset: USDC_ASSET,
        walletAddress: args.receivingWallet.address,
        tokenAccountAddress,
        destinationType: 'internal_collection_receiver',
        trustState: 'trusted',
        label,
        notes: 'Internal destination created for expected inbound collections.',
        isInternal: true,
        isActive: true,
        metadataJson: {
          internalReceivingTreasuryWalletId: args.receivingWallet.treasuryWalletId,
          internalUse: 'collections',
        },
      },
    });
  });
}

async function parseCollectionCsvRecord(args: {
  organizationId: string;
  record: Record<string, string>;
  rowNumber: number;
  defaultReceivingTreasuryWalletId?: string | null;
}) {
  const counterpartyName = normalizeOptionalText(
    args.record.counterparty ?? args.record.counterparty_name ?? args.record.customer ?? args.record.name,
  );
  const counterparty = counterpartyName
    ? await findOrCreateCounterparty(args.organizationId, counterpartyName)
    : null;
  const receivingInput = normalizeOptionalText(
    args.record.receiving_wallet
      ?? args.record.receiving_treasury_wallet
      ?? args.record.treasury_wallet
      ?? args.record.receiver
      ?? args.defaultReceivingTreasuryWalletId,
  );
  if (!receivingInput) {
    throw new Error(`Row ${args.rowNumber}: receiving wallet is required`);
  }
  const receivingWallet = await findTreasuryWallet(args.organizationId, receivingInput);
  if (!receivingWallet) {
    throw new Error(`Row ${args.rowNumber}: receiving treasury wallet "${receivingInput}" was not found`);
  }

  const payerWalletAddress = normalizeOptionalText(
    args.record.payer_wallet
      ?? args.record.payer
      ?? args.record.source_wallet
      ?? args.record.from_wallet,
  );
  const collectionSourceInput = normalizeOptionalText(
    args.record.collection_source
      ?? args.record.collection_source_id
      ?? args.record.payer_source
      ?? args.record.source,
  );
  const collectionSource = collectionSourceInput
    ? await findCollectionSource(args.organizationId, collectionSourceInput)
    : payerWalletAddress
      ? await findCollectionSource(args.organizationId, payerWalletAddress)
      : null;
  if (collectionSourceInput && !collectionSource) {
    throw new Error(`Row ${args.rowNumber}: collection source "${collectionSourceInput}" was not found`);
  }
  if (payerWalletAddress) {
    try {
      deriveUsdcAtaForWallet(payerWalletAddress);
    } catch {
      throw new Error(`Row ${args.rowNumber}: payer wallet "${payerWalletAddress}" is not a valid Solana wallet address`);
    }
  }

  const amountRaw = args.record.amount_raw
    ? BigInt(args.record.amount_raw).toString()
    : parseUsdcAmountToRaw(args.record.amount ?? args.record.amount_usdc);
  const externalReference = normalizeOptionalText(args.record.reference ?? args.record.invoice ?? args.record.invoice_number ?? args.record.external_reference);
  const reason = normalizeOptionalText(args.record.reason ?? args.record.memo)
    ?? [counterpartyName ? `Collect from ${counterpartyName}` : 'Expected collection', externalReference].filter(Boolean).join(' ');

  return {
    counterpartyName,
    counterpartyId: counterparty?.counterpartyId ?? collectionSource?.counterpartyId ?? null,
    receivingTreasuryWalletId: receivingWallet.treasuryWalletId,
    receivingWalletAddress: receivingWallet.address,
    collectionSourceId: collectionSource?.collectionSourceId ?? null,
    payerWalletAddress: payerWalletAddress ?? collectionSource?.walletAddress ?? null,
    payerTokenAccountAddress: collectionSource?.tokenAccountAddress ?? null,
    amountRaw,
    asset: normalizeOptionalText(args.record.asset) ?? 'usdc',
    externalReference,
    reason,
    dueAt: parseOptionalDate(args.record.due_date ?? args.record.due_at),
  };
}

async function findOrCreateCounterparty(organizationId: string, displayName: string) {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { organizationId },
    select: { organizationId: true },
  });
  const existing = await prisma.counterparty.findFirst({
    where: {
      organizationId: organization.organizationId,
      displayName: { equals: displayName, mode: 'insensitive' },
      status: 'active',
    },
  });
  if (existing) {
    return existing;
  }
  return prisma.counterparty.create({
    data: {
      organizationId: organization.organizationId,
      displayName,
      category: 'customer',
      metadataJson: { inputSource: 'collection_csv_import' },
    },
  });
}

async function findTreasuryWallet(organizationId: string, value: string) {
  const alternatives: Prisma.TreasuryWalletWhereInput[] = [
    { treasuryWalletId: isUuid(value) ? value : undefined },
    { address: value },
    { usdcAtaAddress: value },
    { displayName: { equals: value, mode: 'insensitive' as const } },
  ].filter((item) => Object.values(item).some((entry) => entry !== undefined));
  return prisma.treasuryWallet.findFirst({
    where: {
      organizationId,
      isActive: true,
      OR: alternatives,
    },
  });
}

async function findCollectionSource(organizationId: string, value: string) {
  const alternatives: Prisma.CollectionSourceWhereInput[] = [
    { collectionSourceId: isUuid(value) ? value : undefined },
    { walletAddress: value },
    { tokenAccountAddress: value },
    { label: { equals: value, mode: 'insensitive' as const } },
  ].filter((item) => Object.values(item).some((entry) => entry !== undefined));
  return prisma.collectionSource.findFirst({
    where: {
      organizationId,
      isActive: true,
      OR: alternatives,
    },
    include: { counterparty: true },
  });
}

async function resolveCollectionSource(args: {
  organizationId: string;
  collectionSourceId?: string | null;
  counterpartyId?: string | null;
  payerWalletAddress?: string | null;
  payerTokenAccountAddress?: string | null;
  reason: string;
  inputSource: string;
}) {
  if (args.collectionSourceId) {
    const source = await prisma.collectionSource.findFirst({
      where: {
        organizationId: args.organizationId,
        collectionSourceId: args.collectionSourceId,
        isActive: true,
      },
      include: { counterparty: true },
    });
    if (!source) {
      throw new Error('Collection source not found');
    }
    return source;
  }

  const payerWalletAddress = normalizeOptionalText(args.payerWalletAddress);
  if (!payerWalletAddress) {
    return null;
  }

  try {
    deriveUsdcAtaForWallet(payerWalletAddress);
  } catch {
    throw new Error(`Payer wallet "${payerWalletAddress}" is not a valid Solana wallet address`);
  }

  return findOrCreateCollectionSourceForPayer({
    organizationId: args.organizationId,
    counterpartyId: args.counterpartyId,
    payerWalletAddress,
    payerTokenAccountAddress: args.payerTokenAccountAddress,
    label: buildCollectionSourceLabel(args.reason, payerWalletAddress),
    inputSource: args.inputSource,
  });
}

function buildCollectionSourceLabel(reason: string, walletAddress: string) {
  const normalizedReason = normalizeOptionalText(reason);
  if (!normalizedReason) {
    return shortenAddress(walletAddress);
  }
  return `${normalizedReason.slice(0, 80)} source`;
}

async function enforceDuplicateCollectionRequest(args: {
  organizationId: string;
  receivingTreasuryWalletId: string;
  amountRaw: string | bigint;
  externalReference: string | null;
}) {
  const duplicate = await findActiveCollectionDuplicate(args);
  if (duplicate) {
    throw new Error(`Active collection with reference "${args.externalReference}" already exists for this receiving wallet and amount`);
  }
}

async function findActiveCollectionDuplicate(args: {
  organizationId: string;
  receivingTreasuryWalletId: string;
  amountRaw: string | bigint;
  externalReference: string | null;
}) {
  if (!args.externalReference) {
    return null;
  }
  return prisma.collectionRequest.findFirst({
    where: {
      organizationId: args.organizationId,
      receivingTreasuryWalletId: args.receivingTreasuryWalletId,
      amountRaw: BigInt(args.amountRaw),
      externalReference: { equals: args.externalReference, mode: 'insensitive' },
      state: { notIn: ['closed', 'cancelled'] },
    },
    select: {
      collectionRequestId: true,
      state: true,
    },
  });
}

async function findExistingImportedCollectionRun(args: {
  organizationId: string;
  importKey: string | null;
  csvFingerprint: string;
}) {
  return prisma.collectionRun.findFirst({
    where: {
      organizationId: args.organizationId,
      inputSource: 'csv_import',
      OR: [
        { metadataJson: { path: ['csvFingerprint'], equals: args.csvFingerprint } },
        ...(args.importKey ? [{ metadataJson: { path: ['importKey'], equals: args.importKey } }] : []),
      ],
    },
    select: { collectionRunId: true },
  });
}

async function createCollectionRequestEvent(
  client: Prisma.TransactionClient,
  args: {
    collectionRequestId: string;
    organizationId: string;
    eventType: string;
    actorType: string;
    actorId?: string | null;
    beforeState?: string | null;
    afterState?: string | null;
    linkedTransferRequestId?: string | null;
    payloadJson?: Prisma.InputJsonValue;
  },
) {
  await client.collectionRequestEvent.create({
    data: {
      collectionRequestId: args.collectionRequestId,
      organizationId: args.organizationId,
      eventType: args.eventType,
      actorType: args.actorType,
      actorId: args.actorId ?? null,
      beforeState: args.beforeState ?? null,
      afterState: args.afterState ?? null,
      linkedTransferRequestId: args.linkedTransferRequestId ?? null,
      payloadJson: (args.payloadJson ?? {}) as Prisma.InputJsonValue,
    },
  });
}

function serializeCollectionRequestEvent(event: CollectionRequestEvent) {
  return {
    collectionRequestEventId: event.collectionRequestEventId,
    collectionRequestId: event.collectionRequestId,
    organizationId: event.organizationId,
    eventType: event.eventType,
    actorType: event.actorType,
    actorId: event.actorId,
    beforeState: event.beforeState,
    afterState: event.afterState,
    linkedTransferRequestId: event.linkedTransferRequestId,
    payloadJson: event.payloadJson,
    createdAt: event.createdAt,
  };
}

function serializeTreasuryWallet(wallet: TreasuryWallet) {
  return {
    treasuryWalletId: wallet.treasuryWalletId,
    organizationId: wallet.organizationId,
    chain: wallet.chain,
    address: wallet.address,
    assetScope: wallet.assetScope,
    usdcAtaAddress: wallet.usdcAtaAddress,
    isActive: wallet.isActive,
    displayName: wallet.displayName,
    notes: wallet.notes,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
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

function serializeUserRef(user: Pick<User, 'userId' | 'email' | 'displayName'> | null | undefined) {
  return user
    ? {
        userId: user.userId,
        email: user.email,
        displayName: user.displayName,
      }
    : null;
}

function normalizeRequiredText(value: string | null | undefined, message: string) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseUsdcAmountToRaw(value: string | undefined) {
  const amount = normalizeOptionalText(value);
  if (!amount) {
    throw new Error('Amount is required');
  }
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) {
    throw new Error(`Invalid USDC amount "${amount}"`);
  }
  const [whole, fractional = ''] = amount.split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, '0'))).toString();
}

function parseOptionalDate(value: string | undefined) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Invalid due date "${normalized}"`);
  }
  return date;
}

function parseCsv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (inQuotes) {
    throw new Error('CSV has an unterminated quoted field');
  }
  return rows.filter((candidate) => candidate.some((entry) => normalizeOptionalText(entry)));
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replaceAll(/\s+/g, '_');
}

function buildCollectionCsvImportRowKey(parsed: {
  receivingTreasuryWalletId: string;
  amountRaw: string;
  externalReference: string | null;
}) {
  return [
    parsed.receivingTreasuryWalletId,
    parsed.amountRaw,
    parsed.externalReference?.toLowerCase() ?? '',
  ].join('|');
}

function buildCsvFingerprint(csv: string) {
  return createHash('sha256').update(csv.trim()).digest('hex');
}

function mergeJsonObject(existing: unknown, patch: Record<string, unknown>) {
  const base = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  return { ...base, ...patch };
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
}

function shortenAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}
