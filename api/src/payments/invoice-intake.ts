import type { Counterparty, CounterpartyWallet, Prisma } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET, USDC_DECIMALS } from '../solana.js';
import { createPaymentOrder } from './orders.js';
import { extractPaymentRowsFromDocument, type ExtractedRow } from './document-extract.js';

const NEW_COUNTERPARTY_REVIEW_THRESHOLD_RAW = 1_000n * 10n ** BigInt(USDC_DECIMALS);
const LOW_CONFIDENCE_OVERALL_THRESHOLD = 0.72;
const LOW_CONFIDENCE_AMOUNT_THRESHOLD = 0.72;

type InvoiceIntakeRuntime = {
  extractRowsFromDocument: typeof extractPaymentRowsFromDocument;
};

const defaultRuntime: InvoiceIntakeRuntime = {
  extractRowsFromDocument: extractPaymentRowsFromDocument,
};

let runtime: InvoiceIntakeRuntime = defaultRuntime;

export function setInvoiceIntakeRuntimeForTests(nextRuntime: Partial<InvoiceIntakeRuntime> | null) {
  runtime = nextRuntime ? { ...defaultRuntime, ...nextRuntime } : defaultRuntime;
}

export type InvoiceIntakeSkippedRow = {
  counterparty: string;
  amount: number;
  currency: string;
  reference: string | null;
  walletAddress?: string | null;
  reason:
    | 'no_destination_or_wallet'
    | 'unsupported_currency'
    | 'blocked_counterparty'
    | 'invalid_amount'
    | 'invalid_wallet_address'
    | 'creation_failed';
  message: string;
};

export async function uploadInvoiceToPaymentOrders(args: {
  organizationId: string;
  actorUserId: string;
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  sourceTreasuryWalletId?: string | null;
}) {
  logger.info('invoice_intake.started', {
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    filename: args.filename,
    mimeType: args.mimeType,
    bytes: args.fileBytes.length,
    hasSourceTreasuryWallet: Boolean(args.sourceTreasuryWalletId),
  });

  const extraction = await runtime.extractRowsFromDocument({
    fileBytes: args.fileBytes,
    filename: args.filename,
    mimeType: args.mimeType,
  });

  if (extraction.rows.length === 0) {
    throw new Error('No payable invoice rows were extracted from this document.');
  }

  const created = [];
  const skipped: InvoiceIntakeSkippedRow[] = [];

  for (const [index, row] of extraction.rows.entries()) {
    try {
      if (!isUsdLikeCurrency(row.currency)) {
        skipped.push(buildSkippedRow(row, 'unsupported_currency', `Currency ${row.currency} is not supported for USDC payout creation yet.`));
        continue;
      }

      const amountRaw = parseUsdcAmountToRaw(row.amount);
      const counterpartyWallet = await resolveInvoiceCounterpartyWallet({
        organizationId: args.organizationId,
        row,
        rowNumber: index + 1,
      });

      if (!counterpartyWallet) {
        const extractedWalletAddress = normalizeOptionalText(row.wallet_address);
        if (extractedWalletAddress && !isValidSolanaWalletAddress(extractedWalletAddress)) {
          skipped.push(buildSkippedRow(
            row,
            'invalid_wallet_address',
            `Extracted wallet "${extractedWalletAddress}" is not a valid Solana base58 address. This is usually OCR ambiguity; review the invoice or add the counterparty wallet manually.`,
          ));
        } else {
          skipped.push(buildSkippedRow(row, 'no_destination_or_wallet', 'No matching counterparty wallet was found and the invoice did not include a Solana wallet address.'));
        }
        continue;
      }

      if (counterpartyWallet.trustState === 'blocked') {
        skipped.push(buildSkippedRow(row, 'blocked_counterparty', `Counterparty wallet "${counterpartyWallet.label}" is blocked.`));
        continue;
      }

      const triggeredRules = deriveReviewRules({
        row,
        amountRaw,
        counterpartyWallet,
      });
      const decision = triggeredRules.length ? 'needs_review' : 'drafted';

      const paymentOrder = await createPaymentOrder({
        organizationId: args.organizationId,
        actorUserId: args.actorUserId,
        counterpartyWalletId: counterpartyWallet.counterpartyWalletId,
        sourceTreasuryWalletId: args.sourceTreasuryWalletId ?? null,
        amountRaw,
        asset: USDC_ASSET,
        memo: row.notes ?? `Pay ${row.counterparty}`,
        externalReference: row.reference,
        invoiceNumber: row.reference,
        dueAt: parseOptionalDate(row.due_date),
        metadataJson: {
          inputSource: 'invoice_upload',
          agent: {
            name: 'ap-intake',
            version: 'api-native-v1',
            decision,
            triggeredRules,
            extracted: row.source_invoice ?? {
              vendorName: row.counterparty,
              vendorAddress: null,
              vendorEmail: null,
              amount: row.amount,
              currency: row.currency,
              invoiceNumber: row.reference,
              invoiceDate: null,
              dueDate: row.due_date,
              walletAddress: row.wallet_address,
              lineItems: [],
              confidence: {
                vendor: 1,
                amount: 1,
                overall: 1,
              },
            },
            sourceDocument: {
              filename: args.filename,
              mimeType: args.mimeType,
              pageCount: extraction.pageCount,
              modelLatencyMs: extraction.modelLatencyMs,
              rowIndex: index,
            },
          },
        },
        initialState: triggeredRules.length ? 'needs_review' : 'draft',
        submitNow: triggeredRules.length ? false : Boolean(args.sourceTreasuryWalletId),
      });

      created.push({
        rowIndex: index,
        decision,
        triggeredRules,
        paymentOrder,
      });
    } catch (error) {
      skipped.push(buildSkippedRow(
        row,
        error instanceof RangeError ? 'invalid_amount' : 'creation_failed',
        error instanceof Error ? error.message : 'Payment order creation failed.',
      ));
    }
  }

  if (created.length === 0) {
    const detail = skipped.slice(0, 3).map((row) => `${row.counterparty}: ${row.message}`).join(' | ');
    logger.warn('invoice_intake.no_orders_created', {
      organizationId: args.organizationId,
      filename: args.filename,
      extractedRows: extraction.rows.length,
      skippedCount: skipped.length,
      skippedRows: skipped.slice(0, 10),
    });
    throw new Error(`Invoice upload did not create any payment orders.${detail ? ` ${detail}` : ''}`);
  }

  logger.info('invoice_intake.completed', {
    organizationId: args.organizationId,
    filename: args.filename,
    extractedRows: extraction.rows.length,
    createdCount: created.length,
    skippedCount: skipped.length,
    decisions: created.map((item) => ({
      paymentOrderId: item.paymentOrder.paymentOrderId,
      decision: item.decision,
      triggeredRules: item.triggeredRules.map((rule) => rule.rule),
    })),
  });

  return {
    inputSource: 'invoice_upload',
    filename: args.filename,
    modelLatencyMs: extraction.modelLatencyMs,
    pageCount: extraction.pageCount,
    extractedRows: extraction.rows,
    createdCount: created.length,
    skippedCount: skipped.length,
    primaryPaymentOrder: created[0]?.paymentOrder ?? null,
    paymentOrders: created,
    skippedRows: skipped,
  };
}

