// Fetching attachment bytes from Resend.
//
// Resend's inbound webhook carries attachment METADATA only — id, filename,
// content type — so the bytes are a second API call. That is the single fact
// that shapes the whole ingestion design: the fetch is a third-party network
// call that can fail, so it needs a durable queue and a retry, not a floating
// promise inside the request handler.
//
// UNVERIFIED: the exact response shape is not confirmed against live docs. The
// reader below deliberately handles the three plausible forms (raw bytes,
// base64 in JSON, or a signed download URL) so the first real call succeeds
// whichever it turns out to be. Confirm the path, the shape, and — importantly
// — how long Resend retains the bytes: the retry budget below assumes at least
// a few hours.
import { config } from '../../config.js';

const RESEND_API_BASE = 'https://api.resend.com';

export type FetchedAttachment = {
  bytes: Buffer;
  contentType: string | null;
  filename: string | null;
};

export type ResendInboundRuntime = {
  fetchAttachment: (args: { emailId: string; attachmentId: string }) => Promise<FetchedAttachment>;
};

/** Thrown for conditions that will never succeed on retry (a 404, mainly). */
export class PermanentAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentAttachmentError';
  }
}

const defaultRuntime: ResendInboundRuntime = {
  fetchAttachment: async ({ emailId, attachmentId }) => {
    if (!config.resendApiKey) {
      throw new Error('RESEND_API_KEY is not configured; cannot fetch inbound attachment bytes.');
    }

    const response = await fetch(`${RESEND_API_BASE}/emails/${emailId}/attachments/${attachmentId}`, {
      headers: { authorization: `Bearer ${config.resendApiKey}` },
    });

    if (response.status === 404 || response.status === 410) {
      throw new PermanentAttachmentError(
        `Resend no longer has attachment ${attachmentId} for email ${emailId} (${response.status}).`,
      );
    }
    if (!response.ok) {
      // 429/5xx/network — transient, the sweep retries with backoff.
      throw new Error(`Resend attachment fetch failed (${response.status}).`);
    }

    return readAttachmentResponse(response);
  },
};

async function readAttachmentResponse(response: Response): Promise<FetchedAttachment> {
  const contentType = response.headers.get('content-type');

  // Form 1: the body IS the file.
  if (!contentType || !contentType.includes('application/json')) {
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType,
      filename: filenameFromDisposition(response.headers.get('content-disposition')),
    };
  }

  const body = (await response.json()) as Record<string, unknown>;

  // Form 2: base64 in JSON.
  const encoded = firstString(body.content, body.data, body.base64);
  if (encoded) {
    return {
      bytes: Buffer.from(encoded, 'base64'),
      contentType: firstString(body.content_type, body.contentType) ?? null,
      filename: firstString(body.filename, body.name) ?? null,
    };
  }

  // Form 3: a short-lived signed download URL. No auth header on the redirect
  // target — the signature in the URL is the credential.
  const url = firstString(body.url, body.download_url, body.downloadUrl);
  if (url) {
    const download = await fetch(url);
    if (!download.ok) {
      throw new Error(`Resend attachment download failed (${download.status}).`);
    }
    return {
      bytes: Buffer.from(await download.arrayBuffer()),
      contentType: download.headers.get('content-type'),
      filename: filenameFromDisposition(download.headers.get('content-disposition')),
    };
  }

  throw new Error('Resend attachment response had no recognisable body, base64 content, or download URL.');
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

let runtime: ResendInboundRuntime = defaultRuntime;

/** Swap the fetcher for tests, the same seam invoice-intake.ts uses. */
export function setResendInboundRuntimeForTests(next: Partial<ResendInboundRuntime> | null): void {
  runtime = next ? { ...defaultRuntime, ...next } : defaultRuntime;
}

// --- dev simulation ----------------------------------------------------------

// Bytes handed to the simulate endpoint, consulted before any network call.
// This is what lets the whole loop run with no Resend account, no MX records
// and no public ingress. Process-local and never populated in production: the
// only writer is the dev-secret-gated simulate route.
const simulatedBytes = new Map<string, Buffer>();

export function seedSimulatedAttachmentBytes(entries: Record<string, string>): void {
  for (const [attachmentId, base64] of Object.entries(entries)) {
    simulatedBytes.set(attachmentId, Buffer.from(base64, 'base64'));
  }
}

export function clearSimulatedAttachmentBytes(): void {
  simulatedBytes.clear();
}

export async function fetchInboundAttachment(args: {
  emailId: string;
  attachmentId: string;
  filename: string;
  contentType: string | null;
}): Promise<FetchedAttachment> {
  const seeded = simulatedBytes.get(args.attachmentId);
  if (seeded) {
    return { bytes: seeded, contentType: args.contentType, filename: args.filename };
  }
  return runtime.fetchAttachment({ emailId: args.emailId, attachmentId: args.attachmentId });
}
