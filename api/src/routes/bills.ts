// Bills workbench + invoice review routes (AP workbench redesign).
import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { isAdminRole } from '../auth/organization-access.js';
import { asyncRoute } from '../infra/route-helpers.js';
import { forbidden } from '../infra/api-errors.js';
import { assertBillVisible } from '../payments/bill-visibility.js';
import { prisma } from '../infra/prisma.js';
import { getBillsWorkbench, getBillDraft, getBillDetail, getApprovalsInbox, submitBillForApproval, markNotABill, updateBillFacts, overrideDuplicateFlag, addOrganizationTradingName, listAskCandidates, askAboutBill, answerBillQuestion, sendApprovedBillBackToReview } from '../payments/bills.js';

export const billsRouter = Router();

const orgParamsSchema = z.object({ organizationId: z.string().uuid() });
const billParamsSchema = z.object({
  organizationId: z.string().uuid(),
  paymentOrderId: z.string().uuid(),
});

billsRouter.get('/organizations/:organizationId/bills/workbench', asyncRoute(async (req, res) => {
  const { organizationId } = orgParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getBillsWorkbench(organizationId, req.auth!.userId));
}));

billsRouter.get('/organizations/:organizationId/bills/:paymentOrderId/draft', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const review = await getBillDraft(organizationId, paymentOrderId, req.auth!.userId);
  if (!review) {
    res.status(404).json({ error: 'Bill not found' });
    return;
  }
  res.json(review);
}));

billsRouter.get('/organizations/:organizationId/bills/approvals-inbox', asyncRoute(async (req, res) => {
  const { organizationId } = orgParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getApprovalsInbox(organizationId, req.auth!.userId));
}));

billsRouter.get('/organizations/:organizationId/bills/:paymentOrderId/detail', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const detail = await getBillDetail(organizationId, paymentOrderId, req.auth!.userId);
  if (!detail) {
    res.status(404).json({ error: 'Bill not found' });
    return;
  }
  res.json(detail);
}));

const confirmSchema = z.object({
  fields: z.object({
    vendorName: z.string().trim().max(200).nullable().optional(),
    vendorEmail: z.string().trim().max(200).nullable().optional(),
    invoiceNumber: z.string().trim().max(120).nullable().optional(),
    invoiceDate: z.string().trim().max(40).nullable().optional(),
    dueDate: z.string().trim().max(40).nullable().optional(),
    terms: z.string().trim().max(120).nullable().optional(),
    poNumber: z.string().trim().max(120).nullable().optional(),
    discount: z.string().trim().max(120).nullable().optional(),
    currency: z.string().trim().max(10).nullable().optional(),
    total: z.number().positive().optional(),
    taxAmount: z.number().min(0).nullable().optional(),
    remitTo: z.object({
      street: z.string().trim().max(200).nullable().optional(),
      city: z.string().trim().max(100).nullable().optional(),
      state: z.string().trim().max(100).nullable().optional(),
      zip: z.string().trim().max(20).nullable().optional(),
    }).optional(),
  }),
  lines: z.array(z.object({
    description: z.string().trim().max(500),
    quantity: z.number().nullable(),
    unitPrice: z.number().nullable(),
    amount: z.number().nullable(),
    category: z.string().trim().max(120).nullable().optional(),
  })).max(200),
  confirmedFieldKeys: z.array(z.string().max(60)).max(60).default([]),
  noteForApprovers: z.string().trim().max(500).nullable().optional(),
  sourceTreasuryWalletId: z.string().uuid().nullable().optional(),
});

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/confirm', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = confirmSchema.parse(req.body);
  const result = await submitBillForApproval({
    organizationId,
    paymentOrderId,
    actorUserId: req.auth!.userId,
    fields: input.fields,
    lines: input.lines,
    confirmedFieldKeys: input.confirmedFieldKeys,
    noteForApprovers: input.noteForApprovers ?? null,
    sourceTreasuryWalletId: input.sourceTreasuryWalletId,
  });
  res.json(result);
}));