async function resolveInvoiceCounterpartyWallet(args: {
  organizationId: string;
  row: ExtractedRow;
  rowNumber: number;
}): Promise<(CounterpartyWallet & { counterparty: Counterparty | null }) | null> {
  const walletAddress = normalizeOptionalText(args.row.wallet_address);

  if (walletAddress && isValidSolanaWalletAddress(walletAddress)) {
    const byAddress = await prisma.counterpartyWallet.findFirst({
      where: {
        organizationId: args.organizationId,
        isActive: true,
        OR: [
          { walletAddress },
          { tokenAccountAddress: walletAddress },
        ],
      },
      include: { counterparty: true },
    });
    if (byAddress) return byAddress;

    return createInvoiceCounterpartyWalletFromAddress({
      organizationId: args.organizationId,
      walletAddress,
      labelFromInvoice: args.row.counterparty,
      rowNumber: args.rowNumber,
    });
  }

  const counterpartyName = normalizeOptionalText(args.row.counterparty);
  if (!counterpartyName) return null;

  return prisma.counterpartyWallet.findFirst({
    where: {
      organizationId: args.organizationId,
      isActive: true,
      OR: [
        { label: { equals: counterpartyName, mode: 'insensitive' } },
        { counterparty: { displayName: { equals: counterpartyName, mode: 'insensitive' } } },
        { label: { contains: counterpartyName, mode: 'insensitive' } },
        { counterparty: { displayName: { contains: counterpartyName, mode: 'insensitive' } } },
      ],
    },
    include: { counterparty: true },
  });
}

async function createInvoiceCounterpartyWalletFromAddress(args: {
  organizationId: string;
  walletAddress: string;
  labelFromInvoice: string | null;
  rowNumber: number;
}) {
  let tokenAccountAddress: string;
  try {
    tokenAccountAddress = deriveUsdcAtaForWallet(args.walletAddress);
  } catch {
    throw new Error(`Row ${args.rowNumber}: "${args.walletAddress}" is not a valid Solana wallet address`);
  }

  const label = normalizeOptionalText(args.labelFromInvoice) ?? shortenAddress(args.walletAddress);

  return prisma.$transaction(async (tx) => {
    const counterparty = await findOrCreateCounterparty(tx, args.organizationId, label);
    const existing = await tx.counterpartyWallet.findUnique({
      where: {
        organizationId_walletAddress: {
          organizationId: args.organizationId,
          walletAddress: args.walletAddress,
        },
      },
      include: { counterparty: true },
    });

    if (existing) {
      return tx.counterpartyWallet.update({
        where: { counterpartyWalletId: existing.counterpartyWalletId },
        data: {
          isActive: true,
          counterpartyId: existing.counterpartyId ?? counterparty.counterpartyId,
          tokenAccountAddress: existing.tokenAccountAddress ?? tokenAccountAddress,
          metadataJson: {
            ...(isRecordLike(existing.metadataJson) ? existing.metadataJson : {}),
            lastSeenInInvoiceUploadAt: new Date().toISOString(),
          },
        },
        include: { counterparty: true },
      });
    }

    return tx.counterpartyWallet.create({
      data: {
        organizationId: args.organizationId,
        counterpartyId: counterparty.counterpartyId,
        chain: SOLANA_CHAIN,
        asset: USDC_ASSET,
        walletAddress: args.walletAddress,
        tokenAccountAddress,
        walletType: 'invoice_imported',
        trustState: 'unreviewed',
        label,
        notes: 'Created from invoice upload. Human review is required before payment execution.',
        isInternal: false,
        isActive: true,
        metadataJson: {
          inputSource: 'invoice_upload',
          createdFromInvoiceUploadAt: new Date().toISOString(),
        },
      },
      include: { counterparty: true },
    });
  });
}

