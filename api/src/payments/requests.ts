import type { Counterparty, Destination, PaymentRequest, Prisma, User } from '@prisma/client';
import { createPaymentOrder, getPaymentOrderDetail } from './orders.js';
import { prisma } from '../infra/prisma.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET } from '../solana.js';

export const PAYMENT_REQUEST_STATES = [
  'submitted',
  'converted_to_order',
  'cancelled',
] as const;

export type PaymentRequestState = (typeof PAYMENT_REQUEST_STATES)[number];

type PaymentRequestWithRelations = PaymentRequest & {
  destination: Destination & { counterparty: Counterparty | null };
  counterparty: Counterparty | null;
  requestedByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  paymentOrder: { paymentOrderId: string; state: string; createdAt: Date } | null;
};

export function isPaymentRequestState(value: string): value is PaymentRequestState {
  return PAYMENT_REQUEST_STATES.includes(value as PaymentRequestState);
}

export async function listPaymentRequests(
  organizationId: string,
  options?: {
    limit?: number;
    state?: string;
  },
) {
  const requests = await prisma.paymentRequest.findMany({
    where: {
      organizationId,
      ...(options?.state ? { state: options.state } : {}),
    },
    include: paymentRequestInclude,
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return { items: requests.map(serializePaymentRequest) };
}

export async function getPaymentRequestDetail(organizationId: string, paymentRequestId: string) {
  const request = await prisma.paymentRequest.findFirstOrThrow({
    where: { organizationId, paymentRequestId },
    include: paymentRequestInclude,
  });

  return serializePaymentRequest(request);
}

export async function createPaymentRequest(args: {
  organizationId: string;
  actorUserId: string;
  paymentRunId?: string | null;
  destinationId: string;
  amountRaw: string | bigint;
  asset?: string;
  reason: string;
  externalReference?: string | null;
  dueAt?: Date | null;
  metadataJson?: Prisma.InputJsonValue;
  createOrderNow?: boolean;
  sourceTreasuryWalletId?: string | null;
  submitOrderNow?: boolean;
}) {
  const destination = await prisma.destination.findFirst({
    where: {
      organizationId: args.organizationId,
      destinationId: args.destinationId,
      isActive: true,
    },
    include: { counterparty: true },
  });

  if (!destination) {
    throw new Error('Destination not found');
  }

  if (destination.trustState === 'blocked') {
    throw new Error(`Destination "${destination.label}" is blocked and cannot receive payment requests`);
  }

  await enforceDuplicatePaymentRequest({
    organizationId: args.organizationId,
    destinationId: destination.destinationId,
    amountRaw: args.amountRaw,
    externalReference: normalizeOptionalText(args.externalReference),
  });

  const request = await prisma.paymentRequest.create({
    data: {
      organizationId: args.organizationId,
      paymentRunId: args.paymentRunId ?? null,
      destinationId: destination.destinationId,
      counterpartyId: destination.counterpartyId,
      requestedByUserId: args.actorUserId,
      amountRaw: BigInt(args.amountRaw),
      asset: args.asset ?? 'usdc',
      reason: normalizeRequiredText(args.reason, 'Reason is required'),
      externalReference: normalizeOptionalText(args.externalReference),
      dueAt: args.dueAt ?? undefined,
      metadataJson: (args.metadataJson ?? {}) as Prisma.InputJsonValue,
    },
    include: paymentRequestInclude,
  });

  if (!args.createOrderNow) {
    return serializePaymentRequest(request);
  }

  await promotePaymentRequestToOrder({
    organizationId: args.organizationId,
    paymentRequestId: request.paymentRequestId,
    actorUserId: args.actorUserId,
    paymentRunId: args.paymentRunId,
    sourceTreasuryWalletId: args.sourceTreasuryWalletId,
    submitNow: args.submitOrderNow ?? false,
  });

  return getPaymentRequestDetail(args.organizationId, request.paymentRequestId);
}

export async function promotePaymentRequestToOrder(args: {
  organizationId: string;
  paymentRequestId: string;
  actorUserId: string;
  paymentRunId?: string | null;
  sourceTreasuryWalletId?: string | null;
  submitNow?: boolean;
}) {
  const request = await prisma.paymentRequest.findFirstOrThrow({
    where: { organizationId: args.organizationId, paymentRequestId: args.paymentRequestId },
    include: paymentRequestInclude,
  });

  if (request.state === 'cancelled') {
    throw new Error('Cancelled payment requests cannot become payment orders');
  }

  if (request.paymentOrder) {
    return getPaymentOrderDetail(args.organizationId, request.paymentOrder.paymentOrderId);
  }

  const paymentOrder = await createPaymentOrder({
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    destinationId: request.destinationId,
    paymentRunId: args.paymentRunId ?? request.paymentRunId,
    sourceTreasuryWalletId: args.sourceTreasuryWalletId ?? null,
    amountRaw: request.amountRaw,
    asset: request.asset,
    memo: request.reason,
    externalReference: request.externalReference,
    invoiceNumber: getMetadataString(request.metadataJson, 'invoiceNumber'),
    attachmentUrl: getMetadataString(request.metadataJson, 'attachmentUrl'),
    dueAt: request.dueAt,
    sourceBalanceSnapshotJson: getMetadataRecord(request.metadataJson, 'sourceBalanceSnapshot') as Prisma.InputJsonValue | undefined,
    paymentRequestId: request.paymentRequestId,
    metadataJson: {
      paymentRequestId: request.paymentRequestId,
      paymentRunId: args.paymentRunId ?? request.paymentRunId,
      inputSource: 'payment_request',
    },
    submitNow: args.submitNow ?? false,
  });

  await prisma.paymentRequest.update({
    where: { paymentRequestId: request.paymentRequestId },
    data: { state: 'converted_to_order' },
  });

  return paymentOrder;
}

export async function cancelPaymentRequest(args: {
  organizationId: string;
  paymentRequestId: string;
}) {
  const request = await prisma.paymentRequest.findFirstOrThrow({
    where: { organizationId: args.organizationId, paymentRequestId: args.paymentRequestId },
    include: paymentRequestInclude,
  });

  if (request.paymentOrder) {
    throw new Error('Payment requests with a payment order cannot be cancelled directly');
  }

  const updated = await prisma.paymentRequest.update({
    where: { paymentRequestId: args.paymentRequestId },
    data: { state: 'cancelled' },
    include: paymentRequestInclude,
  });

  return serializePaymentRequest(updated);
}

export async function importPaymentRequestsFromCsv(args: {
  organizationId: string;
  actorUserId: string;
  csv: string;
  createOrderNow?: boolean;
  submitOrderNow?: boolean;
  sourceTreasuryWalletId?: string | null;
  paymentRunId?: string | null;
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
      const parsed = parsePaymentRequestCsvRecord(record);
      const importKey = buildCsvImportRowKey(parsed);
      const firstSeenRow = seenImportKeys.get(importKey);
      if (firstSeenRow) {
        throw new Error(`Duplicate CSV row. Same destination, amount, and reference already appeared on row ${firstSeenRow}`);
      }
      seenImportKeys.set(importKey, rowNumber);

      const destination = await resolveCsvDestination({
        organizationId: args.organizationId,
        destinationInput: parsed.destinationInput,
        counterpartyName: parsed.counterpartyName,
        rowNumber,
      });

      const paymentRequest = await createPaymentRequest({
        organizationId: args.organizationId,
        actorUserId: args.actorUserId,
        paymentRunId: args.paymentRunId,
        destinationId: destination.destinationId,
        amountRaw: parsed.amountRaw,
        asset: parsed.asset,
        reason: parsed.reason,
        externalReference: parsed.externalReference,
        dueAt: parsed.dueAt,
        createOrderNow: args.createOrderNow ?? true,
        submitOrderNow: args.submitOrderNow ?? false,
        sourceTreasuryWalletId: args.sourceTreasuryWalletId,
        metadataJson: {
          inputSource: 'csv_import',
          csvRowNumber: rowNumber,
          paymentRunId: args.paymentRunId ?? null,
          counterpartyName: parsed.counterpartyName,
        },
      });

      items.push({
        rowNumber,
        status: 'imported',
        paymentRequest,
      });
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

export async function previewPaymentRequestsCsv(args: {
  organizationId: string;
  csv: string;
}) {
  const rows = parseCsv(args.csv);
  if (!rows.length) {
    throw new Error('CSV import is empty');
  }

  const headers = rows[0].map((header) => normalizeHeader(header));
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => normalizeOptionalText(cell)));
  const seenImportKeys = new Map<string, number>();
  const items = [];

  for (const [index, row] of dataRows.entries()) {
    const rowNumber = index + 2;
    const record = Object.fromEntries(headers.map((header, cellIndex) => [header, row[cellIndex]?.trim() ?? '']));

    try {
      const parsed = parsePaymentRequestCsvRecord(record);
      const importKey = buildCsvImportRowKey(parsed);
      const duplicateRowNumber = seenImportKeys.get(importKey) ?? null;
      seenImportKeys.set(importKey, duplicateRowNumber ?? rowNumber);

      const resolution = await previewCsvDestination({
        organizationId: args.organizationId,
        destinationInput: parsed.destinationInput,
        counterpartyName: parsed.counterpartyName,
        rowNumber,
      });
      const duplicate = resolution.destination
        ? await findActivePaymentDuplicate({
            organizationId: args.organizationId,
            destinationId: resolution.destination.destinationId,
            amountRaw: parsed.amountRaw,
            externalReference: parsed.externalReference,
          })
        : null;
      const warnings = [
        duplicateRowNumber ? `Duplicate CSV row. Same destination, amount, and reference already appeared on row ${duplicateRowNumber}` : null,
        duplicate ? `Active ${duplicate.kind} with this destination, amount, and reference already exists` : null,
        resolution.wouldCreateDestination ? 'Destination wallet will be created as unreviewed and may require approval before execution' : null,
      ].filter((warning): warning is string => Boolean(warning));

      items.push({
        rowNumber,
        status: warnings.length ? 'warning' : 'ready',
        warnings,
        parsed: {
          counterpartyName: parsed.counterpartyName,
          destinationInput: parsed.destinationInput,
          amountRaw: parsed.amountRaw,
          asset: parsed.asset,
          externalReference: parsed.externalReference,
          reason: parsed.reason,
          dueAt: parsed.dueAt,
        },
        resolution,
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

const paymentRequestInclude = {
  destination: {
    include: {
      counterparty: true,
    },
  },
  counterparty: true,
  requestedByUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
    },
  },
  paymentOrder: {
    select: {
      paymentOrderId: true,
      state: true,
      createdAt: true,
    },
  },
} satisfies Prisma.PaymentRequestInclude;

async function resolveCsvDestination(args: {
  organizationId: string;
  destinationInput: string | null;
  counterpartyName: string | null;
  rowNumber: number;
}) {
  if (!args.destinationInput) {
    throw new Error(`Row ${args.rowNumber}: destination wallet address is required`);
  }

  const destination = await findDestinationForCsv(args.organizationId, args.destinationInput);
  if (destination) {
    return destination;
  }

  return createCsvDestinationFromWallet({
    organizationId: args.organizationId,
    walletAddress: args.destinationInput,
    labelFromCsv: args.counterpartyName,
    rowNumber: args.rowNumber,
  });
}

async function previewCsvDestination(args: {
  organizationId: string;
  destinationInput: string | null;
  counterpartyName: string | null;
  rowNumber: number;
}) {
  if (!args.destinationInput) {
    throw new Error(`Row ${args.rowNumber}: destination wallet address is required`);
  }

  const destination = await findDestinationForCsv(args.organizationId, args.destinationInput);
  if (destination) {
    return {
      destination: serializeDestination({ ...destination, counterparty: null }),
      wouldCreateDestination: false,
      walletAddress: destination.walletAddress,
      tokenAccountAddress: destination.tokenAccountAddress,
    };
  }

  let tokenAccountAddress: string;
  try {
    tokenAccountAddress = deriveUsdcAtaForWallet(args.destinationInput);
  } catch {
    throw new Error(`Row ${args.rowNumber}: destination not found and "${args.destinationInput}" is not a valid Solana wallet address`);
  }

  return {
    destination: null,
    wouldCreateDestination: true,
    walletAddress: args.destinationInput,
    tokenAccountAddress,
  };
}

async function findDestinationForCsv(organizationId: string, value: string) {
  const alternatives: Prisma.DestinationWhereInput[] = [
    { label: { equals: value, mode: 'insensitive' } },
    { walletAddress: value },
    { tokenAccountAddress: value },
  ];

  if (isUuid(value)) {
    alternatives.unshift({ destinationId: value });
  }

  return prisma.destination.findFirst({
    where: {
      organizationId,
      isActive: true,
      OR: alternatives,
    },
  });
}

function parsePaymentRequestCsvRecord(record: Record<string, string>) {
  const counterpartyName = normalizeOptionalText(
    record.counterparty ?? record.counterparty_name ?? record.vendor ?? record.name,
  );
  const destinationInput = normalizeOptionalText(record.destination ?? record.destination_id ?? record.wallet ?? record.wallet_address);
  const amountRaw = record.amount_raw ? BigInt(record.amount_raw).toString() : parseUsdcAmountToRaw(record.amount ?? record.amount_usdc);
  const externalReference = normalizeOptionalText(record.reference ?? record.invoice ?? record.invoice_number ?? record.external_reference);
  const reason = normalizeOptionalText(record.reason ?? record.memo)
    ?? [counterpartyName ? `Pay ${counterpartyName}` : 'Payment request', externalReference].filter(Boolean).join(' ');
  const dueAt = parseOptionalDate(record.due_date ?? record.due_at);

  if (!destinationInput) {
    throw new Error('Destination wallet address is required');
  }

  return {
    counterpartyName,
    destinationInput,
    amountRaw,
    asset: normalizeOptionalText(record.asset) ?? 'usdc',
    externalReference,
    reason,
    dueAt,
  };
}

function buildCsvImportRowKey(parsed: ReturnType<typeof parsePaymentRequestCsvRecord>) {
  return [
    parsed.destinationInput?.toLowerCase() ?? '',
    parsed.amountRaw,
    parsed.externalReference?.toLowerCase() ?? '',
  ].join('|');
}

async function findActivePaymentDuplicate(args: {
  organizationId: string;
  destinationId: string;
  amountRaw: string | bigint;
  externalReference: string | null;
}) {
  if (!args.externalReference) {
    return null;
  }

  const paymentRequest = await prisma.paymentRequest.findFirst({
    where: {
      organizationId: args.organizationId,
      destinationId: args.destinationId,
      amountRaw: BigInt(args.amountRaw),
      externalReference: {
        equals: args.externalReference,
        mode: 'insensitive',
      },
      state: 'submitted',
    },
    select: {
      paymentRequestId: true,
      state: true,
    },
  });
  if (paymentRequest) {
    return {
      kind: 'payment_request',
      id: paymentRequest.paymentRequestId,
      state: paymentRequest.state,
    };
  }

  const paymentOrder = await prisma.paymentOrder.findFirst({
    where: {
      organizationId: args.organizationId,
      destinationId: args.destinationId,
      amountRaw: BigInt(args.amountRaw),
      state: {
        notIn: ['closed', 'cancelled'],
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
  if (paymentOrder) {
    return {
      kind: 'payment_order',
      id: paymentOrder.paymentOrderId,
      state: paymentOrder.state,
    };
  }

  return null;
}

async function createCsvDestinationFromWallet(args: {
  organizationId: string;
  walletAddress: string;
  labelFromCsv: string | null;
  rowNumber: number;
}) {
  let usdcAtaAddress: string;
  try {
    usdcAtaAddress = deriveUsdcAtaForWallet(args.walletAddress);
  } catch {
    throw new Error(`Row ${args.rowNumber}: destination not found and "${args.walletAddress}" is not a valid Solana wallet address`);
  }

  const label = normalizeOptionalText(args.labelFromCsv) ?? shortenAddress(args.walletAddress);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.destination.findUnique({
      where: {
        organizationId_walletAddress: {
          organizationId: args.organizationId,
          walletAddress: args.walletAddress,
        },
      },
    });

    if (existing) {
      return tx.destination.update({
        where: { destinationId: existing.destinationId },
        data: {
          isActive: true,
          tokenAccountAddress: existing.tokenAccountAddress ?? usdcAtaAddress,
        },
      });
    }

    return tx.destination.create({
      data: {
        organizationId: args.organizationId,
        chain: SOLANA_CHAIN,
        asset: USDC_ASSET,
        walletAddress: args.walletAddress,
        tokenAccountAddress: usdcAtaAddress,
        destinationType: 'csv_imported',
        trustState: 'unreviewed',
        label,
        notes: 'Created from CSV payment request import. Review trust state before live execution.',
        isInternal: false,
        isActive: true,
        metadataJson: {
          inputSource: 'csv_import',
        },
      },
    });
  });
}

function serializePaymentRequest(request: PaymentRequestWithRelations) {
  return {
    paymentRequestId: request.paymentRequestId,
    organizationId: request.organizationId,
    paymentRunId: request.paymentRunId,
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
    destination: serializeDestination(request.destination),
    counterparty: request.counterparty ? serializeCounterparty(request.counterparty) : null,
    requestedByUser: serializeUserRef(request.requestedByUser),
    paymentOrder: request.paymentOrder
      ? {
          paymentOrderId: request.paymentOrder.paymentOrderId,
          state: request.paymentOrder.state,
          createdAt: request.paymentOrder.createdAt,
        }
      : null,
  };
}

function serializeDestination(destination: Destination & { counterparty: Counterparty | null }) {
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

function serializeUserRef(user: Pick<User, 'userId' | 'email' | 'displayName'> | null | undefined) {
  return user
    ? {
        userId: user.userId,
        email: user.email,
        displayName: user.displayName,
      }
    : null;
}

async function enforceDuplicatePaymentRequest(args: {
  organizationId: string;
  destinationId: string;
  amountRaw: string | bigint;
  externalReference: string | null;
}) {
  if (!args.externalReference) {
    return;
  }

  const duplicate = await prisma.paymentRequest.findFirst({
    where: {
      organizationId: args.organizationId,
      destinationId: args.destinationId,
      amountRaw: BigInt(args.amountRaw),
      externalReference: {
        equals: args.externalReference,
        mode: 'insensitive',
      },
      state: 'submitted',
    },
  });

  if (duplicate) {
    throw new Error(`Active payment request with reference "${args.externalReference}" already exists for this destination and amount`);
  }
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

function getMetadataString(value: unknown, key: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : null;
}

function getMetadataRecord(value: unknown, key: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  return candidate;
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function shortenAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}
