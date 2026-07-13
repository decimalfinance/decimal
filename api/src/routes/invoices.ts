import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { asyncRoute, sendCreated } from '../infra/route-helpers.js';
import { uploadInvoiceToPaymentOrders, beginAsyncInvoiceIntake } from '../payments/invoice-intake.js';
import {
  getInvoiceDocumentMeta,
  getInvoiceDocumentWithBytes,
  getInvoiceDocumentStatus,
  getInvoiceDocumentPage,
} from '../payments/documents.js';

export const invoicesRouter = Router();

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const uploadInvoiceSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  dataBase64: z.string().min(1),
  sourceTreasuryWalletId: z.string().uuid().optional().nullable(),
  autoAdvance: z.boolean().default(true),
});

invoicesRouter.post('/organizations/:organizationId/invoices/upload', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const input = uploadInvoiceSchema.parse(req.body);
  const fileBytes = Buffer.from(input.dataBase64, 'base64');
  if (fileBytes.length > MAX_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit`);
  }

  const result = await uploadInvoiceToPaymentOrders({
    organizationId,
    actorUserId: req.auth!.userId,
    fileBytes,
    filename: input.filename,
    mimeType: input.mimeType,
    sourceTreasuryWalletId: input.sourceTreasuryWalletId,
  });
  // Pipeline v3: every uploaded bill lands in needs_review. Nothing advances at
  // upload time — the review screen's "Confirm & send for approval" is the only
  // door into routing, and execution follows approval via the bridge.
  sendCreated(res, {
    ...result,
    automation: [],
  });
}));

// Async intake: returns the stored document id immediately; extraction runs in
// the background and the review screen polls the status endpoint below.
invoicesRouter.post('/organizations/:organizationId/invoices/upload-async', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const input = uploadInvoiceSchema.parse(req.body);
  const fileBytes = Buffer.from(input.dataBase64, 'base64');
  if (fileBytes.length > MAX_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit`);
  }
  const result = await beginAsyncInvoiceIntake({
    organizationId,
    actorUserId: req.auth!.userId,
    fileBytes,
    filename: input.filename,
    mimeType: input.mimeType,
    sourceTreasuryWalletId: input.sourceTreasuryWalletId,
  });
  sendCreated(res, result);
}));

const documentParamsSchema = z.object({
  organizationId: z.string().uuid(),
  invoiceDocumentId: z.string().uuid(),
});

invoicesRouter.get('/organizations/:organizationId/invoice-documents/:invoiceDocumentId/status', asyncRoute(async (req, res) => {
  const { organizationId, invoiceDocumentId } = documentParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const status = await getInvoiceDocumentStatus(organizationId, invoiceDocumentId);
  if (!status) {
    res.status(404).json({ error: 'Invoice document not found' });
    return;
  }
  res.json(status);
}));

const pageParamsSchema = z.object({
  organizationId: z.string().uuid(),
  invoiceDocumentId: z.string().uuid(),
  pageIndex: z.coerce.number().int().min(0).max(500),
});

// A rendered page image — what the review screen displays (no PDF viewer chrome).
invoicesRouter.get('/organizations/:organizationId/invoice-documents/:invoiceDocumentId/pages/:pageIndex', asyncRoute(async (req, res) => {
  const { organizationId, invoiceDocumentId, pageIndex } = pageParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const page = await getInvoiceDocumentPage(organizationId, invoiceDocumentId, pageIndex);
  if (!page) {
    res.status(404).json({ error: 'Page not found' });
    return;
  }
  res.setHeader('Content-Type', page.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(page.data));
}));

// Metadata only — the review screen lists filename/pages without pulling bytes.
invoicesRouter.get('/organizations/:organizationId/invoice-documents/:invoiceDocumentId/meta', asyncRoute(async (req, res) => {
  const { organizationId, invoiceDocumentId } = documentParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const meta = await getInvoiceDocumentMeta(organizationId, invoiceDocumentId);
  if (!meta) {
    res.status(404).json({ error: 'Invoice document not found' });
    return;
  }
  res.json(meta);
}));

// The original file, served inline so the frontend can render it (PDF viewer / <img>).
invoicesRouter.get('/organizations/:organizationId/invoice-documents/:invoiceDocumentId', asyncRoute(async (req, res) => {
  const { organizationId, invoiceDocumentId } = documentParamsSchema.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const doc = await getInvoiceDocumentWithBytes(organizationId, invoiceDocumentId);
  if (!doc) {
    res.status(404).json({ error: 'Invoice document not found' });
    return;
  }
  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Length', String(doc.byteSize));
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename.replace(/["\\\r\n]/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(doc.data));
}));
