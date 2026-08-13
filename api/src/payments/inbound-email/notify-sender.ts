// Telling the sender their email produced nothing.
//
// Every rejection here used to be silent. The reasoning was defensible on its
// own terms: never answer unknown mail, because replying to a forged sender is
// how you become someone else's spam. But it was applied to everyone, and the
// people forwarding invoices to this address are colleagues. A colleague who
// forwards a bill and hears nothing assumes it worked. The bill then doesn't
// get paid, and nobody finds out until the vendor calls.
//
// So the rule is narrower than "stay quiet": we only ever answer a sender we
// have already recognised as a member of the organization. That single
// condition does most of the safety work. We never reply to an address we
// can't vouch for, which means we can't be pointed at a stranger, and the
// recipient is by definition someone who has an account with us.
//
// Loop safety on top of that, per RFC 3834:
//
//   - we skip anything that announced itself as machine-generated
//     (Auto-Submitted, List-Id, Precedence: bulk), so we don't answer a robot
//   - our own reply carries Auto-Submitted: auto-replied, so a well-behaved
//     responder on the other end won't answer us
//   - one notice per message, ever, enforced in the database
//
// The last one is the backstop that matters. A member's out-of-office reply
// lands back here as an email with no attachment, which is itself a rejection,
// which would earn a notice, which their auto-responder would answer again.
// The header check should catch that on the first pass; sender_notified_at is
// what guarantees it can never reach a second lap even if it doesn't.
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { isEmailDeliveryConfigured, sendEmail } from '../../infra/email.js';
import { trackBackgroundWork } from '../../infra/background.js';

export type SenderNoticeKind =
  | 'no_attachments'
  | 'nothing_we_could_read'
  | 'download_failed';

export type NoticeOutcome =
  | { sent: true; kind: SenderNoticeKind }
  | { sent: false; skipped: string };

/**
 * Why each file didn't become a bill, in the sender's language rather than
 * ours. Keyed by the status reasons written to inbound_email_attachments.
 */
const ATTACHMENT_NOTE: Record<string, string> = {
  inline_attachment: 'part of the message itself rather than an attachment',
  signature_image: 'looks like a signature logo',
  attachment_too_small: 'too small to read as a document',
  attachment_too_large: 'too large for us to open',
  empty_attachment: 'the file was empty',
  unsupported_content_type: 'we can only read PDFs and images',
  too_many_attachments: 'more attachments than we open in one email',
  rich_text_wrapper:
    'your mail client wrapped the attachments in its own format. In Outlook, setting this contact to HTML or plain text fixes it',
  attachment_gone: 'we could not download it in time',
  attachment_fetch_exhausted: 'we could not download it',
  message_not_ingestible: 'we could not process it',
};

/** Dispositions worth a word. Accepted mail speaks for itself in the app. */
const NOTIFIABLE = new Set(['rejected', 'failed']);

/**
 * Reasons we keep to ourselves. Each one is either not the sender's business
 * or not safely answerable: two of them mean we never established who sent it.
 */
const SILENT_REASONS = new Set([
  'unknown_org',
  'org_inactive',
  'sender_not_member',
  'malformed_payload',
]);

