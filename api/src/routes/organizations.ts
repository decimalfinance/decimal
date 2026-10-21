import { Router } from 'express';
import { z } from 'zod';
import { ApiError, badRequest, forbidden } from '../infra/api-errors.js';
import { assertOrganizationAccess, isAdminRole } from '../auth/organization-access.js';
import { ensureDefaultAutomationAgentWithWallet } from '../agents/automation.js';
import { prisma } from '../infra/prisma.js';
import { mintIntakeSlug } from '../payments/inbound-email/slug.js';
import { listTradingNames, removeTradingName, restoreTradingName } from '../payments/trading-names.js';
import { ensureManagedPersonalWalletForUser } from '../wallets/provisioning.js';

export const organizationsRouter = Router();

const orgParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const createOrganizationSchema = z.object({
  organizationName: z.string().min(1),
});

/** How an organisation's name is kept: trimmed, with runs of spaces made one. */
function tidyName(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

// No two organisations share a name, whatever the capitals. A rename may
// change its own name's capitals, so it leaves itself out.
async function assertOrganizationNameAvailable(organizationName: string, exceptOrganizationId?: string) {
  const existing = await prisma.organization.findFirst({
    where: {
      organizationName: {
        equals: organizationName,
        mode: 'insensitive',
      },
      ...(exceptOrganizationId ? { NOT: { organizationId: exceptOrganizationId } } : {}),
    },
    select: { organizationId: true },
  });

  if (existing) {
    // Coded, so the page can say it in its own words beside the field.
    throw new ApiError(409, 'organization_name_taken', `An organisation called "${organizationName}" already exists.`);
  }
}

organizationsRouter.get('/organizations/:organizationId/summary', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const [
      pendingApprovalCount,
      executionQueueCount,
      paymentsIncompleteCount,
      unreviewedWalletsCount,
    ] = await Promise.all([
      prisma.paymentOrder.count({ where: { organizationId, state: 'submitted' } }),
      prisma.paymentOrder.count({ where: { organizationId, state: { in: ['submitted', 'proposed', 'executed'] } } }),
      prisma.paymentOrder.count({ where: { organizationId, state: { notIn: ['settled', 'cancelled'] } } }),
      prisma.counterpartyWallet.count({
        where: {
          organizationId,
          trustState: 'unreviewed',
          isActive: true,
        },
      }),
    ]);

    res.json({
      pendingApprovalCount,
      executionQueueCount,
      paymentsIncompleteCount,
      unreviewedWalletsCount,
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
    const organizationName = tidyName(input.organizationName);
    if (!organizationName) throw badRequest('Enter the organisation’s name.');
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
          role: 'primary_admin',
        },
      });

      // The org's inbound invoice address, minted once and never re-minted.
      await mintIntakeSlug(tx, createdOrganization.organizationId, organizationName);

      // The approval engine is built HERE, in the same transaction as the
      // address. An organization that can receive a bill must already be able
      // to route one — you cannot hand out an intake address that leads
      // somewhere with no approvers. Building it lazily on the first bill is
      // what made two invoices arriving together deadlock: both tried to
      // construct the same structure at once.
      const { setupEngineInTx } = await import('../approvals/wiring.js');
      await setupEngineInTx(tx, createdOrganization.organizationId);

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
      role: 'primary_admin',
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

// --- Organisation's details ---------------------------------------------------
// Admins change these; anyone in the organisation reads them.

const renameOrganizationSchema = z.object({ organizationName: z.string().max(400) });

organizationsRouter.patch('/organizations/:organizationId', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
    if (!isAdminRole(membership.role)) throw forbidden('Only an admin can rename the organisation.');
    const organizationName = tidyName(renameOrganizationSchema.parse(req.body).organizationName);
    if (!organizationName) throw badRequest('Enter a name for the organisation.');
    if (organizationName.length > 120) throw badRequest('Use 120 characters or fewer.');
    await assertOrganizationNameAvailable(organizationName, organizationId);
    // The forwarding address was minted once, from the first name, and stays.
    const organization = await prisma.organization.update({
      where: { organizationId },
      data: { organizationName },
      select: { organizationId: true, organizationName: true, status: true },
    });
    res.json({ ...organization, role: membership.role });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.get('/organizations/:organizationId/trading-names', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    res.json({ items: await listTradingNames(organizationId) });
  } catch (error) {
    next(error);
  }
});

const tradingNameBodySchema = z.object({ name: z.string().trim().min(1).max(120) });

// Taking a name off means bills addressed to it are asked about again, so it
// is an admin's call, as adding one is.
organizationsRouter.post('/organizations/:organizationId/trading-names/remove', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
    if (!isAdminRole(membership.role)) throw forbidden('Only an admin can take a name off.');
    const { name } = tradingNameBodySchema.parse(req.body);
    const actor = await prisma.user.findUniqueOrThrow({ where: { userId: req.auth!.userId }, select: { displayName: true } });
    res.json(await removeTradingName({ organizationId, name, actorUserId: req.auth!.userId, actorName: actor.displayName }));
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations/:organizationId/trading-names/restore', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
    if (!isAdminRole(membership.role)) throw forbidden('Only an admin can put a name back.');
    const { name } = tradingNameBodySchema.parse(req.body);
    res.json(await restoreTradingName({ organizationId, name }));
  } catch (error) {
    next(error);
  }
});

// --- Access tiers (QBO's primary-admin model) --------------------------------
// Exactly one primary admin (role 'primary_admin') per org. Admins can do everything in
// the product, but ONLY the primary admin can promote/demote admins or hand the
// primary-admin seat to someone else. The seat transfers; it is never vacant.

const memberAccessSchema = z.object({ access: z.enum(['admin', 'member']) });

organizationsRouter.patch('/organizations/:organizationId/members/:userId/access', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const { access } = memberAccessSchema.parse(req.body);
    const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
    if (membership.role !== 'primary_admin') {
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
    if (target.role === 'primary_admin') {
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
    if (membership.role !== 'primary_admin') {
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
        data: { role: 'primary_admin' },
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
