// Which attachments on a forwarded email are plausibly invoices.
//
// The allowlist mirrors what the extraction pipeline can actually render
// (document-extract.ts renderDocumentToImages: PDFs via pdftoppm/sips, images
// passed through by extension). Accepting a .docx here would just produce a
// bill that fails extraction later, with the failure surfacing somewhere far
// less legible than "we skipped this attachment".
import { MAX_DOCUMENT_BYTES } from '../documents.js';

export const INBOUND_ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/heic',
]);

export const INBOUND_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'webp', 'heic',
]);

const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
};

/**
 * A forwarded thread can carry a lot of junk. Ten is well past any real invoice
 * email and stops one message from queueing unbounded fetch work.
 */
export const INBOUND_MAX_ATTACHMENTS = 10;

export type AttachmentSkipReason =
  | 'inline_attachment'
  | 'unsupported_content_type'
  | 'too_many_attachments'
  | 'empty_attachment'
  | 'attachment_too_large';

export type AttachmentDecision =
  | { accept: true; mimeType: string }
  | { accept: false; reason: AttachmentSkipReason };

export type InboundAttachmentMeta = {
  filename: string;
  contentType: string | null;
  contentDisposition: string | null;
};

function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Decide on one attachment, given its position among the already-accepted ones.
 *
 * Order matters. The inline check comes first because email signature logos are
 * by far the biggest source of junk here: they are real PNGs, they would pass
 * the content-type check, and every forwarded thread carries a few. An inline
 * PDF is still accepted — some mail clients inline a single-page invoice.
 */
export function decideAttachment(
  attachment: InboundAttachmentMeta,
  acceptedSoFar: number,
): AttachmentDecision {
  const contentType = attachment.contentType?.trim().toLowerCase() ?? null;
  const extension = extensionOf(attachment.filename);
  const isPdf = contentType === 'application/pdf' || extension === 'pdf';

  if (attachment.contentDisposition?.trim().toLowerCase() === 'inline' && !isPdf) {
    return { accept: false, reason: 'inline_attachment' };
  }

  let mimeType: string | null = null;
  if (contentType && INBOUND_ALLOWED_CONTENT_TYPES.has(contentType)) {
    mimeType = contentType === 'image/jpg' ? 'image/jpeg' : contentType;
  } else if ((!contentType || contentType === 'application/octet-stream') && extension && INBOUND_ALLOWED_EXTENSIONS.has(extension)) {
    // Plenty of mail clients send everything as octet-stream. The extension is
    // the better signal there, so correct the mime rather than dropping a bill.
    mimeType = EXTENSION_MIME[extension]!;
  }

  if (!mimeType) {
    return { accept: false, reason: 'unsupported_content_type' };
  }

  if (acceptedSoFar >= INBOUND_MAX_ATTACHMENTS) {
    return { accept: false, reason: 'too_many_attachments' };
  }

  return { accept: true, mimeType };
}

/**
 * Size can only be checked after the bytes arrive — the webhook payload carries
 * no length. One oversized file never fails the whole message; its siblings
 * still ingest.
 */
export function decideFetchedBytes(byteLength: number): { accept: true } | { accept: false; reason: AttachmentSkipReason } {
  if (byteLength === 0) return { accept: false, reason: 'empty_attachment' };
  if (byteLength > MAX_DOCUMENT_BYTES) return { accept: false, reason: 'attachment_too_large' };
  return { accept: true };
}
