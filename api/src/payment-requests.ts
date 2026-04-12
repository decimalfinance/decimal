import type { Counterparty, Destination, Payee, PaymentRequest, Prisma, User } from '@prisma/client';
import { createPaymentOrder, getPaymentOrderDetail } from './payment-orders.js';
import { serializePayee } from './payees.js';
import { prisma } from './prisma.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET } from './solana.js';

export const PAYMENT_REQUEST_STATES = [
  'submitted',
  'converted_to_order',
  'cancelled',
] as const;

export type PaymentRequestState = (typeof PAYMENT_REQUEST_STATES)[number];

type PaymentRequestWithRelations = PaymentRequest & {
  payee: (Payee & { defaultDestination: Destination | null }) | null;
  destination: Destination & { counterparty: Counterparty | null };
  counterparty: Counterparty | null;
  requestedByUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  paymentOrder: { paymentOrderId: string; state: string; createdAt: Date } | null;
};

export function isPaymentRequestState(value: string): value is PaymentRequestState {
  return PAYMENT_REQUEST_STATES.includes(value as PaymentRequestState);
}

export async function listPaymentRequests(
  workspaceId: string,
  options?: {
    limit?: number;
    state?: string;
  },
) {
  const requests = await prisma.paymentRequest.findMany({
    where: {
      workspaceId,
      ...(options?.state ? { state: options.state } : {}),
    },
    include: paymentRequestInclude,
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return { items: requests.map(serializePaymentRequest) };
}

export async function getPaymentRequestDetail(workspaceId: string, paymentRequestId: string) {
  const request = await prisma.paymentRequest.findFirstOrThrow({
    where: { workspaceId, paymentRequestId },
    include: paymentRequestInclude,
  });

  return serializePaymentRequest(request);
}

export async function createPaymentRequest(args: {
  workspaceId: string;
  actorUserId: string;
  payeeId?: string | null;
  destinationId: string;
  amountRaw: string | bigint;
  asset?: string;
  reason: string;
  externalReference?: string | null;
  dueAt?: Date | null;
  metadataJson?: Prisma.InputJsonValue;
  createOrderNow?: boolean;
  sourceWorkspaceAddressId?: string | null;
  submitOrderNow?: boolean;
}) {
  const destination = await prisma.destination.findFirst({
    where: {
      workspaceId: args.workspaceId,
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
    workspaceId: args.workspaceId,
    destinationId: destination.destinationId,
    amountRaw: args.amountRaw,
    externalReference: normalizeOptionalText(args.externalReference),
  });

  const request = await prisma.paymentRequest.create({
    data: {
      workspaceId: args.workspaceId,
      payeeId: args.payeeId ?? null,
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
    workspaceId: args.workspaceId,
    paymentRequestId: request.paymentRequestId,
    actorUserId: args.actorUserId,
    sourceWorkspaceAddressId: args.sourceWorkspaceAddressId,
    submitNow: args.submitOrderNow ?? false,
  });

  return getPaymentRequestDetail(args.workspaceId, request.paymentRequestId);
}

export async function promotePaymentRequestToOrder(args: {
  workspaceId: string;
  paymentRequestId: string;
  actorUserId: string;
  sourceWorkspaceAddressId?: string | null;
  submitNow?: boolean;
}) {
  const request = await prisma.paymentRequest.findFirstOrThrow({
    where: { workspaceId: args.workspaceId, paymentRequestId: args.paymentRequestId },
    include: paymentRequestInclude,
  });

  if (request.state === 'cancelled') {
    throw new Error('Cancelled payment requests cannot become payment orders');
  }

  if (request.paymentOrder) {
    return getPaymentOrderDetail(args.workspaceId, request.paymentOrder.paymentOrderId);
  }

  const paymentOrder = await createPaymentOrder({
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    destinationId: request.destinationId,
    payeeId: request.payeeId,
    sourceWorkspaceAddressId: args.sourceWorkspaceAddressId ?? null,
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
      inputSource: 'payment_request',
      payeeId: request.payeeId,
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
  workspaceId: string;
  paymentRequestId: string;
}) {
  const request = await prisma.paymentRequest.findFirstOrThrow({
    where: { workspaceId: args.workspaceId, paymentRequestId: args.paymentRequestId },
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
  workspaceId: string;
  actorUserId: string;
  csv: string;
  createOrderNow?: boolean;
  submitOrderNow?: boolean;
  sourceWorkspaceAddressId?: string | null;
}) {
  const rows = parseCsv(args.csv);
  if (!rows.length) {
    throw new Error('CSV import is empty');
  }

  const headers = rows[0].map((header) => normalizeHeader(header));
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => normalizeOptionalText(cell)));
  const items = [];

  for (const [index, row] of dataRows.entries()) {
    const rowNumber = index + 2;
    const record = Object.fromEntries(headers.map((header, cellIndex) => [header, row[cellIndex]?.trim() ?? '']));

    try {
      const payeeName = normalizeOptionalText(record.payee ?? record.payee_name ?? record.vendor ?? record.name);
      const destinationInput = normalizeOptionalText(record.destination ?? record.destination_id ?? record.wallet ?? record.wallet_address);
      const amountRaw = record.amount_raw ? BigInt(record.amount_raw).toString() : parseUsdcAmountToRaw(record.amount ?? record.amount_usdc);
      const externalReference = normalizeOptionalText(record.reference ?? record.invoice ?? record.invoice_number ?? record.external_reference);
      const reason = normalizeOptionalText(record.reason ?? record.memo)
        ?? [payeeName ? `Pay ${payeeName}` : 'Payment request', externalReference].filter(Boolean).join(' ');
      const dueAt = parseOptionalDate(record.due_date ?? record.due_at);

      if (!payeeName && !destinationInput) {
        throw new Error('Provide payee or destination');
      }

      const { payee, destination } = await resolveCsvPayeeDestination({
        workspaceId: args.workspaceId,
        payeeName,
        destinationInput,
        rowNumber,
      });

      const paymentRequest = await createPaymentRequest({
        workspaceId: args.workspaceId,
        actorUserId: args.actorUserId,
        payeeId: payee?.payeeId,
        destinationId: destination.destinationId,
        amountRaw,
        asset: normalizeOptionalText(record.asset) ?? 'usdc',
        reason,
        externalReference,
        dueAt,
        createOrderNow: args.createOrderNow ?? true,
        submitOrderNow: args.submitOrderNow ?? false,
        sourceWorkspaceAddressId: args.sourceWorkspaceAddressId,
        metadataJson: {
          inputSource: 'csv_import',
          csvRowNumber: rowNumber,
          payeeName,
        },
      });

      items.push({
        rowNumber,
        status: 'imported',
        payee: payee ? serializePayee(payee) : null,
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

const paymentRequestInclude = {
  payee: {
    include: {
      defaultDestination: true,
    },
  },
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

async function resolveCsvPayeeDestination(args: {
  workspaceId: string;
  payeeName: string | null;
  destinationInput: string | null;
  rowNumber: number;
}) {
  const payee = args.payeeName
    ? await prisma.payee.findFirst({
        where: {
          workspaceId: args.workspaceId,
          name: { equals: args.payeeName, mode: 'insensitive' },
          status: 'active',
        },
        include: { defaultDestination: true },
      })
    : null;

  const destination = args.destinationInput
    ? await findDestinationForCsv(args.workspaceId, args.destinationInput)
    : payee?.defaultDestination ?? null;

  const resolvedDestination = destination
    ?? (args.destinationInput
      ? await createCsvDestinationFromWallet({
          workspaceId: args.workspaceId,
          walletAddress: args.destinationInput,
          payeeName: args.payeeName,
          rowNumber: args.rowNumber,
        })
      : null);

  if (!resolvedDestination) {
    throw new Error(`Row ${args.rowNumber}: destination not found`);
  }

  if (!payee && args.payeeName) {
    const createdPayee = await prisma.payee.create({
      data: {
        workspaceId: args.workspaceId,
        name: args.payeeName,
        defaultDestinationId: resolvedDestination.destinationId,
        metadataJson: {
          inputSource: 'csv_import',
        },
      },
      include: { defaultDestination: true },
    });

    return { payee: createdPayee, destination: resolvedDestination };
  }

  if (payee && !payee.defaultDestinationId && resolvedDestination) {
    const updatedPayee = await prisma.payee.update({
      where: { payeeId: payee.payeeId },
      data: { defaultDestinationId: resolvedDestination.destinationId },
      include: { defaultDestination: true },
    });
    return { payee: updatedPayee, destination: resolvedDestination };
  }

  return { payee, destination: resolvedDestination };
}

async function findDestinationForCsv(workspaceId: string, value: string) {
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
      workspaceId,
      isActive: true,
      OR: alternatives,
    },
  });
}

async function createCsvDestinationFromWallet(args: {
  workspaceId: string;
  walletAddress: string;
  payeeName: string | null;
  rowNumber: number;
}) {
  let usdcAtaAddress: string;
  try {
    usdcAtaAddress = deriveUsdcAtaForWallet(args.walletAddress);
  } catch {
    throw new Error(`Row ${args.rowNumber}: destination not found and "${args.walletAddress}" is not a valid Solana wallet address`);
  }

  const label = normalizeOptionalText(args.payeeName) ?? shortenAddress(args.walletAddress);

  return prisma.$transaction(async (tx) => {
    const workspaceAddress = await tx.workspaceAddress.upsert({
      where: {
        workspaceId_address: {
          workspaceId: args.workspaceId,
          address: args.walletAddress,
        },
      },
      create: {
        workspaceId: args.workspaceId,
        chain: SOLANA_CHAIN,
        address: args.walletAddress,
        addressKind: 'wallet',
        assetScope: USDC_ASSET,
        usdcAtaAddress,
        source: 'csv_import',
        displayName: `${label} wallet`,
        propertiesJson: {
          usdcAtaAddress,
          inputSource: 'csv_import',
        },
      },
      update: {
        isActive: true,
        usdcAtaAddress,
        propertiesJson: {
          usdcAtaAddress,
          inputSource: 'csv_import',
        },
      },
    });

    return tx.destination.upsert({
      where: {
        workspaceId_linkedWorkspaceAddressId: {
          workspaceId: args.workspaceId,
          linkedWorkspaceAddressId: workspaceAddress.workspaceAddressId,
        },
      },
      create: {
        workspaceId: args.workspaceId,
        linkedWorkspaceAddressId: workspaceAddress.workspaceAddressId,
        chain: workspaceAddress.chain,
        asset: workspaceAddress.assetScope,
        walletAddress: workspaceAddress.address,
        tokenAccountAddress: workspaceAddress.usdcAtaAddress,
        destinationType: 'csv_payee_wallet',
        trustState: 'unreviewed',
        label,
        notes: 'Created from CSV payment request import. Review trust state before live execution.',
        isInternal: false,
        isActive: true,
        metadataJson: {
          inputSource: 'csv_import',
        },
      },
      update: {
        isActive: true,
        chain: workspaceAddress.chain,
        asset: workspaceAddress.assetScope,
        walletAddress: workspaceAddress.address,
        tokenAccountAddress: workspaceAddress.usdcAtaAddress,
      },
    });
  });
}

function serializePaymentRequest(request: PaymentRequestWithRelations) {
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
    payee: request.payee ? serializePayee(request.payee) : null,
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
    linkedWorkspaceAddress: null,
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
  workspaceId: string;
  destinationId: string;
  amountRaw: string | bigint;
  externalReference: string | null;
}) {
  if (!args.externalReference) {
    return;
  }

  const duplicate = await prisma.paymentRequest.findFirst({
    where: {
      workspaceId: args.workspaceId,
      destinationId: args.destinationId,
      amountRaw: BigInt(args.amountRaw),
      externalReference: {
        equals: args.externalReference,
        mode: 'insensitive',
      },
      state: {
        not: 'cancelled',
      },
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
