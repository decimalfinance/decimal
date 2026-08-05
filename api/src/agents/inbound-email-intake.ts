// Inbound email attachment sweep.
//
// Resend's webhook carries attachment metadata only, so pulling the bytes is a
// separate third-party call that will sometimes fail. A detached promise inside
// the request handler would die with the process and lose the mail — exactly
// the black hole the members-only sender policy was chosen to avoid. Instead
// every accepted attachment is a durable row, and this sweep drains it.
//
// The queue row doubles as an operational tool: flipping a row back to
// 'pending' replays the ingestion.
//
// Same shape as settlement-reconciler.ts: module-level running guard so ticks
// never overlap, timer.unref() so it never holds the process open, config-gated
// with a no-op stopper, returns a stop function.
import { config } from '../config.js';
import { errorToLogFields, logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { beginAsyncInvoiceIntake } from '../payments/invoice-intake.js';
import { decideFetchedBytes } from '../payments/inbound-email/policy.js';
import { rollUpMessageDisposition } from '../payments/inbound-email/messages.js';
import {
  PermanentAttachmentError,
  fetchInboundAttachment,
} from '../payments/inbound-email/resend-inbound.js';

const BATCH = 25;
/**
 * Six attempts with exponential backoff spans roughly an hour. That has to stay
 * comfortably inside Resend's attachment retention window — see the UNVERIFIED
 * note in resend-inbound.ts.
 */
const MAX_ATTEMPTS = 6;
/**
 * How long a sweep owns a row it picked up. The webhook nudges a sweep inline
 * while the interval sweep may already be running, so two sweeps can select the
 * same pending row; the lease makes the claim exclusive. Without it both would
 * fetch the same attachment — harmless for correctness (the sha256 dedupe in
 * beginAsyncInvoiceIntake stops a duplicate bill) but wasted network, and it
 * muddies the status reason. Long enough to cover a slow fetch, short enough
 * that a crashed sweep's rows come back on their own.
 */
const CLAIM_LEASE_MS = 5 * 60_000;

export type InboundEmailIntakeSummary = {
  ingested: number;
  skipped: number;
  retried: number;
  failed: number;
};

/** Exponential, capped at 30 minutes. */
export function nextAttemptDelayMs(attempts: number): number {
  return Math.min(2 ** attempts, 30) * 60_000;
}

export async function runInboundEmailIntakeOnce(now: Date = new Date()): Promise<InboundEmailIntakeSummary> {
  const summary: InboundEmailIntakeSummary = { ingested: 0, skipped: 0, retried: 0, failed: 0 };

  const queued = await prisma.inboundEmailAttachment.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: BATCH,
    include: {
      message: {
        select: {
          inboundEmailMessageId: true,
          organizationId: true,
          senderUserId: true,
          providerEmailId: true,
          fromAddress: true,
          subject: true,
          receivedAt: true,
        },
      },
    },
  });

  const touchedMessages = new Set<string>();

  for (const attachment of queued) {
    // Claim it: push nextAttemptAt out so a concurrent sweep skips this row.
    // Guarded on the state we selected, so exactly one sweep wins.
    const claim = await prisma.inboundEmailAttachment.updateMany({
      where: {
        inboundEmailAttachmentId: attachment.inboundEmailAttachmentId,
        status: 'pending',
        nextAttemptAt: { lte: now },
      },
      data: { nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (claim.count === 0) continue;

    const message = attachment.message;
    touchedMessages.add(message.inboundEmailMessageId);

    // Belt and braces: the handler only queues attachments on accepted mail.
    if (!message.organizationId || !message.senderUserId || !message.providerEmailId) {
      await markAttachment(attachment.inboundEmailAttachmentId, 'skipped', 'message_not_ingestible');
      summary.skipped += 1;
      continue;
    }

    try {
      const fetched = await fetchInboundAttachment({
        emailId: message.providerEmailId,
        attachmentId: attachment.providerAttachmentId,
        filename: attachment.filename,
        contentType: attachment.contentType,
      });

      const sizeDecision = decideFetchedBytes(fetched.bytes.length);
      if (!sizeDecision.accept) {
        // One oversized or empty file never fails the whole message.
        await markAttachment(attachment.inboundEmailAttachmentId, 'skipped', sizeDecision.reason, {
          byteSize: fetched.bytes.length,
        });
        summary.skipped += 1;
        continue;
      }

      // Hand off to the pipeline that already exists. beginAsyncInvoiceIntake
      // (not uploadInvoiceToPaymentOrders) because it short-circuits on a
      // repeat sha256 — that is what makes a redelivered email safe.
      const result = await beginAsyncInvoiceIntake({
        organizationId: message.organizationId,
        // The sender is a member by policy, so the bill is attributed to a real
        // person. That keeps separation-of-duties honest downstream.
        actorUserId: message.senderUserId,
        fileBytes: fetched.bytes,
        filename: attachment.filename,
        mimeType: attachment.contentType ?? fetched.contentType ?? 'application/octet-stream',
        intakeChannel: {
          kind: 'email',
          inboundEmailMessageId: message.inboundEmailMessageId,
          fromAddress: message.fromAddress,
          subject: message.subject,
          receivedAt: message.receivedAt.toISOString(),
        },
      });

      await prisma.inboundEmailAttachment.update({
        where: { inboundEmailAttachmentId: attachment.inboundEmailAttachmentId },
        data: {
          status: 'ingested',
          statusReason: result.reused ? 'document_reused' : null,
          invoiceDocumentId: result.invoiceDocumentId,
          byteSize: fetched.bytes.length,
          lastError: null,
        },
      });
      summary.ingested += 1;
      if (result.reused) {
        logger.info('inbound_email.attachment_reused', {
          inboundEmailMessageId: message.inboundEmailMessageId,
          invoiceDocumentId: result.invoiceDocumentId,
        });
      }
    } catch (error) {
      const permanent = error instanceof PermanentAttachmentError;
      const attempts = attachment.attempts + 1;
      const exhausted = permanent || attempts >= MAX_ATTEMPTS;
      const messageText = error instanceof Error ? error.message : String(error);

      await prisma.inboundEmailAttachment.update({
        where: { inboundEmailAttachmentId: attachment.inboundEmailAttachmentId },
        data: {
          attempts,
          status: exhausted ? 'failed' : 'pending',
          statusReason: exhausted ? (permanent ? 'attachment_gone' : 'attachment_fetch_exhausted') : null,
          nextAttemptAt: new Date(now.getTime() + nextAttemptDelayMs(attempts)),
          lastError: messageText.slice(0, 500),
        },
      });

      if (exhausted) {
        summary.failed += 1;
        logger.warn('inbound_email.attachment_failed', {
          inboundEmailAttachmentId: attachment.inboundEmailAttachmentId,
          attempts,
          permanent,
          error: messageText,
        });
      } else {
        summary.retried += 1;
      }
    }
  }

  for (const inboundEmailMessageId of touchedMessages) {
    await rollUpMessageDisposition(inboundEmailMessageId).catch((error) => {
      logger.warn('inbound_email.rollup_failed', { inboundEmailMessageId, ...errorToLogFields(error) });
    });
  }

  return summary;
}

async function markAttachment(
  inboundEmailAttachmentId: string,
  status: 'skipped' | 'failed',
  statusReason: string,
  extra: { byteSize?: number } = {},
) {
  await prisma.inboundEmailAttachment.update({
    where: { inboundEmailAttachmentId },
    data: { status, statusReason, ...extra },
  });
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the sweep. Returns a stop function; a no-op stopper when disabled by
 * config. Ticks never overlap, and a failing tick is logged and retried.
 */
export function startInboundEmailIntake(): () => void {
  if (!config.inboundEmailIntakeEnabled) {
    logger.info('inbound_email_intake.disabled');
    return () => {};
  }
  const intervalMs = Math.max(5_000, config.inboundEmailIntakeIntervalMs);
  logger.info('inbound_email_intake.started', { intervalMs });

  timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void runInboundEmailIntakeOnce()
      .then((summary) => {
        if (summary.ingested || summary.skipped || summary.failed || summary.retried) {
          logger.info('inbound_email_intake.tick', summary);
        }
      })
      .catch((error) => {
        logger.warn('inbound_email_intake.tick_failed', errorToLogFields(error));
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
