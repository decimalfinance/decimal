import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../infra/prisma.js';
import { assertOrganizationAccess } from '../auth/organization-access.js';

export const opsRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

opsRouter.get('/organizations/:organizationId/members', async (req, res, next) => {
  try {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    const access = await assertOrganizationAccess(organizationId, req.auth!);

    const items = await prisma.organizationMembership.findMany({
      where: {
        organizationId: access.organization.organizationId,
        status: 'active',
      },
      include: {
        user: {
          select: {
            userId: true,
            email: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: [
        { role: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    res.json({
      items: items.map((membership) => ({
        membershipId: membership.membershipId,
        role: membership.role,
        status: membership.status,
        user: membership.user,
      })),
    });
  } catch (error) {
    next(error);
  }
});
