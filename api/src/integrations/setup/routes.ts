// A setup connects the organisation's books, so all of it is for admins.

import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAdmin } from '../../auth/organization-access.js';
import { asyncRoute, sendJson } from '../../infra/route-helpers.js';
import { RECORD_KINDS } from '../copy.js';
import { SETUP_SYSTEMS } from './record.js';
import { booksClosingDate, changeClosingDate, getReceipt, getRecord, getSetup, goLive, latestSetup, postingView, postMessage, startSetup } from './service.js';

export const integrationSetupRouter = Router();

const orgParams = z.object({ organizationId: z.string().uuid() });
const setupParams = orgParams.extend({ setupId: z.string().uuid() });
const startParams = orgParams.extend({ system: z.enum(SETUP_SYSTEMS) });
const recordParams = setupParams.extend({ kind: z.enum(RECORD_KINDS), recordId: z.string().min(1).max(100) });
/** `answering`: written on a question's card, the key of the call it answers. */
const messageBody = z.object({ text: z.string().trim().min(1).max(4000), answering: z.string().min(1).max(100).optional() });
/** A date the books are closed through, or never closed. */
const closingBody = z.union([z.object({ date: z.string().min(1).max(20) }).strict(), z.object({ neverClosed: z.literal(true) }).strict()]);

integrationSetupRouter.post('/organizations/:organizationId/integrations/:system/setups', asyncRoute(async (req, res) => {
  const { organizationId, system } = startParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await startSetup(organizationId, req.auth!.userId, system));
}));

integrationSetupRouter.get('/organizations/:organizationId/integrations/:system/setups/latest', asyncRoute(async (req, res) => {
  const { organizationId, system } = startParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, { setup: await latestSetup(organizationId, system) });
}));

integrationSetupRouter.get('/organizations/:organizationId/integrations/setups/:setupId', asyncRoute(async (req, res) => {
  const { organizationId, setupId } = setupParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await getSetup(organizationId, setupId));
}));

integrationSetupRouter.post('/organizations/:organizationId/integrations/setups/:setupId/messages', asyncRoute(async (req, res) => {
  const { organizationId, setupId } = setupParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const { text, answering } = messageBody.parse(req.body);
  sendJson(res, await postMessage(organizationId, req.auth!.userId, setupId, text, answering ?? null));
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

// After Go: what posting has done, for the screen the setup leaves behind.
integrationSetupRouter.get('/organizations/:organizationId/integrations/:system/posting', asyncRoute(async (req, res) => {
  const { organizationId, system } = startParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await postingView(organizationId, system));
}));

// After Go: the closing date the books keep themselves, read live. Apart, because the books take seconds to answer.
integrationSetupRouter.get('/organizations/:organizationId/integrations/:system/books-closing-date', asyncRoute(async (req, res) => {
  const { organizationId, system } = startParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  sendJson(res, await booksClosingDate(organizationId, system));
}));

// The closing date moves as months close, so it can change after Go. Nothing else the setup decided can.
integrationSetupRouter.put('/organizations/:organizationId/integrations/setups/:setupId/closing-date', asyncRoute(async (req, res) => {
  const { organizationId, setupId } = setupParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const body = closingBody.parse(req.body);
  sendJson(res, await changeClosingDate(organizationId, req.auth!.userId, setupId, 'date' in body ? body.date : null));
}));
