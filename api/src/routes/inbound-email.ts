// Inbound invoice email: the public webhook Resend delivers to, a dev-only
// simulate endpoint, and the org-scoped reads the UI needs.
//
// Two routers, following the accounting.ts precedent: the public one mounts
// before requireAuth() (a mail provider carries no session), the authed one
// after.
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../infra/api-errors.js';
import { asyncRoute, sendJson } from '../infra/route-helpers.js';
import { INBOUND_EMAIL_WEBHOOK_PATH } from '../infra/rate-limit.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../auth/organization-access.js';
import { config } from '../config.js';
import { errorToLogFields, logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { handleInboundEmailEvent } from '../payments/inbound-email/handler.js';
import { listInboundMessages } from '../payments/inbound-email/messages.js';
import { intakeAddressFor } from '../payments/inbound-email/slug.js';
import { seedSimulatedAttachmentBytes } from '../payments/inbound-email/resend-inbound.js';
import { verifySvixSignature } from '../payments/inbound-email/svix-signature.js';

export const publicInboundEmailRouter = Router();
export const inboundEmailRouter = Router();

const organizationParamsSchema = z.object({ organizationId: z.string().uuid() });

// --- the webhook -------------------------------------------------------------

publicInboundEmailRouter.post(
  INBOUND_EMAIL_WEBHOOK_PATH,
  asyncRoute(async (req, res) => {
    if (!config.inboundEmailWebhookSecret) {
      // Deny the endpoint's own existence when the feature isn't configured,
      // the same way the dev-auth routes do.
      throw new ApiError(404, 'not_found', 'Not found.');
    }

    // Svix signs the exact bytes, so this route is mounted on express.raw().
    // If someone later moves express.json() above that mount, req.body becomes
    // a parsed object and every signature silently fails — fail loudly instead.
    if (!Buffer.isBuffer(req.body)) {
      logger.error('inbound_email.raw_body_missing', {
        note: 'express.raw() must be mounted on the webhook path before express.json()',
      });
      throw new ApiError(500, 'internal_server_error', 'Webhook body was not read as raw bytes.');
    }

    const verification = verifySvixSignature({
      rawBody: req.body,
      headers: req.headers,
      secret: config.inboundEmailWebhookSecret,
    });
    if (!verification.ok) {
      logger.warn('inbound_email.signature_rejected', {
        reason: verification.reason,
        svixId: req.header('svix-id') ?? req.header('webhook-id') ?? null,
      });
      // 401 so the provider retries: a rotated-secret misconfiguration should
      // be recoverable once we fix the config, not silently dropped.
      throw new ApiError(401, 'invalid_signature', 'Webhook signature is invalid.');
    }

    const providerEventId = req.header('svix-id') ?? req.header('webhook-id') ?? crypto.randomUUID();

    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      payload = null;
    }

    const outcome = await handleInboundEmailEvent({ payload, providerEventId, source: 'webhook' });
    nudgeSweep();
    sendJson(res, outcome);
  }),
);

// --- dev-only simulate -------------------------------------------------------

const simulateSchema = z.object({
  secret: z.string().min(1),
  payload: z.unknown(),
  providerEventId: z.string().min(1).optional(),
  /** attachmentId → base64 bytes, so the fetch runs with no Resend account. */
  attachmentBytes: z.record(z.string()).optional(),
});

publicInboundEmailRouter.post(
  `${INBOUND_EMAIL_WEBHOOK_PATH}/simulate`,
  asyncRoute(async (req, res) => {
    // req.body here is a Buffer too (the raw mount covers this path); parse it
    // ourselves rather than depending on middleware ordering.
    const parsedBody = Buffer.isBuffer(req.body) ? safeJson(req.body) : req.body;
    const input = simulateSchema.parse(parsedBody);
    requireDevSecret(input.secret);

    if (input.attachmentBytes) {
      seedSimulatedAttachmentBytes(input.attachmentBytes);
    }

    const outcome = await handleInboundEmailEvent({
      payload: input.payload,
      providerEventId: input.providerEventId ?? `sim_${crypto.randomUUID()}`,
      source: 'simulate',
    });
    nudgeSweep();
    sendJson(res, outcome);
  }),
);

/**
 * Same two-gate model as /auth/dev/*: 404 when the secret isn't configured at
 * all (so production denies the endpoint exists), then a constant-time compare.
 */
function requireDevSecret(secret: string) {
  if (!config.devAuthSecret) {
    throw new ApiError(404, 'not_found', 'Not found.');
  }
  const provided = Buffer.from(secret);
  const expected = Buffer.from(config.devAuthSecret);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new ApiError(401, 'invalid_credentials', 'Invalid developer secret.');
  }
}

/**
 * Run the fetch sweep immediately rather than waiting for the next tick, so a
 * forwarded invoice shows up in seconds. Best-effort: the interval sweep is
 * still the guarantee, this is only latency.
 */
function nudgeSweep() {
  void import('../agents/inbound-email-intake.js')
    .then((module) => module.runInboundEmailIntakeOnce())
    .catch((error) => logger.warn('inbound_email.nudge_failed', errorToLogFields(error)));
}

function safeJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

// --- org-scoped reads --------------------------------------------------------

inboundEmailRouter.get(
  '/organizations/:organizationId/inbound-email/address',
  asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);

    const organization = await prisma.organization.findUnique({
      where: { organizationId },
      select: { intakeSlug: true },
    });

    sendJson(res, {
      address: intakeAddressFor(organization?.intakeSlug ?? null),
      slug: organization?.intakeSlug ?? null,
      domain: config.inboundEmailDomain || null,
      enabled: Boolean(config.inboundEmailDomain && organization?.intakeSlug),
    });
  }),
);

inboundEmailRouter.get(
  '/organizations/:organizationId/inbound-email/messages',
  asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);

    const limit = Number(req.query.limit ?? 25);
    sendJson(res, { items: await listInboundMessages(organizationId, Number.isFinite(limit) ? limit : 25) });
  }),
);