async function findOrCreateCounterparty(
  tx: Prisma.TransactionClient,
  organizationId: string,
  displayName: string,
) {
  const existing = await tx.counterparty.findFirst({
    where: {
      organizationId,
      displayName: { equals: displayName, mode: 'insensitive' },
    },
  });
  if (existing) return existing;

  return tx.counterparty.create({
    data: {
      organizationId,
      displayName,
      category: 'vendor',
      metadataJson: {
        inputSource: 'invoice_upload',
      },
    },
  });
}

function deriveReviewRules(args: {
  row: ExtractedRow;
  amountRaw: bigint;
  counterpartyWallet: Pick<CounterpartyWallet, 'trustState' | 'label' | 'walletAddress'> & { counterparty: Counterparty | null };
}) {
  const rules: Array<{ rule: string; reason: string }> = [];

  if (args.counterpartyWallet.trustState === 'unreviewed') {
    rules.push({
      rule: args.amountRaw > NEW_COUNTERPARTY_REVIEW_THRESHOLD_RAW
        ? 'new_counterparty_threshold'
        : 'unreviewed_counterparty',
      reason:
        args.amountRaw > NEW_COUNTERPARTY_REVIEW_THRESHOLD_RAW
          ? `New counterparty "${args.counterpartyWallet.label}" exceeds the $1000 review threshold.`
          : `Counterparty wallet "${args.counterpartyWallet.label}" has not been reviewed yet.`,
    });
  }

  if (args.counterpartyWallet.trustState === 'restricted') {
    rules.push({
      rule: 'restricted_counterparty',
      reason: `Counterparty wallet "${args.counterpartyWallet.label}" is restricted.`,
    });
  }

  const extractedWalletAddress = normalizeOptionalText(args.row.wallet_address);
  if (extractedWalletAddress && !isValidSolanaWalletAddress(extractedWalletAddress)) {
    rules.push({
      rule: 'invalid_extracted_wallet_address',
      reason:
        `Invoice wallet "${extractedWalletAddress}" is not a valid Solana base58 address. ` +
        `It may be OCR-confused and needs human review before proposal creation.`,
    });
  } else if (
    extractedWalletAddress
    && args.counterpartyWallet.counterparty
    && args.counterpartyWallet.walletAddress !== extractedWalletAddress
  ) {
    rules.push({
      rule: 'known_counterparty_wallet_changed',
      reason: `Invoice wallet ${shortenAddress(extractedWalletAddress)} differs from the matched wallet for ${args.counterpartyWallet.counterparty.displayName}.`,
    });
  }

  const confidence = args.row.source_invoice?.confidence;
  if (confidence && confidence.overall < LOW_CONFIDENCE_OVERALL_THRESHOLD) {
    rules.push({
      rule: 'low_extraction_confidence',
      reason: `Overall extraction confidence ${confidence.overall.toFixed(2)} below threshold ${LOW_CONFIDENCE_OVERALL_THRESHOLD}.`,
    });
  }

  if (confidence && confidence.amount < LOW_CONFIDENCE_AMOUNT_THRESHOLD) {
    rules.push({
      rule: 'amount_ambiguous',
      reason: `Amount confidence ${confidence.amount.toFixed(2)} below threshold ${LOW_CONFIDENCE_AMOUNT_THRESHOLD}.`,
    });
  }

  return rules;
}

function parseUsdcAmountToRaw(amount: number) {
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
  return normalized === 'USDC' || normalized === 'USD' || normalized === '$';
}

function buildSkippedRow(
  row: ExtractedRow,
  reason: InvoiceIntakeSkippedRow['reason'],
  message: string,
): InvoiceIntakeSkippedRow {
  return {
    counterparty: row.counterparty,
    amount: row.amount,
    currency: row.currency,
    reference: row.reference,
    walletAddress: normalizeOptionalText(row.wallet_address),
    reason,
    message,
  };
}

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isValidSolanaWalletAddress(value: string): boolean {
  try {
    deriveUsdcAtaForWallet(value);
    return true;
  } catch {
    return false;
  }
}

function shortenAddress(address: string) {
  return address.length <= 12 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
