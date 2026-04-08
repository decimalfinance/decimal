import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET } from '../solana.js';

export const addressesRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const workspaceAddressParamsSchema = workspaceParamsSchema.extend({
  workspaceAddressId: z.string().uuid(),
});

const createAddressSchema = z.object({
  chain: z.string().default(SOLANA_CHAIN),
  address: z.string().min(1),
  addressKind: z.string().min(1).optional(),
  displayName: z.string().optional(),
  assetScope: z.string().default(USDC_ASSET),
  source: z.string().default('manual'),
  sourceRef: z.string().optional(),
  notes: z.string().optional(),
  properties: z.record(z.any()).optional(),
});

const updateAddressSchema = z.object({
  address: z.string().min(1).optional(),
  displayName: z.string().optional(),
  notes: z.string().optional(),
  isActive: z.boolean().optional(),
}).refine(
  (value) =>
    value.address !== undefined
    || value.displayName !== undefined
    || value.notes !== undefined
    || value.isActive !== undefined,
  'At least one field must be updated',
);

addressesRouter.get('/workspaces/:workspaceId/addresses', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const items = await prisma.workspaceAddress.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

addressesRouter.post('/workspaces/:workspaceId/addresses', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = createAddressSchema.parse(req.body);
    const displayName = input.displayName?.trim() || null;
    const addressKind = input.addressKind ?? 'wallet';
    const usdcAtaAddress = deriveUsdcAtaForWallet(input.address);

    const address = await prisma.workspaceAddress.create({
      data: {
        workspaceId,
        chain: input.chain,
        address: input.address,
        addressKind,
        assetScope: input.assetScope,
        usdcAtaAddress,
        source: input.source,
        sourceRef: input.sourceRef,
        displayName,
        notes: input.notes,
        propertiesJson: {
          usdcAtaAddress,
          ...(input.properties ?? {}),
        },
      },
    });

    res.status(201).json(address);
  } catch (error) {
    next(error);
  }
});

addressesRouter.patch(
  '/workspaces/:workspaceId/addresses/:workspaceAddressId',
  async (req, res, next) => {
    try {
      const { workspaceId, workspaceAddressId } = workspaceAddressParamsSchema.parse(req.params);
      await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
      const input = updateAddressSchema.parse(req.body);

      const current = await prisma.workspaceAddress.findFirstOrThrow({
        where: {
          workspaceId,
          workspaceAddressId,
        },
      });

      const nextAddress = input.address?.trim() || current.address;
      const nextUsdcAtaAddress = deriveUsdcAtaForWallet(nextAddress);

      const updated = await prisma.$transaction(async (tx) => {
        const address = await tx.workspaceAddress.update({
          where: { workspaceAddressId },
          data: {
            address: nextAddress,
            usdcAtaAddress: nextUsdcAtaAddress,
            displayName: input.displayName !== undefined ? input.displayName.trim() || null : undefined,
            notes: input.notes !== undefined ? input.notes.trim() || null : undefined,
            isActive: input.isActive,
            propertiesJson: {
              ...(typeof current.propertiesJson === 'object' && current.propertiesJson ? current.propertiesJson : {}),
              usdcAtaAddress: nextUsdcAtaAddress,
            },
          },
        });

        await tx.destination.updateMany({
          where: {
            workspaceId,
            linkedWorkspaceAddressId: workspaceAddressId,
          },
          data: {
            chain: address.chain,
            asset: address.assetScope,
            walletAddress: address.address,
            tokenAccountAddress: address.usdcAtaAddress,
          },
        });

        return address;
      });

      res.json(updated);
    } catch (error) {
      next(error);
    }
  },
);
