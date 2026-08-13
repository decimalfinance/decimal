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
  | 'rich_text_wrapper'
  | 'unsupported_content_type'
  | 'too_many_attachments'
  | 'empty_attachment'
  | 'signature_image'
  | 'attachment_too_small'
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

  // winmail.dat: Outlook set to send Rich Text wraps every real attachment
  // inside one proprietary blob. This lands as unreadable either way, but the
  // sender's own mail client caused it and they can fix it in one setting —
  // so it earns a reason of its own rather than the generic "not a PDF or an
  // image", which would send them hunting for a problem that isn't theirs.
  if (isTnef(contentType, attachment.filename)) {
    return { accept: false, reason: 'rich_text_wrapper' };
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
 * Outlook renames every image it embeds in a message body to image001.png,
 * image002.jpg and so on. That is where signature logos, social icons and
 * letterhead come from, and it is the single most common junk shape here.
 *
 * Deliberately narrow: three or four digits, nothing else in the name. A phone
 * photo is IMG_4021.jpg and a scan is Scan_2026-08-13.pdf — neither matches.
 * Never used on its own, only in combination with the size ceiling below,
 * because a genuine invoice COULD be named this way if someone scanned it
 * straight into a message body.
 */
const SIGNATURE_FILENAME = /^image\d{3,4}\.(png|jpe?g|gif|bmp)$/i;

/**
 * Thresholds, and how much to trust them.
 *
 * Both numbers are judgement, not measurement — there is no published spec for
 * "how small is too small to be an invoice", and every AP vendor treats this as
 * proprietary. They are set where a signature logo (typically 1–15 KB) falls on
 * one side and a legible page scan on the other, and every skip is written to
 * the attachment row with its byte size, so they can be corrected from real
 * traffic rather than argued about.
 *
 * The risk runs one way: a size floor is the rule most likely to throw away a
 * real invoice — a compressed phone photo of a small receipt can land under
 * 10 KB. Hence the escape hatch in decideFetchedBytes, which is the important
 * half of this policy.
 */
const SIGNATURE_IMAGE_MAX_BYTES = 20 * 1024;
const MIN_IMAGE_BYTES = 8 * 1024;

/**
 * The reasons that cannot be decided from the webhook payload alone, because
 * they need the bytes. The sweep uses this to tell its own skips apart from the
 * handler's when it works out how many attachments a message really offered.
 */
export const POST_FETCH_SKIP_REASONS: readonly AttachmentSkipReason[] = [
  'empty_attachment',
  'attachment_too_large',
  'signature_image',
  'attachment_too_small',
];

export type FetchedBytesContext = {
  byteLength: number;
  filename: string;
  mimeType: string;
  /**
   * True when this is the last attachment on the message still standing. A lone
   * small image is far more likely to be a real (if low-resolution) receipt than
   * a stray logo, so the junk rules stand down and let it through — a bill we
   * can flag beats mail that vanished.
   */
  isOnlyCandidate: boolean;
};

/**
 * Size can only be checked after the bytes arrive — the webhook payload carries
 * no length. One oversized file never fails the whole message; its siblings
 * still ingest.
 */
export function decideFetchedBytes(
  context: FetchedBytesContext,
): { accept: true } | { accept: false; reason: AttachmentSkipReason } {
  const { byteLength, filename, mimeType, isOnlyCandidate } = context;

  if (byteLength === 0) return { accept: false, reason: 'empty_attachment' };
  if (byteLength > MAX_DOCUMENT_BYTES) return { accept: false, reason: 'attachment_too_large' };

  // A PDF is never signature junk — nobody embeds a logo as a PDF — and a
  // small one is a real, if minimal, invoice. Size rules are for images only.
  if (mimeType === 'application/pdf') return { accept: true };

  if (isOnlyCandidate) return { accept: true };

  if (SIGNATURE_FILENAME.test(filename.trim()) && byteLength < SIGNATURE_IMAGE_MAX_BYTES) {
    return { accept: false, reason: 'signature_image' };
  }

  if (byteLength < MIN_IMAGE_BYTES) {
    return { accept: false, reason: 'attachment_too_small' };
  }

  return { accept: true };
}

function isTnef(contentType: string | null, filename: string): boolean {
  if (contentType === 'application/ms-tnef' || contentType === 'application/vnd.ms-tnef') return true;
  return filename.trim().toLowerCase() === 'winmail.dat';
}
