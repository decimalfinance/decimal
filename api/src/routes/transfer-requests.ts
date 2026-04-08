import { Router } from 'express';
import type { Destination, Prisma, WorkspaceAddress } from '@prisma/client';
import { z } from 'zod';
import { buildApprovalEvaluationSummary, getOrCreateWorkspaceApprovalPolicy } from '../approval-policy.js';
import { prisma } from '../prisma.js';
import { getReconciliationDetail, serializeTransferRequest } from '../reconciliation.js';
import { createTransferRequestEvent } from '../transfer-request-events.js';
import {
  ACTIVE_MATCHING_REQUEST_STATUSES,
  CREATE_REQUEST_STATUSES,
  REQUEST_STATUSES,
  deriveRequestDisplayState,
  getAvailableUserTransitions,
  getAvailableOperatorTransitions,
  isUserRequestStatusTransitionAllowed,
  type RequestStatus,
} from '../transfer-request-lifecycle.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';

export const transferRequestsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const transferRequestParamsSchema = workspaceParamsSchema.extend({
  transferRequestId: z.string().uuid(),
});

const amountRawSchema = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative().transform((value) => value.toString()),
]);

const createTransferRequestSchema = z.object({
  sourceWorkspaceAddressId: z.string().uuid().optional(),
  destinationWorkspaceAddressId: z.string().uuid().optional(),
  destinationId: z.string().uuid().optional(),
  requestType: z.string().default('wallet_transfer'),
  asset: z.string().default('usdc'),
  amountRaw: amountRawSchema,
  reason: z.string().optional(),
  externalReference: z.string().optional(),
  status: z.enum(CREATE_REQUEST_STATUSES).default('submitted'),
  dueAt: z.string().datetime().optional(),
  propertiesJson: z.record(z.any()).default({}),
}).refine(
  (value) => Boolean(value.destinationId || value.destinationWorkspaceAddressId),
  'Either destinationId or destinationWorkspaceAddressId is required',
);

const requestNoteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

const transitionTransferRequestSchema = z.object({
  toStatus: z.enum(REQUEST_STATUSES),
  note: z.string().trim().min(1).max(5000).optional(),
  payloadJson: z.record(z.any()).default({}),
  linkedSignature: z.string().trim().min(1).optional(),
  linkedPaymentId: z.string().uuid().optional(),
  linkedTransferIds: z.array(z.string().uuid()).max(64).default([]),
});

transferRequestsRouter.get('/workspaces/:workspaceId/transfer-requests', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const items = await prisma.transferRequest.findMany({
      where: { workspaceId },
      include: {
        sourceWorkspaceAddress: true,
        destinationWorkspaceAddress: true,
        destination: {
          include: {
            counterparty: true,
          },
        },
        requestedByUser: true,
      },
      orderBy: { requestedAt: 'desc' },
    });

    res.json({
      items: items.map((item) => ({
        ...serializeTransferRequest(item),
        availableTransitions: getAvailableUserTransitions(item.status as RequestStatus),
      })),
    });
  } catch (error) {
    next(error);
  }
});

transferRequestsRouter.get(
  '/workspaces/:workspaceId/transfer-requests/:transferRequestId',
  async (req, res, next) => {
    try {
      const { workspaceId, transferRequestId } = transferRequestParamsSchema.parse(req.params);
      await assertWorkspaceAccess(workspaceId, req.auth!.userId);
      const detail = await getReconciliationDetail(workspaceId, transferRequestId);
      res.json(detail);
    } catch (error) {
      next(error);
    }
  },
);

