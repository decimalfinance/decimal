import { Router } from 'express';
import { z } from 'zod';
import {
  attachPaymentRunSignature,
  cancelPaymentRun,
  closePaymentRun,
  deletePaymentRun,
  getPaymentRunDetail,
  importPaymentRunFromCsv,
  importPaymentRunFromDocument,
  listPaymentRuns,
  preparePaymentRunExecution,
  previewPaymentRunCsv,
  resolvePaymentRunDocumentRow,
} from '../payments/runs.js';
import { buildPaymentRunProofPacket } from '../payments/run-proof.js';
import { isSolanaSignatureLike } from '../solana.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../auth/organization-access.js';
import { asyncRoute, sendCreated, sendJson, sendList, unwrapItems } from '../infra/route-helpers.js';

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
  importKey: z.string().trim().max(200).optional(),
  submitOrderNow: z.boolean().default(false),
});

// Doc-to-proposal: client base64-encodes the file in JSON to avoid pulling
// in a multipart parser. 10MB cap on the decoded payload.
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const importPaymentRunFromDocumentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  dataBase64: z.string().min(1),
  runName: z.string().trim().max(200).optional(),
  sourceTreasuryWalletId: z.string().uuid().optional(),
});

const preparePaymentRunExecutionSchema = z.object({
  sourceTreasuryWalletId: z.string().uuid().optional(),
});

const attachPaymentRunSignatureSchema = z.object({
  submittedSignature: z.string().trim().refine(isSolanaSignatureLike, 'Invalid Solana signature'),
  submittedAt: z.string().datetime().optional(),
});

const resolvePaymentRunDocumentRowSchema = z.object({
  rowIndex: z.number().int().min(0),
  counterpartyWalletId: z.string().uuid().optional().nullable(),
  walletAddress: z.string().trim().optional().nullable(),
  label: z.string().trim().max(200).optional().nullable(),
  trustState: z.enum(['unreviewed', 'trusted']).default('unreviewed'),
}).refine((value) => Boolean(value.counterpartyWalletId ?? value.walletAddress), {
  message: 'Provide counterpartyWalletId or walletAddress',
  path: ['walletAddress'],
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
      importKey: input.importKey,
      submitOrderNow: input.submitOrderNow,
    }));
}));

paymentRunsRouter.post('/organizations/:organizationId/payment-runs/from-document', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = importPaymentRunFromDocumentSchema.parse(req.body);
    const fileBytes = Buffer.from(input.dataBase64, 'base64');
    if (fileBytes.length > MAX_DOCUMENT_BYTES) {
      throw new Error(`Document exceeds ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit`);
    }
    sendCreated(res, await importPaymentRunFromDocument({
      organizationId,
      actorUserId: req.auth!.userId,
      fileBytes,
      filename: input.filename,
      mimeType: input.mimeType,
      runName: input.runName,
      sourceTreasuryWalletId: input.sourceTreasuryWalletId,
    }));
}));

// Server-Sent Events variant of /from-document. Same behavior, but the
// response is `text/event-stream` and the backend writes one SSE event
// per real milestone (rendering, extracting, matching, creating, done).
// The final event is named `result` and carries the same JSON the
// non-streaming route returns. Errors come back as `error` events.
paymentRunsRouter.post('/organizations/:organizationId/payment-runs/from-document/stream', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = importPaymentRunFromDocumentSchema.parse(req.body);
    const fileBytes = Buffer.from(input.dataBase64, 'base64');
    if (fileBytes.length > MAX_DOCUMENT_BYTES) {
      throw new Error(`Document exceeds ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit`);
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx-style buffering
    res.flushHeaders?.();

    function emit(event: string, data: unknown) {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      // Express 5 doesn't expose .flush() on res; relying on no buffering
      // in the chain (cloudflared + express) is what keeps streaming live.
    }

    try {
      const result = await importPaymentRunFromDocument({
        organizationId,
        actorUserId: req.auth!.userId,
        fileBytes,
        filename: input.filename,
        mimeType: input.mimeType,
        runName: input.runName,
        sourceTreasuryWalletId: input.sourceTreasuryWalletId,
        onProgress: (event) => emit('stage', event),
      });
      emit('result', result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Document import failed.';
      emit('error', { message });
    } finally {
      res.end();
    }
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

paymentRunsRouter.post('/organizations/:organizationId/payment-runs/:paymentRunId/resolve-document-row', asyncRoute(async (req, res) => {
    const { organizationId, paymentRunId } = paymentRunParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = resolvePaymentRunDocumentRowSchema.parse(req.body);
    sendCreated(res, await resolvePaymentRunDocumentRow({
      organizationId,
      paymentRunId,
      actorUserId: req.auth!.userId,
      rowIndex: input.rowIndex,
      counterpartyWalletId: input.counterpartyWalletId,
      walletAddress: input.walletAddress,
      label: input.label,
      trustState: input.trustState,
    }));
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
