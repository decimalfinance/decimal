import { Router } from 'express';
import { z } from 'zod';
import {
  createCollectionSource,
  listCollectionSources,
  updateCollectionSource,
} from '../collections/sources.js';
import { asyncRoute, listQuerySchema, sendCreated, sendJson, sendList, unwrapItems } from '../infra/route-helpers.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../auth/organization-access.js';

export const collectionSourcesRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const collectionSourceParamsSchema = organizationParamsSchema.extend({
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
  notes: z.string().trim().max(5000).nullable().optional(),
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

collectionSourcesRouter.get('/organizations/:organizationId/collection-sources', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listCollectionSourcesQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listCollectionSources(organizationId, query)), { limit: query.limit });
}));

collectionSourcesRouter.post('/organizations/:organizationId/collection-sources', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = createCollectionSourceSchema.parse(req.body);
  sendCreated(res, await createCollectionSource(organizationId, input));
}));

collectionSourcesRouter.patch('/organizations/:organizationId/collection-sources/:collectionSourceId', asyncRoute(async (req, res) => {
  const { organizationId, collectionSourceId } = collectionSourceParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = updateCollectionSourceSchema.parse(req.body);
  sendJson(res, await updateCollectionSource(organizationId, collectionSourceId, input));
}));
