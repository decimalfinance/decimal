import crypto from 'node:crypto';
import type { Counterparty, CounterpartyWallet, Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET } from '../solana.js';
import { createPaymentOrder } from './orders.js';

export type BatchCsvImportResult = Awaited<ReturnType<typeof importPaymentOrdersFromCsv>>;

type ParsedPaymentCsvRecord = ReturnType<typeof parsePaymentCsvRecord>;
type SerializedCounterpartyWallet = ReturnType<typeof serializeCounterpartyWalletShallow>;
type ResolvedCsvItem =
  | {
      rowNumber: number;
      status: 'ready' | 'warning';
      warnings: string[];
      parsed: ParsedPaymentCsvRecord;
      counterpartyWallet: SerializedCounterpartyWallet;
    }
  | {
      rowNumber: number;
      status: 'failed';
      error: string;
    };
type ImportedCsvItem =
  | {
      rowNumber: number;
      status: 'imported';
      inputBatchId: string;
      inputBatchLabel: string;
      decision: 'drafted' | 'needs_review';
      counterpartyWallet: SerializedCounterpartyWallet;
      paymentOrder: Awaited<ReturnType<typeof createPaymentOrder>>;
    }
  | {
      rowNumber: number;
      status: 'failed';
      error: string;
    };

export async function importPaymentOrdersFromCsv(args: {
  organizationId: string;
  actorUserId: string;
  csv: string;
  sourceTreasuryWalletId?: string | null;
  batchLabel?: string | null;
}) {
  const parsedRows = await parseAndResolvePaymentCsv(args.organizationId, args.csv);
  const inputBatchId = crypto.randomUUID();
  const inputBatchLabel = normalizeOptionalText(args.batchLabel) ?? `CSV import ${new Date().toISOString()}`;
  const items: ImportedCsvItem[] = [];

  for (const item of parsedRows.items) {
    if (item.status === 'failed') {
      items.push(item);
      continue;
    }

    try {
      const needsReview = item.counterpartyWallet.trustState !== 'trusted';
      const paymentOrder = await createPaymentOrder({
        organizationId: args.organizationId,
        actorUserId: args.actorUserId,
        counterpartyWalletId: item.counterpartyWallet.counterpartyWalletId,
        sourceTreasuryWalletId: args.sourceTreasuryWalletId ?? null,
        amountRaw: item.parsed.amountRaw,
        asset: item.parsed.asset,
        memo: item.parsed.reason,
        externalReference: item.parsed.externalReference,
        invoiceNumber: item.parsed.externalReference,
        dueAt: item.parsed.dueAt,
        inputBatchId,
        inputBatchLabel,
        metadataJson: {
          inputSource: 'csv_import',
          csvRowNumber: item.rowNumber,
          inputBatchId,
          inputBatchLabel,
          counterpartyName: item.parsed.counterpartyName,
        },
        initialState: needsReview ? 'needs_review' : 'draft',
      });

      items.push({
        rowNumber: item.rowNumber,
        status: 'imported' as const,
        inputBatchId,
        inputBatchLabel,
        decision: needsReview ? 'needs_review' : 'drafted',
        counterpartyWallet: item.counterpartyWallet,
        paymentOrder,
      });
    } catch (error) {
      items.push({
        rowNumber: item.rowNumber,
        status: 'failed' as const,
        error: error instanceof Error ? error.message : 'Payment order creation failed',
      });
    }
  }

  const paymentOrders = items.filter((item): item is Extract<typeof items[number], { status: 'imported' }> => item.status === 'imported');
  return {
    inputSource: 'csv_import',
    inputBatchId,
    inputBatchLabel,
    imported: paymentOrders.length,
    failed: items.filter((item) => item.status === 'failed').length,
    paymentOrders,
    items,
  };
}

export async function previewPaymentOrdersCsv(args: {
  organizationId: string;
  csv: string;
}) {
  const parsedRows = await parseAndResolvePaymentCsv(args.organizationId, args.csv, { previewOnly: true });
  return {
    totalRows: parsedRows.items.length,
    ready: parsedRows.items.filter((item) => item.status === 'ready').length,
    warnings: parsedRows.items.filter((item) => item.status === 'warning').length,
    failed: parsedRows.items.filter((item) => item.status === 'failed').length,
    canImport: parsedRows.items.every((item) => item.status !== 'failed'),
    items: parsedRows.items,
  };
}