// Clear a duplicate flag — an admin asserts the bill is genuinely new. The
// override is itself the audit record (policy_overridden event), never a
// silent bypass. Admin-tier only: overriding a policy gate is an escalation.
const duplicateOverrideSchema = z.object({ reason: z.string().trim().min(3).max(300) });

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/duplicate-override', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    throw forbidden('Only an admin can clear a duplicate flag — ask one to review this bill.');
  }
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = duplicateOverrideSchema.parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { userId: req.auth!.userId }, select: { displayName: true } });
  const review = await overrideDuplicateFlag({
    organizationId,
    paymentOrderId,
    actorUserId: req.auth!.userId,
    actorName: user.displayName,
    reason: input.reason,
  });
  res.json(review);
}));

// "This is us" — record a name the organization also trades under, resolving
// the addressed_elsewhere flag for it permanently rather than dismissing it
// once. Authority lives in addOrganizationTradingName; the route reports its
// refusal as a 403 rather than a 500 so the UI can say something useful.
const tradingNameSchema = z.object({ name: z.string().trim().min(2).max(120) });

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/this-is-us', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = tradingNameSchema.parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({
    where: { userId: req.auth!.userId },
    select: { displayName: true },
  });
  try {
    const result = await addOrganizationTradingName({
      organizationId,
      name: input.name,
      actorUserId: req.auth!.userId,
      actorName: user.displayName,
      fromPaymentOrderId: paymentOrderId,
    });
    res.json({ ...result, review: await getBillDraft(organizationId, paymentOrderId, req.auth!.userId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not record that name.';
    if (/owner or admin/.test(message)) throw forbidden(message);
    throw error;
  }
}));

// Who this person could ask, most-answered first — the person who actually
// replies is the useful default, not whoever sorts first alphabetically.
billsRouter.get('/organizations/:organizationId/bills/:paymentOrderId/ask-candidates', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  res.json({ candidates: await listAskCandidates(organizationId, req.auth!.userId) });
}));

// Ask a colleague about a bill. No role gate on purpose: asking is never the
// dangerous act, and it must never be the thing an approver cannot do.
const askSchema = z.object({
  askedOfUserId: z.string().uuid(),
  question: z.string().trim().min(3).max(500),
  aboutFlag: z.string().trim().max(60).nullable().optional(),
  // What the asker confirmed they want filled — the suggestion, as edited.
  highlightFields: z.array(z.string()).max(20).nullable().optional(),
  // Ties what was sent back to what we proposed.
  suggestionId: z.string().uuid().nullable().optional(),
});

// What fields does this question look like it is about? A SUGGESTION, shown to
// the asker before anything is sent — no side effects, nothing recorded. The
// model proposes; the person asking decides.
billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/ask/suggest-fields', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = z.object({ question: z.string().trim().min(3).max(500) }).parse(req.body);
  const { fieldsForQuestion } = await import('../payments/question-fields.js');
  const { logSuggestion } = await import('../payments/suggestion-log.js');
  const fields = await fieldsForQuestion(input.question);
  // Logged BEFORE knowing what the asker does with it. If we only recorded
  // accepted suggestions we would have no negatives, and no way to tell a
  // suggestion nobody edited from one nobody was shown.
  const suggestionId = await logSuggestion({
    organizationId,
    stage: 'question_fields',
    subjectType: 'payment_order',
    subjectId: paymentOrderId,
    suggested: fields,
    producer: 'question-fields/v1',
    inputs: { question: input.question },
  });
  res.json({ fields, suggestionId });
}));

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/ask', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = askSchema.parse(req.body);
  const asked = await askAboutBill({
    organizationId,
    paymentOrderId,
    askedByUserId: req.auth!.userId,
    askedOfUserId: input.askedOfUserId,
    question: input.question,
    aboutFlag: input.aboutFlag ?? null,
    highlightFields: input.highlightFields ?? null,
  });

  // What the asker did with the suggestion. 'edited' is the informative one —
  // the difference between what we proposed and what they kept is the only
  // signal that says WHERE we were wrong.
  if (input.suggestionId) {
    const { logSuggestionOutcome, sameFieldSet } = await import('../payments/suggestion-log.js');
    const kept = input.highlightFields ?? [];
    const suggested = await prisma.aiSuggestion.findUnique({
      where: { aiSuggestionId: input.suggestionId },
      select: { suggested: true },
    });
    const proposed = Array.isArray(suggested?.suggested) ? (suggested!.suggested as string[]) : [];
    await logSuggestionOutcome({
      aiSuggestionId: input.suggestionId,
      outcome: kept.length === 0 ? 'rejected' : sameFieldSet(proposed, kept) ? 'accepted' : 'edited',
      finalValue: kept,
      decidedByUserId: req.auth!.userId,
    });
  }
  res.status(201).json({ billQuestionId: asked.billQuestionId, review: await getBillDraft(organizationId, paymentOrderId, req.auth!.userId) });
}));