transferRequestsRouter.post('/workspaces/:workspaceId/transfer-requests', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = createTransferRequestSchema.parse(req.body);

    const [sourceWorkspaceAddress, destinationWorkspaceAddress, destination] = await Promise.all([
      input.sourceWorkspaceAddressId
        ? prisma.workspaceAddress.findFirst({
            where: {
              workspaceId,
              workspaceAddressId: input.sourceWorkspaceAddressId,
            },
          })
        : Promise.resolve(null),
      prisma.workspaceAddress.findFirst({
        where: {
          workspaceId,
          workspaceAddressId: input.destinationWorkspaceAddressId,
        },
      }),
      input.destinationId
        ? prisma.destination.findFirst({
            where: {
              workspaceId,
              destinationId: input.destinationId,
              isActive: true,
            },
            include: {
              counterparty: true,
            },
          })
        : Promise.resolve(null),
    ]);

    if (input.sourceWorkspaceAddressId && !sourceWorkspaceAddress) {
      throw new Error('Source wallet not found');
    }

    const resolvedDestinationWorkspaceAddress =
      destination && destination.linkedWorkspaceAddressId
        ? await prisma.workspaceAddress.findFirst({
            where: {
              workspaceId,
              workspaceAddressId: destination.linkedWorkspaceAddressId,
            },
          })
        : destinationWorkspaceAddress;

    if (input.destinationId && !destination) {
      throw new Error('Destination not found');
    }

    if (destination) {
      enforceDestinationRequestRules(destination, input.status);
    }

    if (!resolvedDestinationWorkspaceAddress) {
      throw new Error('Destination wallet not found');
    }

    const transferRequest = await prisma.$transaction(async (tx) => {
      const created = await tx.transferRequest.create({
        data: {
          workspaceId,
          sourceWorkspaceAddressId: sourceWorkspaceAddress?.workspaceAddressId,
          destinationWorkspaceAddressId: resolvedDestinationWorkspaceAddress.workspaceAddressId,
          destinationId: destination?.destinationId,
          requestType: input.requestType,
          asset: input.asset,
          amountRaw: BigInt(input.amountRaw),
          requestedByUserId: req.auth!.userId,
          reason: input.reason,
          externalReference: input.externalReference,
          status: input.status,
          dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
          propertiesJson: input.propertiesJson,
        },
        include: {
          sourceWorkspaceAddress: true,
          destinationWorkspaceAddress: true,
          destination: {
            include: {
              counterparty: true,
            },
          },
          requestedByUser: true,
        },
      });

      await createTransferRequestEvent(tx, {
        transferRequestId: created.transferRequestId,
        workspaceId,
        eventType: 'request_created',
        actorType: 'user',
        actorId: req.auth!.userId,
        eventSource: 'user',
        beforeState: null,
        afterState: created.status,
        payloadJson: {
          requestType: created.requestType,
          asset: created.asset,
          amountRaw: created.amountRaw.toString(),
        } as Prisma.InputJsonValue,
      });

      if (input.status === 'draft') {
        return created;
      }

      const approvalPolicy = await getOrCreateWorkspaceApprovalPolicy(workspaceId, tx);
      const approvalEvaluation = buildApprovalEvaluationSummary({
        policy: approvalPolicy,
        amountRaw: created.amountRaw,
        destination: buildApprovalDestinationContext(destination, resolvedDestinationWorkspaceAddress),
      });
      const finalStatus = approvalEvaluation.requiresApproval ? 'pending_approval' : 'approved';

      await tx.approvalDecision.create({
        data: {
          approvalPolicyId: approvalPolicy.approvalPolicyId,
          transferRequestId: created.transferRequestId,
          workspaceId,
          actorType: 'system',
          action: approvalEvaluation.requiresApproval ? 'routed_for_approval' : 'auto_approved',
          payloadJson: approvalEvaluation as Prisma.InputJsonValue,
        },
      });

      const updated = await tx.transferRequest.update({
        where: { transferRequestId: created.transferRequestId },
        data: {
          status: finalStatus,
        },
        include: {
          sourceWorkspaceAddress: true,
          destinationWorkspaceAddress: true,
          destination: {
            include: {
              counterparty: true,
            },
          },
          requestedByUser: true,
        },
      });

      await createTransferRequestEvent(tx, {
        transferRequestId: created.transferRequestId,
        workspaceId,
        eventType: approvalEvaluation.requiresApproval ? 'approval_required' : 'approval_auto_approved',
        actorType: 'system',
        eventSource: 'system',
        beforeState: 'submitted',
        afterState: finalStatus,
        payloadJson: approvalEvaluation as Prisma.InputJsonValue,
      });

      return updated;
    });

    res.status(201).json({
      ...serializeTransferRequest(transferRequest),
      availableTransitions: getAvailableUserTransitions(transferRequest.status as RequestStatus),
    });
  } catch (error) {
    next(error);
  }
});

