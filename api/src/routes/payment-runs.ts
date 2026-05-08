import { Router } from 'express';
import { z } from 'zod';
import {
  attachPaymentRunSignature,
  cancelPaymentRun,
  closePaymentRun,
  deletePaymentRun,
  getPaymentRunDetail,
  importPaymentRunFromCsv,
  listPaymentRuns,
  preparePaymentRunExecution,
  previewPaymentRunCsv,
} from '../payment-runs.js';
import { buildPaymentRunProofPacket } from '../payment-run-proof.js';
import { isSolanaSignatureLike } from '../solana.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../organization-access.js';
import { asyncRoute, sendCreated, sendJson, sendList, unwrapItems } from '../route-helpers.js';

export const paymentRunsRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const paymentRunParamsSchema = organizationParamsSchema.extend({
  paymentRunId: z.string().uuid(),
});

const paymentRunProofQuerySchema = z.object({
  detail: z.enum(['summary', 'compact', 'full']).default('summary'),
  format: z.literal('json').default('json'),
});

const importPaymentRunCsvSchema = z.object({
  csv: z.string().min(1),
  runName: z.string().trim().max(200).optional(),
  sourceTreasuryWalletId: z.string().uuid().optional(),
  submitOrderNow: z.boolean().default(false),
  importKey: z.string().trim().max(200).optional(),
});

const preparePaymentRunExecutionSchema = z.object({
  sourceTreasuryWalletId: z.string().uuid().optional(),
});

const attachPaymentRunSignatureSchema = z.object({
  submittedSignature: z.string().trim().refine(isSolanaSignatureLike, 'Invalid Solana signature'),
  submittedAt: z.string().datetime().optional(),
});

paymentRunsRouter.get('/organizations/:organizationId/payment-runs', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    sendList(res, unwrapItems(await listPaymentRuns(organizationId)), { limit: 100 });
}));

paymentRunsRouter.post('/organizations/:organizationId/payment-runs/import-csv', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = importPaymentRunCsvSchema.parse(req.body);
    sendCreated(res, await importPaymentRunFromCsv({
      organizationId,
      actorUserId: req.auth!.userId,
      csv: input.csv,
      runName: input.runName,
      sourceTreasuryWalletId: input.sourceTreasuryWalletId,
      submitOrderNow: input.submitOrderNow,
      importKey: input.importKey,
    }));
}));

paymentRunsRouter.post('/organizations/:organizationId/payment-runs/import-csv/preview', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const input = z.object({ csv: z.string().min(1) }).parse(req.body);
    sendJson(res, await previewPaymentRunCsv({
      organizationId,
      csv: input.csv,
    }));
}));

paymentRunsRouter.get('/organizations/:organizationId/payment-runs/:paymentRunId', asyncRoute(async (req, res) => {
    const { organizationId, paymentRunId } = paymentRunParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    sendJson(res, await getPaymentRunDetail(organizationId, paymentRunId));
}));

paymentRunsRouter.delete('/organizations/:organizationId/payment-runs/:paymentRunId', asyncRoute(async (req, res) => {
    const { organizationId, paymentRunId } = paymentRunParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    sendJson(res, await deletePaymentRun(organizationId, paymentRunId));
}));

paymentRunsRouter.post('/organizations/:organizationId/payment-runs/:paymentRunId/cancel', asyncRoute(async (req, res) => {
    const { organizationId, paymentRunId } = paymentRunParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    sendJson(res, await cancelPaymentRun({
      organizationId,
      paymentRunId,
      actorUserId: req.auth!.userId,
    }));
}));

paymentRunsRouter.post('/organizations/:organizationId/payment-runs/:paymentRunId/close', asyncRoute(async (req, res) => {
    const { organizationId, paymentRunId } = paymentRunParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    sendJson(res, await closePaymentRun({
      organizationId,
      paymentRunId,
      actorUserId: req.auth!.userId,
    }));
}));

paymentRunsRouter.post('/organizations/:organizationId/payment-runs/:paymentRunId/prepare-execution', asyncRoute(async (req, res) => {
    const { organizationId, paymentRunId } = paymentRunParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = preparePaymentRunExecutionSchema.parse(req.body);
    sendCreated(res, await preparePaymentRunExecution({
      organizationId,
      paymentRunId,
      actorUserId: req.auth!.userId,
      sourceTreasuryWalletId: input.sourceTreasuryWalletId,
    }));
}));

paymentRunsRouter.post('/organizations/:organizationId/payment-runs/:paymentRunId/attach-signature', asyncRoute(async (req, res) => {
    const { organizationId, paymentRunId } = paymentRunParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = attachPaymentRunSignatureSchema.parse(req.body);
    sendCreated(res, await attachPaymentRunSignature({
      organizationId,
      paymentRunId,
      actorUserId: req.auth!.userId,
      submittedSignature: input.submittedSignature,
      submittedAt: input.submittedAt ? new Date(input.submittedAt) : null,
    }));
}));

paymentRunsRouter.get('/organizations/:organizationId/payment-runs/:paymentRunId/proof', asyncRoute(async (req, res) => {
    const { organizationId, paymentRunId } = paymentRunParamsSchema.parse(req.params);
    const query = paymentRunProofQuerySchema.parse(req.query);
    await assertOrganizationAccess(organizationId, req.auth!);
    const proof = await buildPaymentRunProofPacket(organizationId, paymentRunId, { detail: query.detail });
    sendJson(res, proof);
}));
