import express from 'express';
import crypto from 'node:crypto';
import { ZodError } from 'zod';
import { mapKnownError, normalizeErrorCode } from './api-errors.js';
import { requireAuth } from './auth.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { collectionSourcesRouter } from './routes/collection-sources.js';
import { collectionsRouter } from './routes/collections.js';
import { config } from './config.js';
import { approvalsRouter } from './routes/approvals.js';
import { destinationsRouter } from './routes/destinations.js';
import { authRouter } from './routes/auth.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { idempotencyMiddleware } from './idempotency.js';
import { internalRouter } from './routes/internal.js';
import { notifyMatchingIndexChanged, shouldInvalidateMatchingIndex } from './matching-index-events.js';
import { openApiRouter } from './routes/openapi.js';
import { organizationsRouter } from './routes/organizations.js';
import { opsRouter } from './routes/ops.js';
import { paymentOrdersRouter } from './routes/payment-orders.js';
import { paymentRequestsRouter } from './routes/payment-requests.js';
import { paymentRunsRouter } from './routes/payment-runs.js';
import { publicRateLimitMiddleware } from './rate-limit.js';
import { treasuryWalletsRouter } from './routes/treasury-wallets.js';

export function createApp() {
  const app = express();

  app.use((req, res, next) => {
    const requestId = normalizeRequestId(req.header('x-request-id')) ?? crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });

  app.use((req, res, next) => {
    const origin = req.header('origin');
    const allowOrigin =
      origin && (origin === config.corsOrigin || isLocalDevOrigin(origin))
        ? origin
        : config.corsOrigin;

    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,idempotency-key,x-request-id');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'content-disposition,x-request-id');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use(publicRateLimitMiddleware());
  app.use(express.json());

  app.use((req, res, next) => {
    const shouldInvalidate = shouldInvalidateMatchingIndex(req.method, req.path);
    if (shouldInvalidate) {
      res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          notifyMatchingIndexChanged(`${req.method} ${req.path}`);
        }
      });
    }

    next();
  });

  app.use(healthRouter);
  app.use(capabilitiesRouter);
  app.use(openApiRouter);
  app.use(authRouter);
  app.use(internalRouter);
  app.use(requireAuth());
  app.use(idempotencyMiddleware());
  app.use(organizationsRouter);
  app.use(opsRouter);
  app.use(treasuryWalletsRouter);
  app.use(approvalsRouter);
  app.use(destinationsRouter);
  app.use(collectionSourcesRouter);
  app.use(paymentRequestsRouter);
  app.use(paymentRunsRouter);
  app.use(paymentOrdersRouter);
  app.use(collectionsRouter);
  app.use(eventsRouter);

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'ValidationError',
        code: 'validation_error',
        message: 'Request validation failed',
        requestId: _req.requestId,
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      });
      return;
    }

    const mappedError = mapKnownError(error);
    if (mappedError) {
      res.status(mappedError.statusCode).json({
        error: mappedError.name,
        code: mappedError.code,
        message: mappedError.message,
        requestId: _req.requestId,
        ...(mappedError.details === undefined ? {} : { details: mappedError.details }),
      });
      return;
    }

    if (error instanceof Error) {
      res.status(400).json({
        error: error.name,
        code: normalizeErrorCode(error.name),
        message: error.message,
        requestId: _req.requestId,
      });
      return;
    }

    res.status(500).json({
      error: 'InternalServerError',
      code: 'internal_server_error',
      message: 'Unexpected error',
      requestId: _req.requestId,
    });
  });

  return app;
}

function isLocalDevOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

function normalizeRequestId(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed && /^[a-zA-Z0-9._:-]{1,120}$/.test(trimmed) ? trimmed : null;
}
