import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';

export const destinationsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const destinationParamsSchema = workspaceParamsSchema.extend({
  destinationId: z.string().uuid(),
});

const createCounterpartySchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100).default('vendor'),
  externalReference: z.string().trim().min(1).max(200).optional(),
  status: z.string().trim().min(1).max(50).default('active'),
  metadataJson: z.record(z.any()).default({}),
});

const updateCounterpartySchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  externalReference: z.string().trim().max(200).optional(),
  status: z.string().trim().min(1).max(50).optional(),
}).refine(
  (value) =>
    value.displayName !== undefined
    || value.category !== undefined
    || value.externalReference !== undefined
    || value.status !== undefined,
  'At least one field must be updated',
);

const createDestinationSchema = z.object({
  counterpartyId: z.string().uuid().optional(),
  linkedWorkspaceAddressId: z.string().uuid(),
  destinationType: z.string().trim().min(1).max(100).default('wallet'),
  trustState: z.enum(['unreviewed', 'trusted', 'restricted', 'blocked']).default('unreviewed'),
  label: z.string().trim().min(1).max(200),
  notes: z.string().trim().min(1).max(5000).optional(),
  isInternal: z.boolean().default(false),
  isActive: z.boolean().default(true),
  metadataJson: z.record(z.any()).default({}),
});

const updateDestinationSchema = z.object({
  counterpartyId: z.string().uuid().nullable().optional(),
  linkedWorkspaceAddressId: z.string().uuid().optional(),
  destinationType: z.string().trim().min(1).max(100).optional(),
  trustState: z.enum(['unreviewed', 'trusted', 'restricted', 'blocked']).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
  isInternal: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).refine(
  (value) =>
    value.counterpartyId !== undefined
    || value.linkedWorkspaceAddressId !== undefined
    || value.destinationType !== undefined
    || value.trustState !== undefined
    || value.label !== undefined
    || value.notes !== undefined
    || value.isInternal !== undefined
    || value.isActive !== undefined,
  'At least one field must be updated',
);

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

destinationsRouter.get('/workspaces/:workspaceId/counterparties', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { workspaceId },
      select: { organizationId: true },
    });

    const items = await prisma.counterparty.findMany({
      where: { organizationId: workspace.organizationId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ items: items.map(serializeCounterparty) });
  } catch (error) {
    next(error);
  }
});

destinationsRouter.post('/workspaces/:workspaceId/counterparties', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = createCounterpartySchema.parse(req.body);
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { workspaceId },
      select: { organizationId: true },
    });
    await assertCounterpartyNameAvailable(workspace.organizationId, input.displayName);

    const counterparty = await prisma.counterparty.create({
      data: {
        organizationId: workspace.organizationId,
        displayName: input.displayName,
        category: input.category,
        externalReference: input.externalReference,
        status: input.status,
        metadataJson: input.metadataJson,
      },
    });

    res.status(201).json(serializeCounterparty(counterparty));
  } catch (error) {
    next(error);
  }
});

destinationsRouter.patch('/workspaces/:workspaceId/counterparties/:counterpartyId', async (req, res, next) => {
  try {
    const { workspaceId, counterpartyId } = z.object({
      workspaceId: z.string().uuid(),
      counterpartyId: z.string().uuid(),
    }).parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = updateCounterpartySchema.parse(req.body);
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { workspaceId },
      select: { organizationId: true },
    });

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
        externalReference: input.externalReference !== undefined ? input.externalReference.trim() || null : undefined,
        status: input.status,
      },
    });

    res.json(serializeCounterparty(updated));
  } catch (error) {
    next(error);
  }
});

destinationsRouter.get('/workspaces/:workspaceId/destinations', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const items = await prisma.destination.findMany({
      where: { workspaceId },
      include: {
        counterparty: true,
        linkedWorkspaceAddress: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ items: items.map(serializeDestination) });
  } catch (error) {
    next(error);
  }
});

destinationsRouter.post('/workspaces/:workspaceId/destinations', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = createDestinationSchema.parse(req.body);

    const [workspace, linkedWorkspaceAddress] = await Promise.all([
      prisma.workspace.findUniqueOrThrow({
        where: { workspaceId },
        select: { organizationId: true },
      }),
      prisma.workspaceAddress.findFirst({
        where: {
          workspaceId,
          workspaceAddressId: input.linkedWorkspaceAddressId,
          isActive: true,
        },
      }),
    ]);

    if (!linkedWorkspaceAddress) {
      throw new Error('Linked wallet not found');
    }

    if (input.counterpartyId) {
      const counterparty = await prisma.counterparty.findFirst({
        where: {
          counterpartyId: input.counterpartyId,
          organizationId: workspace.organizationId,
        },
      });

      if (!counterparty) {
        throw new Error('Counterparty not found');
      }
    }

    await assertDestinationLabelAvailable(workspaceId, input.label);

    const destination = await prisma.destination.create({
      data: {
        workspaceId,
        counterpartyId: input.counterpartyId,
        linkedWorkspaceAddressId: linkedWorkspaceAddress.workspaceAddressId,
        chain: linkedWorkspaceAddress.chain,
        asset: linkedWorkspaceAddress.assetScope,
        walletAddress: linkedWorkspaceAddress.address,
        tokenAccountAddress: linkedWorkspaceAddress.usdcAtaAddress,
        destinationType: input.destinationType,
        trustState: input.trustState,
        label: input.label,
        notes: input.notes,
        isInternal: input.isInternal,
        isActive: input.isActive,
        metadataJson: input.metadataJson,
      },
      include: {
        counterparty: true,
        linkedWorkspaceAddress: true,
      },
    });

    res.status(201).json(serializeDestination(destination));
  } catch (error) {
    next(error);
  }
});

