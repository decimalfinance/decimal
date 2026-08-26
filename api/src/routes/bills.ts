// Bills workbench + bill draft routes (AP workbench redesign).
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
  const billDraft = await getBillDraft(organizationId, paymentOrderId, req.auth!.userId);
  if (!billDraft) {
    res.status(404).json({ error: 'Bill not found' });
    return;
  }
  res.json(billDraft);
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

// Keep what has been typed, without sending the bill anywhere.
//
// Confirm was the only way to persist a draft, and confirm submits it for
// approval — so a clerk part-way through a bill had to finish it or lose the
// work. Same body as confirm, none of its gates: a half-finished bill is the
// point, and a flagged one is exactly what somebody is part-way through fixing.
billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/save', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = confirmSchema.parse(req.body);
  const { saveBillDraft } = await import('../payments/bills.js');
  res.json(await saveBillDraft({
    organizationId,
    paymentOrderId,
    actorUserId: req.auth!.userId,
    fields: input.fields,
    lines: input.lines,
    confirmedFieldKeys: input.confirmedFieldKeys,
    noteForApprovers: input.noteForApprovers ?? null,
  }));
}));

// Clear a duplicate flag — an admin asserts the bill is genuinely new. The
// override is itself the audit record (policy_overridden event), never a
// silent bypass. Admin-tier only: overriding a policy gate is an escalation.
const duplicateOverrideSchema = z.object({ reason: z.string().trim().min(3).max(300) });

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/duplicate-override', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
  if (!membership || (membership.role !== 'primary_admin' && membership.role !== 'admin')) {
    throw forbidden('Only an admin can clear a duplicate flag — ask one to review this bill.');
  }
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = duplicateOverrideSchema.parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { userId: req.auth!.userId }, select: { displayName: true } });
  const billDraft = await overrideDuplicateFlag({
    organizationId,
    paymentOrderId,
    actorUserId: req.auth!.userId,
    actorName: user.displayName,
    reason: input.reason,
  });
  res.json(billDraft);
}));

// Pay what the bill itemises rather than what it prints, with a reason.
//
// Not admin-gated, unlike clearing a duplicate: this does not bypass a control,
// it records a judgement about a defective document, and the bill still has its
// entire approval chain ahead of it with the reason attached. bills.edit is
// enforced by the capability middleware, same as saving a draft.
const itemisedPaySchema = z.object({ reason: z.string().trim().min(3).max(300) });

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/pay-itemised', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = itemisedPaySchema.parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({
    where: { userId: req.auth!.userId },
    select: { displayName: true },
  });
  const { payItemisedTotal } = await import('../payments/bills.js');
  res.json(await payItemisedTotal({
    organizationId,
    paymentOrderId,
    actorUserId: req.auth!.userId,
    actorName: user.displayName,
    reason: input.reason,
  }));
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
    res.json({ ...result, draft: await getBillDraft(organizationId, paymentOrderId, req.auth!.userId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not record that name.';
    if (/primary admin or admin/.test(message)) throw forbidden(message);
    throw error;
  }
}));

// Who this person could ask, most-answered first — the person who actually
// replies is the useful default, not whoever sorts first alphabetically.
billsRouter.get('/organizations/:organizationId/bills/:paymentOrderId/ask-candidates', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const aboutFlag = typeof req.query.flag === 'string' ? req.query.flag : null;
  res.json({
    candidates: await listAskCandidates(organizationId, req.auth!.userId, aboutFlag, paymentOrderId),
  });
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
  res.status(201).json({ billQuestionId: asked.billQuestionId, draft: await getBillDraft(organizationId, paymentOrderId, req.auth!.userId) });
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

// Send an approved-but-unpaid bill back to draft (the recovery path when a
// release gate refuses, e.g. pinned destination). Admin-tier; reason logged.
const sendBackSchema = z.object({ reason: z.string().trim().min(3).max(300) });

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/send-back', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
  if (!membership || (membership.role !== 'primary_admin' && membership.role !== 'admin')) {
    throw forbidden('Only an admin can send an approved bill back to draft.');
  }
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = sendBackSchema.parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { userId: req.auth!.userId }, select: { displayName: true } });
  const billDraft = await sendApprovedBillBackToReview({
    organizationId,
    paymentOrderId,
    actorUserId: req.auth!.userId,
    actorName: user.displayName,
    reason: input.reason,
  });
  res.json(billDraft);
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
    throw forbidden('Only a primary admin or admin can close a bill — ask one to look, or ask a question on it instead.');
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

// ---- recall: asked by the submitter, answered by an admin --------------------
//
// Recall throws away approvals real people gave, so it stopped being a button.
// Raising freezes the bill immediately — before a third approver can spend a
// decision on something already known to be wrong — and a primary admin or admin
// answers. Denying and withdrawing both cost nothing, which is what makes
// raising one safe enough to actually use.

const recallRequestSchema = z.object({ reason: z.string().min(1).max(2000) });
const recallDecisionSchema = z.object({
  grant: z.boolean(),
  note: z.string().max(2000).optional(),
});
const recallParamsSchema = z.object({
  organizationId: z.string().uuid(),
  recallRequestId: z.string().uuid(),
});

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/recall-request', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  await assertBillVisible(organizationId, req.auth!.userId, paymentOrderId);
  const input = recallRequestSchema.parse(req.body);
  const { requestBillRecall } = await import('../payments/bill-recall.js');
  res.json(await requestBillRecall({
    organizationId, paymentOrderId, actorUserId: req.auth!.userId, reason: input.reason,
  }));
}));

// The decision itself. Admin standing is checked here as well as in the engine:
// the screen should not offer what the server will refuse, and the engine
// should not trust that it didn't.
billsRouter.post('/organizations/:organizationId/recall-requests/:recallRequestId/decision', asyncRoute(async (req, res) => {
  const { organizationId, recallRequestId } = recallParamsSchema.parse(req.params);
  const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
  if (!isAdminRole(membership?.role)) {
    throw forbidden('Only a primary admin or admin can decide a recall.');
  }
  const input = recallDecisionSchema.parse(req.body);
  const { decideBillRecall } = await import('../payments/bill-recall.js');
  res.json(await decideBillRecall({
    organizationId, recallRequestId, actorUserId: req.auth!.userId,
    grant: input.grant, note: input.note,
  }));
}));

// Taking your own request back needs nobody's permission.
billsRouter.post('/organizations/:organizationId/recall-requests/:recallRequestId/withdraw', asyncRoute(async (req, res) => {
  const { organizationId, recallRequestId } = recallParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { withdrawBillRecall } = await import('../payments/bill-recall.js');
  res.json(await withdrawBillRecall({ organizationId, recallRequestId, actorUserId: req.auth!.userId }));
}));

// The admin's queue: every bill frozen and waiting on an answer.
billsRouter.get('/organizations/:organizationId/recall-requests', asyncRoute(async (req, res) => {
  const { organizationId } = orgParamsSchema.parse(req.params);
  const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
  if (!isAdminRole(membership?.role)) throw forbidden('Only a primary admin or admin sees the recall queue.');
  const { pendingBillRecalls } = await import('../payments/bill-recall.js');
  res.json(await pendingBillRecalls(organizationId));
}));
