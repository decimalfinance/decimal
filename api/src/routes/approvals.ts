import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  getOrCreateOrganizationApprovalPolicy,
  normalizeApprovalPolicyRule,
  serializeApprovalPolicy,
} from '../approval-policy.js';
import { listApprovalInbox } from '../settlement-read-model.js';
import { prisma } from '../prisma.js';
import { createTransferRequestEvent } from '../transfer-request-events.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../organization-access.js';
import { sendList } from '../route-helpers.js';

export const approvalsRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const transferRequestParamsSchema = organizationParamsSchema.extend({
  transferRequestId: z.string().uuid(),
});

const approvalPolicyUpdateSchema = z.object({
  policyName: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  ruleJson: z.object({
    requireTrustedDestination: z.boolean().optional(),
    requireApprovalForExternal: z.boolean().optional(),
    requireApprovalForInternal: z.boolean().optional(),
    externalApprovalThresholdRaw: z.string().regex(/^\d+$/).optional(),
    internalApprovalThresholdRaw: z.string().regex(/^\d+$/).optional(),
  }).partial().optional(),
});

const approvalInboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.enum(['pending_approval', 'escalated', 'all']).optional(),
});

const approvalDecisionSchema = z.object({
  action: z.enum(['approve', 'reject', 'escalate']),
  comment: z.string().trim().min(1).max(5000).optional(),
});

approvalsRouter.get('/organizations/:organizationId/approval-policy', async (req, res, next) => {
  try {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const policy = await getOrCreateOrganizationApprovalPolicy(organizationId);
    res.json(serializeApprovalPolicy(policy));
  } catch (error) {
    next(error);
  }
});

approvalsRouter.patch('/organizations/:organizationId/approval-policy', async (req, res, next) => {
  try {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = approvalPolicyUpdateSchema.parse(req.body);
    const existing = await getOrCreateOrganizationApprovalPolicy(organizationId);
    const existingRules = (
      existing.ruleJson && typeof existing.ruleJson === 'object' && !Array.isArray(existing.ruleJson)
        ? existing.ruleJson
        : {}
    ) as Record<string, unknown>;
    const nextRules = normalizeApprovalPolicyRule({
      ...existingRules,
      ...(input.ruleJson ?? {}),
    });

    const updated = await prisma.approvalPolicy.update({
      where: { approvalPolicyId: existing.approvalPolicyId },
      data: {
        policyName: input.policyName ?? existing.policyName,
        isActive: input.isActive ?? existing.isActive,
        ruleJson: nextRules as Prisma.InputJsonValue,
      },
    });

    res.json(serializeApprovalPolicy(updated));
  } catch (error) {
    next(error);
  }
});

approvalsRouter.get('/organizations/:organizationId/approval-inbox', async (req, res, next) => {
  try {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    const query = approvalInboxQuerySchema.parse(req.query);
    await assertOrganizationAccess(organizationId, req.auth!);

    const result = await listApprovalInbox({
      organizationId,
      limit: query.limit,
      statuses:
        query.status === 'all'
          ? ['pending_approval', 'escalated']
          : query.status
            ? [query.status]
            : ['pending_approval', 'escalated'],
    });

    sendList(res, result.items, {
      limit: query.limit,
      status: query.status ?? null,
      approvalPolicy: result.approvalPolicy,
    });
  } catch (error) {
    next(error);
  }
});

approvalsRouter.post(
  '/organizations/:organizationId/transfer-requests/:transferRequestId/approval-decisions',
  async (req, res, next) => {
    try {
      const { organizationId, transferRequestId } = transferRequestParamsSchema.parse(req.params);
      await assertOrganizationAdmin(organizationId, req.auth!);
      const input = approvalDecisionSchema.parse(req.body);

      const current = await prisma.transferRequest.findFirstOrThrow({
        where: { organizationId, transferRequestId },
      });

      if (current.status !== 'pending_approval' && current.status !== 'escalated') {
        throw new Error('Only pending approval requests can receive approval decisions');
      }

      const nextStatus = getDecisionTargetStatus(current.status, input.action);
      const policy = await getOrCreateOrganizationApprovalPolicy(organizationId);

      const updated = await prisma.$transaction(async (tx) => {
        const decision = await tx.approvalDecision.create({
          data: {
            approvalPolicyId: policy.approvalPolicyId,
            transferRequestId,
            organizationId,
            actorUserId: req.auth!.userId,
            actorType: 'user',
            action: input.action,
            comment: input.comment,
          },
        });

        const request = await tx.transferRequest.update({
          where: { transferRequestId },
          data: {
            status: nextStatus,
          },
        });

        await createTransferRequestEvent(tx, {
          transferRequestId,
          organizationId,
          eventType: 'approval_decision',
          actorType: 'user',
          actorId: req.auth!.userId,
          eventSource: 'user',
          beforeState: current.status,
          afterState: nextStatus,
          payloadJson: {
            approvalDecisionId: decision.approvalDecisionId,
            action: input.action,
            comment: input.comment ?? null,
          },
        });

        // Advance the linked payment order's state in lockstep so both the
        // Approvals page and the PaymentDetail page (and Squads-sourced
        // derivedState which reads paymentOrder.state directly) see the
        // decision. updateMany scoped to state='pending_approval' makes this
        // a no-op on already-advanced orders or run-orchestrated orders that
        // sit in a different state.
        if (current.paymentOrderId && (input.action === 'approve' || input.action === 'reject')) {
          const nextOrderState = input.action === 'approve' ? 'approved' : 'cancelled';
          const updateResult = await tx.paymentOrder.updateMany({
            where: {
              paymentOrderId: current.paymentOrderId,
              organizationId,
              state: 'pending_approval',
            },
            data: { state: nextOrderState },
          });
          if (updateResult.count > 0) {
            await tx.paymentOrderEvent.create({
              data: {
                paymentOrderId: current.paymentOrderId,
                organizationId,
                eventType: input.action === 'approve' ? 'payment_order_approved' : 'payment_order_rejected',
                actorType: 'user',
                actorId: req.auth!.userId,
                beforeState: 'pending_approval',
                afterState: nextOrderState,
                linkedTransferRequestId: transferRequestId,
                payloadJson: {
                  approvalDecisionId: decision.approvalDecisionId,
                  action: input.action,
                } satisfies Prisma.InputJsonValue,
              },
            });
          }
        }

        return request;
      });

      res.json({
        transferRequestId: updated.transferRequestId,
        status: updated.status,
      });
    } catch (error) {
      next(error);
    }
  },
);

function getDecisionTargetStatus(
  currentStatus: string,
  action: 'approve' | 'reject' | 'escalate',
) {
  if (action === 'approve') {
    return 'approved';
  }

  if (action === 'reject') {
    return 'rejected';
  }

  if (currentStatus !== 'pending_approval') {
    throw new Error('Only pending approval requests can be escalated');
  }

  return 'escalated';
}
