import { Router } from 'express';
import type { WorkspaceAddress, TransferRequest } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';

export const transferRequestsRouter = Router();

type TransferRequestWithAddresses = TransferRequest & {
  sourceWorkspaceAddress: WorkspaceAddress | null;
  destinationWorkspaceAddress: WorkspaceAddress | null;
};

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const amountRawSchema = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative().transform((value) => value.toString()),
]);

const createTransferRequestSchema = z.object({
  sourceWorkspaceAddressId: z.string().uuid().optional(),
  destinationWorkspaceAddressId: z.string().uuid(),
  requestType: z.string().default('wallet_transfer'),
  asset: z.string().default('usdc'),
  amountRaw: amountRawSchema,
  reason: z.string().optional(),
  externalReference: z.string().optional(),
  status: z.string().default('submitted'),
  dueAt: z.string().datetime().optional(),
  propertiesJson: z.record(z.any()).default({}),
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
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      items: items.map(serializeTransferRequest),
    });
  } catch (error) {
    next(error);
  }
});

transferRequestsRouter.post('/workspaces/:workspaceId/transfer-requests', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = createTransferRequestSchema.parse(req.body);

    const [sourceWorkspaceAddress, destinationWorkspaceAddress] = await Promise.all([
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
    ]);

    if (input.sourceWorkspaceAddressId && !sourceWorkspaceAddress) {
      throw new Error('Source wallet not found');
    }

    if (!destinationWorkspaceAddress) {
      throw new Error('Destination wallet not found');
    }

    const transferRequest = await prisma.transferRequest.create({
      data: {
        workspaceId,
        sourceWorkspaceAddressId: sourceWorkspaceAddress?.workspaceAddressId,
        destinationWorkspaceAddressId: destinationWorkspaceAddress.workspaceAddressId,
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
      },
    });

    res.status(201).json(serializeTransferRequest(transferRequest));
  } catch (error) {
    next(error);
  }
});

function serializeTransferRequest(
  request: TransferRequestWithAddresses,
) {
  return {
    transferRequestId: request.transferRequestId,
    workspaceId: request.workspaceId,
    sourceWorkspaceAddressId: request.sourceWorkspaceAddressId,
    destinationWorkspaceAddressId: request.destinationWorkspaceAddressId,
    requestType: request.requestType,
    asset: request.asset,
    amountRaw: request.amountRaw.toString(),
    requestedByUserId: request.requestedByUserId,
    reason: request.reason,
    externalReference: request.externalReference,
    status: request.status,
    requestedAt: request.requestedAt,
    dueAt: request.dueAt,
    propertiesJson: request.propertiesJson,
    sourceWorkspaceAddress: request.sourceWorkspaceAddress
      ? serializeWorkspaceAddressLite(request.sourceWorkspaceAddress)
      : null,
    destinationWorkspaceAddress: request.destinationWorkspaceAddress
      ? serializeWorkspaceAddressLite(request.destinationWorkspaceAddress)
      : null,
  };
}

function serializeWorkspaceAddressLite(
  address: WorkspaceAddress,
) {
  return {
    workspaceAddressId: address.workspaceAddressId,
    address: address.address,
    usdcAtaAddress: address.usdcAtaAddress,
    addressKind: address.addressKind,
    displayName: address.displayName,
    notes: address.notes,
  };
}
