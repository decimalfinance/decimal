import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import {
  confirmDecimalProposalExecution,
  confirmDecimalProposalSubmission,
  createDecimalProposalApprovalIntent,
  createDecimalProposalExecuteIntent,
  createDecimalProposalRejectIntent,
  getDecimalProposal,
  listDecimalProposals,
} from '../squads/treasury.js';
import { asyncRoute, sendCreated, sendJson, sendList, unwrapItems } from '../infra/route-helpers.js';

export const proposalsRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const proposalParamsSchema = organizationParamsSchema.extend({
  decimalProposalId: z.string().uuid(),
});

const listProposalsQuerySchema = z.object({
  status: z.enum(['pending', 'all', 'closed']).optional(),
  proposalType: z.string().min(1).optional(),
  treasuryWalletId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
});

const memberActionSchema = z.object({
  memberPersonalWalletId: z.string().uuid(),
  memo: z.string().optional().nullable(),
});

const signatureSchema = z.object({
  signature: z.string().min(1),
});

proposalsRouter.get('/organizations/:organizationId/proposals', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listProposalsQuerySchema.parse(req.query);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendList(res, unwrapItems(await listDecimalProposals(organizationId, req.auth!.userId, query)));
}));

proposalsRouter.get('/organizations/:organizationId/proposals/:decimalProposalId', asyncRoute(async (req, res) => {
  const { organizationId, decimalProposalId } = proposalParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendJson(res, await getDecimalProposal(organizationId, req.auth!.userId, decimalProposalId));
}));

proposalsRouter.post('/organizations/:organizationId/proposals/:decimalProposalId/confirm-submission', asyncRoute(async (req, res) => {
  const { organizationId, decimalProposalId } = proposalParamsSchema.parse(req.params);
  const input = signatureSchema.parse(req.body);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendJson(res, await confirmDecimalProposalSubmission(organizationId, req.auth!.userId, decimalProposalId, input));
}));

proposalsRouter.post('/organizations/:organizationId/proposals/:decimalProposalId/confirm-execution', asyncRoute(async (req, res) => {
  const { organizationId, decimalProposalId } = proposalParamsSchema.parse(req.params);
  const input = signatureSchema.parse(req.body);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendJson(res, await confirmDecimalProposalExecution(organizationId, req.auth!.userId, decimalProposalId, input));
}));

proposalsRouter.post('/organizations/:organizationId/proposals/:decimalProposalId/approve-intent', asyncRoute(async (req, res) => {
  const { organizationId, decimalProposalId } = proposalParamsSchema.parse(req.params);
  const input = memberActionSchema.parse(req.body);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendCreated(res, await createDecimalProposalApprovalIntent(organizationId, req.auth!.userId, decimalProposalId, input));
}));

proposalsRouter.post('/organizations/:organizationId/proposals/:decimalProposalId/reject-intent', asyncRoute(async (req, res) => {
  const { organizationId, decimalProposalId } = proposalParamsSchema.parse(req.params);
  const input = memberActionSchema.parse(req.body);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendCreated(res, await createDecimalProposalRejectIntent(organizationId, req.auth!.userId, decimalProposalId, input));
}));

proposalsRouter.post('/organizations/:organizationId/proposals/:decimalProposalId/execute-intent', asyncRoute(async (req, res) => {
  const { organizationId, decimalProposalId } = proposalParamsSchema.parse(req.params);
  const input = memberActionSchema.pick({ memberPersonalWalletId: true }).parse(req.body);
  await assertOrganizationAccess(organizationId, req.auth!);
  sendCreated(res, await createDecimalProposalExecuteIntent(organizationId, req.auth!.userId, decimalProposalId, input));
}));
