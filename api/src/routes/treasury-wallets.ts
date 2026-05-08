import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../organization-access.js';
import { fetchWalletBalances, SOLANA_CHAIN, USDC_ASSET } from '../solana.js';
import { getSolUsdPrice } from '../pricing.js';
import {
  confirmSquadsTreasuryCreation,
  createSquadsAddMemberProposalIntent,
  createSquadsChangeThresholdProposalIntent,
  createSquadsConfigProposalApprovalIntent,
  createSquadsConfigProposalExecuteIntent,
  createSquadsPaymentProposalIntent,
  createSquadsPaymentRunProposalIntent,
  createSquadsTreasuryIntent,
  getSquadsConfigProposal,
  getSquadsTreasuryDetail,
  getSquadsTreasuryStatus,
  listOrganizationSquadsProposals,
  listSquadsConfigProposals,
  syncSquadsTreasuryMembers,
} from '../squads-treasury.js';
import { createTreasuryWallet, listTreasuryWallets, updateTreasuryWallet } from '../treasury-wallets.js';
import { asyncRoute, listQuerySchema, sendCreated, sendList, sendJson, unwrapItems } from '../route-helpers.js';

export const treasuryWalletsRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const treasuryWalletParamsSchema = organizationParamsSchema.extend({
  treasuryWalletId: z.string().uuid(),
});

const listTreasuryWalletsQuerySchema = listQuerySchema({ defaultLimit: 100, maxLimit: 250 });

const createTreasuryWalletSchema = z.object({
  chain: z.string().default(SOLANA_CHAIN),
  address: z.string().min(1),
  displayName: z.string().optional(),
  assetScope: z.string().default(USDC_ASSET),
  source: z.string().default('manual'),
  sourceRef: z.string().optional(),
  notes: z.string().optional(),
  properties: z.record(z.any()).optional(),
});

const squadsPermissionSchema = z.enum(['initiate', 'vote', 'execute']);

const createSquadsTreasuryIntentSchema = z.object({
  displayName: z.string().optional().nullable(),
  creatorPersonalWalletId: z.string().uuid(),
  threshold: z.number().int().min(1).max(65_535),
  timeLockSeconds: z.number().int().min(0).max(7_776_000).optional(),
  vaultIndex: z.number().int().min(0).max(255).optional(),
  members: z.array(z.object({
    personalWalletId: z.string().uuid(),
    permissions: z.array(squadsPermissionSchema).min(1),
  })).min(1),
});

const confirmSquadsTreasurySchema = z.object({
  signature: z.string().min(1),
  displayName: z.string().optional().nullable(),
  createKey: z.string().min(1),
  multisigPda: z.string().min(1),
  vaultIndex: z.number().int().min(0).max(255).optional(),
});

const createSquadsAddMemberProposalSchema = z.object({
  creatorPersonalWalletId: z.string().uuid(),
  newMemberPersonalWalletId: z.string().uuid(),
  permissions: z.array(squadsPermissionSchema).min(1),
  newThreshold: z.number().int().min(1).max(65_535).optional(),
  memo: z.string().optional().nullable(),
});

const createSquadsChangeThresholdProposalSchema = z.object({
  creatorPersonalWalletId: z.string().uuid(),
  newThreshold: z.number().int().min(1).max(65_535),
  memo: z.string().optional().nullable(),
});

const createSquadsPaymentProposalSchema = z.object({
  paymentOrderId: z.string().uuid(),
  creatorPersonalWalletId: z.string().uuid(),
  memo: z.string().optional().nullable(),
});

const createSquadsPaymentRunProposalSchema = z.object({
  paymentRunId: z.string().uuid(),
  creatorPersonalWalletId: z.string().uuid(),
  memo: z.string().optional().nullable(),
});

const squadsConfigProposalParamsSchema = treasuryWalletParamsSchema.extend({
  transactionIndex: z.string().regex(/^\d+$/),
});

const squadsConfigProposalMemberSchema = z.object({
  memberPersonalWalletId: z.string().uuid(),
  memo: z.string().optional().nullable(),
});

const listSquadsConfigProposalsQuerySchema = z.object({
  status: z.enum(['pending', 'all', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const updateTreasuryWalletSchema = z.object({
  address: z.string().min(1).optional(),
  displayName: z.string().optional(),
  notes: z.string().optional(),
  isActive: z.boolean().optional(),
}).refine(
  (value) =>
    value.address !== undefined
    || value.displayName !== undefined
    || value.notes !== undefined
    || value.isActive !== undefined,
  'At least one field must be updated',
);

treasuryWalletsRouter.get('/organizations/:organizationId/treasury-wallets', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listTreasuryWalletsQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listTreasuryWallets(organizationId, query)), { limit: query.limit });
}));

