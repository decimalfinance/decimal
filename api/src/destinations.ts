import type { Counterparty, Destination, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET } from './solana.js';

export type CreateCounterpartyInput = {
  displayName: string;
  category?: string;
  externalReference?: string | null;
  status?: string;
  metadataJson?: Prisma.InputJsonValue;
};

export type UpdateCounterpartyInput = {
  displayName?: string;
  category?: string;
  externalReference?: string | null;
  status?: string;
};

export type CreateDestinationInput = {
  counterpartyId?: string | null;
  chain?: 'solana';
  asset?: 'usdc';
  walletAddress: string;
  tokenAccountAddress?: string | null;
  destinationType?: string;
  trustState?: 'unreviewed' | 'trusted' | 'restricted' | 'blocked';
  label: string;
  notes?: string | null;
  isInternal?: boolean;
  isActive?: boolean;
  metadataJson?: Prisma.InputJsonValue;
};

export type UpdateDestinationInput = {
  counterpartyId?: string | null;
  walletAddress?: string;
  tokenAccountAddress?: string | null;
  destinationType?: string;
  trustState?: 'unreviewed' | 'trusted' | 'restricted' | 'blocked';
  label?: string;
  notes?: string | null;
  isInternal?: boolean;
  isActive?: boolean;
};

