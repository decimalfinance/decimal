import { Router } from 'express';
import { z } from 'zod';
import {
  createCollectionSource,
  listCollectionSources,
  updateCollectionSource,
} from '../collection-sources.js';
import { asyncRoute, listQuerySchema, sendCreated, sendJson, sendList, unwrapItems } from '../route-helpers.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';

export const collectionSourcesRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const collectionSourceParamsSchema = workspaceParamsSchema.extend({
  collectionSourceId: z.string().uuid(),
});

const listCollectionSourcesQuerySchema = listQuerySchema({ defaultLimit: 100, maxLimit: 250 });

const createCollectionSourceSchema = z.object({
  counterpartyId: z.string().uuid().optional(),
  chain: z.literal('solana').default('solana'),
  asset: z.literal('usdc').default('usdc'),
  walletAddress: z.string().trim().min(1),
  tokenAccountAddress: z.string().trim().min(1).optional(),
  sourceType: z.string().trim().min(1).max(100).default('payer_wallet'),
  trustState: z.enum(['unreviewed', 'trusted', 'restricted', 'blocked']).default('unreviewed'),
  label: z.string().trim().min(1).max(200),
  notes: z.string().trim().min(1).max(5000).optional(),
  isActive: z.boolean().default(true),
  metadataJson: z.record(z.any()).default({}),
});

const updateCollectionSourceSchema = z.object({
  counterpartyId: z.string().uuid().nullable().optional(),
  walletAddress: z.string().trim().min(1).optional(),
  tokenAccountAddress: z.string().trim().min(1).nullable().optional(),
  sourceType: z.string().trim().min(1).max(100).optional(),
  trustState: z.enum(['unreviewed', 'trusted', 'restricted', 'blocked']).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
  isActive: z.boolean().optional(),
}).refine(
  (value) =>
    value.counterpartyId !== undefined
    || value.walletAddress !== undefined
    || value.tokenAccountAddress !== undefined
    || value.sourceType !== undefined
    || value.trustState !== undefined
    || value.label !== undefined
    || value.notes !== undefined
    || value.isActive !== undefined,
  'At least one field must be updated',
);

collectionSourcesRouter.get('/workspaces/:workspaceId/collection-sources', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  const query = listCollectionSourcesQuerySchema.parse(req.query);
  await assertWorkspaceAccess(workspaceId, req.auth!);
  sendList(res, unwrapItems(await listCollectionSources(workspaceId, query)), { limit: query.limit });
}));

collectionSourcesRouter.post('/workspaces/:workspaceId/collection-sources', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  await assertWorkspaceAdmin(workspaceId, req.auth!);
  const input = createCollectionSourceSchema.parse(req.body);
  sendCreated(res, await createCollectionSource(workspaceId, input));
}));

collectionSourcesRouter.patch('/workspaces/:workspaceId/collection-sources/:collectionSourceId', asyncRoute(async (req, res) => {
  const { workspaceId, collectionSourceId } = collectionSourceParamsSchema.parse(req.params);
  await assertWorkspaceAdmin(workspaceId, req.auth!);
  const input = updateCollectionSourceSchema.parse(req.body);
  sendJson(res, await updateCollectionSource(workspaceId, collectionSourceId, input));
}));