// Live balances from Solana RPC. Served on-demand; the frontend refreshes on a
// short interval. Callers should treat rpcError=non-null rows as "unknown".
treasuryWalletsRouter.get(
  '/organizations/:organizationId/treasury-wallets/balances',
  asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const wallets = unwrapItems(await listTreasuryWallets(organizationId, { limit: 250 }));
    const [items, solUsdPrice] = await Promise.all([
      Promise.all(
        wallets.map(async (wallet) => {
          const balances = await fetchWalletBalances({
            walletAddress: wallet.address,
            usdcAtaAddress: wallet.usdcAtaAddress,
          });
          return {
            treasuryWalletId: wallet.treasuryWalletId,
            address: wallet.address,
            usdcAtaAddress: wallet.usdcAtaAddress,
            displayName: wallet.displayName,
            isActive: wallet.isActive,
            ...balances,
          };
        }),
      ),
      getSolUsdPrice(),
    ]);
    res.json({
      items,
      solUsdPrice,
      priceSource: solUsdPrice === null ? null : 'binance:SOLUSDT',
      fetchedAt: new Date().toISOString(),
    });
  }),
);

treasuryWalletsRouter.post('/organizations/:organizationId/treasury-wallets', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = createTreasuryWalletSchema.parse(req.body);
  sendCreated(res, await createTreasuryWallet(organizationId, input));
}));

treasuryWalletsRouter.post(
  '/organizations/:organizationId/treasury-wallets/squads/create-intent',
  asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = createSquadsTreasuryIntentSchema.parse(req.body);
    sendCreated(res, await createSquadsTreasuryIntent(organizationId, req.auth!.userId, input));
  }),
);

treasuryWalletsRouter.post(
  '/organizations/:organizationId/treasury-wallets/squads/confirm',
  asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = confirmSquadsTreasurySchema.parse(req.body);
    sendCreated(res, await confirmSquadsTreasuryCreation(organizationId, req.auth!.userId, input));
  }),
);

treasuryWalletsRouter.get(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/detail',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    sendJson(res, await getSquadsTreasuryDetail(organizationId, treasuryWalletId));
  }),
);

treasuryWalletsRouter.get(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/status',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    sendJson(res, await getSquadsTreasuryStatus(organizationId, treasuryWalletId));
  }),
);

treasuryWalletsRouter.get(
  '/organizations/:organizationId/squads/proposals',
  asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const query = listSquadsConfigProposalsQuerySchema.parse(req.query);
    sendList(res, unwrapItems(await listOrganizationSquadsProposals(organizationId, req.auth!.userId, query)));
  }),
);

treasuryWalletsRouter.get(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const query = listSquadsConfigProposalsQuerySchema.parse(req.query);
    sendList(res, unwrapItems(await listSquadsConfigProposals(organizationId, treasuryWalletId, req.auth!.userId, query)));
  }),
);

treasuryWalletsRouter.get(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/:transactionIndex',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId, transactionIndex } = squadsConfigProposalParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    sendJson(res, await getSquadsConfigProposal(organizationId, treasuryWalletId, req.auth!.userId, transactionIndex));
  }),
);

treasuryWalletsRouter.post(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/add-member-intent',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = createSquadsAddMemberProposalSchema.parse(req.body);
    sendCreated(res, await createSquadsAddMemberProposalIntent(organizationId, treasuryWalletId, req.auth!.userId, input));
  }),
);

treasuryWalletsRouter.post(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/change-threshold-intent',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = createSquadsChangeThresholdProposalSchema.parse(req.body);
    sendCreated(res, await createSquadsChangeThresholdProposalIntent(organizationId, treasuryWalletId, req.auth!.userId, input));
  }),
);

treasuryWalletsRouter.post(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/vault-proposals/payment-intent',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const input = createSquadsPaymentProposalSchema.parse(req.body);
    sendCreated(res, await createSquadsPaymentProposalIntent(organizationId, treasuryWalletId, req.auth!.userId, input));
  }),
);

treasuryWalletsRouter.post(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/vault-proposals/payment-run-intent',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const input = createSquadsPaymentRunProposalSchema.parse(req.body);
    sendCreated(res, await createSquadsPaymentRunProposalIntent(organizationId, treasuryWalletId, req.auth!.userId, input));
  }),
);

treasuryWalletsRouter.post(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/:transactionIndex/approve-intent',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId, transactionIndex } = squadsConfigProposalParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const input = squadsConfigProposalMemberSchema.parse(req.body);
    sendCreated(res, await createSquadsConfigProposalApprovalIntent(organizationId, treasuryWalletId, req.auth!.userId, {
      transactionIndex,
      ...input,
    }));
  }),
);

treasuryWalletsRouter.post(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/:transactionIndex/execute-intent',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId, transactionIndex } = squadsConfigProposalParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const input = squadsConfigProposalMemberSchema.pick({ memberPersonalWalletId: true }).parse(req.body);
    sendCreated(res, await createSquadsConfigProposalExecuteIntent(organizationId, treasuryWalletId, req.auth!.userId, {
      transactionIndex,
      ...input,
    }));
  }),
);

treasuryWalletsRouter.post(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/sync-members',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    sendJson(res, await syncSquadsTreasuryMembers(organizationId, treasuryWalletId));
  }),
);

treasuryWalletsRouter.patch(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = updateTreasuryWalletSchema.parse(req.body);
    sendJson(res, await updateTreasuryWallet(organizationId, treasuryWalletId, input));
  }),
);
