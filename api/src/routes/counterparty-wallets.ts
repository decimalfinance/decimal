import { Router } from 'express';
import { z } from 'zod';
import {
  createCounterparty,
  createCounterpartyWallet,
  listCounterparties,
  listCounterpartyWallets,
  removeCounterpartyWallet,
  serializeCounterparty,
  updateCounterparty,
  updateCounterpartyWallet,
} from '../counterparty-wallets.js';
import { prisma } from '../infra/prisma.js';
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

// Vendor coding rules (GL-coding P0): the vendor's default expense account —
// learned from agreeing history or set by hand. Manual rules are never
// auto-changed; deleting one lets learning take over again.
const codingRuleSchema = z.object({
  accountId: z.string().trim().min(1).max(120),
  accountName: z.string().trim().max(200).nullable().optional(),
});

counterpartyWalletsRouter.get('/organizations/:organizationId/vendor-coding-rules', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { listVendorCodingRules } = await import('../accounting/gl-coding.js');
  sendJson(res, { items: await listVendorCodingRules(organizationId) });
}));

counterpartyWalletsRouter.put('/organizations/:organizationId/counterparties/:counterpartyId/coding-rule', asyncRoute(async (req, res) => {
  const { organizationId, counterpartyId } = counterpartyParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = codingRuleSchema.parse(req.body);
  const { setVendorCodingRule } = await import('../accounting/gl-coding.js');
  sendJson(res, await setVendorCodingRule({
    organizationId,
    counterpartyId,
    accountId: input.accountId,
    accountName: input.accountName ?? null,
    actorUserId: req.auth!.userId,
  }));
}));

counterpartyWalletsRouter.delete('/organizations/:organizationId/counterparties/:counterpartyId/coding-rule', asyncRoute(async (req, res) => {
  const { organizationId, counterpartyId } = counterpartyParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const { clearVendorCodingRule } = await import('../accounting/gl-coding.js');
  await clearVendorCodingRule(organizationId, counterpartyId);
  sendJson(res, { ok: true });
}));

// Vendor payable gate (policy P0): held = any admin sets/releases; blocked is
// terminal and only the PRIMARY ADMIN may set or lift it. A hold needs a
// reason — the status change is the audit record.
const payableStatusSchema = z.object({
  status: z.enum(['payable', 'held', 'blocked']),
  reason: z.string().trim().max(300).nullable().optional(),
});

counterpartyWalletsRouter.patch('/organizations/:organizationId/counterparties/:counterpartyId/payable-status', asyncRoute(async (req, res) => {
  const { organizationId, counterpartyId } = counterpartyParamsSchema.parse(req.params);
  const { membership } = await assertOrganizationAdmin(organizationId, req.auth!);
  const input = payableStatusSchema.parse(req.body);

  const { readPayableHold, setVendorPayableStatus } = await import('../payments/vendor-payable.js');
  const current = await prisma.counterparty.findFirst({
    where: { organizationId, counterpartyId },
    select: { metadataJson: true },
  });
  if (!current) throw new Error('Vendor not found');
  const existing = readPayableHold(current.metadataJson);
  const touchesBlocked = input.status === 'blocked' || existing?.status === 'blocked';
  if (touchesBlocked && membership.role !== 'owner') {
    throw new Error('Blocking a vendor (or unblocking one) is the primary admin’s call.');
  }
  if (input.status !== 'payable' && !input.reason?.trim()) {
    throw new Error('Give a reason — it goes on the vendor’s record.');
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { userId: req.auth!.userId }, select: { displayName: true } });
  const updated = await setVendorPayableStatus({
    organizationId,
    counterpartyId,
    status: input.status,
    reason: input.reason?.trim() || null,
    actorUserId: req.auth!.userId,
    actorName: user.displayName,
  });
  sendJson(res, serializeCounterparty(updated));
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
