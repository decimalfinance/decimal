import { Router } from 'express';
import { prisma } from '../prisma.js';
import { config } from '../config.js';
import { ACTIVE_MATCHING_REQUEST_STATUSES } from '../transfer-request-lifecycle.js';

export const internalRouter = Router();

internalRouter.use((req, res, next) => {
  if (!config.controlPlaneServiceToken) {
    next();
    return;
  }

  const token = req.header('x-service-token');
  if (token !== config.controlPlaneServiceToken) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Internal service token required',
    });
    return;
  }

  next();
});

internalRouter.get('/internal/workspaces', async (_req, res, next) => {
  try {
    const items = await prisma.workspace.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        workspaceId: true,
        workspaceName: true,
      },
    });

    res.json({
      items: items.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
      })),
    });
  } catch (error) {
    next(error);
  }
});

internalRouter.get('/internal/workspaces/:workspaceId/matching-context', async (req, res, next) => {
  try {
    const workspaceId = req.params.workspaceId;

    const [workspace, addresses, transferRequests] = await prisma.$transaction([
      prisma.workspace.findUniqueOrThrow({
        where: { workspaceId },
      }),
      prisma.workspaceAddress.findMany({
        where: { workspaceId, isActive: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.transferRequest.findMany({
        where: {
          workspaceId,
          asset: 'usdc',
          status: {
            in: [...ACTIVE_MATCHING_REQUEST_STATUSES],
          },
        },
        include: {
          sourceWorkspaceAddress: true,
          destinationWorkspaceAddress: true,
          executionRecords: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          destination: {
            include: {
              counterparty: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({
      workspace,
      addresses: addresses.map((address) => ({
        workspaceAddressId: address.workspaceAddressId,
        workspaceId: address.workspaceId,
        chain: address.chain,
        address: address.address,
        usdcAtaAddress: address.usdcAtaAddress,
        addressKind: address.addressKind,
        displayName: address.displayName,
        notes: address.notes,
        createdAt: address.createdAt,
        updatedAt: address.updatedAt,
      })),
      transferRequests: transferRequests.map((request) => ({
        transferRequestId: request.transferRequestId,
        workspaceId: request.workspaceId,
        paymentOrderId: request.paymentOrderId,
        sourceWorkspaceAddressId: request.sourceWorkspaceAddressId,
        destinationWorkspaceAddressId: request.destinationWorkspaceAddressId,
        requestType: request.requestType,
        asset: request.asset,
        amountRaw: request.amountRaw.toString(),
        reason: request.reason,
        externalReference: request.externalReference,
        status: request.status,
        requestedAt: request.requestedAt,
        dueAt: request.dueAt,
        sourceWorkspaceAddress: request.sourceWorkspaceAddress
          ? {
              workspaceAddressId: request.sourceWorkspaceAddress.workspaceAddressId,
              address: request.sourceWorkspaceAddress.address,
              usdcAtaAddress: request.sourceWorkspaceAddress.usdcAtaAddress,
              addressKind: request.sourceWorkspaceAddress.addressKind,
              displayName: request.sourceWorkspaceAddress.displayName,
            }
          : null,
        destination: request.destination
          ? {
              destinationId: request.destination.destinationId,
              counterpartyId: request.destination.counterpartyId,
              linkedWorkspaceAddressId: request.destination.linkedWorkspaceAddressId,
              label: request.destination.label,
              destinationType: request.destination.destinationType,
              trustState: request.destination.trustState,
              isInternal: request.destination.isInternal,
              isActive: request.destination.isActive,
              walletAddress: request.destination.walletAddress,
              tokenAccountAddress: request.destination.tokenAccountAddress,
              counterparty: request.destination.counterparty
                ? {
                    counterpartyId: request.destination.counterparty.counterpartyId,
                    displayName: request.destination.counterparty.displayName,
                    category: request.destination.counterparty.category,
                    status: request.destination.counterparty.status,
                  }
                : null,
            }
          : null,
        destinationWorkspaceAddress: request.destinationWorkspaceAddress
          ? {
              workspaceAddressId: request.destinationWorkspaceAddress.workspaceAddressId,
              address: request.destinationWorkspaceAddress.address,
              usdcAtaAddress: request.destinationWorkspaceAddress.usdcAtaAddress,
              addressKind: request.destinationWorkspaceAddress.addressKind,
              displayName: request.destinationWorkspaceAddress.displayName,
            }
          : null,
        latestExecution: request.executionRecords[0]
          ? {
              executionRecordId: request.executionRecords[0].executionRecordId,
              submittedSignature: request.executionRecords[0].submittedSignature,
              executionSource: request.executionRecords[0].executionSource,
              state: request.executionRecords[0].state,
              submittedAt: request.executionRecords[0].submittedAt,
            }
          : null,
      })),
    });
  } catch (error) {
    next(error);
  }
});
