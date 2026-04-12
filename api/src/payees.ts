import type { Destination, Payee, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export type PayeeWithDestination = Payee & {
  defaultDestination: Destination | null;
};

const payeeInclude = {
  defaultDestination: true,
} satisfies Prisma.PayeeInclude;

export async function listPayees(
  workspaceId: string,
  options?: {
    limit?: number;
    status?: string;
  },
) {
  const payees = await prisma.payee.findMany({
    where: {
      workspaceId,
      ...(options?.status ? { status: options.status } : {}),
    },
    include: payeeInclude,
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return { items: payees.map(serializePayee) };
}

export async function getPayeeDetail(workspaceId: string, payeeId: string) {
  const payee = await prisma.payee.findFirstOrThrow({
    where: { workspaceId, payeeId },
    include: payeeInclude,
  });

  return serializePayee(payee);
}

export async function createPayee(args: {
  workspaceId: string;
  name: string;
  defaultDestinationId?: string | null;
  externalReference?: string | null;
  status?: string;
  notes?: string | null;
  metadataJson?: Prisma.InputJsonValue;
}) {
  const destination = args.defaultDestinationId
    ? await prisma.destination.findFirst({
        where: {
          workspaceId: args.workspaceId,
          destinationId: args.defaultDestinationId,
          isActive: true,
        },
      })
    : null;

  if (args.defaultDestinationId && !destination) {
    throw new Error('Default destination not found');
  }

  const payee = await prisma.payee.create({
    data: {
      workspaceId: args.workspaceId,
      defaultDestinationId: destination?.destinationId,
      name: normalizeRequiredText(args.name, 'Payee name is required'),
      externalReference: normalizeOptionalText(args.externalReference),
      status: args.status ?? 'active',
      notes: normalizeOptionalText(args.notes),
      metadataJson: (args.metadataJson ?? {}) as Prisma.InputJsonValue,
    },
    include: payeeInclude,
  });

  return serializePayee(payee);
}

export async function updatePayee(args: {
  workspaceId: string;
  payeeId: string;
  input: {
    name?: string;
    defaultDestinationId?: string | null;
    externalReference?: string | null;
    status?: string;
    notes?: string | null;
    metadataJson?: Prisma.InputJsonValue;
  };
}) {
  const current = await prisma.payee.findFirstOrThrow({
    where: { workspaceId: args.workspaceId, payeeId: args.payeeId },
  });

  const destination = args.input.defaultDestinationId
    ? await prisma.destination.findFirst({
        where: {
          workspaceId: args.workspaceId,
          destinationId: args.input.defaultDestinationId,
          isActive: true,
        },
      })
    : null;

  if (args.input.defaultDestinationId && !destination) {
    throw new Error('Default destination not found');
  }

  const nextMetadata = {
    ...(isRecordLike(current.metadataJson) ? current.metadataJson : {}),
    ...(isRecordLike(args.input.metadataJson) ? args.input.metadataJson : {}),
  };

  const payee = await prisma.payee.update({
    where: { payeeId: current.payeeId },
    data: {
      name: args.input.name === undefined ? undefined : normalizeRequiredText(args.input.name, 'Payee name is required'),
      defaultDestinationId:
        args.input.defaultDestinationId === undefined
          ? undefined
          : destination?.destinationId ?? null,
      externalReference:
        args.input.externalReference === undefined ? undefined : normalizeOptionalText(args.input.externalReference),
      status: args.input.status,
      notes: args.input.notes === undefined ? undefined : normalizeOptionalText(args.input.notes),
      metadataJson: args.input.metadataJson === undefined ? undefined : nextMetadata as Prisma.InputJsonValue,
    },
    include: payeeInclude,
  });

  return serializePayee(payee);
}

export function serializePayee(payee: PayeeWithDestination) {
  return {
    payeeId: payee.payeeId,
    workspaceId: payee.workspaceId,
    defaultDestinationId: payee.defaultDestinationId,
    name: payee.name,
    externalReference: payee.externalReference,
    status: payee.status,
    notes: payee.notes,
    metadataJson: payee.metadataJson,
    createdAt: payee.createdAt,
    updatedAt: payee.updatedAt,
    defaultDestination: payee.defaultDestination ? {
      destinationId: payee.defaultDestination.destinationId,
      label: payee.defaultDestination.label,
      walletAddress: payee.defaultDestination.walletAddress,
      tokenAccountAddress: payee.defaultDestination.tokenAccountAddress,
      trustState: payee.defaultDestination.trustState,
      isActive: payee.defaultDestination.isActive,
    } : null,
  };
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

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
