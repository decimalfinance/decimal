import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';

export const labelsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const createLabelSchema = z.object({
  labelName: z.string().min(1),
  labelType: z.string().min(1),
  color: z.string().optional(),
  description: z.string().optional(),
});

const attachLabelSchema = z.object({
  workspaceAddressId: z.string().uuid(),
  labelId: z.string().uuid(),
});

labelsRouter.get('/workspaces/:workspaceId/labels', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const items = await prisma.workspaceLabel.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

labelsRouter.post('/workspaces/:workspaceId/labels', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = createLabelSchema.parse(req.body);
    const label = await prisma.workspaceLabel.create({
      data: {
        workspaceId,
        labelName: input.labelName,
        labelType: input.labelType,
        color: input.color,
        description: input.description,
      },
    });
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

labelsRouter.get('/workspaces/:workspaceId/address-labels', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const items = await prisma.workspaceAddressLabel.findMany({
      where: { workspaceId },
      include: {
        workspaceAddress: true,
        label: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

labelsRouter.post('/workspaces/:workspaceId/address-labels', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = attachLabelSchema.parse(req.body);
    const link = await prisma.workspaceAddressLabel.upsert({
      where: {
        workspaceId_workspaceAddressId_labelId: {
          workspaceId,
          workspaceAddressId: input.workspaceAddressId,
          labelId: input.labelId,
        },
      },
      update: {},
      create: {
        workspaceId,
        workspaceAddressId: input.workspaceAddressId,
        labelId: input.labelId,
      },
    });
    res.status(201).json(link);
  } catch (error) {
    next(error);
  }
});