export async function notifySenderIfNeeded(inboundEmailMessageId: string): Promise<NoticeOutcome> {
  const message = await prisma.inboundEmailMessage.findUnique({
    where: { inboundEmailMessageId },
    select: {
      toAddress: true,
      subject: true,
      disposition: true,
      dispositionReason: true,
      senderNotifiedAt: true,
      senderUserId: true,
      payloadJson: true,
      senderUser: { select: { email: true, displayName: true } },
      attachments: {
        select: { filename: true, status: true, statusReason: true },
        orderBy: { filename: 'asc' },
      },
    },
  });

  if (!message) return { sent: false, skipped: 'message_not_found' };
  if (message.senderNotifiedAt) return { sent: false, skipped: 'already_notified' };

  // The whole safety model in one line: members only, no exceptions.
  if (!message.senderUserId || !message.senderUser?.email) {
    return { sent: false, skipped: 'sender_not_a_member' };
  }

  if (!NOTIFIABLE.has(message.disposition)) return { sent: false, skipped: 'nothing_to_report' };
  if (message.dispositionReason && SILENT_REASONS.has(message.dispositionReason)) {
    return { sent: false, skipped: 'reason_is_not_theirs' };
  }
  if (wasMachineGenerated(message.payloadJson)) return { sent: false, skipped: 'auto_submitted' };
  if (!isEmailDeliveryConfigured()) return { sent: false, skipped: 'email_delivery_not_configured' };

  const kind = noticeKindFor(message.disposition, message.attachments);
  const notice = composeNotice({
    kind,
    displayName: message.senderUser.displayName,
    subject: message.subject,
    intakeAddress: message.toAddress,
    attachments: message.attachments,
  });

  // Claim before sending, not after.
  //
  // The webhook nudges a sweep while the interval sweep may already be running,
  // so two of them can roll up the same message at the same moment. A
  // read-then-write guard lets both through, and the colleague gets the same
  // notice twice. Making the database pick the winner is the same lease the
  // attachment sweep uses on its own rows.
  const claim = await prisma.inboundEmailMessage.updateMany({
    where: { inboundEmailMessageId, senderNotifiedAt: null },
    data: { senderNotifiedAt: new Date(), senderNoticeKind: kind },
  });
  if (claim.count === 0) return { sent: false, skipped: 'already_notified' };

  try {
    await sendEmail({
      to: message.senderUser.email,
      subject: notice.subject,
      text: notice.text,
      html: notice.html,
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
  } catch (error) {
    // Hand the claim back. Claiming first means at most one notice; releasing
    // on failure means a real send error doesn't cost the sender their only
    // chance of hearing about it.
    await prisma.inboundEmailMessage
      .updateMany({ where: { inboundEmailMessageId }, data: { senderNotifiedAt: null, senderNoticeKind: null } })
      .catch(() => {});
    throw error;
  }

  logger.info('inbound_email.sender_notified', { inboundEmailMessageId, kind });
  return { sent: true, kind };
}

/**
 * Fire the notice without making the caller wait on an outbound send. The
 * webhook has a response to return and the sweep has a batch to finish.
 */
export function queueSenderNotice(inboundEmailMessageId: string): void {
  trackBackgroundWork(
    notifySenderIfNeeded(inboundEmailMessageId).catch((error: unknown) => {
      // A notice that fails to send must never fail the intake around it.
      logger.warn('inbound_email.sender_notice_failed', {
        inboundEmailMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );
}

type NoticeAttachment = { filename: string; status: string; statusReason: string | null };

function noticeKindFor(disposition: string, attachments: NoticeAttachment[]): SenderNoticeKind {
  if (attachments.length === 0) return 'no_attachments';
  if (disposition === 'failed' || attachments.some((a) => a.status === 'failed')) return 'download_failed';
  return 'nothing_we_could_read';
}

function composeNotice(args: {
  kind: SenderNoticeKind;
  displayName: string | null;
  subject: string | null;
  intakeAddress: string;
  attachments: NoticeAttachment[];
}): { subject: string; text: string; html: string } {
  const { kind, displayName, subject, intakeAddress, attachments } = args;
  const greeting = displayName ? `Hi ${displayName.split(' ')[0]},` : 'Hi,';
  const named = subject ? `"${subject}"` : 'the email you forwarded';

  const lines: string[] = [greeting, ''];

  if (kind === 'download_failed') {
    lines.push(
      `Something went wrong on our side while downloading the attachment on ${named}, which you sent to ${intakeAddress}. No bill was created.`,
      '',
      'Please forward it again and it should go through.',
    );
  } else if (kind === 'no_attachments') {
    lines.push(
      `You sent ${named} to ${intakeAddress}, but there was no attachment on it, so there is no bill for anyone to approve.`,
      '',
      'If the invoice is written in the body of the email, send it again with the invoice attached as a PDF or an image. We do not read invoices out of the message itself.',
    );
  } else {
    lines.push(`We could not find an invoice in ${named}, which you sent to ${intakeAddress}. Here is what we found instead:`, '');
    for (const attachment of describable(attachments)) {
      lines.push(`  ${attachment.filename}: ${noteFor(attachment)}`);
    }
    lines.push('', 'Send it again with the invoice attached as a PDF or an image.');
  }

  lines.push('', 'No bill was created, so nothing is waiting on anyone.', '', '— Decimal');

  const heading =
    kind === 'download_failed' ? 'We could not open your attachment' : 'We could not find an invoice in your email';

  return {
    subject: subject ? `${heading}: ${subject}` : heading,
    text: lines.join('\n'),
    html: renderHtml(lines),
  };
}

/** Every attachment we can say something useful about, capped so a forwarded thread doesn't produce a wall. */
function describable(attachments: NoticeAttachment[]): NoticeAttachment[] {
  return attachments.filter((a) => a.status !== 'ingested').slice(0, 10);
}

function noteFor(attachment: NoticeAttachment): string {
  return (attachment.statusReason && ATTACHMENT_NOTE[attachment.statusReason]) ?? 'we could not read it';
}

function renderHtml(lines: string[]): string {
  const body = lines
    .map((line) => {
      if (line === '') return '';
      const indented = line.startsWith('  ');
      const style = indented
        ? 'margin: 4px 0 4px 16px; color: #444;'
        : 'margin: 12px 0;';
      return `<p style="${style}">${escapeHtml(line.trim())}</p>`;
    })
    .join('');
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111; line-height: 1.5;">${body}</div>`;
}

/**
 * Did this message announce itself as machine-generated?
 *
 * Read defensively out of the stored payload: the provider's header shape is
 * not something we control, so anything unrecognised reads as "a person sent
 * this", which is the direction that fails safely — we would rather answer one
 * robot than swallow a real colleague's email.
 */
function wasMachineGenerated(payload: unknown): boolean {
  const headers = readHeaders(payload);
  if (!headers) return false;

  const autoSubmitted = headers.get('auto-submitted');
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') return true;

  if (headers.has('list-id') || headers.has('list-unsubscribe')) return true;

  const precedence = headers.get('precedence')?.trim().toLowerCase();
  return precedence === 'bulk' || precedence === 'list' || precedence === 'auto_reply';
}

function readHeaders(payload: unknown): Map<string, string> | null {
  const data = (payload as { data?: unknown })?.data;
  const raw = (data as { headers?: unknown })?.headers ?? (payload as { headers?: unknown })?.headers;
  if (!raw) return null;

  const headers = new Map<string, string>();
  // Shape 1: [{ name, value }, ...]
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const name = (entry as { name?: unknown })?.name;
      const value = (entry as { value?: unknown })?.value;
      if (typeof name === 'string' && typeof value === 'string') headers.set(name.toLowerCase(), value);
    }
    return headers;
  }
  // Shape 2: { "Auto-Submitted": "auto-replied", ... }
  if (typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') headers.set(name.toLowerCase(), value);
    }
    return headers;
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
