import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { assertWorkspaceAccess } from '../workspace-access.js';

export const workspacesRouter = Router();

workspacesRouter.get('/workspaces', async (req, res, next) => {
  try {
    const memberships = await prisma.organizationMembership.findMany({
      where: {
        userId: req.auth!.userId,
        status: 'active',
      },
      select: {
        organizationId: true,
      },
    });

    const items = await prisma.workspace.findMany({
      where: {
        organizationId: {
          in: memberships.map((membership) => membership.organizationId),
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

workspacesRouter.get('/workspaces/:workspaceId/onboarding', async (req, res, next) => {
  try {
    const params = z.object({
      workspaceId: z.string().uuid(),
    }).parse(req.params);

    const access = await assertWorkspaceAccess(params.workspaceId, req.auth!.userId);

    const [
      addresses,
      labels,
      addressLabels,
      objects,
      addressObjectMappings,
    ] = await prisma.$transaction([
      prisma.workspaceAddress.findMany({
        where: { workspaceId: params.workspaceId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.workspaceLabel.findMany({
        where: { workspaceId: params.workspaceId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.workspaceAddressLabel.findMany({
        where: { workspaceId: params.workspaceId },
        include: {
          workspaceAddress: true,
          label: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.workspaceObject.findMany({
        where: { workspaceId: params.workspaceId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.workspaceAddressObjectMapping.findMany({
        where: { workspaceId: params.workspaceId },
        include: {
          workspaceAddress: true,
          workspaceObject: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({
      workspace: access.workspace,
      addresses,
      labels,
      addressLabels,
      objects,
      addressObjectMappings,
    });
  } catch (error) {
    next(error);
  }
});
