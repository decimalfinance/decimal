import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../auth/organization-access.js';
import {
  createAutomationAgent,
  createManagedAgentWallet,
  listAgentWallets,
  listAutomationAgents,
} from '../agents/automation.js';
import { executePaymentOrderWithSpendingLimit, listSpendingLimitExecutions } from '../agents/spending-limit-execution.js';
import {
  createSquadsAddAgentMemberProposalIntent,
  createSquadsRemoveSpendingLimitProposalIntent,
  createSquadsReplaceSpendingLimitProposalIntent,
  createSquadsSpendingLimitProposalIntent,
  getSpendingLimitPolicy,
  listSpendingLimitPolicies,
  syncSpendingLimitPolicy,
} from '../squads/treasury.js';
import { asyncRoute, listQuerySchema, sendCreated, sendJson, sendList, unwrapItems } from '../infra/route-helpers.js';

export const automationAgentsRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const automationAgentParamsSchema = organizationParamsSchema.extend({
  automationAgentId: z.string().uuid(),
});

const treasuryWalletParamsSchema = organizationParamsSchema.extend({
  treasuryWalletId: z.string().uuid(),
});

const spendingLimitPolicyParamsSchema = organizationParamsSchema.extend({
  spendingLimitPolicyId: z.string().uuid(),
});

const paymentOrderParamsSchema = organizationParamsSchema.extend({
  paymentOrderId: z.string().uuid(),
});

const createAutomationAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  agentType: z.string().trim().min(1).max(80).optional(),
  metadataJson: z.record(z.any()).optional(),
});

const createManagedAgentWalletSchema = z.object({
  provider: z.enum(['privy']).default('privy'),
  label: z.string().trim().min(1).max(120).optional().nullable(),
});

const listAutomationAgentsQuerySchema = listQuerySchema({ defaultLimit: 100, maxLimit: 250 }).extend({
  status: z.string().trim().min(1).max(40).optional(),
});

const listAgentWalletsQuerySchema = listQuerySchema({ defaultLimit: 100, maxLimit: 250 }).extend({
  automationAgentId: z.string().uuid().optional(),
  status: z.string().trim().min(1).max(40).optional(),
});

const squadsPermissionSchema = z.enum(['initiate', 'vote', 'execute']);

const createSquadsAddAgentMemberProposalSchema = z.object({
  creatorPersonalWalletId: z.string().uuid(),
  agentWalletId: z.string().uuid(),
  permissions: z.array(squadsPermissionSchema).min(1),
  newThreshold: z.number().int().min(1).max(65_535).optional(),
  memo: z.string().optional().nullable(),
});

const createSquadsSpendingLimitProposalSchema = z.object({
  creatorPersonalWalletId: z.string().uuid(),
  agentWalletId: z.string().uuid(),
  policyName: z.string().trim().min(1).max(160),
  policyCode: z.string().trim().min(1).max(120).optional().nullable(),
  amountRaw: z.string().regex(/^\d+$/),
  period: z.enum(['one_time', 'day', 'week', 'month']),
  counterpartyWalletIds: z.array(z.string().uuid()).min(1),
  memo: z.string().optional().nullable(),
});

const removeSquadsSpendingLimitProposalSchema = z.object({
  creatorPersonalWalletId: z.string().uuid(),
  memo: z.string().optional().nullable(),
});

const replaceSquadsSpendingLimitProposalSchema = z.object({
  creatorPersonalWalletId: z.string().uuid(),
  agentWalletId: z.string().uuid().optional(),
  policyName: z.string().trim().min(1).max(160).optional(),
  policyCode: z.string().trim().min(1).max(120).optional().nullable(),
  amountRaw: z.string().regex(/^\d+$/).optional(),
  period: z.enum(['one_time', 'day', 'week', 'month']).optional(),
  counterpartyWalletIds: z.array(z.string().uuid()).min(1).optional(),
  memo: z.string().optional().nullable(),
});

const listSpendingLimitPoliciesQuerySchema = listQuerySchema({ defaultLimit: 100, maxLimit: 250 }).extend({
  treasuryWalletId: z.string().uuid().optional(),
  automationAgentId: z.string().uuid().optional(),
  status: z.string().trim().min(1).max(40).optional(),
});

const listSpendingLimitExecutionsQuerySchema = listQuerySchema({ defaultLimit: 100, maxLimit: 250 }).extend({
  spendingLimitPolicyId: z.string().uuid().optional(),
  treasuryWalletId: z.string().uuid().optional(),
  automationAgentId: z.string().uuid().optional(),
  agentWalletId: z.string().uuid().optional(),
  paymentOrderId: z.string().uuid().optional(),
  status: z.string().trim().min(1).max(40).optional(),
});

