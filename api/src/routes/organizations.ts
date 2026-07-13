import { Router } from 'express';
import { z } from 'zod';
import { forbidden } from '../infra/api-errors.js';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { ensureDefaultAutomationAgentWithWallet } from '../agents/automation.js';
import { prisma } from '../infra/prisma.js';
import { ensureManagedPersonalWalletForUser } from '../wallets/provisioning.js';

export const organizationsRouter = Router();

const orgParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const createOrganizationSchema = z.object({
  organizationName: z.string().min(1),
});

async function assertOrganizationNameAvailable(organizationName: string) {
  const existing = await prisma.organization.findFirst({
    where: {
      organizationName: {
        equals: organizationName,
        mode: 'insensitive',
      },
    },
    select: { organizationId: true },
  });

  if (existing) {
    throw new Error(`Organization name "${organizationName}" already exists`);
  }
}

organizationsRouter.get('/organizations', async (req, res, next) => {
  try {
    // Scoped to the current user's memberships. We intentionally do not expose
    // a directory of other organizations — users only see what they belong to.
    const items = await prisma.organization.findMany({
      where: {
        memberships: {
          some: {
            userId: req.auth!.userId,
            status: 'active',
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      items: items.map((organization) => ({
        organizationId: organization.organizationId,
        organizationName: organization.organizationName,
        status: organization.status,
        isMember: true,
      })),
    });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.get('/organizations/:organizationId/summary', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const [
      pendingApprovalCount,
      executionQueueCount,
      paymentsIncompleteCount,
      unreviewedWalletsCount,
      codingInboxCount,
    ] = await Promise.all([
      prisma.paymentOrder.count({ where: { organizationId, state: 'pending_approval' } }),
      prisma.paymentOrder.count({ where: { organizationId, state: { in: ['draft', 'proposed', 'executed'] } } }),
      prisma.paymentOrder.count({ where: { organizationId, state: { notIn: ['settled', 'cancelled'] } } }),
      prisma.counterpartyWallet.count({
        where: {
          organizationId,
          trustState: 'unreviewed',
          isActive: true,
        },
      }),
      prisma.paymentOrder.count({
        where: {
          organizationId,
          state: 'settled',
          accountingSyncs: { none: { provider: 'quickbooks', status: 'synced' } },
        },
      }),
    ]);

    res.json({
      pendingApprovalCount,
      executionQueueCount,
      paymentsIncompleteCount,
      unreviewedWalletsCount,
      codingInboxCount,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations', async (req, res, next) => {
  try {
    assertVerifiedEmail(req.auth!.userEmailVerifiedAt);
    const input = createOrganizationSchema.parse(req.body);
    const organizationName = input.organizationName.trim();
    await assertOrganizationNameAvailable(organizationName);

    const organization = await prisma.$transaction(async (tx) => {
      const createdOrganization = await tx.organization.create({
        data: {
          organizationName,
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
    const [personalWalletProvisioning, agentProvisioning] = await Promise.all([
      ensureManagedPersonalWalletForUser(req.auth!.userId, {
        label: 'Decimal signing wallet',
      }),
      ensureDefaultAutomationAgentWithWallet(organization.organizationId),
    ]);

    res.status(201).json({
      organizationId: organization.organizationId,
      organizationName: organization.organizationName,
      role: 'owner',
      status: organization.status,
      provisioning: {
        personalWallet: personalWalletProvisioning,
        defaultAgent: agentProvisioning,
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- Access tiers (QBO's primary-admin model) --------------------------------
// Exactly one primary admin (role 'owner') per org. Admins can do everything in
// the product, but ONLY the primary admin can promote/demote admins or hand the
// primary-admin seat to someone else. The seat transfers; it is never vacant.

const memberAccessSchema = z.object({ access: z.enum(['admin', 'member']) });

organizationsRouter.patch('/organizations/:organizationId/members/:userId/access', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const { access } = memberAccessSchema.parse(req.body);
    const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
    if (membership.role !== 'owner') {
      throw forbidden('Only the primary admin can promote or demote admins.');
    }
    if (userId === req.auth!.userId) {
      throw forbidden('You are the primary admin — transfer that first if you want to step down.');
    }
    const target = await prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (!target || target.status !== 'active') {
      throw forbidden('That person is not an active member.');
    }
    if (target.role === 'owner') {
      throw forbidden('The primary admin cannot be demoted — transfer the seat instead.');
    }
    await prisma.$transaction(async (tx) => {
      await tx.organizationMembership.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { role: access },
      });
      // Admins hold every capability, so pipeline roles on them are dead weight
      // that would misstate the roster — shed them on promotion.
      if (access === 'admin') {
        await tx.$executeRaw`
          DELETE FROM approval.person_roles
          WHERE organization_id = ${organizationId}::uuid
            AND person_id IN (SELECT id FROM approval.people WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid)`;
      }
    });
    res.json({ ok: true, userId, access });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations/:organizationId/primary-admin/transfer', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
    if (membership.role !== 'owner') {
      throw forbidden('Only the primary admin can transfer the primary-admin seat.');
    }
    if (userId === req.auth!.userId) {
      throw forbidden('You already hold the primary-admin seat.');
    }
    const target = await prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (!target || target.status !== 'active') {
      throw forbidden('That person is not an active member.');
    }
    // Atomic: the seat moves, the previous holder stays on as an admin — the
    // org is never left without a primary admin. The new holder sheds any
    // pipeline roles (full access makes them dead weight).
    await prisma.$transaction([
      prisma.organizationMembership.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { role: 'owner' },
      }),
      prisma.organizationMembership.update({
        where: { organizationId_userId: { organizationId, userId: req.auth!.userId } },
        data: { role: 'admin' },
      }),
      prisma.$executeRaw`
        DELETE FROM approval.person_roles
        WHERE organization_id = ${organizationId}::uuid
          AND person_id IN (SELECT id FROM approval.people WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid)`,
    ]);
    res.json({ ok: true, primaryAdminUserId: userId });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations/:organizationId/join', async (_req, _res, next) => {
  next(forbidden('Organizations can only be joined through an invite link.'));
});

function assertVerifiedEmail(emailVerifiedAt: string | null) {
  if (!emailVerifiedAt) {
    throw forbidden('Email verification is required before joining or creating an organization.');
  }
}
