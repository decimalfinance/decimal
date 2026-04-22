import { Router } from 'express';
import { z } from 'zod';
import {
  cancelCollectionRequest,
  createCollectionRequest,
  getCollectionRequestDetail,
  getCollectionRunDetail,
  importCollectionRunFromCsv,
  isCollectionRequestState,
  listCollectionRequests,
  listCollectionRuns,
  previewCollectionRequestsCsv,
  previewCollectionRunCsv,
} from '../collections.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';
import { asyncRoute, sendCreated, sendJson, sendList, unwrapItems } from '../route-helpers.js';

export const collectionsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const collectionRequestParamsSchema = workspaceParamsSchema.extend({
  collectionRequestId: z.string().uuid(),
});

const collectionRunParamsSchema = workspaceParamsSchema.extend({
  collectionRunId: z.string().uuid(),
});

const amountRawSchema = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative().transform((value) => value.toString()),
]);

const listCollectionRequestsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  state: z.string().refine((value) => isCollectionRequestState(value), 'Invalid collection request state').optional(),
  collectionRunId: z.string().uuid().optional(),
});

const createCollectionRequestSchema = z.object({
  collectionRunId: z.string().uuid().optional(),
  receivingTreasuryWalletId: z.string().uuid(),
  collectionSourceId: z.string().uuid().optional(),
  counterpartyId: z.string().uuid().optional(),
  payerWalletAddress: z.string().trim().max(100).optional(),
  payerTokenAccountAddress: z.string().trim().max(100).optional(),
  amountRaw: amountRawSchema,
  asset: z.string().trim().min(1).max(20).default('usdc'),
  reason: z.string().trim().min(1).max(1000),
  externalReference: z.string().trim().max(200).optional(),
  dueAt: z.string().datetime().optional(),
  metadataJson: z.record(z.any()).default({}),
});

const collectionRunCsvSchema = z.object({
  csv: z.string().min(1),
  runName: z.string().trim().max(200).optional(),
  receivingTreasuryWalletId: z.string().uuid().optional(),
  importKey: z.string().trim().max(200).optional(),
});

collectionsRouter.get('/workspaces/:workspaceId/collections', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  const query = listCollectionRequestsQuerySchema.parse(req.query);
  await assertWorkspaceAccess(workspaceId, req.auth!);

  const result = await listCollectionRequests(workspaceId, {
    limit: query.limit,
    state: query.state,
    collectionRunId: query.collectionRunId,
  });
  sendList(res, unwrapItems(result), {
    limit: query.limit,
    state: query.state ?? null,
    collectionRunId: query.collectionRunId ?? null,
  });
}));

collectionsRouter.post('/workspaces/:workspaceId/collections', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  await assertWorkspaceAdmin(workspaceId, req.auth!);
  const input = createCollectionRequestSchema.parse(req.body);

  sendCreated(res, await createCollectionRequest({
    workspaceId,
    actorUserId: req.auth!.userId,
    collectionRunId: input.collectionRunId,
    receivingTreasuryWalletId: input.receivingTreasuryWalletId,
    collectionSourceId: input.collectionSourceId,
    counterpartyId: input.counterpartyId,
    payerWalletAddress: input.payerWalletAddress,
    payerTokenAccountAddress: input.payerTokenAccountAddress,
    amountRaw: input.amountRaw,
    asset: input.asset,
    reason: input.reason,
    externalReference: input.externalReference,
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    metadataJson: input.metadataJson,
  }));
}));

collectionsRouter.post('/workspaces/:workspaceId/collections/import-csv/preview', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  await assertWorkspaceAccess(workspaceId, req.auth!);
  const input = z.object({
    csv: z.string().min(1),
    receivingTreasuryWalletId: z.string().uuid().optional(),
  }).parse(req.body);

  sendJson(res, await previewCollectionRequestsCsv({
    workspaceId,
    csv: input.csv,
    defaultReceivingTreasuryWalletId: input.receivingTreasuryWalletId,
  }));
}));

collectionsRouter.get('/workspaces/:workspaceId/collections/:collectionRequestId', asyncRoute(async (req, res) => {
  const { workspaceId, collectionRequestId } = collectionRequestParamsSchema.parse(req.params);
  await assertWorkspaceAccess(workspaceId, req.auth!);

  sendJson(res, await getCollectionRequestDetail(workspaceId, collectionRequestId));
}));

collectionsRouter.post('/workspaces/:workspaceId/collections/:collectionRequestId/cancel', asyncRoute(async (req, res) => {
  const { workspaceId, collectionRequestId } = collectionRequestParamsSchema.parse(req.params);
  await assertWorkspaceAdmin(workspaceId, req.auth!);

  sendJson(res, await cancelCollectionRequest({
    workspaceId,
    collectionRequestId,
    actorUserId: req.auth!.userId,
  }));
}));

collectionsRouter.get('/workspaces/:workspaceId/collection-runs', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  await assertWorkspaceAccess(workspaceId, req.auth!);
  sendList(res, unwrapItems(await listCollectionRuns(workspaceId)), { limit: 100 });
}));

collectionsRouter.post('/workspaces/:workspaceId/collection-runs/import-csv', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  await assertWorkspaceAdmin(workspaceId, req.auth!);
  const input = collectionRunCsvSchema.parse(req.body);

  sendCreated(res, await importCollectionRunFromCsv({
    workspaceId,
    actorUserId: req.auth!.userId,
    csv: input.csv,
    runName: input.runName,
    receivingTreasuryWalletId: input.receivingTreasuryWalletId,
    importKey: input.importKey,
  }));
}));

collectionsRouter.post('/workspaces/:workspaceId/collection-runs/import-csv/preview', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  await assertWorkspaceAccess(workspaceId, req.auth!);
  const input = collectionRunCsvSchema.pick({
    csv: true,
    receivingTreasuryWalletId: true,
  }).parse(req.body);

  sendJson(res, await previewCollectionRunCsv({
    workspaceId,
    csv: input.csv,
    receivingTreasuryWalletId: input.receivingTreasuryWalletId,
  }));
}));

collectionsRouter.get('/workspaces/:workspaceId/collection-runs/:collectionRunId', asyncRoute(async (req, res) => {
  const { workspaceId, collectionRunId } = collectionRunParamsSchema.parse(req.params);
  await assertWorkspaceAccess(workspaceId, req.auth!);
  sendJson(res, await getCollectionRunDetail(workspaceId, collectionRunId));
}));
