// A setup connects the organisation's books, so all of it is for admins.

import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAdmin } from '../../auth/organization-access.js';
import { asyncRoute, sendJson } from '../../infra/route-helpers.js';
import { RECORD_KINDS } from '../copy.js';
import { SETUP_SYSTEMS } from './record.js';
import { getReceipt, getRecord, getSetup, goLive, postMessage, startSetup } from './service.js';

export const integrationSetupRouter = Router();

const orgParams = z.object({ organizationId: z.string().uuid() });
const setupParams = orgParams.extend({ setupId: z.string().uuid() });
const startParams = orgParams.extend({ system: z.enum(SETUP_SYSTEMS) });
const recordParams = setupParams.extend({ kind: z.enum(RECORD_KINDS), recordId: z.string().min(1).max(100) });
const messageBody = z.object({ text: z.string().trim().min(1).max(4000) });

integrationSetupRouter.post('/organizations/:organizationId/integrations/:system/setups', asyncRoute(async (req, res) => {
  const { organizationId, system } = startParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await startSetup(organizationId, req.auth!.userId, system));
}));

integrationSetupRouter.get('/organizations/:organizationId/integrations/setups/:setupId', asyncRoute(async (req, res) => {
  const { organizationId, setupId } = setupParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await getSetup(organizationId, setupId));
}));

integrationSetupRouter.post('/organizations/:organizationId/integrations/setups/:setupId/messages', asyncRoute(async (req, res) => {
  const { organizationId, setupId } = setupParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const { text } = messageBody.parse(req.body);
  sendJson(res, await postMessage(organizationId, req.auth!.userId, setupId, text));
}));

// The person's yes. Only a click reaches this, and it checks the done conditions itself.
integrationSetupRouter.post('/organizations/:organizationId/integrations/setups/:setupId/go', asyncRoute(async (req, res) => {
  const { organizationId, setupId } = setupParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await goLive(organizationId, req.auth!.userId, setupId));
}));

integrationSetupRouter.get('/organizations/:organizationId/integrations/setups/:setupId/records/:kind/:recordId', asyncRoute(async (req, res) => {
  const { organizationId, setupId, kind, recordId } = recordParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await getRecord(organizationId, setupId, kind, recordId));
}));

integrationSetupRouter.get('/organizations/:organizationId/integrations/setups/:setupId/receipt', asyncRoute(async (req, res) => {
  const { organizationId, setupId } = setupParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await getReceipt(organizationId, setupId));
}));