export async function listCounterparties(workspaceId: string, options?: { limit?: number }) {
  const workspace = await getWorkspaceOrg(workspaceId);
  const items = await prisma.counterparty.findMany({
    where: { organizationId: workspace.organizationId },
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return { items: items.map(serializeCounterparty) };
}

export async function createCounterparty(workspaceId: string, input: CreateCounterpartyInput) {
  const workspace = await getWorkspaceOrg(workspaceId);
  await assertCounterpartyNameAvailable(workspace.organizationId, input.displayName);

  const counterparty = await prisma.counterparty.create({
    data: {
      organizationId: workspace.organizationId,
      displayName: input.displayName,
      category: input.category ?? 'vendor',
      externalReference: normalizeOptionalText(input.externalReference),
      status: input.status ?? 'active',
      metadataJson: (input.metadataJson ?? {}) as Prisma.InputJsonValue,
    },
  });

  return serializeCounterparty(counterparty);
}

export async function updateCounterparty(workspaceId: string, counterpartyId: string, input: UpdateCounterpartyInput) {
  const workspace = await getWorkspaceOrg(workspaceId);
  const current = await prisma.counterparty.findFirst({
    where: {
      counterpartyId,
      organizationId: workspace.organizationId,
    },
  });

  if (!current) {
    throw new Error('Counterparty not found');
  }

  const nextDisplayName = input.displayName?.trim() || current.displayName;
  await assertCounterpartyNameAvailable(workspace.organizationId, nextDisplayName, counterpartyId);

  const updated = await prisma.counterparty.update({
    where: { counterpartyId },
    data: {
      displayName: input.displayName,
      category: input.category,
      externalReference: input.externalReference !== undefined ? normalizeOptionalText(input.externalReference) : undefined,
      status: input.status,
    },
  });

  return serializeCounterparty(updated);
}

export async function listDestinations(workspaceId: string, options?: { limit?: number; includeInternal?: boolean }) {
  const items = await prisma.destination.findMany({
    where: {
      workspaceId,
      ...(options?.includeInternal ? {} : { isInternal: false }),
    },
    include: {
      counterparty: true,
    },
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return { items: items.map(serializeDestination) };
}

export async function createDestination(workspaceId: string, input: CreateDestinationInput) {
  const workspace = await getWorkspaceOrg(workspaceId);

  if (input.counterpartyId) {
    await assertCounterpartyBelongsToOrg(workspace.organizationId, input.counterpartyId);
  }

  await assertDestinationLabelAvailable(workspaceId, input.label);
  await assertDestinationWalletAvailable(workspaceId, input.walletAddress);
  const tokenAccountAddress = normalizeOptionalText(input.tokenAccountAddress) ?? deriveUsdcAtaForWallet(input.walletAddress);

  const destination = await prisma.destination.create({
    data: {
      workspaceId,
      counterpartyId: input.counterpartyId,
      chain: input.chain ?? SOLANA_CHAIN,
      asset: input.asset ?? USDC_ASSET,
      walletAddress: input.walletAddress,
      tokenAccountAddress,
      destinationType: input.destinationType ?? 'wallet',
      trustState: input.trustState ?? 'unreviewed',
      label: input.label,
      notes: normalizeOptionalText(input.notes),
      isInternal: input.isInternal ?? false,
      isActive: input.isActive ?? true,
      metadataJson: (input.metadataJson ?? {}) as Prisma.InputJsonValue,
    },
    include: {
      counterparty: true,
    },
  });

  return serializeDestination(destination);
}

export async function updateDestination(workspaceId: string, destinationId: string, input: UpdateDestinationInput) {
  const [workspace, current] = await Promise.all([
    getWorkspaceOrg(workspaceId),
    prisma.destination.findFirstOrThrow({
      where: { workspaceId, destinationId },
    }),
  ]);

  if (input.counterpartyId) {
    await assertCounterpartyBelongsToOrg(workspace.organizationId, input.counterpartyId);
  }

  const nextLabel = input.label?.trim() || current.label;
  await assertDestinationLabelAvailable(workspaceId, nextLabel, destinationId);

  const nextWalletAddress = input.walletAddress?.trim();
  if (nextWalletAddress && nextWalletAddress !== current.walletAddress) {
    await assertDestinationWalletAvailable(workspaceId, nextWalletAddress, destinationId);
  }
  const shouldUpdateTokenAccount = input.tokenAccountAddress !== undefined || Boolean(nextWalletAddress);
  const tokenAccountAddress = shouldUpdateTokenAccount
    ? normalizeOptionalText(input.tokenAccountAddress)
      ?? deriveUsdcAtaForWallet(nextWalletAddress ?? current.walletAddress)
    : undefined;

  const updated = await prisma.destination.update({
    where: { destinationId },
    data: {
      counterpartyId: input.counterpartyId !== undefined ? input.counterpartyId : undefined,
      walletAddress: nextWalletAddress,
      tokenAccountAddress,
      destinationType: input.destinationType,
      trustState: input.trustState,
      label: input.label,
      notes: input.notes !== undefined ? normalizeOptionalText(input.notes) : undefined,
      isInternal: input.isInternal,
      isActive: input.isActive,
    },
    include: {
      counterparty: true,
    },
  });

  return serializeDestination(updated);
}

function getWorkspaceOrg(workspaceId: string) {
  return prisma.workspace.findUniqueOrThrow({
    where: { workspaceId },
    select: { organizationId: true },
  });
}

async function assertCounterpartyBelongsToOrg(organizationId: string, counterpartyId: string) {
  const counterparty = await prisma.counterparty.findFirst({
    where: {
      counterpartyId,
      organizationId,
    },
  });

  if (!counterparty) {
    throw new Error('Counterparty not found');
  }
}

async function assertCounterpartyNameAvailable(
  organizationId: string,
  displayName: string,
  excludeCounterpartyId?: string,
) {
  const existing = await prisma.counterparty.findFirst({
    where: {
      organizationId,
      displayName: {
        equals: displayName,
        mode: 'insensitive',
      },
      ...(excludeCounterpartyId ? { counterpartyId: { not: excludeCounterpartyId } } : {}),
    },
    select: { counterpartyId: true },
  });

  if (existing) {
    throw new Error(`Counterparty name "${displayName}" already exists in this organization`);
  }
}

async function assertDestinationLabelAvailable(
  workspaceId: string,
  label: string,
  excludeDestinationId?: string,
) {
  const existing = await prisma.destination.findFirst({
    where: {
      workspaceId,
      label: {
        equals: label,
        mode: 'insensitive',
      },
      ...(excludeDestinationId ? { destinationId: { not: excludeDestinationId } } : {}),
    },
    select: { destinationId: true },
  });

  if (existing) {
    throw new Error(`Destination name "${label}" already exists in this workspace`);
  }
}

async function assertDestinationWalletAvailable(
  workspaceId: string,
  walletAddress: string,
  excludeDestinationId?: string,
) {
  const existing = await prisma.destination.findFirst({
    where: {
      workspaceId,
      walletAddress,
      ...(excludeDestinationId ? { destinationId: { not: excludeDestinationId } } : {}),
    },
    select: { destinationId: true },
  });

  if (existing) {
    throw new Error(`Destination wallet "${walletAddress}" already exists in this workspace`);
  }
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

function serializeDestination(destination: Destination & {
  counterparty?: Counterparty | null;
}) {
  return {
    destinationId: destination.destinationId,
    workspaceId: destination.workspaceId,
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

function normalizeOptionalText(value?: string | null) {
  return value?.trim() || null;
}
