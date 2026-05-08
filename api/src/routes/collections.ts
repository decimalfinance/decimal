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
} from '../collections/requests.js';
import { buildCollectionProofPacket, buildCollectionRunProofPacket } from '../collections/proof.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../auth/organization-access.js';
import { asyncRoute, sendCreated, sendJson, sendList, unwrapItems } from '../infra/route-helpers.js';

export const collectionsRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const collectionRequestParamsSchema = organizationParamsSchema.extend({
  collectionRequestId: z.string().uuid(),
});

const collectionRunParamsSchema = organizationParamsSchema.extend({
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

const collectionRunProofQuerySchema = z.object({
  detail: z.enum(['summary', 'compact', 'full']).default('summary'),
});

collectionsRouter.get('/organizations/:organizationId/collections', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listCollectionRequestsQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);

  const result = await listCollectionRequests(organizationId, {
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

collectionsRouter.post('/organizations/:organizationId/collections', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = createCollectionRequestSchema.parse(req.body);

  sendCreated(res, await createCollectionRequest({
    organizationId,
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

collectionsRouter.post('/organizations/:organizationId/collections/import-csv/preview', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const input = z.object({
    csv: z.string().min(1),
    receivingTreasuryWalletId: z.string().uuid().optional(),
  }).parse(req.body);

  sendJson(res, await previewCollectionRequestsCsv({
    organizationId,
    csv: input.csv,
    defaultReceivingTreasuryWalletId: input.receivingTreasuryWalletId,
  }));
}));

collectionsRouter.get('/organizations/:organizationId/collections/:collectionRequestId', asyncRoute(async (req, res) => {
  const { organizationId, collectionRequestId } = collectionRequestParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);

  sendJson(res, await getCollectionRequestDetail(organizationId, collectionRequestId));
}));

collectionsRouter.get('/organizations/:organizationId/collections/:collectionRequestId/proof', asyncRoute(async (req, res) => {
  const { organizationId, collectionRequestId } = collectionRequestParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendJson(res, await buildCollectionProofPacket(organizationId, collectionRequestId));
}));

collectionsRouter.post('/organizations/:organizationId/collections/:collectionRequestId/cancel', asyncRoute(async (req, res) => {
  const { organizationId, collectionRequestId } = collectionRequestParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);

  sendJson(res, await cancelCollectionRequest({
    organizationId,
    collectionRequestId,
    actorUserId: req.auth!.userId,
  }));
}));

collectionsRouter.get('/organizations/:organizationId/collection-runs', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listCollectionRuns(organizationId)), { limit: 100 });
}));

collectionsRouter.post('/organizations/:organizationId/collection-runs/import-csv', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = collectionRunCsvSchema.parse(req.body);

  sendCreated(res, await importCollectionRunFromCsv({
    organizationId,
    actorUserId: req.auth!.userId,
    csv: input.csv,
    runName: input.runName,
    receivingTreasuryWalletId: input.receivingTreasuryWalletId,
    importKey: input.importKey,
  }));
}));

collectionsRouter.post('/organizations/:organizationId/collection-runs/import-csv/preview', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const input = collectionRunCsvSchema.pick({
    csv: true,
    receivingTreasuryWalletId: true,
  }).parse(req.body);

  sendJson(res, await previewCollectionRunCsv({
    organizationId,
    csv: input.csv,
    receivingTreasuryWalletId: input.receivingTreasuryWalletId,
  }));
}));

collectionsRouter.get('/organizations/:organizationId/collection-runs/:collectionRunId', asyncRoute(async (req, res) => {
  const { organizationId, collectionRunId } = collectionRunParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendJson(res, await getCollectionRunDetail(organizationId, collectionRunId));
}));

collectionsRouter.get('/organizations/:organizationId/collection-runs/:collectionRunId/proof', asyncRoute(async (req, res) => {
  const { organizationId, collectionRunId } = collectionRunParamsSchema.parse(req.params);
  const query = collectionRunProofQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendJson(res, await buildCollectionRunProofPacket(organizationId, collectionRunId, { detail: query.detail }));
}));
