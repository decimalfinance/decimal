// The companion's routes. Any member may read their console: what it contains
// is filtered to their own work inside getCompanionConsole, not gated here.
import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { notFound } from '../infra/api-errors.js';
import { asyncRoute } from '../infra/route-helpers.js';
import { getCompanionConsole, getCompanionJob } from './today.js';
import { followUp, getChat, listChats, startChat } from './chat.js';

export const companionRouter = Router();

const orgParams = z.object({ organizationId: z.string().uuid() });
const jobParams = orgParams.extend({ jobId: z.string().uuid() });

companionRouter.get('/organizations/:organizationId/companion/console', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getCompanionConsole(organizationId, req.auth!.userId));
}));

companionRouter.get('/organizations/:organizationId/companion/jobs/:jobId', asyncRoute(async (req, res) => {
  const { organizationId, jobId } = jobParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const job = await getCompanionJob(organizationId, req.auth!.userId, jobId);
  if (!job) throw notFound('No such job.');
  res.json(job);
}));

// Chats are the asker's own. Every route checks the chat belongs to them.
const chatParams = orgParams.extend({ chatId: z.string().uuid() });
const askBody = z.object({ text: z.string().min(1).max(2000) });

companionRouter.get('/organizations/:organizationId/companion/chats', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await listChats(organizationId, req.auth!.userId));
}));

companionRouter.post('/organizations/:organizationId/companion/chats', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { text } = askBody.parse(req.body);
  res.status(201).json(await startChat(organizationId, req.auth!.userId, text));
}));

companionRouter.get('/organizations/:organizationId/companion/chats/:chatId', asyncRoute(async (req, res) => {
  const { organizationId, chatId } = chatParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getChat(organizationId, req.auth!.userId, chatId));
}));

companionRouter.post('/organizations/:organizationId/companion/chats/:chatId/messages', asyncRoute(async (req, res) => {
  const { organizationId, chatId } = chatParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { text } = askBody.parse(req.body);
  res.status(201).json(await followUp(organizationId, req.auth!.userId, chatId, text));
}));
