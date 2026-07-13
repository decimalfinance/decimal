// Invoice document storage. The uploaded file is persisted BEFORE extraction runs,
// so even a failed or empty extraction leaves the original document retrievable —
// the review screen renders it next to the extracted fields.
import { createHash } from 'node:crypto';
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';

export async function storeInvoiceDocument(args: {
  organizationId: string;
  uploadedByUserId: string | null;
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  // 'processing' for the async intake path (extraction still running).
  status?: 'processing' | 'processed';
}) {
  const sha256 = createHash('sha256').update(args.fileBytes).digest('hex');

  const existing = await prisma.invoiceDocument.findUnique({
    where: { organizationId_sha256: { organizationId: args.organizationId, sha256 } },
    select: { invoiceDocumentId: true, filename: true },
  });
  if (existing) {
    logger.info('invoice_document.reused', {
      organizationId: args.organizationId,
      invoiceDocumentId: existing.invoiceDocumentId,
      filename: existing.filename,
    });
    return { invoiceDocumentId: existing.invoiceDocumentId, reused: true };
  }

  const created = await prisma.invoiceDocument.create({
    data: {
      organizationId: args.organizationId,
      filename: args.filename,
      mimeType: args.mimeType,
      byteSize: args.fileBytes.length,
      sha256,
      data: new Uint8Array(args.fileBytes),
      status: args.status ?? 'processed',
      uploadedByUserId: args.uploadedByUserId,
    },
    select: { invoiceDocumentId: true },
  });
  logger.info('invoice_document.stored', {
    organizationId: args.organizationId,
    invoiceDocumentId: created.invoiceDocumentId,
    filename: args.filename,
    bytes: args.fileBytes.length,
  });
  return { invoiceDocumentId: created.invoiceDocumentId, reused: false };
}

export async function setInvoiceDocumentPageCount(invoiceDocumentId: string, pageCount: number | null) {
  if (pageCount == null) return;
  await prisma.invoiceDocument.update({
    where: { invoiceDocumentId },
    data: { pageCount },
  });
}

// Metadata only — never pulls the bytes.
export async function getInvoiceDocumentMeta(organizationId: string, invoiceDocumentId: string) {
  return prisma.invoiceDocument.findFirst({
    where: { organizationId, invoiceDocumentId },
    select: {
      invoiceDocumentId: true,
      filename: true,
      mimeType: true,
      byteSize: true,
      sha256: true,
      pageCount: true,
      uploadedByUserId: true,
      createdAt: true,
    },
  });
}

export async function storeInvoiceDocumentPages(
  invoiceDocumentId: string,
  pages: Array<{ bytes: Buffer; mime: string }>,
) {
  // Idempotent per (document, index): a re-upload of a deduped file skips cleanly.
  for (const [index, page] of pages.entries()) {
    await prisma.invoiceDocumentPage.upsert({
      where: { invoiceDocumentId_pageIndex: { invoiceDocumentId, pageIndex: index } },
      create: {
        invoiceDocumentId,
        pageIndex: index,
        mimeType: page.mime,
        data: new Uint8Array(page.bytes),
      },
      update: {},
    });
  }
  await prisma.invoiceDocument.update({
    where: { invoiceDocumentId },
    data: { pageCount: pages.length },
  });
}

export async function getInvoiceDocumentPage(
  organizationId: string,
  invoiceDocumentId: string,
  pageIndex: number,
) {
  return prisma.invoiceDocumentPage.findFirst({
    where: {
      invoiceDocumentId,
      pageIndex,
      document: { organizationId },
    },
    select: { mimeType: true, data: true },
  });
}

export async function setInvoiceDocumentStatus(
  invoiceDocumentId: string,
  status: 'processing' | 'processed' | 'failed',
  processingError?: string | null,
) {
  await prisma.invoiceDocument.update({
    where: { invoiceDocumentId },
    data: { status, processingError: processingError ?? null },
  });
}

export async function getInvoiceDocumentStatus(organizationId: string, invoiceDocumentId: string) {
  const doc = await prisma.invoiceDocument.findFirst({
    where: { organizationId, invoiceDocumentId },
    select: {
      invoiceDocumentId: true,
      filename: true,
      mimeType: true,
      status: true,
      processingError: true,
      pageCount: true,
      pages: { select: { pageIndex: true }, orderBy: { pageIndex: 'asc' } },
      paymentOrders: { select: { paymentOrderId: true, state: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!doc) return null;
  return {
    invoiceDocumentId: doc.invoiceDocumentId,
    filename: doc.filename,
    mimeType: doc.mimeType,
    status: doc.status,
    processingError: doc.processingError,
    pageCount: doc.pageCount,
    pagesStored: doc.pages.length,
    paymentOrders: doc.paymentOrders,
  };
}

export async function getInvoiceDocumentWithBytes(organizationId: string, invoiceDocumentId: string) {
  return prisma.invoiceDocument.findFirst({
    where: { organizationId, invoiceDocumentId },
    select: {
      invoiceDocumentId: true,
      filename: true,
      mimeType: true,
      byteSize: true,
      data: true,
    },
  });
}