const executeWithSpendingLimitSchema = z.object({
  spendingLimitPolicyId: z.string().uuid(),
  memo: z.string().optional().nullable(),
});

automationAgentsRouter.get('/organizations/:organizationId/automation-agents', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listAutomationAgentsQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listAutomationAgents(organizationId, query)), { limit: query.limit });
}));

automationAgentsRouter.post('/organizations/:organizationId/automation-agents', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = createAutomationAgentSchema.parse(req.body);
  sendCreated(res, await createAutomationAgent(organizationId, input));
}));

automationAgentsRouter.get('/organizations/:organizationId/agent-wallets', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listAgentWalletsQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listAgentWallets(organizationId, query)), { limit: query.limit });
}));

automationAgentsRouter.post('/organizations/:organizationId/automation-agents/:automationAgentId/wallets/managed', asyncRoute(async (req, res) => {
  const { organizationId, automationAgentId } = automationAgentParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = createManagedAgentWalletSchema.parse(req.body);
  sendCreated(res, await createManagedAgentWallet(organizationId, automationAgentId, input));
}));

automationAgentsRouter.post(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/add-agent-member-intent',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = createSquadsAddAgentMemberProposalSchema.parse(req.body);
    sendCreated(res, await createSquadsAddAgentMemberProposalIntent(organizationId, treasuryWalletId, req.auth!.userId, input));
  }),
);

automationAgentsRouter.get('/organizations/:organizationId/spending-limit-policies', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listSpendingLimitPoliciesQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listSpendingLimitPolicies(organizationId, query)), { limit: query.limit });
}));

automationAgentsRouter.get('/organizations/:organizationId/spending-limit-policies/:spendingLimitPolicyId', asyncRoute(async (req, res) => {
  const { organizationId, spendingLimitPolicyId } = spendingLimitPolicyParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendJson(res, await getSpendingLimitPolicy(organizationId, spendingLimitPolicyId));
}));

automationAgentsRouter.post(
  '/organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/add-spending-limit-intent',
  asyncRoute(async (req, res) => {
    const { organizationId, treasuryWalletId } = treasuryWalletParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = createSquadsSpendingLimitProposalSchema.parse(req.body);
    sendCreated(res, await createSquadsSpendingLimitProposalIntent(organizationId, treasuryWalletId, req.auth!.userId, input));
  }),
);

automationAgentsRouter.post('/organizations/:organizationId/spending-limit-policies/:spendingLimitPolicyId/sync', asyncRoute(async (req, res) => {
  const { organizationId, spendingLimitPolicyId } = spendingLimitPolicyParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await syncSpendingLimitPolicy(organizationId, spendingLimitPolicyId));
}));

automationAgentsRouter.post('/organizations/:organizationId/spending-limit-policies/:spendingLimitPolicyId/remove-intent', asyncRoute(async (req, res) => {
  const { organizationId, spendingLimitPolicyId } = spendingLimitPolicyParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = removeSquadsSpendingLimitProposalSchema.parse(req.body);
  sendCreated(res, await createSquadsRemoveSpendingLimitProposalIntent(organizationId, req.auth!.userId, spendingLimitPolicyId, input));
}));

automationAgentsRouter.post('/organizations/:organizationId/spending-limit-policies/:spendingLimitPolicyId/replace-intent', asyncRoute(async (req, res) => {
  const { organizationId, spendingLimitPolicyId } = spendingLimitPolicyParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = replaceSquadsSpendingLimitProposalSchema.parse(req.body);
  sendCreated(res, await createSquadsReplaceSpendingLimitProposalIntent(organizationId, req.auth!.userId, spendingLimitPolicyId, input));
}));

automationAgentsRouter.get('/organizations/:organizationId/spending-limit-executions', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listSpendingLimitExecutionsQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listSpendingLimitExecutions(organizationId, query)), { limit: query.limit });
}));

automationAgentsRouter.get('/organizations/:organizationId/spending-limit-policies/:spendingLimitPolicyId/executions', asyncRoute(async (req, res) => {
  const { organizationId, spendingLimitPolicyId } = spendingLimitPolicyParamsSchema.parse(req.params);
  const query = listSpendingLimitExecutionsQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listSpendingLimitExecutions(organizationId, {
    ...query,
    spendingLimitPolicyId,
  })), { limit: query.limit });
}));

automationAgentsRouter.post('/organizations/:organizationId/payment-orders/:paymentOrderId/execute-with-spending-limit', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = executeWithSpendingLimitSchema.parse(req.body);
  sendCreated(res, await executePaymentOrderWithSpendingLimit(organizationId, req.auth!.userId, paymentOrderId, input));
}));
