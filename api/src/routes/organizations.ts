import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../workspace-access.js';

export const organizationsRouter = Router();

const orgParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const createOrganizationSchema = z.object({
  organizationName: z.string().min(1),
  organizationSlug: z.string().min(1),
});

const createWorkspaceSchema = z.object({
  workspaceSlug: z.string().min(1),
  workspaceName: z.string().min(1),
  status: z.string().default('active'),
});

organizationsRouter.get('/organizations', async (req, res, next) => {
  try {
    const items = await prisma.organization.findMany({
      include: {
        memberships: {
          where: { userId: req.auth!.userId },
          take: 1,
        },
        _count: {
          select: { workspaces: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      items: items.map((organization) => {
        const membership = organization.memberships[0] ?? null;
        return {
          organizationId: organization.organizationId,
          organizationName: organization.organizationName,
          organizationSlug: organization.organizationSlug,
          status: organization.status,
          workspaceCount: organization._count.workspaces,
          isMember: Boolean(membership && membership.status === 'active'),
          membershipRole: membership?.status === 'active' ? membership.role : null,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations', async (req, res, next) => {
  try {
    const input = createOrganizationSchema.parse(req.body);

    const organization = await prisma.$transaction(async (tx) => {
      const createdOrganization = await tx.organization.create({
        data: {
          organizationName: input.organizationName,
          organizationSlug: input.organizationSlug,
        },
      });

      await tx.organizationMembership.create({
        data: {
          organizationId: createdOrganization.organizationId,
          userId: req.auth!.userId,
          role: 'owner',
        },
      });

      return createdOrganization;
    });

    res.status(201).json({
      organizationId: organization.organizationId,
      organizationName: organization.organizationName,
      organizationSlug: organization.organizationSlug,
      role: 'owner',
      status: organization.status,
      workspaces: [],
    });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations/:organizationId/join', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);

    const organization = await prisma.organization.findUnique({
      where: { organizationId },
    });

    if (!organization) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Organization not found',
      });
      return;
    }

    const membership = await prisma.organizationMembership.upsert({
      where: {
        organizationId_userId: {
          organizationId,
          userId: req.auth!.userId,
        },
      },
      update: {
        status: 'active',
      },
      create: {
        organizationId,
        userId: req.auth!.userId,
        role: 'member',
        status: 'active',
      },
    });

    const workspaces = await prisma.workspace.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });

    res.status(201).json({
      organizationId: organization.organizationId,
      organizationName: organization.organizationName,
      organizationSlug: organization.organizationSlug,
      role: membership.role,
      status: organization.status,
      workspaces,
    });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.get('/organizations/:organizationId/workspaces', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!.userId);

    const items = await prisma.workspace.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ items });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations/:organizationId/workspaces', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!.userId);
    const input = createWorkspaceSchema.parse(req.body);

    const workspace = await prisma.workspace.create({
      data: {
        organizationId,
        workspaceSlug: input.workspaceSlug,
        workspaceName: input.workspaceName,
        status: input.status,
      },
    });

    res.status(201).json(workspace);
  } catch (error) {
    next(error);
  }
});
