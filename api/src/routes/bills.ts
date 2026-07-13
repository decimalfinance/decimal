// Bills workbench + invoice review routes (AP workbench redesign).
import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { asyncRoute } from '../infra/route-helpers.js';
import { forbidden } from '../infra/api-errors.js';
import { prisma } from '../infra/prisma.js';
import { getBillsWorkbench, getBillReview, getBillDetail, getApprovalsInbox, confirmBillReview, markNotABill, updateBillFacts, overrideDuplicateFlag, sendApprovedBillBackToReview } from '../payments/bills.js';

export const billsRouter = Router();

const orgParamsSchema = z.object({ organizationId: z.string().uuid() });
const billParamsSchema = z.object({
  organizationId: z.string().uuid(),
  paymentOrderId: z.string().uuid(),
});

billsRouter.get('/organizations/:organizationId/bills/workbench', asyncRoute(async (req, res) => {
  const { organizationId } = orgParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getBillsWorkbench(organizationId));
}));

billsRouter.get('/organizations/:organizationId/bills/:paymentOrderId/review', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const review = await getBillReview(organizationId, paymentOrderId);
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
  const input = confirmSchema.parse(req.body);
  const result = await confirmBillReview({
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

// Send an approved-but-unpaid bill back to Review (the recovery path when a
// release gate refuses, e.g. pinned destination). Admin-tier; reason logged.
const sendBackSchema = z.object({ reason: z.string().trim().min(3).max(300) });

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/send-back', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  const { membership } = await assertOrganizationAccess(organizationId, req.auth!);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    throw forbidden('Only an admin can send an approved bill back to review.');
  }
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
  const facts = factsSchema.parse(req.body);
  const result = await updateBillFacts({ organizationId, paymentOrderId, actorUserId: req.auth!.userId, facts });
  res.json(result);
}));

const notABillSchema = z.object({
  reason: z.enum(['duplicate', 'statement', 'not_ours', 'unreadable', 'other']),
  note: z.string().trim().max(500).nullable().optional(),
});

billsRouter.post('/organizations/:organizationId/bills/:paymentOrderId/not-a-bill', asyncRoute(async (req, res) => {
  const { organizationId, paymentOrderId } = billParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
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
