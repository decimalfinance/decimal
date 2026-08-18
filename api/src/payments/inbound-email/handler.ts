// The one code path for a received email. The webhook route and the dev
// simulate route both call handleInboundEmailEvent; only signature verification
// differs between them, so everything below is exercised identically in dev.
//
// Status-code rule, and the reason for it:
//
//   401  bad signature      — the provider retries, which is what we want: a
//                             rotated-secret misconfiguration should be loud
//                             and recoverable, never silently swallowed.
//   404  not configured     — deny the endpoint's own existence in production.
//   500  we failed to record — the one case where a retry genuinely helps.
//   200  every business outcome, INCLUDING every rejection.
//
// That last line is the important one. Retries exist to survive our downtime,
// not to relitigate a decision. An unknown address will still be unknown in ten
// minutes; making the provider redeliver it eight more times just fills the log.
import { z } from 'zod';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { decideAttachment } from './policy.js';
import {
  type InboundRejectionReason,
  recordInboundMessage,
  type RecordMessageResult,
} from './messages.js';
import { extractEmailAddress, parseIntakeAddress } from './slug.js';

const attachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1).max(255).default('attachment'),
  content_type: z.string().max(255).nullish(),
  content_disposition: z.string().max(255).nullish(),
});

/**
 * Deliberately permissive about everything we don't act on: a provider adding a
 * field must never turn a real invoice into a malformed_payload rejection.
 */
export const inboundEventSchema = z.object({
  type: z.string(),
  data: z.object({
    email_id: z.string().min(1).nullish(),
    from: z.string().min(1),
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).default([]),
    subject: z.string().nullish(),
    message_id: z.string().nullish(),
    attachments: z.array(attachmentSchema).default([]),
    spf: z.unknown().optional(),
    dkim: z.unknown().optional(),
    dmarc: z.unknown().optional(),
  }),
});

export type InboundEvent = z.infer<typeof inboundEventSchema>;

export type InboundHandlerOutcome =
  | { status: 'ignored'; eventType: string }
  | { status: 'deduped'; inboundEmailMessageId: string }
  | { status: 'rejected'; inboundEmailMessageId: string; reason: InboundRejectionReason }
  | { status: 'queued'; inboundEmailMessageId: string; queuedAttachments: number };

export type HandleInboundArgs = {
  /** Already signature-verified (or dev-simulated) event body. */
  payload: unknown;
  /** Svix delivery id — the idempotency key for a redelivered webhook. */
  providerEventId: string;
  source: 'webhook' | 'simulate';
};

