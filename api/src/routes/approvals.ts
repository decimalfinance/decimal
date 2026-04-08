import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  getOrCreateWorkspaceApprovalPolicy,
  normalizeApprovalPolicyRule,
  serializeApprovalPolicy,
} from '../approval-policy.js';
import { listApprovalInbox } from '../reconciliation.js';
import { prisma } from '../prisma.js';
import { createTransferRequestEvent } from '../transfer-request-events.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';

export const approvalsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const transferRequestParamsSchema = workspaceParamsSchema.extend({
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

approvalsRouter.get('/workspaces/:workspaceId/approval-policy', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const policy = await getOrCreateWorkspaceApprovalPolicy(workspaceId);
    res.json(serializeApprovalPolicy(policy));
  } catch (error) {
    next(error);
  }
});

approvalsRouter.patch('/workspaces/:workspaceId/approval-policy', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = approvalPolicyUpdateSchema.parse(req.body);
    const existing = await getOrCreateWorkspaceApprovalPolicy(workspaceId);
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

approvalsRouter.get('/workspaces/:workspaceId/approval-inbox', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = approvalInboxQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const result = await listApprovalInbox({
      workspaceId,
      limit: query.limit,
      statuses:
        query.status === 'all'
          ? ['pending_approval', 'escalated']
          : query.status
            ? [query.status]
            : ['pending_approval', 'escalated'],
    });

    res.json({
      servedAt: new Date().toISOString(),
      approvalPolicy: result.approvalPolicy,
      items: result.items,
    });
  } catch (error) {
    next(error);
  }
});

approvalsRouter.post(
  '/workspaces/:workspaceId/transfer-requests/:transferRequestId/approval-decisions',
  async (req, res, next) => {
    try {
      const { workspaceId, transferRequestId } = transferRequestParamsSchema.parse(req.params);
      await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
      const input = approvalDecisionSchema.parse(req.body);

      const current = await prisma.transferRequest.findFirstOrThrow({
        where: { workspaceId, transferRequestId },
      });

      if (current.status !== 'pending_approval' && current.status !== 'escalated') {
        throw new Error('Only pending approval requests can receive approval decisions');
      }

      const nextStatus = getDecisionTargetStatus(current.status, input.action);
      const policy = await getOrCreateWorkspaceApprovalPolicy(workspaceId);

      const updated = await prisma.$transaction(async (tx) => {
        const decision = await tx.approvalDecision.create({
          data: {
            approvalPolicyId: policy.approvalPolicyId,
            transferRequestId,
            workspaceId,
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
          workspaceId,
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