async function parseAndResolvePaymentCsv(
  organizationId: string,
  csv: string,
  options: { previewOnly?: boolean } = {},
): Promise<{ items: ResolvedCsvItem[] }> {
  const rows = parseCsv(csv);
  if (!rows.length) {
    throw new Error('CSV import is empty');
  }

  const headers = rows[0].map((header) => normalizeHeader(header));
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => normalizeOptionalText(cell)));
  const seenImportKeys = new Map<string, number>();
  const items: ResolvedCsvItem[] = [];

  for (const [index, row] of dataRows.entries()) {
    const rowNumber = index + 2;
    const record = Object.fromEntries(headers.map((header, cellIndex) => [header, row[cellIndex]?.trim() ?? '']));

    try {
      const parsed = parsePaymentCsvRecord(record);
      const importKey = buildCsvImportRowKey(parsed);
      const duplicateRowNumber = seenImportKeys.get(importKey) ?? null;
      if (duplicateRowNumber && !options.previewOnly) {
        throw new Error(`Duplicate CSV row. Same destination, amount, and reference already appeared on row ${duplicateRowNumber}`);
      }
      seenImportKeys.set(importKey, duplicateRowNumber ?? rowNumber);

      const counterpartyWallet = await resolveCsvCounterpartyWallet({
        organizationId,
        destinationInput: parsed.destinationInput,
        counterpartyName: parsed.counterpartyName,
        rowNumber,
        createIfMissing: !options.previewOnly,
      });
      const duplicate = counterpartyWallet
        ? await findActivePaymentDuplicate({
            organizationId,
            counterpartyWalletId: counterpartyWallet.counterpartyWalletId,
            amountRaw: parsed.amountRaw,
            externalReference: parsed.externalReference,
          })
        : null;
      const warnings = [
        duplicateRowNumber ? `Duplicate CSV row. Same destination, amount, and reference already appeared on row ${duplicateRowNumber}` : null,
        duplicate ? `Active payment order with this destination, amount, and reference exists` : null,
        counterpartyWallet && counterpartyWallet.trustState !== 'trusted'
          ? 'Counterparty wallet needs review before execution'
          : null,
      ].filter((warning): warning is string => Boolean(warning));

      items.push({
        rowNumber,
        status: warnings.length ? 'warning' as const : 'ready' as const,
        warnings,
        parsed,
        counterpartyWallet: serializeCounterpartyWalletShallow(counterpartyWallet),
      });
    } catch (error) {
      items.push({
        rowNumber,
        status: 'failed' as const,
        error: error instanceof Error ? error.message : 'CSV row is invalid',
      });
    }
  }

  return { items };
}

async function resolveCsvCounterpartyWallet(args: {
  organizationId: string;
  destinationInput: string | null;
  counterpartyName: string | null;
  rowNumber: number;
  createIfMissing: boolean;
}) {
  if (!args.destinationInput) {
    throw new Error(`Row ${args.rowNumber}: destination wallet address is required`);
  }

  const counterpartyWallet = await findCounterpartyWalletForCsv(args.organizationId, args.destinationInput);
  if (counterpartyWallet) {
    return counterpartyWallet;
  }

  if (!args.createIfMissing) {
    const tokenAccountAddress = deriveUsdcAtaForWallet(args.destinationInput);
    return {
      counterpartyWalletId: 'preview',
      organizationId: args.organizationId,
      counterpartyId: null,
      chain: SOLANA_CHAIN,
      asset: USDC_ASSET,
      walletAddress: args.destinationInput,
      tokenAccountAddress,
      walletType: 'csv_imported',
      trustState: 'unreviewed',
      label: normalizeOptionalText(args.counterpartyName) ?? shortenAddress(args.destinationInput),
      notes: null,
      isInternal: false,
      isActive: true,
      metadataJson: { inputSource: 'csv_import_preview' },
      createdAt: new Date(),
      updatedAt: new Date(),
      counterparty: null,
    } satisfies CounterpartyWallet & { counterparty: Counterparty | null };
  }

  return createCsvCounterpartyWalletFromAddress({
    organizationId: args.organizationId,
    walletAddress: args.destinationInput,
    labelFromCsv: args.counterpartyName,
    rowNumber: args.rowNumber,
  });
}

