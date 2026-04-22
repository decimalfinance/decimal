import { Router } from 'express';
import { prisma } from '../prisma.js';
import { config } from '../config.js';
import { ACTIVE_MATCHING_REQUEST_STATUSES } from '../transfer-request-lifecycle.js';
import { getMatchingIndexVersion, subscribeToMatchingIndexChanges } from '../matching-index-events.js';

export const internalRouter = Router();

internalRouter.use((req, res, next) => {
  if (!config.controlPlaneServiceToken) {
    if (config.nodeEnv === 'production') {
      res.status(503).json({
        error: 'InternalServiceTokenNotConfigured',
        message: 'Internal service routes require CONTROL_PLANE_SERVICE_TOKEN in production',
      });
      return;
    }

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
    res.json(await buildWorkspaceMatchingSnapshot(req.params.workspaceId));
  } catch (error) {
    next(error);
  }
});

internalRouter.get('/internal/matching-index', async (_req, res, next) => {
  try {
    const workspaces = await prisma.workspace.findMany({
      orderBy: { createdAt: 'desc' },
      select: { workspaceId: true },
    });

    const snapshots = await Promise.all(
      workspaces.map(async (workspace) => buildWorkspaceMatchingSnapshot(workspace.workspaceId)),
    );

    res.json({
      version: getMatchingIndexVersion(),
      generatedAt: new Date().toISOString(),
      workspaces: snapshots,
    });
  } catch (error) {
    next(error);
  }
});

internalRouter.get('/internal/matching-index/events', (req, res) => {
  const unsubscribe = subscribeToMatchingIndexChanges(res);
  req.on('close', unsubscribe);
});

async function buildWorkspaceMatchingSnapshot(workspaceId: string) {
  const [workspace, treasuryWallets, transferRequests] = await prisma.$transaction([
    prisma.workspace.findUniqueOrThrow({
      where: { workspaceId },
    }),
    prisma.treasuryWallet.findMany({
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
        sourceTreasuryWallet: true,
        executionRecords: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        destination: {
          include: {
            counterparty: true,
          },
        },
        collectionRequest: {
          include: {
            collectionSource: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const serializedTreasuryWallets = treasuryWallets.map((wallet) => ({
    workspaceId: wallet.workspaceId,
    treasuryWalletId: wallet.treasuryWalletId,
    address: wallet.address,
    usdcAtaAddress: wallet.usdcAtaAddress,
  }));
  const serializedMatches = transferRequests.map((request) => ({
    transferRequestId: request.transferRequestId,
    workspaceId: request.workspaceId,
    paymentOrderId: request.paymentOrderId,
    sourceTreasuryWalletId: request.sourceTreasuryWalletId,
    collectionRequestId: request.collectionRequest?.collectionRequestId ?? null,
    collectionSourceId: request.collectionRequest?.collectionSourceId ?? null,
    expectedSourceWalletAddress: request.collectionRequest?.collectionSource?.walletAddress ?? request.collectionRequest?.payerWalletAddress ?? null,
    expectedSourceTokenAccountAddress: request.collectionRequest?.collectionSource?.tokenAccountAddress ?? request.collectionRequest?.payerTokenAccountAddress ?? null,
    collectionSourceTrustState: request.collectionRequest?.collectionSource?.trustState ?? null,
    requestType: request.requestType,
    asset: request.asset,
    amountRaw: request.amountRaw.toString(),
    reason: request.reason,
    externalReference: request.externalReference,
    status: request.status,
    requestedAt: request.requestedAt,
    dueAt: request.dueAt,
    sourceTreasuryWallet: request.sourceTreasuryWallet
      ? {
          treasuryWalletId: request.sourceTreasuryWallet.treasuryWalletId,
          address: request.sourceTreasuryWallet.address,
          usdcAtaAddress: request.sourceTreasuryWallet.usdcAtaAddress,
        }
      : null,
    destination: {
      destinationId: request.destination.destinationId,
      walletAddress: request.destination.walletAddress,
      tokenAccountAddress: request.destination.tokenAccountAddress,
      label: request.destination.label,
      trustState: request.destination.trustState,
      isInternal: request.destination.isInternal,
      counterparty: request.destination.counterparty
        ? {
            counterpartyId: request.destination.counterparty.counterpartyId,
            displayName: request.destination.counterparty.displayName,
          }
        : null,
    },
    latestExecution: request.executionRecords[0]
      ? {
          executionRecordId: request.executionRecords[0].executionRecordId,
          submittedSignature: request.executionRecords[0].submittedSignature,
          executionSource: request.executionRecords[0].executionSource,
          state: request.executionRecords[0].state,
          submittedAt: request.executionRecords[0].submittedAt,
        }
      : null,
  }));

  return {
    workspace,
    treasuryWallets: serializedTreasuryWallets,
    matches: serializedMatches,
    addresses: serializedTreasuryWallets,
    transferRequests: serializedMatches,
  };
}
