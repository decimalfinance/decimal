import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

/** Public paths reachable by machines, not people — see isWebhookPath. */
export const INBOUND_EMAIL_WEBHOOK_PATH = '/webhooks/resend/inbound';

export function publicRateLimitMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.rateLimitEnabled) {
      next();
      return;
    }

    // Webhooks get their own, much higher bucket: the auth limiter's 120/min
    // would throttle a legitimate Monday-morning batch of forwarded invoices.
    // Signature verification still runs after this, so an unsigned flood is
    // cheap to reject either way.
    if (isWebhookPath(req.path)) {
      applyRateLimit({
        req,
        res,
        next,
        bucketKey: `webhook:${clientIp(req)}:${req.path}`,
        limit: config.inboundWebhookRateLimitMax,
        windowMs: 60_000,
      });
      return;
    }

    if (!isPublicLimitedPath(req.path)) {
      next();
      return;
    }

    applyRateLimit({
      req,
      res,
      next,
      bucketKey: `public:${clientIp(req)}:${req.path}`,
      limit: config.publicRateLimitMax,
      windowMs: config.publicRateLimitWindowMs,
    });
  };
}

export function resetRateLimitBuckets() {
  buckets.clear();
}

function applyRateLimit(args: {
  req: Request;
  res: Response;
  next: NextFunction;
  bucketKey: string;
  limit: number;
  windowMs: number;
}) {
  const limit = Math.max(1, args.limit);
  const windowMs = Math.max(1_000, args.windowMs);
  const now = Date.now();
  const existing = buckets.get(args.bucketKey);
  const bucket = existing && existing.resetAt > now
    ? existing
    : { count: 0, resetAt: now + windowMs };

  bucket.count += 1;
  buckets.set(args.bucketKey, bucket);

  const remaining = Math.max(0, limit - bucket.count);
  args.res.setHeader('ratelimit-limit', String(limit));
  args.res.setHeader('ratelimit-remaining', String(remaining));
  args.res.setHeader('ratelimit-reset', String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count <= limit) {
    args.next();
    return;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  args.res.setHeader('retry-after', String(retryAfterSeconds));
  args.res.status(429).json({
    error: 'RateLimitExceeded',
    code: 'rate_limit_exceeded',
    message: 'Too many requests. Retry after the current rate limit window resets.',
    requestId: args.req.requestId,
    retryAfterSeconds,
  });
}

function isPublicLimitedPath(path: string) {
  return path === '/auth/register' || path === '/auth/login' || path === '/capabilities';
}

function isWebhookPath(path: string) {
  return path === INBOUND_EMAIL_WEBHOOK_PATH || path === `${INBOUND_EMAIL_WEBHOOK_PATH}/simulate`;
}

function clientIp(req: Request) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}