async function findCounterpartyWalletForCsv(organizationId: string, value: string) {
  const alternatives: Prisma.CounterpartyWalletWhereInput[] = [
    { label: { equals: value, mode: 'insensitive' } },
    { walletAddress: value },
    { tokenAccountAddress: value },
  ];

  if (isUuid(value)) {
    alternatives.unshift({ counterpartyWalletId: value });
  }

  return prisma.counterpartyWallet.findFirst({
    where: {
      organizationId,
      isActive: true,
      OR: alternatives,
    },
    include: { counterparty: true },
  });
}

async function createCsvCounterpartyWalletFromAddress(args: {
  organizationId: string;
  walletAddress: string;
  labelFromCsv: string | null;
  rowNumber: number;
}) {
  let usdcAtaAddress: string;
  try {
    usdcAtaAddress = deriveUsdcAtaForWallet(args.walletAddress);
  } catch {
    throw new Error(`Row ${args.rowNumber}: counterparty wallet not found and "${args.walletAddress}" is not a valid Solana wallet address`);
  }

  const label = normalizeOptionalText(args.labelFromCsv) ?? shortenAddress(args.walletAddress);
  return prisma.$transaction(async (tx) => {
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
          tokenAccountAddress: existing.tokenAccountAddress ?? usdcAtaAddress,
        },
        include: { counterparty: true },
      });
    }

    return tx.counterpartyWallet.create({
      data: {
        organizationId: args.organizationId,
        chain: SOLANA_CHAIN,
        asset: USDC_ASSET,
        walletAddress: args.walletAddress,
        tokenAccountAddress: usdcAtaAddress,
        walletType: 'csv_imported',
        trustState: 'unreviewed',
        label,
        notes: 'Created from CSV payment import. Review trust state before live execution.',
        isInternal: false,
        isActive: true,
        metadataJson: {
          inputSource: 'csv_import',
        },
      },
      include: { counterparty: true },
    });
  });
}

function parsePaymentCsvRecord(record: Record<string, string>) {
  const counterpartyName = normalizeOptionalText(
    record.counterparty ?? record.counterparty_name ?? record.vendor ?? record.name ?? record.payee,
  );
  const destinationInput = normalizeOptionalText(record.destination ?? record.destination_id ?? record.wallet ?? record.wallet_address);
  const amountRaw = record.amount_raw ? BigInt(record.amount_raw).toString() : parseUsdcAmountToRaw(record.amount ?? record.amount_usdc);
  const externalReference = normalizeOptionalText(record.reference ?? record.invoice ?? record.invoice_number ?? record.external_reference);
  const reason = normalizeOptionalText(record.reason ?? record.memo)
    ?? [counterpartyName ? `Pay ${counterpartyName}` : 'Payment', externalReference].filter(Boolean).join(' ');
  const dueAt = parseOptionalDate(record.due_date ?? record.due_at);

  if (!destinationInput) {
    throw new Error('Destination wallet address is required');
  }

  return {
    counterpartyName,
    destinationInput,
    amountRaw,
    asset: normalizeOptionalText(record.asset) ?? USDC_ASSET,
    externalReference,
    reason,
    dueAt,
  };
}

function buildCsvImportRowKey(parsed: ReturnType<typeof parsePaymentCsvRecord>) {
  return [
    parsed.destinationInput?.toLowerCase() ?? '',
    parsed.amountRaw,
    parsed.externalReference?.toLowerCase() ?? '',
  ].join('|');
}

async function findActivePaymentDuplicate(args: {
  organizationId: string;
  counterpartyWalletId: string;
  amountRaw: string | bigint;
  externalReference: string | null;
}) {
  if (!args.externalReference || args.counterpartyWalletId === 'preview') {
    return null;
  }

  return prisma.paymentOrder.findFirst({
    where: {
      organizationId: args.organizationId,
      counterpartyWalletId: args.counterpartyWalletId,
      amountRaw: BigInt(args.amountRaw),
      state: {
        notIn: ['settled', 'cancelled'],
      },
      OR: [
        { externalReference: { equals: args.externalReference, mode: 'insensitive' } },
        { invoiceNumber: { equals: args.externalReference, mode: 'insensitive' } },
      ],
    },
    select: {
      paymentOrderId: true,
      state: true,
    },
  });
}

function serializeCounterpartyWalletShallow(wallet: CounterpartyWallet & { counterparty: Counterparty | null }) {
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
    counterparty: wallet.counterparty ? {
      counterpartyId: wallet.counterparty.counterpartyId,
      displayName: wallet.counterparty.displayName,
    } : null,
  };
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replaceAll(/\s+/g, '_');
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

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
}

function shortenAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
