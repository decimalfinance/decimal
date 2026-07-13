import type { Counterparty, CounterpartyWallet, Prisma } from '@prisma/client';
import { prisma } from './infra/prisma.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET } from './solana.js';
import { readPayableHold } from './payments/vendor-payable.js';

// Auto-note stamped on wallets created by invoice intake. It's only true while
// the address is unreviewed; once reviewed we clear it (see updateCounterpartyWallet)
// so it doesn't linger as stale text. Kept here so intake and the clear-on-review
// path reference the exact same string.
export const INVOICE_IMPORT_REVIEW_NOTE =
  'Created from invoice upload. Human review is required before payment execution.';

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
  isPrimary?: boolean;
};

// All wallets that belong to the same vendor as `wallet`. Vendor identity is the
// linked counterparty when present, else the label — matching how the address
// book groups wallets.
function vendorGroupWhere(wallet: {
  organizationId: string;
  counterpartyId: string | null;
  label: string;
}): Prisma.CounterpartyWalletWhereInput {
  return wallet.counterpartyId
    ? { organizationId: wallet.organizationId, counterpartyId: wallet.counterpartyId }
    : {
        organizationId: wallet.organizationId,
        counterpartyId: null,
        label: { equals: wallet.label, mode: 'insensitive' },
      };
}

// If the vendor has no primary (default) payout address yet, make this one it.
// Used when an address becomes trusted, so the first verified address a vendor
// gets becomes its default automatically.
export async function autoPromotePrimaryIfNone(
  tx: Prisma.TransactionClient,
  wallet: { counterpartyWalletId: string; organizationId: string; counterpartyId: string | null; label: string },
): Promise<void> {
  const existingPrimary = await tx.counterpartyWallet.findFirst({
    where: { ...vendorGroupWhere(wallet), isPrimary: true },
    select: { counterpartyWalletId: true },
  });
  if (existingPrimary) return;
  await tx.counterpartyWallet.update({
    where: { counterpartyWalletId: wallet.counterpartyWalletId },
    data: { isPrimary: true },
  });
}

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
    view?: 'all' | 'destinations';
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

  const wallet = await prisma.$transaction(async (tx) => {
    const created = await tx.counterpartyWallet.create({
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
      include: { counterparty: true },
    });

    // A vendor added straight as verified becomes its own default.
    if ((input.trustState ?? 'unreviewed') === 'trusted') {
      await autoPromotePrimaryIfNone(tx, {
        counterpartyWalletId: created.counterpartyWalletId,
        organizationId: created.organizationId,
        counterpartyId: created.counterpartyId,
        label: created.label,
      });
      return tx.counterpartyWallet.findUniqueOrThrow({
        where: { counterpartyWalletId: created.counterpartyWalletId },
        include: { counterparty: true },
      });
    }
    return created;
  });

  return serializeCounterpartyWallet(wallet);
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

  // Drop the auto-generated "review required" note once the address has been
  // reviewed — it's no longer true and shouldn't linger. Only the exact
  // auto-note is cleared; a note the user wrote is left untouched.
  const effectiveTrustState = input.trustState ?? current.trustState;
  let notesUpdate: string | null | undefined =
    input.notes !== undefined ? normalizeOptionalText(input.notes) : undefined;
  const effectiveNotes = notesUpdate !== undefined ? notesUpdate : current.notes;
  if (effectiveTrustState !== 'unreviewed' && effectiveNotes === INVOICE_IMPORT_REVIEW_NOTE) {
    notesUpdate = null;
  }

  // Primary (default) payout address handling.
  const trusted = effectiveTrustState === 'trusted';
  let nextIsPrimary: boolean | undefined;
  if (input.isPrimary === true) {
    if (!trusted) {
      throw new Error('Only a verified address can be set as the primary payout address.');
    }
    nextIsPrimary = true;
  } else if (input.isPrimary === false) {
    nextIsPrimary = false;
  } else if (!trusted && current.isPrimary) {
    // A no-longer-trusted address must not remain the default.
    nextIsPrimary = false;
  }

  const group = {
    counterpartyWalletId,
    organizationId,
    counterpartyId: input.counterpartyId !== undefined ? input.counterpartyId : current.counterpartyId,
    label: input.label ?? current.label,
  };

  const updated = await prisma.$transaction(async (tx) => {
    if (nextIsPrimary === true) {
      // Exactly one primary per vendor — clear it on the others first.
      await tx.counterpartyWallet.updateMany({
        where: { ...vendorGroupWhere(group), counterpartyWalletId: { not: counterpartyWalletId } },
        data: { isPrimary: false },
      });
    }

    const row = await tx.counterpartyWallet.update({
      where: { counterpartyWalletId },
      data: {
        counterpartyId: input.counterpartyId !== undefined ? input.counterpartyId : undefined,
        walletAddress: nextWalletAddress,
        tokenAccountAddress,
        walletType: input.walletType,
        trustState: input.trustState,
        label: input.label,
        notes: notesUpdate,
        isInternal: input.isInternal,
        isActive: input.isActive,
        isPrimary: nextIsPrimary,
      },
      include: { counterparty: true },
    });

    // First verified address for a vendor becomes its default automatically.
    if (trusted && nextIsPrimary === undefined && !row.isPrimary) {
      await autoPromotePrimaryIfNone(tx, group);
      return tx.counterpartyWallet.findUniqueOrThrow({
        where: { counterpartyWalletId },
        include: { counterparty: true },
      });
    }
    return row;
  });

  return serializeCounterpartyWallet(updated);
}

