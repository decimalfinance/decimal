import type { Counterparty, CounterpartyWallet, Prisma } from '@prisma/client';
import { prisma } from './infra/prisma.js';
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

export type CreateCounterpartyWalletInput = {
  counterpartyId?: string | null;
  chain?: 'solana';
  asset?: 'usdc';
  walletAddress: string;
  tokenAccountAddress?: string | null;
  walletType?: string;
  trustState?: 'unreviewed' | 'trusted' | 'restricted' | 'blocked';
  label: string;
  notes?: string | null;
  isInternal?: boolean;
  isActive?: boolean;
  metadataJson?: Prisma.InputJsonValue;
};

export type UpdateCounterpartyWalletInput = {
  counterpartyId?: string | null;
  walletAddress?: string;
  tokenAccountAddress?: string | null;
  walletType?: string;
  trustState?: 'unreviewed' | 'trusted' | 'restricted' | 'blocked';
  label?: string;
  notes?: string | null;
  isInternal?: boolean;
  isActive?: boolean;
};

export async function listCounterparties(organizationId: string, options?: { limit?: number }) {
  const organization = await getOrganization(organizationId);
  const items = await prisma.counterparty.findMany({
    where: { organizationId: organization.organizationId },
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return { items: items.map(serializeCounterparty) };
}

export async function createCounterparty(organizationId: string, input: CreateCounterpartyInput) {
  const organization = await getOrganization(organizationId);
  await assertCounterpartyNameAvailable(organization.organizationId, input.displayName);

  const counterparty = await prisma.counterparty.create({
    data: {
      organizationId: organization.organizationId,
      displayName: input.displayName,
      category: input.category ?? 'vendor',
      externalReference: normalizeOptionalText(input.externalReference),
      status: input.status ?? 'active',
      metadataJson: (input.metadataJson ?? {}) as Prisma.InputJsonValue,
    },
  });

  return serializeCounterparty(counterparty);
}

export async function updateCounterparty(organizationId: string, counterpartyId: string, input: UpdateCounterpartyInput) {
  const organization = await getOrganization(organizationId);
  const current = await prisma.counterparty.findFirst({
    where: {
      counterpartyId,
      organizationId: organization.organizationId,
    },
  });

  if (!current) {
    throw new Error('Counterparty not found');
  }

  const nextDisplayName = input.displayName?.trim() || current.displayName;
  await assertCounterpartyNameAvailable(organization.organizationId, nextDisplayName, counterpartyId);

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

export async function listCounterpartyWallets(
  organizationId: string,
  options?: {
    limit?: number;
    includeInternal?: boolean;
    view?: 'all' | 'destinations' | 'collection_sources';
  },
) {
  const walletTypeFilter = options?.view === 'destinations'
    ? { walletType: { not: 'payer_wallet' } }
    : {};

  const items = await prisma.counterpartyWallet.findMany({
    where: {
      organizationId,
      ...(options?.includeInternal ? {} : { isInternal: false }),
      ...walletTypeFilter,
    },
    include: {
      counterparty: true,
    },
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return { items: items.map(serializeCounterpartyWallet) };
}

export async function createCounterpartyWallet(organizationId: string, input: CreateCounterpartyWalletInput) {
  const organization = await getOrganization(organizationId);

  if (input.counterpartyId) {
    await assertCounterpartyBelongsToOrg(organization.organizationId, input.counterpartyId);
  }

  await assertCounterpartyWalletWalletAvailable(organizationId, input.walletAddress);
  const tokenAccountAddress = normalizeOptionalText(input.tokenAccountAddress) ?? deriveUsdcAtaForWallet(input.walletAddress);

  const wallet = await prisma.counterpartyWallet.create({
    data: {
      organizationId,
      counterpartyId: input.counterpartyId,
      chain: input.chain ?? SOLANA_CHAIN,
      asset: input.asset ?? USDC_ASSET,
      walletAddress: input.walletAddress,
      tokenAccountAddress,
      walletType: input.walletType ?? 'wallet',
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

  return serializeCounterpartyWallet(wallet);
}

export async function createCollectionSourceWallet(organizationId: string, input: CreateCounterpartyWalletInput) {
  const organization = await getOrganization(organizationId);

  if (input.counterpartyId) {
    await assertCounterpartyBelongsToOrg(organization.organizationId, input.counterpartyId);
  }

  const walletAddress = normalizeRequiredText(input.walletAddress, 'Wallet address is required');
  const tokenAccountAddress = normalizeOptionalText(input.tokenAccountAddress) ?? deriveUsdcAtaForWallet(walletAddress);
  const existing = await prisma.counterpartyWallet.findUnique({
    where: {
      organizationId_walletAddress: {
        organizationId: organization.organizationId,
        walletAddress,
      },
    },
    include: { counterparty: true },
  });

  if (existing) {
    const updated = await prisma.counterpartyWallet.update({
      where: { counterpartyWalletId: existing.counterpartyWalletId },
      data: {
        counterpartyId: input.counterpartyId ?? existing.counterpartyId,
        tokenAccountAddress,
        trustState: input.trustState ?? existing.trustState,
        notes: input.notes !== undefined ? normalizeOptionalText(input.notes) : undefined,
        isActive: input.isActive ?? existing.isActive,
      },
      include: { counterparty: true },
    });
    return serializeCounterpartyWallet(updated);
  }

  const created = await prisma.counterpartyWallet.create({
    data: {
      organizationId: organization.organizationId,
      counterpartyId: input.counterpartyId ?? null,
      chain: input.chain ?? SOLANA_CHAIN,
      asset: input.asset ?? USDC_ASSET,
      walletAddress,
      tokenAccountAddress,
      walletType: input.walletType ?? 'payer_wallet',
      trustState: input.trustState ?? 'unreviewed',
      label: input.label,
      notes: normalizeOptionalText(input.notes),
      isInternal: input.isInternal ?? false,
      isActive: input.isActive ?? true,
      metadataJson: (input.metadataJson ?? {}) as Prisma.InputJsonValue,
    },
    include: { counterparty: true },
  });

  return serializeCounterpartyWallet(created);
}

export async function updateCounterpartyWallet(
  organizationId: string,
  counterpartyWalletId: string,
  input: UpdateCounterpartyWalletInput,
) {
  const [organization, current] = await Promise.all([
    getOrganization(organizationId),
    prisma.counterpartyWallet.findFirstOrThrow({
      where: { organizationId, counterpartyWalletId },
    }),
  ]);

  if (input.counterpartyId) {
    await assertCounterpartyBelongsToOrg(organization.organizationId, input.counterpartyId);
  }

  const nextWalletAddress = input.walletAddress?.trim();
  if (nextWalletAddress && nextWalletAddress !== current.walletAddress) {
    await assertCounterpartyWalletWalletAvailable(organizationId, nextWalletAddress, counterpartyWalletId);
  }
  const shouldUpdateTokenAccount = input.tokenAccountAddress !== undefined || Boolean(nextWalletAddress);
  const tokenAccountAddress = shouldUpdateTokenAccount
    ? normalizeOptionalText(input.tokenAccountAddress)
      ?? deriveUsdcAtaForWallet(nextWalletAddress ?? current.walletAddress)
    : undefined;

  const updated = await prisma.counterpartyWallet.update({
    where: { counterpartyWalletId },
    data: {
      counterpartyId: input.counterpartyId !== undefined ? input.counterpartyId : undefined,
      walletAddress: nextWalletAddress,
      tokenAccountAddress,
      walletType: input.walletType,
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

  return serializeCounterpartyWallet(updated);
}

/**
 * Look up an existing wallet for a payer, or create one. A wallet has no
 * direction, so the same record is reused for outbound and inbound flows;
 * we just upsert by (organizationId, walletAddress) and optionally link the
 * counterparty if it wasn't set before.
 */
export async function findOrCreateWalletForPayer(args: {
  organizationId: string;
  counterpartyId?: string | null;
  payerWalletAddress: string;
  payerTokenAccountAddress?: string | null;
  label?: string | null;
  inputSource: string;
}) {
  const payerWalletAddress = normalizeRequiredText(args.payerWalletAddress, 'Payer wallet address is required');
  const tokenAccountAddress = normalizeOptionalText(args.payerTokenAccountAddress) ?? deriveUsdcAtaForWallet(payerWalletAddress);
  const existing = await prisma.counterpartyWallet.findUnique({
    where: {
      organizationId_walletAddress: {
        organizationId: args.organizationId,
        walletAddress: payerWalletAddress,
      },
    },
    include: { counterparty: true },
  });

  if (existing) {
    const needsCounterpartyLink = !existing.counterpartyId && args.counterpartyId;
    if (!needsCounterpartyLink) {
      return existing;
    }
    return prisma.counterpartyWallet.update({
      where: { counterpartyWalletId: existing.counterpartyWalletId },
      data: {
        counterpartyId: args.counterpartyId,
      },
      include: { counterparty: true },
    });
  }

  const wallet = await prisma.counterpartyWallet.create({
    data: {
      organizationId: args.organizationId,
      counterpartyId: args.counterpartyId ?? null,
      chain: SOLANA_CHAIN,
      asset: USDC_ASSET,
      walletAddress: payerWalletAddress,
      tokenAccountAddress,
      walletType: 'payer_wallet',
      trustState: 'unreviewed',
      label: await buildAvailableInboundWalletLabel(args.organizationId, args.label ?? shortenAddress(payerWalletAddress)),
      notes: 'Automatically created from an expected collection payer wallet.',
      isActive: true,
      metadataJson: {
        inputSource: args.inputSource,
        autoCreated: true,
      },
    },
    include: { counterparty: true },
  });

  return wallet;
}

export function serializeCounterpartyWallet(wallet: CounterpartyWallet & {
  counterparty?: Counterparty | null;
}) {
  return {
    collectionSourceId: wallet.counterpartyWalletId,
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
    counterparty: wallet.counterparty ? serializeCounterparty(wallet.counterparty) : null,
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

async function assertCounterpartyWalletWalletAvailable(
  organizationId: string,
  walletAddress: string,
  excludeCounterpartyWalletId?: string,
) {
  const existing = await prisma.counterpartyWallet.findFirst({
    where: {
      organizationId,
      walletAddress,
      ...(excludeCounterpartyWalletId ? { counterpartyWalletId: { not: excludeCounterpartyWalletId } } : {}),
    },
    select: { counterpartyWalletId: true },
  });

  if (existing) {
    throw new Error(`Counterparty wallet "${walletAddress}" already exists in this organization`);
  }
}

async function buildAvailableInboundWalletLabel(organizationId: string, baseLabel: string) {
  let candidate = normalizeRequiredText(baseLabel, 'Counterparty wallet label is required');
  for (let suffix = 1; suffix <= 50; suffix += 1) {
    const existing = await prisma.counterpartyWallet.findFirst({
      where: {
        organizationId,
        label: { equals: candidate, mode: 'insensitive' },
      },
      select: { counterpartyWalletId: true },
    });
    if (!existing) {
      return candidate;
    }
    candidate = `${baseLabel} ${suffix + 1}`;
  }
  throw new Error(`Could not allocate a unique counterparty wallet label for "${baseLabel}"`);
}

export function serializeCounterparty(counterparty: Counterparty) {
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
