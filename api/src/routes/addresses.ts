import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET } from '../solana.js';

export const addressesRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
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
