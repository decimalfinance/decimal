import type {
  Counterparty,
  CounterpartyWallet,
  PaymentRun,
  Prisma,
  TransferRequest,
  User,
  TreasuryWallet,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { serializeExecutionRecord } from '../transfer-requests/execution-records.js';
import { extractPaymentRowsFromDocument, type ExtractedRow } from './document-extract.js';
import { listPaymentOrders, submitPaymentOrder } from './orders.js';
import { createPaymentRequest, importPaymentRequestsFromCsv, previewPaymentRequestsCsv } from './requests.js';
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

type PaymentRunDocumentRuntime = {
  extractRowsFromDocument: typeof extractPaymentRowsFromDocument;
};

const defaultDocumentRuntime: PaymentRunDocumentRuntime = {
  extractRowsFromDocument: extractPaymentRowsFromDocument,
};

let documentRuntime: PaymentRunDocumentRuntime = defaultDocumentRuntime;

export function setPaymentRunDocumentRuntimeForTests(nextRuntime: Partial<PaymentRunDocumentRuntime> | null) {
  documentRuntime = nextRuntime ? { ...defaultDocumentRuntime, ...nextRuntime } : defaultDocumentRuntime;
}

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
  counterpartyWallet: CounterpartyWallet;
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
  importKey?: string | null;
  submitOrderNow?: boolean;
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

export type DocumentImportSkippedRow = {
  rowIndex: number;
  counterparty: string;
  amount: number;
  currency: string;
  reference: string | null;
  walletAddress?: string | null;
  reason: 'no_destination_or_wallet' | 'unsupported_currency' | 'invalid_wallet_address';
  message?: string;
};

/**
 * Run the doc-to-proposal pipeline: extract structured rows from an
 * invoice/expense document, match each counterparty against the org's
 * destination registry, then route the matched rows through the
 * existing CSV-import machinery to create a draft PaymentRun.
 *
 * Rows whose counterparty has no matching destination (or whose
 * currency isn't USDC/USD) are skipped and reported back so the
 * caller can prompt the operator to add a destination first.
 */
export type DocumentImportProgressStage =
  | 'received'
  | 'rendering'
  | 'extracting'
  | 'matching'
  | 'creating'
  | 'done';

export type DocumentImportProgressEvent =
  | { stage: 'received'; message: string; bytes: number }
  | { stage: 'rendering'; message: string }
  | { stage: 'extracting'; message: string; pageCount: number }
  | { stage: 'matching'; message: string; extractedCount: number; modelLatencyMs: number }
  | { stage: 'creating'; message: string; matchedCount: number; skippedCount: number }
  | { stage: 'done'; message: string };

export async function importPaymentRunFromDocument(args: {
  organizationId: string;
  actorUserId: string;
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  runName?: string | null;
  sourceTreasuryWalletId?: string | null;
  /** Optional progress callback, fires once per stage with real milestones. */
  onProgress?: (event: DocumentImportProgressEvent) => void;
}) {
  const emit = args.onProgress ?? (() => {});

  emit({ stage: 'received', message: 'Document received', bytes: args.fileBytes.length });
  emit({ stage: 'rendering', message: 'Rendering document pages' });

  const extraction = await documentRuntime.extractRowsFromDocument({
    fileBytes: args.fileBytes,
    filename: args.filename,
    mimeType: args.mimeType,
    onProgress: (e) => {
      // Surface the "extracting" stage right when the model call starts —
      // pageCount is known after the render step inside extract.
      if (e.stage === 'extracting') {
        emit({ stage: 'extracting', message: 'Reading invoices with AI', pageCount: e.pageCount });
      }
    },
  });

  if (extraction.rows.length === 0) {
    throw new Error('No payments could be extracted from this document.');
  }

  emit({
    stage: 'matching',
    message: `Matching ${extraction.rows.length} extracted row${extraction.rows.length === 1 ? '' : 's'} to your address book`,
    extractedCount: extraction.rows.length,
    modelLatencyMs: extraction.modelLatencyMs,
  });

  const counterpartyWallets = await prisma.counterpartyWallet.findMany({
    where: {
      organizationId: args.organizationId,
      isActive: true,
    },
    include: { counterparty: true },
  });

  const matched: Array<{ row: ExtractedRow; destinationLabel: string; walletAddress: string }> = [];
  const skipped: DocumentImportSkippedRow[] = [];

  for (const [rowIndex, row] of extraction.rows.entries()) {
    if (!isUsdLikeCurrency(row.currency)) {
      skipped.push({
        rowIndex,
        counterparty: row.counterparty,
        amount: row.amount,
        currency: row.currency,
        reference: row.reference,
        reason: 'unsupported_currency',
        message: `Currency ${row.currency} is not supported for USDC payment runs.`,
      });
      continue;
    }
    // Prefer the registry-matched counterparty wallet — that wallet has
    // been verified out-of-band. Fall back to the wallet printed on the
    // invoice if the vendor is new; the existing CSV import flow will
    // auto-create that wallet as `unreviewed`, and the per-row Approve
    // button on the run page is the trust gate.
    const counterpartyWallet = matchCounterpartyWallet(counterpartyWallets, row.counterparty);
    if (counterpartyWallet) {
      matched.push({
        row,
        destinationLabel: counterpartyWallet.label,
        walletAddress: counterpartyWallet.walletAddress,
      });
      continue;
    }
    const extractedWalletAddress = normalizeOptionalText(row.wallet_address);
    if (extractedWalletAddress) {
      if (!isValidSolanaWalletAddress(extractedWalletAddress)) {
        skipped.push({
          rowIndex,
          counterparty: row.counterparty,
          amount: row.amount,
          currency: row.currency,
          reference: row.reference,
          walletAddress: extractedWalletAddress,
          reason: 'invalid_wallet_address',
          message:
            `Extracted wallet "${extractedWalletAddress}" is not a valid Solana base58 address. ` +
            `This is usually OCR ambiguity; review the invoice or add the counterparty wallet manually.`,
        });
        continue;
      }
      matched.push({
        row,
        destinationLabel: row.counterparty,
        walletAddress: extractedWalletAddress,
      });
      continue;
    }
    skipped.push({
      rowIndex,
      counterparty: row.counterparty,
      amount: row.amount,
      currency: row.currency,
      reference: row.reference,
      reason: 'no_destination_or_wallet',
      message: 'No matching counterparty wallet was found and the invoice did not include a usable Solana wallet address.',
    });
  }

  if (matched.length === 0) {
    emit({
      stage: 'creating',
      message: 'Creating review record for unrouted document rows',
      matchedCount: 0,
      skippedCount: skipped.length,
    });
    const reviewRun = await createUnroutedDocumentImportRun({
      organizationId: args.organizationId,
      actorUserId: args.actorUserId,
      sourceTreasuryWalletId: args.sourceTreasuryWalletId,
      runName: normalizeOptionalText(args.runName) ?? deriveRunNameFromExtraction(extraction.rows, args.filename),
      filename: args.filename,
      mimeType: args.mimeType,
      extraction,
      skippedRows: skipped,
    });

    emit({ stage: 'done', message: 'Document needs routing review' });

    return {
      paymentRun: reviewRun,
      importResult: {
        idempotentReplay: false,
        imported: 0,
        failed: skipped.length,
        items: skipped.map((row) => ({
          rowNumber: row.rowIndex + 1,
          status: 'failed',
          error: row.message ?? row.reason,
          counterparty: row.counterparty,
          amount: row.amount,
          reference: row.reference,
        })),
      },
      extractedRows: extraction.rows,
      skippedRows: skipped,
      modelLatencyMs: extraction.modelLatencyMs,
      documentImportReview: {
        status: 'needs_routing',
        reason: 'no_routable_rows',
        message: 'No extracted rows could be routed to a verified counterparty wallet.',
      },
    };
  }

  emit({
    stage: 'creating',
    message: `Creating draft batch with ${matched.length} payment${matched.length === 1 ? '' : 's'}`,
    matchedCount: matched.length,
    skippedCount: skipped.length,
  });

  const csv = buildCsvFromMatchedRows(matched);
  const derivedRunName =
    normalizeOptionalText(args.runName) ?? deriveRunNameFromDocument(matched, args.filename);
  const result = await importPaymentRunFromCsv({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    csv,
    runName: derivedRunName,
    sourceTreasuryWalletId: args.sourceTreasuryWalletId,
  });

  emit({ stage: 'done', message: 'Batch ready for review' });

  return {
    ...result,
    extractedRows: extraction.rows,
    skippedRows: skipped,
    modelLatencyMs: extraction.modelLatencyMs,
  };
}

export async function resolvePaymentRunDocumentRow(args: {
  organizationId: string;
  paymentRunId: string;
  actorUserId: string;
  rowIndex: number;
  counterpartyWalletId?: string | null;
  walletAddress?: string | null;
  label?: string | null;
  trustState?: 'unreviewed' | 'trusted';
}) {
  const run = await prisma.paymentRun.findFirstOrThrow({
    where: {
      organizationId: args.organizationId,
      paymentRunId: args.paymentRunId,
    },
  });
  const importReview = getDocumentImportReview(run.metadataJson);
  if (!importReview) {
    throw new Error('This payment run does not have document routing review data.');
  }

  const row = importReview.extractedRows[args.rowIndex];
  if (!row) {
    throw new Error(`No extracted row exists at index ${args.rowIndex}.`);
  }
  if (!isUsdLikeCurrency(row.currency)) {
    throw new Error(`Currency ${row.currency} is not supported for USDC payout creation yet.`);
  }
  if (importReview.resolvedRows.some((resolved) => resolved.rowIndex === args.rowIndex)) {
    throw new Error(`Extracted row ${args.rowIndex + 1} has already been resolved.`);
  }

  const counterpartyWallet = await resolveDocumentImportCounterpartyWallet({
    organizationId: args.organizationId,
    row,
    counterpartyWalletId: args.counterpartyWalletId,
    walletAddress: args.walletAddress,
    label: args.label,
    trustState: args.trustState ?? 'unreviewed',
  });

  const paymentRequest = await createPaymentRequest({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    paymentRunId: args.paymentRunId,
    counterpartyWalletId: counterpartyWallet.counterpartyWalletId,
    amountRaw: parseDocumentRowAmountToRaw(row.amount),
    asset: 'usdc',
    reason: row.notes ?? `Pay ${row.counterparty}`,
    externalReference: row.reference,
    dueAt: parseOptionalDate(row.due_date),
    createOrderNow: true,
    submitOrderNow: false,
    sourceTreasuryWalletId: run.sourceTreasuryWalletId,
    metadataJson: {
      inputSource: 'document_import_routing_review',
      paymentRunId: args.paymentRunId,
      invoiceNumber: row.reference,
      extractedRowIndex: args.rowIndex,
      extractedRow: row as Prisma.InputJsonValue,
    },
  });

  const nextResolvedRows = [
    ...importReview.resolvedRows,
    {
      rowIndex: args.rowIndex,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: args.actorUserId,
      counterpartyWalletId: counterpartyWallet.counterpartyWalletId,
      paymentRequestId: paymentRequest.paymentRequestId,
      paymentOrderId: paymentRequest.paymentOrder?.paymentOrderId ?? null,
    },
  ];
  const nextSkippedRows = importReview.skippedRows.filter((skipped) => skipped.rowIndex !== args.rowIndex);

  await prisma.paymentRun.update({
    where: { paymentRunId: args.paymentRunId },
    data: {
      state: nextSkippedRows.length > 0 ? run.state : 'draft',
      metadataJson: {
        ...(isRecordLike(run.metadataJson) ? run.metadataJson : {}),
        importReview: {
          ...importReview.raw,
          status: nextSkippedRows.length > 0 ? 'needs_routing' : 'resolved',
          skippedRows: nextSkippedRows,
          resolvedRows: nextResolvedRows,
        },
      } as Prisma.InputJsonValue,
    },
  });

  return {
    paymentRun: await getPaymentRunDetail(args.organizationId, args.paymentRunId),
    paymentRequest,
    resolvedRow: nextResolvedRows[nextResolvedRows.length - 1],
  };
}

async function createUnroutedDocumentImportRun(args: {
  organizationId: string;
  actorUserId: string;
  sourceTreasuryWalletId?: string | null;
  runName: string;
  filename: string;
  mimeType: string;
  extraction: { rows: ExtractedRow[]; modelLatencyMs: number; pageCount: number };
  skippedRows: DocumentImportSkippedRow[];
}) {
  const run = await prisma.paymentRun.create({
    data: {
      organizationId: args.organizationId,
      sourceTreasuryWalletId: args.sourceTreasuryWalletId ?? null,
      runName: args.runName,
      inputSource: 'document_import',
      state: 'exception',
      metadataJson: {
        inputSource: 'document_import',
        importReview: {
          status: 'needs_routing',
          reason: 'no_routable_rows',
          skippedRows: args.skippedRows,
          resolvedRows: [],
          extractedRows: args.extraction.rows,
          sourceDocument: {
            filename: args.filename,
            mimeType: args.mimeType,
            pageCount: args.extraction.pageCount,
            modelLatencyMs: args.extraction.modelLatencyMs,
          },
        },
      },
      createdByUserId: args.actorUserId,
    },
  });

  return getPaymentRunDetail(args.organizationId, run.paymentRunId);
}

async function resolveDocumentImportCounterpartyWallet(args: {
  organizationId: string;
  row: ExtractedRow;
  counterpartyWalletId?: string | null;
  walletAddress?: string | null;
  label?: string | null;
  trustState: 'unreviewed' | 'trusted';
}): Promise<CounterpartyWallet & { counterparty: Counterparty | null }> {
  const counterpartyWalletId = normalizeOptionalText(args.counterpartyWalletId);
  if (counterpartyWalletId) {
    const wallet = await prisma.counterpartyWallet.findFirst({
      where: {
        organizationId: args.organizationId,
        counterpartyWalletId,
        isActive: true,
      },
      include: { counterparty: true },
    });
    if (!wallet) {
      throw new Error('Counterparty wallet not found for this organization.');
    }
    return wallet;
  }

  const walletAddress = normalizeOptionalText(args.walletAddress);
  if (!walletAddress) {
    throw new Error('Provide a counterparty wallet or a corrected Solana wallet address.');
  }

  let tokenAccountAddress: string;
  try {
    tokenAccountAddress = deriveUsdcAtaForWallet(walletAddress);
  } catch {
    throw new Error(`"${walletAddress}" is not a valid Solana wallet address.`);
  }

  const existing = await prisma.counterpartyWallet.findUnique({
    where: {
      organizationId_walletAddress: {
        organizationId: args.organizationId,
        walletAddress,
      },
    },
    include: { counterparty: true },
  });
  if (existing) {
    return existing;
  }

  const label = normalizeOptionalText(args.label) ?? normalizeOptionalText(args.row.counterparty) ?? shortenAddress(walletAddress);
  const counterparty = await findOrCreateCounterpartyByName(args.organizationId, label);
  return prisma.counterpartyWallet.create({
    data: {
      organizationId: args.organizationId,
      counterpartyId: counterparty.counterpartyId,
      chain: 'solana',
      asset: 'usdc',
      walletAddress,
      tokenAccountAddress,
      walletType: 'invoice_imported',
      trustState: args.trustState,
      label,
      notes: 'Created while resolving an OCR document-import routing review.',
      isInternal: false,
      isActive: true,
      metadataJson: {
        inputSource: 'document_import_routing_review',
        counterpartyName: args.row.counterparty,
        extractedWalletAddress: args.row.wallet_address,
      },
    },
    include: { counterparty: true },
  });
}

async function findOrCreateCounterpartyByName(organizationId: string, displayName: string) {
  const existing = await prisma.counterparty.findFirst({
    where: {
      organizationId,
      displayName: { equals: displayName, mode: 'insensitive' },
    },
  });
  if (existing) return existing;

  return prisma.counterparty.create({
    data: {
      organizationId,
      displayName,
      category: 'vendor',
      metadataJson: {
        inputSource: 'document_import_routing_review',
      },
    },
  });
}

function getDocumentImportReview(metadataJson: Prisma.JsonValue) {
  if (!isRecordLike(metadataJson) || !isRecordLike(metadataJson.importReview)) {
    return null;
  }
  const raw = metadataJson.importReview;
  const extractedRows = Array.isArray(raw.extractedRows) ? raw.extractedRows.filter(isExtractedRowLike) : [];
  const skippedRows = Array.isArray(raw.skippedRows)
    ? raw.skippedRows
      .map((row, index) => normalizeDocumentImportSkippedRow(row, index))
      .filter((row): row is DocumentImportSkippedRow => Boolean(row))
    : [];
  const resolvedRows = Array.isArray(raw.resolvedRows) ? raw.resolvedRows.filter(isResolvedDocumentRowLike) : [];
  return { raw, extractedRows, skippedRows, resolvedRows };
}

function isExtractedRowLike(value: unknown): value is ExtractedRow {
  if (!isRecordLike(value)) return false;
  return typeof value.counterparty === 'string'
    && typeof value.amount === 'number'
    && typeof value.currency === 'string'
    && (typeof value.reference === 'string' || value.reference === null)
    && (typeof value.due_date === 'string' || value.due_date === null)
    && (typeof value.wallet_address === 'string' || value.wallet_address === null)
    && (typeof value.notes === 'string' || value.notes === null);
}

function normalizeDocumentImportSkippedRow(value: unknown, fallbackRowIndex: number): DocumentImportSkippedRow | null {
  if (!isRecordLike(value)) return null;
  if (
    typeof value.counterparty !== 'string'
    || typeof value.amount !== 'number'
    || typeof value.currency !== 'string'
    || !(typeof value.reference === 'string' || value.reference === null)
    || typeof value.reason !== 'string'
  ) {
    return null;
  }
  const rowIndex = typeof value.rowIndex === 'number' ? value.rowIndex : fallbackRowIndex;
  return {
    rowIndex,
    counterparty: value.counterparty,
    amount: value.amount,
    currency: value.currency,
    reference: value.reference,
    walletAddress: typeof value.walletAddress === 'string' ? value.walletAddress : null,
    reason: value.reason as DocumentImportSkippedRow['reason'],
    message: typeof value.message === 'string' ? value.message : undefined,
  };
}

function isResolvedDocumentRowLike(value: unknown): value is {
  rowIndex: number;
  resolvedAt: string;
  resolvedByUserId: string;
  counterpartyWalletId: string;
  paymentRequestId: string;
  paymentOrderId: string | null;
} {
  return isRecordLike(value)
    && typeof value.rowIndex === 'number'
    && typeof value.resolvedAt === 'string'
    && typeof value.resolvedByUserId === 'string'
    && typeof value.counterpartyWalletId === 'string'
    && typeof value.paymentRequestId === 'string'
    && (typeof value.paymentOrderId === 'string' || value.paymentOrderId === null);
}

function parseDocumentRowAmountToRaw(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RangeError('Amount must be positive.');
  }
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

function parseOptionalDate(value: string | null | undefined) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUsdLikeCurrency(currency: string): boolean {
  const normalized = currency.trim().toUpperCase();
  // We pay in USDC; treat USD as a stand-in (the human readable amount
  // matches 1:1 in the demo path). A future iteration can do FX.
  return normalized === 'USDC' || normalized === 'USD' || normalized === '$';
}

function isValidSolanaWalletAddress(value: string): boolean {
  try {
    deriveUsdcAtaForWallet(value);
    return true;
  } catch {
    return false;
  }
}

function matchCounterpartyWallet(
  wallets: Array<{ counterpartyWalletId: string; label: string; walletAddress: string; counterparty: { displayName: string } | null }>,
  counterpartyName: string,
) {
  const needle = counterpartyName.trim().toLowerCase();
  if (!needle) return null;
  // Prefer exact label match, fall back to counterparty.displayName
  // exact match, then a containment check in either direction.
  const exact = wallets.find(
    (w) =>
      w.label.toLowerCase() === needle
      || w.counterparty?.displayName.toLowerCase() === needle,
  );
  if (exact) return exact;
  return wallets.find(
    (w) =>
      w.label.toLowerCase().includes(needle)
      || needle.includes(w.label.toLowerCase())
      || (w.counterparty && w.counterparty.displayName.toLowerCase().includes(needle))
      || (w.counterparty && needle.includes(w.counterparty.displayName.toLowerCase())),
  ) ?? null;
}

// When the operator doesn't supply a batch name, derive one from the
// extracted invoice content so the run is recognizable in the list
// (instead of falling through to the generic "CSV payment run YYYY-MM-DD"
// fallback baked into the CSV importer).
function deriveRunNameFromDocument(
  matched: Array<{ row: ExtractedRow }>,
  filename: string,
): string {
  const vendors = matched
    .map((m) => m.row.counterparty.trim())
    .filter((v) => v.length > 0);
  const uniqueVendors = Array.from(new Set(vendors));

  if (uniqueVendors.length === 1) {
    return truncateVendorName(uniqueVendors[0]!);
  }
  if (uniqueVendors.length > 1) {
    const first = truncateVendorName(uniqueVendors[0]!);
    return `${first} + ${uniqueVendors.length - 1} more`;
  }
  // No vendor names at all — extremely unlikely since `matched` is
  // non-empty here, but keep a safe fallback.
  const stem = filename.replace(/\.[^.]+$/, '').trim();
  return stem || `Document import ${new Date().toISOString().slice(0, 10)}`;
}

function deriveRunNameFromExtraction(rows: ExtractedRow[], filename: string): string {
  const vendors = rows
    .map((row) => row.counterparty.trim())
    .filter((vendor) => vendor.length > 0);
  if (vendors.length > 0) {
    const uniqueVendors = Array.from(new Set(vendors));
    if (uniqueVendors.length === 1) {
      return `${truncateVendorName(uniqueVendors[0]!)} review`;
    }
    return `${truncateVendorName(uniqueVendors[0]!)} + ${uniqueVendors.length - 1} review`;
  }
  const stem = filename.replace(/\.[^.]+$/, '').trim();
  return stem ? `${stem} review` : `Document review ${new Date().toISOString().slice(0, 10)}`;
}

function truncateVendorName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 57)}…`;
}

function buildCsvFromMatchedRows(
  rows: Array<{ row: ExtractedRow; destinationLabel: string; walletAddress: string }>,
): string {
  const header = 'counterparty,destination,amount,reference,due_date';
  const body = rows
    .map(({ row, destinationLabel, walletAddress }) => {
      // CSV escape: wrap in quotes + double up internal quotes if the
      // value contains a comma, quote, or newline.
      const cells = [
        csvCell(row.counterparty || destinationLabel),
        csvCell(walletAddress),
        csvCell(row.amount.toString()),
        csvCell(row.reference ?? ''),
        csvCell(row.due_date ?? ''),
      ];
      return cells.join(',');
    })
    .join('\n');
  return `${header}\n${body}\n`;
}

function csvCell(value: string): string {
  if (value === '') return '';
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
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
      if (order.counterpartyWallet.walletAddress === source.address) {
        throw new Error(`Source wallet cannot be the same as counterparty wallet "${order.counterpartyWallet.label}"`);
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
              counterpartyWallet: draft.counterpartyWallet.walletAddress,
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
      counterpartyWallet: true,
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
  const destinationTokenAccount = order.counterpartyWallet.tokenAccountAddress
    ?? deriveUsdcAtaForWallet(order.counterpartyWallet.walletAddress);

  return {
    paymentOrderId: order.paymentOrderId,
    paymentOrderState: order.state,
    transferRequestId: request.transferRequestId,
    transferRequestStatus: request.status,
    counterpartyWallet: {
      counterpartyWalletId: order.counterpartyWallet.counterpartyWalletId,
      label: order.counterpartyWallet.label,
      walletAddress: order.counterpartyWallet.walletAddress,
      tokenAccountAddress: destinationTokenAccount,
    },
    amountRaw: order.amountRaw.toString(),
    memo: order.memo,
    reference: order.externalReference ?? order.invoiceNumber,
    instructions: buildUsdcTransferInstructions({
      sourceWallet: source.address,
      sourceTokenAccount,
      destinationWallet: order.counterpartyWallet.walletAddress,
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
      counterpartyWallet: draft.counterpartyWallet,
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

function shortenAddress(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
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
