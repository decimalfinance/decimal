// Persistence for received mail. Every message gets a row before the webhook
// responds — accepted or not. That record is the whole reason mail we ignore is
// debuggable rather than a black hole, and it is what makes the
// sender_not_member rejection rate measurable on day one.
import type { Prisma } from '@prisma/client';
import { prisma } from '../../infra/prisma.js';

export const INBOUND_PROVIDER = 'resend';

export type InboundDisposition =
  | 'pending'
  | 'accepted'
  | 'partially_accepted'
  | 'rejected'
  | 'failed';

export type InboundRejectionReason =
  | 'unknown_org'
  | 'org_inactive'
  | 'sender_not_member'
  | 'no_attachments'
  | 'no_supported_attachments'
  | 'malformed_payload';

/** Plain-voice copy for the operator-facing ignored-mail list. */
export const REJECTION_COPY: Record<InboundRejectionReason, string> = {
  unknown_org: "Sent to an address we don't recognise",
  org_inactive: 'That workspace is no longer active',
  sender_not_member: 'Not on your team',
  no_attachments: 'No invoice attached',
  no_supported_attachments: "Attachments weren't a PDF or an image",
  malformed_payload: "We couldn't read that message",
};

export type AttachmentStatus = 'pending' | 'ingested' | 'skipped' | 'failed';

export type RecordMessageInput = {
  providerEventId: string;
  providerEmailId: string | null;
  organizationId: string | null;
  toAddress: string;
  intakeSlug: string | null;
  plusTag: string | null;
  fromAddress: string;
  fromDisplay: string | null;
  senderUserId: string | null;
  subject: string | null;
  messageIdHeader: string | null;
  disposition: InboundDisposition;
  dispositionReason: InboundRejectionReason | null;
  authResults: Prisma.InputJsonValue;
  payload: Prisma.InputJsonValue;
  attachments: Array<{
    providerAttachmentId: string;
    filename: string;
    contentType: string | null;
    contentDisposition: string | null;
    status: AttachmentStatus;
    statusReason: string | null;
  }>;
};

export type RecordMessageResult = {
  inboundEmailMessageId: string;
  deduped: boolean;
  queuedAttachments: number;
};

/**
 * Write the message and its attachment rows, or return the existing row when
 * this message has already been recorded.
 *
 * Dedupe is on `providerEmailId` (the MESSAGE) with `providerEventId` (the
 * DELIVERY) as a backstop — a provider retrying a delivery must never produce a
 * second bill. The insert is guarded by both unique indexes rather than a
 * read-then-write, so concurrent redeliveries can't both win.
 */
export async function recordInboundMessage(input: RecordMessageInput): Promise<RecordMessageResult> {
  const existing = await findExistingMessage(input.providerEventId, input.providerEmailId);
  if (existing) {
    return { inboundEmailMessageId: existing.inboundEmailMessageId, deduped: true, queuedAttachments: 0 };
  }

  try {
    const message = await prisma.inboundEmailMessage.create({
      data: {
        provider: INBOUND_PROVIDER,
        providerEventId: input.providerEventId,
        providerEmailId: input.providerEmailId,
        organizationId: input.organizationId,
        toAddress: input.toAddress,
        intakeSlug: input.intakeSlug,
        plusTag: input.plusTag,
        fromAddress: input.fromAddress,
        fromDisplay: input.fromDisplay,
        senderUserId: input.senderUserId,
        subject: input.subject,
        messageIdHeader: input.messageIdHeader,
        attachmentCount: input.attachments.length,
        disposition: input.disposition,
        dispositionReason: input.dispositionReason,
        authResultsJson: input.authResults,
        payloadJson: input.payload,
        processedAt: input.disposition === 'pending' ? null : new Date(),
        attachments: {
          create: input.attachments.map((attachment) => ({
            providerAttachmentId: attachment.providerAttachmentId,
            filename: attachment.filename,
            contentType: attachment.contentType,
            contentDisposition: attachment.contentDisposition,
            status: attachment.status,
            statusReason: attachment.statusReason,
          })),
        },
      },
      select: { inboundEmailMessageId: true },
    });

    return {
      inboundEmailMessageId: message.inboundEmailMessageId,
      deduped: false,
      queuedAttachments: input.attachments.filter((a) => a.status === 'pending').length,
    };
  } catch (error) {
    // Lost a race with a concurrent redelivery of the same message.
    if (isUniqueViolation(error)) {
      const raced = await findExistingMessage(input.providerEventId, input.providerEmailId);
      if (raced) {
        return { inboundEmailMessageId: raced.inboundEmailMessageId, deduped: true, queuedAttachments: 0 };
      }
    }
    throw error;
  }
}

async function findExistingMessage(providerEventId: string, providerEmailId: string | null) {
  return prisma.inboundEmailMessage.findFirst({
    where: {
      provider: INBOUND_PROVIDER,
      OR: [
        { providerEventId },
        ...(providerEmailId ? [{ providerEmailId }] : []),
      ],
    },
    select: { inboundEmailMessageId: true },
  });
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'P2002');
}

/**
 * Roll a message up once every attachment has reached a terminal state. Mixed
 * outcomes are `partially_accepted` rather than a flat pass or fail: one
 * unreadable logo must not make three real invoices look rejected.
 */
export async function rollUpMessageDisposition(inboundEmailMessageId: string): Promise<InboundDisposition | null> {
  const attachments = await prisma.inboundEmailAttachment.findMany({
    where: { inboundEmailMessageId },
    select: { status: true },
  });
  if (attachments.length === 0) return null;
  if (attachments.some((a) => a.status === 'pending')) return null;

  const ingested = attachments.filter((a) => a.status === 'ingested').length;
  const failed = attachments.filter((a) => a.status === 'failed').length;

  let disposition: InboundDisposition;
  let reason: string | null = null;
  if (ingested === attachments.length) {
    disposition = 'accepted';
  } else if (ingested > 0) {
    disposition = 'partially_accepted';
    reason = 'some_attachments_skipped';
  } else if (failed > 0) {
    disposition = 'failed';
    reason = 'attachment_fetch_exhausted';
  } else {
    disposition = 'rejected';
    reason = 'no_supported_attachments';
  }

  await prisma.inboundEmailMessage.update({
    where: { inboundEmailMessageId },
    data: { disposition, dispositionReason: reason, processedAt: new Date() },
  });
  return disposition;
}

/**
 * The operator-facing log: what arrived at this org's address and what we did
 * with it. Read-only; there is no release ceremony by design.
 */
export async function listInboundMessages(organizationId: string, limit = 25) {
  const rows = await prisma.inboundEmailMessage.findMany({
    where: { organizationId },
    orderBy: { receivedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
    select: {
      inboundEmailMessageId: true,
      fromAddress: true,
      fromDisplay: true,
      subject: true,
      receivedAt: true,
      disposition: true,
      dispositionReason: true,
      attachmentCount: true,
    },
  });

  return rows.map((row) => ({
    inboundEmailMessageId: row.inboundEmailMessageId,
    from: row.fromDisplay ?? row.fromAddress,
    fromAddress: row.fromAddress,
    subject: row.subject,
    receivedAt: row.receivedAt.toISOString(),
    disposition: row.disposition,
    attachmentCount: row.attachmentCount,
    // Plain voice for the UI; the raw reason stays available for support.
    reason: row.dispositionReason
      ? REJECTION_COPY[row.dispositionReason as InboundRejectionReason] ?? row.dispositionReason
      : null,
    reasonCode: row.dispositionReason,
  }));
}
