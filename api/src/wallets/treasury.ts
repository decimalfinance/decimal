import type { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET } from '../solana.js';

export type CreateTreasuryWalletInput = {
  chain?: string;
  address: string;
  displayName?: string | null;
  assetScope?: string;
  source?: string;
  sourceRef?: string | null;
  notes?: string | null;
  properties?: Record<string, unknown>;
};

export type UpdateTreasuryWalletInput = {
  address?: string;
  displayName?: string | null;
  notes?: string | null;
  isActive?: boolean;
};

export async function listTreasuryWallets(organizationId: string, options?: { limit?: number }) {
  const items = await prisma.treasuryWallet.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
  });

  return { items: items.map(serializeTreasuryWallet) };
}

export async function createTreasuryWallet(organizationId: string, input: CreateTreasuryWalletInput) {
  const displayName = normalizeOptionalText(input.displayName);
  if (displayName) {
    await assertWalletNameAvailable(organizationId, displayName);
  }
  await assertWalletAddressAvailable(organizationId, input.address);
  const usdcAtaAddress = deriveUsdcAtaForWallet(input.address);

  const wallet = await prisma.treasuryWallet.create({
    data: {
      organizationId,
      chain: input.chain ?? SOLANA_CHAIN,
      address: input.address,
      assetScope: input.assetScope ?? USDC_ASSET,
      usdcAtaAddress,
      source: input.source ?? 'manual',
      sourceRef: input.sourceRef,
      displayName,
      notes: normalizeOptionalText(input.notes),
      propertiesJson: {
        usdcAtaAddress,
        ...(input.properties ?? {}),
      } as Prisma.InputJsonObject,
    },
  });

  return serializeTreasuryWallet(wallet);
}

export async function updateTreasuryWallet(
  organizationId: string,
  treasuryWalletId: string,
  input: UpdateTreasuryWalletInput,
) {
  const current = await prisma.treasuryWallet.findFirstOrThrow({
    where: {
      organizationId,
      treasuryWalletId,
    },
  });

  const nextAddress = input.address?.trim() || current.address;
  const nextUsdcAtaAddress = deriveUsdcAtaForWallet(nextAddress);
  const nextDisplayName =
    input.displayName !== undefined ? normalizeOptionalText(input.displayName) : current.displayName;

  if (nextDisplayName) {
    await assertWalletNameAvailable(organizationId, nextDisplayName, treasuryWalletId);
  }

  if (nextAddress !== current.address) {
    await assertWalletAddressAvailable(organizationId, nextAddress, treasuryWalletId);
  }

  const wallet = await prisma.$transaction(async (tx) => {
    const updated = await tx.treasuryWallet.update({
      where: { treasuryWalletId },
      data: {
        address: nextAddress,
        usdcAtaAddress: nextUsdcAtaAddress,
        displayName: nextDisplayName,
        notes: input.notes !== undefined ? normalizeOptionalText(input.notes) : undefined,
        isActive: input.isActive,
        propertiesJson: {
          ...(isRecordLike(current.propertiesJson) ? current.propertiesJson : {}),
          usdcAtaAddress: nextUsdcAtaAddress,
        } as Prisma.InputJsonObject,
      },
    });

    return updated;
  });

  return serializeTreasuryWallet(wallet);
}

async function assertWalletNameAvailable(
  organizationId: string,
  displayName: string,
  excludeTreasuryWalletId?: string,
) {
  const existing = await prisma.treasuryWallet.findFirst({
    where: {
      organizationId,
      displayName: {
        equals: displayName,
        mode: 'insensitive',
      },
      ...(excludeTreasuryWalletId ? { treasuryWalletId: { not: excludeTreasuryWalletId } } : {}),
    },
    select: { treasuryWalletId: true },
  });

  if (existing) {
    throw new Error(`Wallet name "${displayName}" already exists in this organization`);
  }
}

async function assertWalletAddressAvailable(
  organizationId: string,
  address: string,
  excludeTreasuryWalletId?: string,
) {
  const existing = await prisma.treasuryWallet.findFirst({
    where: {
      organizationId,
      address,
      ...(excludeTreasuryWalletId ? { treasuryWalletId: { not: excludeTreasuryWalletId } } : {}),
    },
    select: { treasuryWalletId: true },
  });

  if (existing) {
    throw new Error(`Treasury wallet address "${address}" already exists in this organization`);
  }
}

function serializeTreasuryWallet(wallet: {
  treasuryWalletId: string;
  organizationId: string;
  chain: string;
  address: string;
  assetScope: string;
  usdcAtaAddress: string | null;
  isActive: boolean;
  source: string;
  sourceRef: string | null;
  displayName: string | null;
  notes: string | null;
  propertiesJson: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    treasuryWalletId: wallet.treasuryWalletId,
    organizationId: wallet.organizationId,
    chain: wallet.chain,
    address: wallet.address,
    assetScope: wallet.assetScope,
    usdcAtaAddress: wallet.usdcAtaAddress,
    isActive: wallet.isActive,
    source: wallet.source,
    sourceRef: wallet.sourceRef,
    displayName: wallet.displayName,
    notes: wallet.notes,
    propertiesJson: wallet.propertiesJson,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function normalizeOptionalText(value?: string | null) {
  return value?.trim() || null;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
