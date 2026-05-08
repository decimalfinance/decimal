import type { CollectionSource, Counterparty, Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET } from '../solana.js';

export type CreateCollectionSourceInput = {
  counterpartyId?: string | null;
  chain?: 'solana';
  asset?: 'usdc';
  walletAddress: string;
  tokenAccountAddress?: string | null;
  sourceType?: string;
  trustState?: 'unreviewed' | 'trusted' | 'restricted' | 'blocked';
  label: string;
  notes?: string | null;
  isActive?: boolean;
  metadataJson?: Prisma.InputJsonValue;
};

export type UpdateCollectionSourceInput = {
  counterpartyId?: string | null;
  walletAddress?: string;
  tokenAccountAddress?: string | null;
  sourceType?: string;
  trustState?: 'unreviewed' | 'trusted' | 'restricted' | 'blocked';
  label?: string;
  notes?: string | null;
  isActive?: boolean;
};

export async function listCollectionSources(organizationId: string, options?: { limit?: number }) {
  const items = await prisma.collectionSource.findMany({
    where: { organizationId },
    include: { counterparty: true },
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return { items: items.map(serializeCollectionSource) };
}

export async function createCollectionSource(organizationId: string, input: CreateCollectionSourceInput) {
  const organization = await getOrganization(organizationId);

  if (input.counterpartyId) {
    await assertCounterpartyBelongsToOrg(organization.organizationId, input.counterpartyId);
  }

  await assertCollectionSourceLabelAvailable(organizationId, input.label);
  await assertCollectionSourceWalletAvailable(organizationId, input.walletAddress);
  const tokenAccountAddress = normalizeOptionalText(input.tokenAccountAddress) ?? deriveUsdcAtaForWallet(input.walletAddress);

  const source = await prisma.collectionSource.create({
    data: {
      organizationId,
      counterpartyId: input.counterpartyId ?? null,
      chain: input.chain ?? SOLANA_CHAIN,
      asset: input.asset ?? USDC_ASSET,
      walletAddress: input.walletAddress,
      tokenAccountAddress,
      sourceType: input.sourceType ?? 'payer_wallet',
      trustState: input.trustState ?? 'unreviewed',
      label: input.label,
      notes: normalizeOptionalText(input.notes),
      isActive: input.isActive ?? true,
      metadataJson: (input.metadataJson ?? {}) as Prisma.InputJsonValue,
    },
    include: { counterparty: true },
  });

  return serializeCollectionSource(source);
}

export async function updateCollectionSource(
  organizationId: string,
  collectionSourceId: string,
  input: UpdateCollectionSourceInput,
) {
  const [organization, current] = await Promise.all([
    getOrganization(organizationId),
    prisma.collectionSource.findFirstOrThrow({
      where: { organizationId, collectionSourceId },
    }),
  ]);

  if (input.counterpartyId) {
    await assertCounterpartyBelongsToOrg(organization.organizationId, input.counterpartyId);
  }

  const nextLabel = input.label?.trim() || current.label;
  await assertCollectionSourceLabelAvailable(organizationId, nextLabel, collectionSourceId);

  const nextWalletAddress = input.walletAddress?.trim();
  if (nextWalletAddress && nextWalletAddress !== current.walletAddress) {
    await assertCollectionSourceWalletAvailable(organizationId, nextWalletAddress, collectionSourceId);
  }

  const shouldUpdateTokenAccount = input.tokenAccountAddress !== undefined || Boolean(nextWalletAddress);
  const tokenAccountAddress = shouldUpdateTokenAccount
    ? normalizeOptionalText(input.tokenAccountAddress)
      ?? deriveUsdcAtaForWallet(nextWalletAddress ?? current.walletAddress)
    : undefined;

  const updated = await prisma.collectionSource.update({
    where: { collectionSourceId },
    data: {
      counterpartyId: input.counterpartyId !== undefined ? input.counterpartyId : undefined,
      walletAddress: nextWalletAddress,
      tokenAccountAddress,
      sourceType: input.sourceType,
      trustState: input.trustState,
      label: input.label,
      notes: input.notes !== undefined ? normalizeOptionalText(input.notes) : undefined,
      isActive: input.isActive,
    },
    include: { counterparty: true },
  });

  return serializeCollectionSource(updated);
}

export async function findOrCreateCollectionSourceForPayer(args: {
  organizationId: string;
  counterpartyId?: string | null;
  payerWalletAddress: string;
  payerTokenAccountAddress?: string | null;
  label?: string | null;
  inputSource: string;
}) {
  const payerWalletAddress = normalizeRequiredText(args.payerWalletAddress, 'Payer wallet address is required');
  const tokenAccountAddress = normalizeOptionalText(args.payerTokenAccountAddress) ?? deriveUsdcAtaForWallet(payerWalletAddress);
  const existing = await prisma.collectionSource.findUnique({
    where: {
      organizationId_walletAddress: {
        organizationId: args.organizationId,
        walletAddress: payerWalletAddress,
      },
    },
    include: { counterparty: true },
  });

  if (existing) {
    const shouldUpdate = !existing.counterpartyId && args.counterpartyId;
    if (!shouldUpdate) {
      return existing;
    }
    return prisma.collectionSource.update({
      where: { collectionSourceId: existing.collectionSourceId },
      data: { counterpartyId: args.counterpartyId },
      include: { counterparty: true },
    });
  }

  const source = await prisma.collectionSource.create({
    data: {
      organizationId: args.organizationId,
      counterpartyId: args.counterpartyId ?? null,
      chain: SOLANA_CHAIN,
      asset: USDC_ASSET,
      walletAddress: payerWalletAddress,
      tokenAccountAddress,
      sourceType: 'payer_wallet',
      trustState: 'unreviewed',
      label: await buildAvailableCollectionSourceLabel(args.organizationId, args.label ?? shortenAddress(payerWalletAddress)),
      notes: 'Automatically created from an expected collection payer wallet.',
      isActive: true,
      metadataJson: {
        inputSource: args.inputSource,
        autoCreated: true,
      },
    },
    include: { counterparty: true },
  });

  return source;
}

export function serializeCollectionSource(source: CollectionSource & { counterparty?: Counterparty | null }) {
  return {
    collectionSourceId: source.collectionSourceId,
    organizationId: source.organizationId,
    counterpartyId: source.counterpartyId,
    chain: source.chain,
    asset: source.asset,
    walletAddress: source.walletAddress,
    tokenAccountAddress: source.tokenAccountAddress,
    sourceType: source.sourceType,
    trustState: source.trustState,
    label: source.label,
    notes: source.notes,
    isActive: source.isActive,
    metadataJson: source.metadataJson,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    counterparty: source.counterparty ? serializeCounterparty(source.counterparty) : null,
  };
}

function getOrganization(organizationId: string) {
  return prisma.organization.findUniqueOrThrow({
    where: { organizationId },
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

async function assertCollectionSourceLabelAvailable(
  organizationId: string,
  label: string,
  excludeCollectionSourceId?: string,
) {
  const existing = await prisma.collectionSource.findFirst({
    where: {
      organizationId,
      label: {
        equals: label,
        mode: 'insensitive',
      },
      ...(excludeCollectionSourceId ? { collectionSourceId: { not: excludeCollectionSourceId } } : {}),
    },
    select: { collectionSourceId: true },
  });

  if (existing) {
    throw new Error(`Collection source name "${label}" already exists in this organization`);
  }
}

async function assertCollectionSourceWalletAvailable(
  organizationId: string,
  walletAddress: string,
  excludeCollectionSourceId?: string,
) {
  const existing = await prisma.collectionSource.findFirst({
    where: {
      organizationId,
      walletAddress,
      ...(excludeCollectionSourceId ? { collectionSourceId: { not: excludeCollectionSourceId } } : {}),
    },
    select: { collectionSourceId: true },
  });

  if (existing) {
    throw new Error(`Collection source wallet "${walletAddress}" already exists in this organization`);
  }
}

async function buildAvailableCollectionSourceLabel(organizationId: string, baseLabel: string) {
  let candidate = normalizeRequiredText(baseLabel, 'Collection source label is required');
  for (let suffix = 1; suffix <= 50; suffix += 1) {
    const existing = await prisma.collectionSource.findFirst({
      where: {
        organizationId,
        label: { equals: candidate, mode: 'insensitive' },
      },
      select: { collectionSourceId: true },
    });
    if (!existing) {
      return candidate;
    }
    candidate = `${baseLabel} ${suffix + 1}`;
  }
  throw new Error(`Could not allocate a unique collection source label for "${baseLabel}"`);
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

function normalizeRequiredText(value: string | null | undefined, message: string) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeOptionalText(value?: string | null) {
  return value?.trim() || null;
}

function shortenAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}