export async function handleInboundEmailEvent(args: HandleInboundArgs): Promise<InboundHandlerOutcome> {
  const parsed = inboundEventSchema.safeParse(args.payload);
  if (!parsed.success) {
    // Terminal: our fix will not ship inside the provider's retry window, and a
    // stuck retry queue is worse than a recorded message we can replay through
    // the simulate endpoint.
    logger.error('inbound_email.malformed_payload', {
      providerEventId: args.providerEventId,
      source: args.source,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.code}`),
    });
    const recorded = await recordMalformed(args.providerEventId, args.payload);
    return { status: 'rejected', inboundEmailMessageId: recorded.inboundEmailMessageId, reason: 'malformed_payload' };
  }

  const event = parsed.data;
  if (event.type !== 'email.received') {
    // Never make a provider retry an event we simply don't handle.
    return { status: 'ignored', eventType: event.type };
  }

  const fromAddress = extractEmailAddress(event.data.from);
  const fromDisplay = displayNameOf(event.data.from);
  const authResults = {
    spf: event.data.spf ?? null,
    dkim: event.data.dkim ?? null,
    dmarc: event.data.dmarc ?? null,
  };

  // A clerk who cc's the intake address is a real habit, so scan cc too.
  const recipients = [...event.data.to, ...event.data.cc];
  const match = resolveIntakeRecipient(recipients);

  const base = {
    providerEventId: args.providerEventId,
    providerEmailId: event.data.email_id ?? null,
    fromAddress,
    fromDisplay,
    subject: event.data.subject ?? null,
    messageIdHeader: event.data.message_id ?? null,
    authResults,
    payload: toJson(args.payload),
  };

  if (!match) {
    return reject({
      ...base,
      toAddress: extractEmailAddress(recipients[0] ?? 'unknown@unknown'),
      intakeSlug: null,
      plusTag: null,
      organizationId: null,
      senderUserId: null,
      reason: 'unknown_org',
      attachments: event.data.attachments,
    });
  }

  const organization = await prisma.organization.findUnique({
    where: { intakeSlug: match.slug },
    select: { organizationId: true, status: true },
  });

  if (!organization) {
    return reject({
      ...base,
      toAddress: match.address,
      intakeSlug: match.slug,
      plusTag: match.plusTag,
      organizationId: null,
      senderUserId: null,
      reason: 'unknown_org',
      attachments: event.data.attachments,
    });
  }

  if (organization.status !== 'active') {
    return reject({
      ...base,
      toAddress: match.address,
      intakeSlug: match.slug,
      plusTag: match.plusTag,
      organizationId: organization.organizationId,
      senderUserId: null,
      reason: 'org_inactive',
      attachments: event.data.attachments,
    });
  }

  // Sender policy: members only. One indexed lookup — users.email is unique.
  const membership = await prisma.organizationMembership.findFirst({
    where: {
      organizationId: organization.organizationId,
      status: 'active',
      user: { email: fromAddress, status: 'active' },
    },
    select: { userId: true },
  });

  const scoped = {
    ...base,
    toAddress: match.address,
    intakeSlug: match.slug,
    plusTag: match.plusTag,
    organizationId: organization.organizationId,
  };

  if (!membership) {
    // No bill, no bounce — but a record, so the rejection rate is measurable
    // and "why didn't my invoice arrive" is answerable.
    return reject({ ...scoped, senderUserId: null, reason: 'sender_not_member', attachments: event.data.attachments });
  }

  // The two doors have to agree.
  //
  // Upload is gated on bills.create, so anyone but a Viewer may bring a bill
  // in. If email were left at members-only, a Viewer refused at the Upload
  // button could forward the same invoice and it would land — the same act
  // allowed or refused depending on which door was used. A Viewer's seat is
  // read-only, and creating a record is not reading.
  const { getOrgAccess } = await import('../../approvals/permissions.js');
  const senderAccess = await getOrgAccess(organization.organizationId, membership.userId);
  if (!senderAccess?.capabilities.includes('bills.create')) {
    return reject({ ...scoped, senderUserId: membership.userId, reason: 'sender_cannot_create', attachments: event.data.attachments });
  }

  if (event.data.attachments.length === 0) {
    return reject({ ...scoped, senderUserId: membership.userId, reason: 'no_attachments', attachments: [] });
  }

  // Triage the attachments: accepted ones queue for the fetch sweep, the rest
  // are recorded as skipped with a reason.
  let accepted = 0;
  const rows = event.data.attachments.map((attachment) => {
    const decision = decideAttachment(
      {
        filename: attachment.filename,
        contentType: attachment.content_type ?? null,
        contentDisposition: attachment.content_disposition ?? null,
      },
      accepted,
    );
    if (decision.accept) accepted += 1;
    return {
      providerAttachmentId: attachment.id,
      filename: attachment.filename,
      contentType: decision.accept ? decision.mimeType : attachment.content_type ?? null,
      contentDisposition: attachment.content_disposition ?? null,
      status: decision.accept ? ('pending' as const) : ('skipped' as const),
      statusReason: decision.accept ? null : decision.reason,
    };
  });

  if (accepted === 0) {
    const recorded = await recordInboundMessage({
      ...scoped,
      senderUserId: membership.userId,
      disposition: 'rejected',
      dispositionReason: 'no_supported_attachments',
      attachments: rows,
    });
    logIgnored('no_supported_attachments', scoped.organizationId, fromAddress, args.source);
    return {
      status: 'rejected',
      inboundEmailMessageId: recorded.inboundEmailMessageId,
      reason: 'no_supported_attachments',
    };
  }

  const recorded = await recordInboundMessage({
    ...scoped,
    senderUserId: membership.userId,
    disposition: 'pending',
    dispositionReason: null,
    attachments: rows,
  });

  if (recorded.deduped) {
    logger.info('inbound_email.deduped', {
      inboundEmailMessageId: recorded.inboundEmailMessageId,
      providerEventId: args.providerEventId,
    });
    return { status: 'deduped', inboundEmailMessageId: recorded.inboundEmailMessageId };
  }

  logger.info('inbound_email.queued', {
    inboundEmailMessageId: recorded.inboundEmailMessageId,
    organizationId: organization.organizationId,
    queuedAttachments: recorded.queuedAttachments,
    source: args.source,
  });

  return {
    status: 'queued',
    inboundEmailMessageId: recorded.inboundEmailMessageId,
    queuedAttachments: recorded.queuedAttachments,
  };
}

type RejectArgs = Omit<Parameters<typeof recordInboundMessage>[0], 'disposition' | 'dispositionReason' | 'attachments'> & {
  reason: InboundRejectionReason;
  attachments: Array<z.infer<typeof attachmentSchema>>;
};

async function reject(args: RejectArgs): Promise<InboundHandlerOutcome> {
  const { reason, attachments, ...rest } = args;
  // Attachments are recorded but never queued: we do not fetch bytes for mail
  // we are not accepting. Storing untrusted attachments from arbitrary senders
  // is a liability, and nothing downstream would read them.
  const recorded = await recordInboundMessage({
    ...rest,
    disposition: 'rejected',
    dispositionReason: reason,
    attachments: attachments.map((a) => ({
      providerAttachmentId: a.id,
      filename: a.filename,
      contentType: a.content_type ?? null,
      contentDisposition: a.content_disposition ?? null,
      status: 'skipped' as const,
      statusReason: reason,
    })),
  });
  logIgnored(reason, rest.organizationId, rest.fromAddress, 'webhook');
  return { status: 'rejected', inboundEmailMessageId: recorded.inboundEmailMessageId, reason };
}

async function recordMalformed(providerEventId: string, payload: unknown): Promise<RecordMessageResult> {
  return recordInboundMessage({
    providerEventId,
    providerEmailId: null,
    organizationId: null,
    toAddress: 'unknown',
    intakeSlug: null,
    plusTag: null,
    fromAddress: 'unknown',
    fromDisplay: null,
    senderUserId: null,
    subject: null,
    messageIdHeader: null,
    disposition: 'rejected',
    dispositionReason: 'malformed_payload',
    authResults: {},
    payload: toJson(payload),
    attachments: [],
  });
}

function logIgnored(
  reason: InboundRejectionReason,
  organizationId: string | null,
  fromAddress: string,
  source: string,
) {
  logger.info('inbound_email.ignored', { reason, organizationId, fromAddress, source });
}

function resolveIntakeRecipient(recipients: string[]): { address: string; slug: string; plusTag: string | null } | null {
  for (const raw of recipients) {
    const address = extractEmailAddress(raw);
    const parsed = parseIntakeAddress(address);
    if (parsed) return { address, slug: parsed.slug, plusTag: parsed.plusTag };
  }
  return null;
}

function displayNameOf(value: string): string | null {
  const angled = value.match(/^\s*(.+?)\s*<[^>]+>\s*$/);
  const name = angled?.[1]?.replace(/^"|"$/g, '').trim();
  return name && name.length > 0 ? name : null;
}

function toJson(value: unknown) {
  // The raw event is kept for support/replay; anything unserializable is
  // discarded rather than failing the write.
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
}
