// The companion's routes. Any member may read their console: what it contains
// is filtered to their own work inside getCompanionConsole, not gated here.
import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { notFound } from '../infra/api-errors.js';
import { asyncRoute } from '../infra/route-helpers.js';
import { getCompanionConsole, getCompanionJob } from './today.js';
import { followUp, getChat, listChats, recordActionOutcome, startChat } from './chat.js';
import { getInbox, markAllInboxSeen, markInboxSeen, tickReply } from './inbox.js';
import { forgetLine, getKnowledge } from './knowledge.js';
import { getBillNote } from './bill-note.js';
import { getReadyBills } from './ready-pass.js';

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
const askBody = z.object({ text: z.string().min(1).max(2000), billId: z.string().uuid().nullish() });

companionRouter.get('/organizations/:organizationId/companion/chats', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await listChats(organizationId, req.auth!.userId));
}));

companionRouter.post('/organizations/:organizationId/companion/chats', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { text, billId } = askBody.parse(req.body);
  res.status(201).json(await startChat(organizationId, req.auth!.userId, text, billId ?? null));
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

const actionParams = chatParams.extend({ actionId: z.string().uuid() });
const outcomeBody = z.object({ ok: z.boolean(), message: z.string().max(1000).nullable().optional() });

companionRouter.post('/organizations/:organizationId/companion/chats/:chatId/actions/:actionId/outcome', asyncRoute(async (req, res) => {
  const { organizationId, chatId, actionId } = actionParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { ok, message } = outcomeBody.parse(req.body);
  res.json(await recordActionOutcome(organizationId, req.auth!.userId, chatId, actionId, { ok, message: message ?? null }));
}));

// The inbox. Anyone on the team has one; what is in it is filtered inside.
const seenBody = z.object({ billId: z.string().uuid() });
const replyParams = orgParams.extend({ billQuestionId: z.string().uuid() });

companionRouter.get('/organizations/:organizationId/inbox', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getInbox(organizationId, req.auth!.userId));
}));

companionRouter.post('/organizations/:organizationId/inbox/seen', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { billId } = seenBody.parse(req.body);
  res.json(await markInboxSeen(organizationId, req.auth!.userId, billId));
}));

companionRouter.post('/organizations/:organizationId/inbox/seen-all', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await markAllInboxSeen(organizationId, req.auth!.userId));
}));

// The asker ticks off a reply to their question.
companionRouter.post('/organizations/:organizationId/inbox/replies/:billQuestionId/done', asyncRoute(async (req, res) => {
  const { organizationId, billQuestionId } = replyParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await tickReply(organizationId, req.auth!.userId, billQuestionId));
}));

// What the companion knows. Anyone on the team may read it; forgetting a line
// is for whoever codes bills (checked inside).

companionRouter.get('/organizations/:organizationId/knowledge', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getKnowledge(organizationId, req.auth!.userId));
}));

const forgetLineBody = z.object({ counterpartyId: z.string().uuid(), description: z.string().trim().min(1).max(500) });
companionRouter.post('/organizations/:organizationId/knowledge/lines/forget', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { counterpartyId, description } = forgetLineBody.parse(req.body);
  res.json(await forgetLine(organizationId, req.auth!.userId, counterpartyId, description));
}));

// The companion's note on one bill, for the bill's own screen.
const billNoteParams = orgParams.extend({ paymentOrderId: z.string().uuid() });
companionRouter.get('/organizations/:organizationId/bills/:paymentOrderId/companion', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billNoteParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getBillNote(organizationId, req.auth!.userId, paymentOrderId));
}));

// The quick pass through ready bills: which ones, in what order.
companionRouter.get('/organizations/:organizationId/companion/ready', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getReadyBills(organizationId, req.auth!.userId));
}));
