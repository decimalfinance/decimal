import { Router } from 'express';
import { z } from 'zod';
import {
  createCollectionSourceWallet,
  createCounterparty,
  createCounterpartyWallet,
  listCounterparties,
  listCounterpartyWallets,
  removeCounterpartyWallet,
  updateCounterparty,
  updateCounterpartyWallet,
} from '../counterparty-wallets.js';
import { advancePendingReviewsForWallet } from '../payments/orders.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../auth/organization-access.js';
import { asyncRoute, listQuerySchema, sendCreated, sendList, sendJson, unwrapItems } from '../infra/route-helpers.js';

export const counterpartyWalletsRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const counterpartyWalletParamsSchema = organizationParamsSchema.extend({
  counterpartyWalletId: z.string().uuid(),
});

const counterpartyParamsSchema = organizationParamsSchema.extend({
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

const createCounterpartyWalletSchema = z.object({
  counterpartyId: z.string().uuid().optional(),
  chain: z.literal('solana').default('solana'),
  asset: z.literal('usdc').default('usdc'),
  walletAddress: z.string().trim().min(1),
  tokenAccountAddress: z.string().trim().min(1).optional(),
  walletType: z.string().trim().min(1).max(100).default('wallet'),
  destinationType: z.string().trim().min(1).max(100).optional(),
  trustState: z.enum(['unreviewed', 'trusted', 'restricted', 'blocked']).default('unreviewed'),
  label: z.string().trim().min(1).max(200),
  notes: z.string().trim().min(1).max(5000).optional(),
  isInternal: z.boolean().default(false),
  isActive: z.boolean().default(true),
  metadataJson: z.record(z.any()).default({}),
});

const updateCounterpartyWalletSchema = z.object({
  counterpartyId: z.string().uuid().nullable().optional(),
  walletAddress: z.string().trim().min(1).optional(),
  tokenAccountAddress: z.string().trim().min(1).nullable().optional(),
  walletType: z.string().trim().min(1).max(100).optional(),
  destinationType: z.string().trim().min(1).max(100).optional(),
  trustState: z.enum(['unreviewed', 'trusted', 'restricted', 'blocked']).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  isInternal: z.boolean().optional(),
  isActive: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
}).refine(
  (value) =>
    value.counterpartyId !== undefined
    || value.walletAddress !== undefined
    || value.tokenAccountAddress !== undefined
    || value.walletType !== undefined
    || value.trustState !== undefined
    || value.destinationType !== undefined
    || value.label !== undefined
    || value.notes !== undefined
    || value.isInternal !== undefined
    || value.isActive !== undefined
    || value.isPrimary !== undefined,
  'At least one field must be updated',
);

counterpartyWalletsRouter.get('/organizations/:organizationId/counterparties', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listAddressBookQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listCounterparties(organizationId, query)), { limit: query.limit });
}));

counterpartyWalletsRouter.post('/organizations/:organizationId/counterparties', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = createCounterpartySchema.parse(req.body);
  sendCreated(res, await createCounterparty(organizationId, input));
}));

counterpartyWalletsRouter.patch('/organizations/:organizationId/counterparties/:counterpartyId', asyncRoute(async (req, res) => {
  const { organizationId, counterpartyId } = counterpartyParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = updateCounterpartySchema.parse(req.body);
  sendJson(res, await updateCounterparty(organizationId, counterpartyId, input));
}));

counterpartyWalletsRouter.get('/organizations/:organizationId/counterparty-wallets', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listAddressBookQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listCounterpartyWallets(organizationId, query)), { limit: query.limit });
}));

counterpartyWalletsRouter.get('/organizations/:organizationId/destinations', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listAddressBookQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listCounterpartyWallets(organizationId, { ...query, view: 'destinations' })), { limit: query.limit });
}));

counterpartyWalletsRouter.get('/organizations/:organizationId/collection-sources', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listAddressBookQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listCounterpartyWallets(organizationId, { ...query, view: 'collection_sources' })), { limit: query.limit });
}));

counterpartyWalletsRouter.post('/organizations/:organizationId/counterparty-wallets', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = createCounterpartyWalletSchema.parse(req.body);
  sendCreated(res, await createCounterpartyWallet(organizationId, {
    ...input,
    walletType: input.destinationType ?? input.walletType,
  }));
}));

counterpartyWalletsRouter.post('/organizations/:organizationId/destinations', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = createCounterpartyWalletSchema.parse(req.body);
  sendCreated(res, await createCounterpartyWallet(organizationId, {
    ...input,
    walletType: input.destinationType ?? input.walletType,
  }));
}));

counterpartyWalletsRouter.post('/organizations/:organizationId/collection-sources', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = createCounterpartyWalletSchema.parse(req.body);
  sendCreated(res, await createCollectionSourceWallet(organizationId, {
    ...input,
    walletType: input.destinationType ?? (input.walletType === 'wallet' ? 'payer_wallet' : input.walletType),
  }));
}));

counterpartyWalletsRouter.patch('/organizations/:organizationId/counterparty-wallets/:counterpartyWalletId', asyncRoute(async (req, res) => {
  const { organizationId, counterpartyWalletId } = counterpartyWalletParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = updateCounterpartyWalletSchema.parse(req.body);
  const updated = await updateCounterpartyWallet(organizationId, counterpartyWalletId, {
    ...input,
    walletType: input.destinationType ?? input.walletType,
  });
  // Trusting a wallet here should un-stick any payment parked in review only because
  // the wallet wasn't trusted yet — advance them to draft (not auto-paid).
  if (input.trustState === 'trusted') {
    await advancePendingReviewsForWallet({ organizationId, counterpartyWalletId, actorUserId: req.auth!.userId ?? null });
  }
  sendJson(res, updated);
}));

counterpartyWalletsRouter.patch('/organizations/:organizationId/destinations/:counterpartyWalletId', asyncRoute(async (req, res) => {
  const { organizationId, counterpartyWalletId } = counterpartyWalletParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = updateCounterpartyWalletSchema.parse(req.body);
  const updated = await updateCounterpartyWallet(organizationId, counterpartyWalletId, {
    ...input,
    walletType: input.destinationType ?? input.walletType,
  });
  // Trusting a wallet here should un-stick any payment parked in review only because
  // the wallet wasn't trusted yet — advance them to draft (not auto-paid).
  if (input.trustState === 'trusted') {
    await advancePendingReviewsForWallet({ organizationId, counterpartyWalletId, actorUserId: req.auth!.userId ?? null });
  }
  sendJson(res, updated);
}));

counterpartyWalletsRouter.delete('/organizations/:organizationId/counterparty-wallets/:counterpartyWalletId', asyncRoute(async (req, res) => {
  const { organizationId, counterpartyWalletId } = counterpartyWalletParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await removeCounterpartyWallet(organizationId, counterpartyWalletId));
}));
