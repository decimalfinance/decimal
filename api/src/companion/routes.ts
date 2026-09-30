// The companion's routes. Any member may read their console: what it contains
// is filtered to their own work inside getCompanionConsole, not gated here.
import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { notFound } from '../infra/api-errors.js';
import { asyncRoute } from '../infra/route-helpers.js';
import { getCompanionConsole, getCompanionJob } from './today.js';
import { followUp, getChat, listChats, recordActionOutcome, startChat } from './chat.js';
import { getInbox, markAllInboxSeen, markInboxSeen, nudgeAboutBill, tickAsk } from './inbox.js';
import { forgetHabit, getKnowledge, keepHabit, setHabit } from './knowledge.js';
import { getBillNote } from './bill-note.js';

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
const nudgeBody = z.object({ billId: z.string().uuid(), toUserId: z.string().uuid(), text: z.string().trim().min(3).max(500) });
const askParams = orgParams.extend({ askId: z.string().uuid() });

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

companionRouter.post('/organizations/:organizationId/inbox/asks/:askId/done', asyncRoute(async (req, res) => {
  const { organizationId, askId } = askParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await tickAsk(organizationId, req.auth!.userId, askId));
}));

// Ask a colleague to do something on a bill without holding it. Anyone who can
// see the bill may ask anyone else who can: asking is never the dangerous act.
companionRouter.post('/organizations/:organizationId/inbox/nudge', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const input = nudgeBody.parse(req.body);
  res.status(201).json(await nudgeAboutBill({ organizationId, fromUserId: req.auth!.userId, toUserId: input.toUserId, billId: input.billId, text: input.text, via: req.get('x-decimal-via') === 'companion' ? 'companion' : 'person' }));
}));

// What the companion knows. Anyone on the team may read it; keeping (and,
// through the Vendors routes, changing or forgetting) is for admins.
const habitParams = orgParams.extend({ ruleId: z.string().uuid() });

companionRouter.get('/organizations/:organizationId/knowledge', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getKnowledge(organizationId, req.auth!.userId));
}));

companionRouter.post('/organizations/:organizationId/knowledge/:ruleId/keep', asyncRoute(async (req, res) => {
  const { organizationId, ruleId } = habitParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await keepHabit(organizationId, req.auth!.userId, ruleId));
}));

const setHabitBody = z.object({ counterpartyId: z.string().uuid(), category: z.string().trim().min(1).max(200) });
const vendorParams = orgParams.extend({ counterpartyId: z.string().uuid() });

companionRouter.put('/organizations/:organizationId/knowledge/habits', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { counterpartyId, category } = setHabitBody.parse(req.body);
  res.json(await setHabit(organizationId, req.auth!.userId, counterpartyId, category));
}));

companionRouter.delete('/organizations/:organizationId/knowledge/habits/:counterpartyId', asyncRoute(async (req, res) => {
  const { organizationId, counterpartyId } = vendorParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await forgetHabit(organizationId, req.auth!.userId, counterpartyId));
}));

// The companion's note on one bill, for the bill's own screen.
const billNoteParams = orgParams.extend({ paymentOrderId: z.string().uuid() });
companionRouter.get('/organizations/:organizationId/bills/:paymentOrderId/companion', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billNoteParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getBillNote(organizationId, req.auth!.userId, paymentOrderId));
}));