function enforceDestinationRequestRules(
  destination: {
    label: string;
    trustState: string;
    isActive: boolean;
  },
  createStatus: (typeof CREATE_REQUEST_STATUSES)[number],
) {
  if (!destination.isActive) {
    throw new Error(`Destination "${destination.label}" is inactive and cannot be used for new requests`);
  }

  if (destination.trustState === 'blocked') {
    throw new Error(`Destination "${destination.label}" is blocked and cannot be used for new requests`);
  }

  if ((destination.trustState === 'unreviewed' || destination.trustState === 'restricted') && createStatus !== 'draft') {
    throw new Error(
      `Destination "${destination.label}" is ${destination.trustState}. Create the request as draft until it is reviewed or trusted`,
    );
  }
}

transferRequestsRouter.post(
  '/workspaces/:workspaceId/transfer-requests/:transferRequestId/notes',
  async (req, res, next) => {
    try {
      const { workspaceId, transferRequestId } = transferRequestParamsSchema.parse(req.params);
      await assertWorkspaceAccess(workspaceId, req.auth!.userId);
      const input = requestNoteSchema.parse(req.body);

      await ensureTransferRequestExists(workspaceId, transferRequestId);

      const note = await prisma.transferRequestNote.create({
        data: {
          workspaceId,
          transferRequestId,
          authorUserId: req.auth!.userId,
          body: input.body,
        },
        include: {
          authorUser: {
            select: {
              userId: true,
              email: true,
              displayName: true,
            },
          },
        },
      });

      res.status(201).json({
        transferRequestNoteId: note.transferRequestNoteId,
        transferRequestId: note.transferRequestId,
        workspaceId: note.workspaceId,
        body: note.body,
        createdAt: note.createdAt,
        authorUser: note.authorUser,
      });
    } catch (error) {
      next(error);
    }
  },
);