// Remove an address from the book. Hard-deletes when nothing references it;
// otherwise archives (isActive=false) so payment/transfer history is preserved
// (those FKs are ON DELETE RESTRICT). Blocks removal of an address that is a
// live spending-limit destination — that would hide an address the on-chain
// allowlist still lets the agent pay; it must be removed from the limit first.
export async function removeCounterpartyWallet(organizationId: string, counterpartyWalletId: string) {
  await prisma.counterpartyWallet.findFirstOrThrow({
    where: { organizationId, counterpartyWalletId },
  });

  const onSpendingLimit = await prisma.spendingLimitPolicyDestination.findFirst({
    where: { counterpartyWalletId },
    select: { counterpartyWalletId: true },
  });
  if (onSpendingLimit) {
    throw new Error(
      'This address is on an active spending limit. Remove it from the spending limit before removing the address.',
    );
  }

  try {
    await prisma.counterpartyWallet.delete({ where: { counterpartyWalletId } });
    return { removed: 'deleted' as const, counterpartyWalletId };
  } catch (error) {
    // P2003 = foreign key constraint failed → it has history, so archive instead.
    if ((error as { code?: string }).code !== 'P2003') {
      throw error;
    }
  }

  const updated = await prisma.counterpartyWallet.update({
    where: { counterpartyWalletId },
    data: { isActive: false, isPrimary: false },
    include: { counterparty: true },
  });
  return { removed: 'archived' as const, wallet: serializeCounterpartyWallet(updated) };
}

/**
 * Look up an existing wallet for a payer, or create one. A wallet has no
 * direction, so the same record is reused for outbound and inbound flows;
 * we just upsert by (organizationId, walletAddress) and optionally link the
 * counterparty if it wasn't set before.
 */
export function serializeCounterpartyWallet(wallet: CounterpartyWallet & {
  counterparty?: Counterparty | null;
}) {
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
    isPrimary: wallet.isPrimary,
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
export function serializeCounterparty(counterparty: Counterparty) {
  const hold = readPayableHold(counterparty.metadataJson);
  return {
    counterpartyId: counterparty.counterpartyId,
    organizationId: counterparty.organizationId,
    displayName: counterparty.displayName,
    category: counterparty.category,
    externalReference: counterparty.externalReference,
    status: counterparty.status,
    // Payable gate: 'payable' unless an admin held or the owner blocked them.
    payableStatus: hold?.status ?? 'payable',
    payableHold: hold,
    metadataJson: counterparty.metadataJson,
    createdAt: counterparty.createdAt,
    updatedAt: counterparty.updatedAt,
  };
}
function normalizeOptionalText(value?: string | null) {
  return value?.trim() || null;
}