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
      collectionsOpenCount,
      unreviewedWalletsCount,
    ] = await Promise.all([
      prisma.paymentOrder.count({ where: { organizationId, state: 'pending_approval' } }),
      prisma.paymentOrder.count({ where: { organizationId, state: { in: ['draft', 'proposed', 'executed'] } } }),
      prisma.paymentOrder.count({ where: { organizationId, state: { notIn: ['settled', 'cancelled'] } } }),
      prisma.collectionRequest.count({ where: { organizationId, state: { notIn: ['collected', 'closed', 'cancelled'] } } }),
      prisma.counterpartyWallet.count({
        where: {
          organizationId,
          trustState: 'unreviewed',
          isActive: true,
        },
      }),
    ]);

    // A wallet no longer has a direction — same row may serve outbound and
    // inbound flows. Surface a single unreviewed-wallets total under both
    // legacy field names so the existing frontend OrganizationSummary type
    // keeps compiling. Drop one of these once the UI converges on a single
    // count.
    res.json({
      pendingApprovalCount,
      executionQueueCount,
      paymentsIncompleteCount,
      collectionsOpenCount,
      destinationsUnreviewedCount: unreviewedWalletsCount,
      payersUnreviewedCount: unreviewedWalletsCount,
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

organizationsRouter.post('/organizations/:organizationId/join', async (_req, _res, next) => {
  next(forbidden('Organizations can only be joined through an invite link.'));
});

function assertVerifiedEmail(emailVerifiedAt: string | null) {
  if (!emailVerifiedAt) {
    throw forbidden('Email verification is required before joining or creating an organization.');
  }
}