destinationsRouter.patch('/workspaces/:workspaceId/destinations/:destinationId', async (req, res, next) => {
  try {
    const { workspaceId, destinationId } = destinationParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = updateDestinationSchema.parse(req.body);

    const [workspace, current] = await Promise.all([
      prisma.workspace.findUniqueOrThrow({
        where: { workspaceId },
        select: { organizationId: true },
      }),
      prisma.destination.findFirstOrThrow({
        where: { workspaceId, destinationId },
      }),
    ]);

    if (input.counterpartyId) {
      const counterparty = await prisma.counterparty.findFirst({
        where: {
          counterpartyId: input.counterpartyId,
          organizationId: workspace.organizationId,
        },
      });

      if (!counterparty) {
        throw new Error('Counterparty not found');
      }
    }

    const nextLabel = input.label?.trim() || current.label;
    await assertDestinationLabelAvailable(workspaceId, nextLabel, destinationId);

    const linkedWorkspaceAddress = input.linkedWorkspaceAddressId
      ? await prisma.workspaceAddress.findFirst({
          where: {
            workspaceId,
            workspaceAddressId: input.linkedWorkspaceAddressId,
            isActive: true,
          },
        })
      : current.linkedWorkspaceAddressId
        ? await prisma.workspaceAddress.findFirst({
            where: {
              workspaceId,
              workspaceAddressId: current.linkedWorkspaceAddressId,
            },
          })
        : null;

    const updated = await prisma.destination.update({
      where: { destinationId },
      data: {
        counterpartyId: input.counterpartyId !== undefined ? input.counterpartyId : undefined,
        linkedWorkspaceAddressId: input.linkedWorkspaceAddressId ?? undefined,
        chain: linkedWorkspaceAddress?.chain ?? undefined,
        asset: linkedWorkspaceAddress?.assetScope ?? undefined,
        walletAddress: linkedWorkspaceAddress?.address ?? undefined,
        tokenAccountAddress: linkedWorkspaceAddress?.usdcAtaAddress ?? undefined,
        destinationType: input.destinationType,
        trustState: input.trustState,
        label: input.label,
        notes: input.notes !== undefined ? input.notes.trim() || null : undefined,
        isInternal: input.isInternal,
        isActive: input.isActive,
      },
      include: {
        counterparty: true,
        linkedWorkspaceAddress: true,
      },
    });

    res.json(serializeDestination(updated));
  } catch (error) {
    next(error);
  }
});

function serializeCounterparty(counterparty: {
  counterpartyId: string;
  organizationId: string;
  displayName: string;
  category: string;
  externalReference: string | null;
  status: string;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
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

function serializeDestination(destination: {
  destinationId: string;
  workspaceId: string;
  counterpartyId: string | null;
  linkedWorkspaceAddressId: string | null;
  chain: string;
  asset: string;
  walletAddress: string;
  tokenAccountAddress: string | null;
  destinationType: string;
  trustState: string;
  label: string;
  notes: string | null;
  isInternal: boolean;
  isActive: boolean;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
  counterparty?: {
    counterpartyId: string;
    organizationId: string;
    displayName: string;
    category: string;
    externalReference: string | null;
    status: string;
    metadataJson: unknown;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  linkedWorkspaceAddress?: {
    workspaceAddressId: string;
    address: string;
    usdcAtaAddress: string | null;
    addressKind: string;
    displayName: string | null;
    notes: string | null;
  } | null;
}) {
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
    linkedWorkspaceAddress: destination.linkedWorkspaceAddress
      ? {
          workspaceAddressId: destination.linkedWorkspaceAddress.workspaceAddressId,
          address: destination.linkedWorkspaceAddress.address,
          usdcAtaAddress: destination.linkedWorkspaceAddress.usdcAtaAddress,
          addressKind: destination.linkedWorkspaceAddress.addressKind,
          displayName: destination.linkedWorkspaceAddress.displayName,
          notes: destination.linkedWorkspaceAddress.notes,
        }
      : null,
  };
}