// Answer a question someone asked you about a bill. Visibility is enough to
// answer, for the same reason it is enough to ask; the function itself refuses
// anyone who was not the person asked.
const answerSchema = z.object({
  answer: z.string().trim().min(1).max(1000),
  // The person answering says whether this resolves it. Inferring would be
  // guessing at intent on something the asker is relying on.
  outcome: z.enum(['answered', 'partial', 'handed_back', 'forwarded']).default('answered'),
  resolvedFields: z.array(z.string()).max(20).nullable().optional(),
  forwardTo: z.object({
    userId: z.string().uuid(),
    question: z.string().trim().min(3).max(500),
  }).nullable().optional(),
});

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/questions/:billQuestionId/answer', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  const billQuestionId = z.string().uuid().parse(req.params.billQuestionId);
  await assertOrganizationAccess(organizationId, req.auth!);
  // Being asked about a bill is itself involvement, so this always passes for
  // the person answering — it refuses everyone else.
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = answerSchema.parse(req.body);
  try {
    await answerBillQuestion({
      organizationId,
      billQuestionId,
      answererUserId: req.auth!.userId,
      answer: input.answer,
      outcome: input.outcome,
      resolvedFields: input.resolvedFields ?? null,
      forwardTo: input.forwardTo ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not answer.';
    if (/person who was asked/.test(message)) throw forbidden(message);
    throw error;
  }
  res.json(await getBillDraft(organizationId, paymentOrderId, req.auth!.userId));
}));

// Send an approved-but-unpaid bill back to Review (the recovery path when a
// release gate refuses, e.g. pinned destination). Admin-tier; reason logged.
const sendBackSchema = z.object({ reason: z.string().trim().min(3).max(300) });

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/send-back', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    throw forbidden('Only an admin can send an approved bill back to review.');
  }
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = sendBackSchema.parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { userId: req.auth!.userId }, select: { displayName: true } });
  const review = await sendApprovedBillBackToReview({
    organizationId,
    paymentOrderId,
    actorUserId: req.auth!.userId,
    actorName: user.displayName,
    reason: input.reason,
  });
  res.json(review);
}));

const factsSchema = z.object({
  invoiceNumber: z.string().trim().max(120).nullable().optional(),
  invoiceDate: z.string().trim().max(40).nullable().optional(),
  dueDate: z.string().trim().max(40).nullable().optional(),
  terms: z.string().trim().max(120).nullable().optional(),
  poNumber: z.string().trim().max(120).nullable().optional(),
  discount: z.string().trim().max(120).nullable().optional(),
  vendorEmail: z.string().trim().max(200).nullable().optional(),
  taxAmount: z.number().min(0).nullable().optional(),
  remitTo: z.object({
    street: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(100).nullable().optional(),
    state: z.string().trim().max(100).nullable().optional(),
    zip: z.string().trim().max(20).nullable().optional(),
  }).optional(),
});

// Tier-2/3 facts can be completed while the bill is already in approval.
billsRouter.patch('/organizations/:organizationId/bills/:paymentOrderId/facts', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const facts = factsSchema.parse(req.body);
  const result = await updateBillFacts({ organizationId, paymentOrderId, actorUserId: req.auth!.userId, facts });
  res.json(result);
}));

const notABillSchema = z.object({
  reason: z.enum(['duplicate', 'statement', 'not_ours', 'unreadable', 'other']),
  note: z.string().trim().max(500).nullable().optional(),
});

// Dismissing a bill kills a payable, which costs the organization as much as
// paying a false one — it just surfaces later, as a vendor chasing an invoice
// everyone believes was handled. It carries the same weight as approving, so it
// carries the same standing: admin only. Previously any member could do it.
billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/not-a-bill', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
  if (!isAdminRole(membership?.role)) {
    throw forbidden('Only an owner or admin can close a bill — ask one to look, or ask a question on it instead.');
  }
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = notABillSchema.parse(req.body);
  const detail = await markNotABill({
    organizationId,
    paymentOrderId,
    actorUserId: req.auth!.userId,
    reason: input.reason,
    note: input.note ?? null,
  });
  res.json(detail);
}));
