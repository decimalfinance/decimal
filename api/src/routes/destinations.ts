import { Router } from 'express';
import { z } from 'zod';
import {
  createCounterparty,
  createDestination,
  listCounterparties,
  listDestinations,
  updateCounterparty,
  updateDestination,
} from '../destinations.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';
import { asyncRoute, listQuerySchema, sendCreated, sendList, sendJson, unwrapItems } from '../route-helpers.js';

export const destinationsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const destinationParamsSchema = workspaceParamsSchema.extend({
  destinationId: z.string().uuid(),
});

const counterpartyParamsSchema = workspaceParamsSchema.extend({
  counterpartyId: z.string().uuid(),
});

const booleanQuerySchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return value;
}, z.boolean().default(false));

const listAddressBookQuerySchema = listQuerySchema({ defaultLimit: 100, maxLimit: 250 }).extend({
  includeInternal: booleanQuerySchema,
});

const createCounterpartySchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100).default('vendor'),
  externalReference: z.string().trim().min(1).max(200).optional(),
  status: z.string().trim().min(1).max(50).default('active'),
  metadataJson: z.record(z.any()).default({}),
});

const updateCounterpartySchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  externalReference: z.string().trim().max(200).optional(),
  status: z.string().trim().min(1).max(50).optional(),
}).refine(
  (value) =>
    value.displayName !== undefined
    || value.category !== undefined
    || value.externalReference !== undefined
    || value.status !== undefined,
  'At least one field must be updated',
);

const createDestinationSchema = z.object({
  counterpartyId: z.string().uuid().optional(),
  chain: z.literal('solana').default('solana'),
  asset: z.literal('usdc').default('usdc'),
  walletAddress: z.string().trim().min(1),
  tokenAccountAddress: z.string().trim().min(1).optional(),
  destinationType: z.string().trim().min(1).max(100).default('wallet'),
  trustState: z.enum(['unreviewed', 'trusted', 'restricted', 'blocked']).default('unreviewed'),
  label: z.string().trim().min(1).max(200),
  notes: z.string().trim().min(1).max(5000).optional(),
  isInternal: z.boolean().default(false),
  isActive: z.boolean().default(true),
  metadataJson: z.record(z.any()).default({}),
});

const updateDestinationSchema = z.object({
  counterpartyId: z.string().uuid().nullable().optional(),
  walletAddress: z.string().trim().min(1).optional(),
  tokenAccountAddress: z.string().trim().min(1).nullable().optional(),
  destinationType: z.string().trim().min(1).max(100).optional(),
  trustState: z.enum(['unreviewed', 'trusted', 'restricted', 'blocked']).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
  isInternal: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).refine(
  (value) =>
    value.counterpartyId !== undefined
    || value.walletAddress !== undefined
    || value.tokenAccountAddress !== undefined
    || value.destinationType !== undefined
    || value.trustState !== undefined
    || value.label !== undefined
    || value.notes !== undefined
    || value.isInternal !== undefined
    || value.isActive !== undefined,
  'At least one field must be updated',
);

destinationsRouter.get('/workspaces/:workspaceId/counterparties', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  const query = listAddressBookQuerySchema.parse(req.query);
  await assertWorkspaceAccess(workspaceId, req.auth!);
  sendList(res, unwrapItems(await listCounterparties(workspaceId, query)), { limit: query.limit });
}));

destinationsRouter.post('/workspaces/:workspaceId/counterparties', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  await assertWorkspaceAdmin(workspaceId, req.auth!);
  const input = createCounterpartySchema.parse(req.body);
  sendCreated(res, await createCounterparty(workspaceId, input));
}));

destinationsRouter.patch('/workspaces/:workspaceId/counterparties/:counterpartyId', asyncRoute(async (req, res) => {
  const { workspaceId, counterpartyId } = counterpartyParamsSchema.parse(req.params);
  await assertWorkspaceAdmin(workspaceId, req.auth!);
  const input = updateCounterpartySchema.parse(req.body);
  sendJson(res, await updateCounterparty(workspaceId, counterpartyId, input));
}));

destinationsRouter.get('/workspaces/:workspaceId/destinations', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  const query = listAddressBookQuerySchema.parse(req.query);
  await assertWorkspaceAccess(workspaceId, req.auth!);
  sendList(res, unwrapItems(await listDestinations(workspaceId, query)), { limit: query.limit });
}));

destinationsRouter.post('/workspaces/:workspaceId/destinations', asyncRoute(async (req, res) => {
  const { workspaceId } = workspaceParamsSchema.parse(req.params);
  await assertWorkspaceAdmin(workspaceId, req.auth!);
  const input = createDestinationSchema.parse(req.body);
  sendCreated(res, await createDestination(workspaceId, input));
}));

destinationsRouter.patch('/workspaces/:workspaceId/destinations/:destinationId', asyncRoute(async (req, res) => {
    const { workspaceId, destinationId } = destinationParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!);
    const input = updateDestinationSchema.parse(req.body);
    sendJson(res, await updateDestination(workspaceId, destinationId, input));
}));
