// One way out.
//
// Two things send mail now — the sign-in code and the intake notice that tells
// a colleague their forwarded email produced no bill — and both need the same
// from-header assembly, the same "not configured, so don't pretend" answer, and
// the same test seam. The alternative was a second copy of the fetch call,
// which is how two senders quietly drift apart on things like whether a 4xx
// throws.
import { config } from '../config.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Extra headers. RFC 3834 asks that anything a machine generated says so,
   * so the receiving end can decline to answer it.
   */
  headers?: Record<string, string>;
};

export type OutboundEmailRuntime = {
  send: (email: OutboundEmail) => Promise<void>;
};

export function isEmailDeliveryConfigured(): boolean {
  return Boolean(config.resendApiKey && config.resendFromEmail);
}

/** `Decimal <bills@…>` when a display name is configured, the bare address otherwise. */
export function outboundFromHeader(): string {
  return config.resendFromName
    ? `${config.resendFromName} <${config.resendFromEmail}>`
    : String(config.resendFromEmail);
}

const defaultRuntime: OutboundEmailRuntime = {
  send: async (email) => {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: outboundFromHeader(),
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
        ...(email.headers ? { headers: email.headers } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Resend send failed (${response.status}): ${body || response.statusText}`);
    }
  },
};

let runtime: OutboundEmailRuntime = defaultRuntime;

/**
 * Send, or report honestly that delivery isn't set up.
 *
 * `delivered: false` is not an error — a local checkout with no Resend key is a
 * normal state, and callers decide for themselves whether that matters. What
 * they must not do is record "we told them" when nothing left the building.
 */
export async function sendEmail(email: OutboundEmail): Promise<{ delivered: boolean }> {
  if (!isEmailDeliveryConfigured()) return { delivered: false };
  await runtime.send(email);
  return { delivered: true };
}

/** Capture outbound mail in tests instead of posting it to Resend. */
export function setOutboundEmailRuntimeForTests(next: OutboundEmailRuntime | null): void {
  runtime = next ?? defaultRuntime;
}
