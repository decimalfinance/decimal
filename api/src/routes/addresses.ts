import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';

export const addressesRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const createAddressSchema = z.object({
  chain: z.string().default('solana'),
  address: z.string().min(1),
  addressKind: z.string().min(1),
  assetScope: z.string().default('usdc'),
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
    const address = await prisma.workspaceAddress.create({
      data: {
        workspaceId,
        chain: input.chain,
        address: input.address,
        addressKind: input.addressKind,
        assetScope: input.assetScope,
        source: input.source,
        sourceRef: input.sourceRef,
        notes: input.notes,
        propertiesJson: input.properties ?? {},
      },
    });
    res.status(201).json(address);
  } catch (error) {
    next(error);
  }
});
