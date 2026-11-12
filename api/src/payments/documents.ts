// Invoice document storage. The uploaded file is persisted BEFORE extraction runs,
// so even a failed or empty extraction leaves the original document retrievable —
// the draft screen renders it next to the extracted fields.
import { createHash } from 'node:crypto';
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';

/**
 * Largest document we accept, whatever door it comes through — a browser upload
 * or an email attachment. Lives here rather than on a route so both callers
 * share one number.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

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

/**
 * A bill's own pages, when its upload held several invoices (split-pages.ts): a
 * document of their own, so the bill page shows them alone and posting attaches them
 * alone. Never an upload: its hash is kept apart from uploads' ("pages:"), so the same
 * bytes uploaded later are read as an upload of their own, and it is on no list.
 * Splitting the same upload again finds the one already made.
 */
export async function storePagesDocument(args: {
  organizationId: string;
  uploadedByUserId: string | null;
  uploadName: string;
  from: number;
  to: number;
  bytes: Buffer;
  pageImages: Array<{ bytes: Buffer; mime: string }>;
}): Promise<{ invoiceDocumentId: string; filename: string }> {
  const sha256 = `pages:${createHash('sha256').update(args.bytes).digest('hex')}`;
  const base = args.uploadName.replace(/\.pdf$/i, '');
  const filename = `${base} (${args.from === args.to ? `page ${args.from}` : `pages ${args.from}-${args.to}`}).pdf`;
  const key = { organizationId_sha256: { organizationId: args.organizationId, sha256 } };
  const select = { invoiceDocumentId: true, filename: true } as const;
  const doc = await prisma.invoiceDocument.findUnique({ where: key, select })
    ?? await prisma.invoiceDocument.create({
      data: {
        organizationId: args.organizationId,
        filename,
        mimeType: 'application/pdf',
        byteSize: args.bytes.length,
        sha256,
        data: new Uint8Array(args.bytes),
        pageCount: args.to - args.from + 1,
        status: 'processed',
        uploadedByUserId: args.uploadedByUserId,
      },
      select,
    }).catch(async (error) => {
      // Made by a reading of the same upload a moment ago.
      const made = await prisma.invoiceDocument.findUnique({ where: key, select });
      if (made) return made;
      throw error;
    });
  if (args.pageImages.length > 0) await storeInvoiceDocumentPages(doc.invoiceDocumentId, args.pageImages);
  return doc;
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
  status: 'processing' | 'processed' | 'failed' | 'removed',
  processingError?: string | null,
) {
  await prisma.invoiceDocument.update({
    where: { invoiceDocumentId },
    data: { status, processingError: processingError ?? null },
  });
}

/** The words a document that failed on our side carries: the file is fine, the reading was not. */
export const READ_FAILED_ON_OUR_SIDE =
  'We could not read this document. That is a fault on our side, not a problem with the file. It is stored, so it can be read again.';

export async function getInvoiceDocumentStatus(organizationId: string, invoiceDocumentId: string) {
  const doc = await prisma.invoiceDocument.findFirst({
    where: { organizationId, invoiceDocumentId },
    select: {
      invoiceDocumentId: true,
      filename: true,
      mimeType: true,
      byteSize: true,
      status: true,
      processingError: true,
      pageCount: true,
      createdAt: true,
      uploadedByUser: { select: { displayName: true } },
      pages: { select: { pageIndex: true }, orderBy: { pageIndex: 'asc' } },
      paymentOrders: { select: { paymentOrderId: true, state: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!doc) return null;
  return {
    invoiceDocumentId: doc.invoiceDocumentId,
    filename: doc.filename,
    mimeType: doc.mimeType,
    byteSize: doc.byteSize,
    status: doc.status,
    processingError: doc.processingError,
    // Whose fault a failure was. Ours (a provider down, no key, a bug) reads
    // fine next time; anything else is what the document gave us.
    failure: doc.status !== 'failed' ? null
      : !doc.processingError || /fault on our side/.test(doc.processingError) ? 'ours' as const
      : 'no_bill' as const,
    pageCount: doc.pageCount,
    pagesStored: doc.pages.length,
    uploadedAt: doc.createdAt,
    uploadedByName: doc.uploadedByUser?.displayName ?? null,
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
