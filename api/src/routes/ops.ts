import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { assertOrganizationAccess } from '../organization-access.js';
import { listOrganizationAuditLog } from '../organization-audit-log.js';

export const opsRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  entityType: z.enum(['payment_order', 'transfer_request', 'approval', 'execution']).optional(),
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

opsRouter.get('/organizations/:organizationId/audit-log', async (req, res, next) => {
  try {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    const query = auditLogQuerySchema.parse(req.query);
    await assertOrganizationAccess(organizationId, req.auth!);

    res.json(await listOrganizationAuditLog({
      organizationId,
      limit: query.limit,
      entityType: query.entityType,
    }));
  } catch (error) {
    next(error);
  }
});

opsRouter.get('/organizations/:organizationId/ops-health', async (req, res, next) => {
  try {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);

    await prisma.$queryRaw`SELECT 1`;
    const [proposalCounts, paymentCounts, runCounts] = await Promise.all([
      prisma.decimalProposal.groupBy({
        by: ['status'],
        where: { organizationId },
        _count: { status: true },
      }),
      prisma.paymentOrder.groupBy({
        by: ['state'],
        where: { organizationId },
        _count: { state: true },
      }),
      prisma.paymentRun.groupBy({
        by: ['state'],
        where: { organizationId },
        _count: { state: true },
      }),
    ]);

    res.json({
      postgres: 'ok',
      settlementMode: 'rpc',
      indexerStatus: 'not_required',
      proposals: groupCounts(proposalCounts, 'status'),
      paymentOrders: groupCounts(paymentCounts, 'state'),
      paymentRuns: groupCounts(runCounts, 'state'),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

function groupCounts<T extends string>(
  rows: Array<Record<T, string> & { _count: Record<T, number> }>,
  key: T,
) {
  return Object.fromEntries(
    rows.map((row) => [row[key], row._count[key]]),
  );
}