transferRequestsRouter.post(
  '/workspaces/:workspaceId/transfer-requests/:transferRequestId/transitions',
  async (req, res, next) => {
    try {
      const { workspaceId, transferRequestId } = transferRequestParamsSchema.parse(req.params);
      await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
      const input = transitionTransferRequestSchema.parse(req.body);

      const current = await prisma.transferRequest.findFirstOrThrow({
        where: { workspaceId, transferRequestId },
        include: {
          sourceWorkspaceAddress: true,
          destinationWorkspaceAddress: true,
          destination: {
            include: {
              counterparty: true,
            },
          },
          requestedByUser: true,
        },
      });

      const reconciliationDetail = await getReconciliationDetail(workspaceId, transferRequestId);
      const allowsOperatorClose =
        input.toStatus === 'closed'
        && reconciliationDetail.requestDisplayState !== 'pending'
        && current.status !== 'closed'
        && current.status !== 'rejected';

      if (
        !allowsOperatorClose
        && !isUserRequestStatusTransitionAllowed(current.status as RequestStatus, input.toStatus)
      ) {
        throw new Error(
          `Invalid request status transition from ${current.status} to ${input.toStatus}`,
        );
      }

      const updated = await prisma.$transaction(async (tx) => {
        const nextRequest = await tx.transferRequest.update({
          where: { transferRequestId },
          data: {
            status: input.toStatus,
          },
          include: {
            sourceWorkspaceAddress: true,
            destinationWorkspaceAddress: true,
            destination: {
              include: {
                counterparty: true,
              },
            },
            requestedByUser: true,
          },
        });

        await createTransferRequestEvent(tx, {
          transferRequestId,
          workspaceId,
          eventType: 'status_transition',
          actorType: 'user',
          actorId: req.auth!.userId,
          eventSource: 'user',
          beforeState: current.status,
          afterState: input.toStatus,
          linkedSignature: input.linkedSignature ?? null,
          linkedPaymentId: input.linkedPaymentId ?? null,
          linkedTransferIds: input.linkedTransferIds,
          payloadJson: input.payloadJson as Prisma.InputJsonValue,
        });

        if (input.note) {
          await tx.transferRequestNote.create({
            data: {
              workspaceId,
              transferRequestId,
              authorUserId: req.auth!.userId,
              body: input.note,
            },
          });
        }

        if (current.status === 'draft' && input.toStatus === 'submitted') {
          const approvalPolicy = await getOrCreateWorkspaceApprovalPolicy(workspaceId, tx);
          const approvalEvaluation = buildApprovalEvaluationSummary({
            policy: approvalPolicy,
            amountRaw: nextRequest.amountRaw,
            destination: buildApprovalDestinationContext(
              nextRequest.destination,
              nextRequest.destinationWorkspaceAddress,
            ),
          });
          const finalStatus = approvalEvaluation.requiresApproval ? 'pending_approval' : 'approved';

          await tx.approvalDecision.create({
            data: {
              approvalPolicyId: approvalPolicy.approvalPolicyId,
              transferRequestId,
              workspaceId,
              actorType: 'system',
              action: approvalEvaluation.requiresApproval ? 'routed_for_approval' : 'auto_approved',
              payloadJson: approvalEvaluation as Prisma.InputJsonValue,
            },
          });

          const routedRequest = await tx.transferRequest.update({
            where: { transferRequestId },
            data: {
              status: finalStatus,
            },
            include: {
              sourceWorkspaceAddress: true,
              destinationWorkspaceAddress: true,
              destination: {
                include: {
                  counterparty: true,
                },
              },
              requestedByUser: true,
            },
          });

          await createTransferRequestEvent(tx, {
            transferRequestId,
            workspaceId,
            eventType: approvalEvaluation.requiresApproval ? 'approval_required' : 'approval_auto_approved',
            actorType: 'system',
            eventSource: 'system',
            beforeState: 'submitted',
            afterState: finalStatus,
            payloadJson: approvalEvaluation as Prisma.InputJsonValue,
          });

          return routedRequest;
        }

        return nextRequest;
      });

      const nextDisplayState = deriveRequestDisplayState({
        requestStatus: updated.status,
        matchStatus: reconciliationDetail.match?.matchStatus ?? null,
        exceptionStatuses: reconciliationDetail.exceptions.map((item) => item.status),
      });

      res.json({
        ...serializeTransferRequest(updated),
        availableTransitions: getAvailableOperatorTransitions({
          requestStatus: updated.status as RequestStatus,
          requestDisplayState: nextDisplayState,
        }),
      });
    } catch (error) {
      next(error);
    }
  },
);

async function ensureTransferRequestExists(workspaceId: string, transferRequestId: string) {
  await prisma.transferRequest.findFirstOrThrow({
    where: { workspaceId, transferRequestId },
    select: { transferRequestId: true },
  });
}

export const matchingActiveRequestStatuses = [...ACTIVE_MATCHING_REQUEST_STATUSES];

function buildApprovalDestinationContext(
  destination: Pick<Destination, 'label' | 'trustState' | 'isInternal'> | null | undefined,
  workspaceAddress: Pick<WorkspaceAddress, 'displayName' | 'address'> | null | undefined,
) {
  if (destination) {
    return {
      label: destination.label,
      trustState: destination.trustState,
      isInternal: destination.isInternal,
    };
  }

  return {
    label: workspaceAddress?.displayName ?? workspaceAddress?.address ?? 'unnamed destination',
    trustState: 'unreviewed',
    isInternal: false,
  };
}
