import express from 'express';
import crypto from 'node:crypto';
import { ZodError } from 'zod';
import { mapKnownError, normalizeErrorCode } from './infra/api-errors.js';
import { errorToLogFields, logger, requestLoggerMiddleware } from './infra/logger.js';
import { requireAuth } from './auth/sessions.js';
import { capabilityAccessMiddleware } from './auth/capability-access.js';
import { accountingRouter, publicAccountingRouter } from './routes/accounting.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { config } from './config.js';
import { counterpartyWalletsRouter } from './routes/counterparty-wallets.js';
import { eventsRouter } from './routes/events.js';
import { authRouter } from './routes/auth.js';
import { automationAgentsRouter } from './routes/automation-agents.js';
import { healthRouter } from './routes/health.js';
import { idempotencyMiddleware } from './infra/idempotency.js';
import { invoicesRouter } from './routes/invoices.js';
import { billsRouter } from './routes/bills.js';
import { openApiRouter } from './routes/openapi.js';
import { organizationsRouter } from './routes/organizations.js';
import { organizationInvitesRouter, publicOrganizationInvitesRouter } from './routes/organization-invites.js';
import { opsRouter } from './routes/ops.js';
import { paymentOrdersRouter } from './routes/payment-orders.js';
import { proposalsRouter } from './routes/proposals.js';
import { approvalsRouter } from './approvals/routes.js';
import { publicRateLimitMiddleware } from './infra/rate-limit.js';
import { solanaRpcRouter } from './routes/solana-rpc.js';
import { treasuryWalletsRouter } from './routes/treasury-wallets.js';
import { userWalletsRouter } from './routes/user-wallets.js';
import { walletAuthorizationsRouter } from './routes/wallet-authorizations.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    const requestId = normalizeRequestId(req.header('x-request-id')) ?? crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });
  app.use(requestLoggerMiddleware());

  app.use((req, res, next) => {
    const origin = req.header('origin');
    if (origin) {
      if (!isAllowedOrigin(origin)) {
        if (req.method === 'OPTIONS') {
          res.status(403).json({
            error: 'ForbiddenOrigin',
            code: 'forbidden_origin',
            message: 'Origin is not allowed',
            requestId: req.requestId,
          });
          return;
        }

        next();
        return;
      }

      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,idempotency-key,x-request-id,solana-client');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'content-disposition,x-request-id');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use(publicRateLimitMiddleware());
  // 15mb covers base64-encoded invoice uploads on the doc-to-proposal
  // route (10mb decoded, ~13.4mb encoded + headers). The 1mb default
  // is too tight for that payload.
  app.use(express.json({ limit: '15mb' }));

  app.use(healthRouter);
  app.use(capabilitiesRouter);
  app.use(openApiRouter);
  app.use(authRouter);
  app.use(publicOrganizationInvitesRouter);
  // QuickBooks OAuth callback — Intuit redirects here with no auth header.
  app.use(publicAccountingRouter);
  app.use(requireAuth());
  // Role-based access: org-scoped requests must carry the capability their
  // area requires (auth/capability-access.ts). Owner/admin bypass.
  app.use(capabilityAccessMiddleware());
  // SSE stream is authed but long-lived; mount it before idempotency so that
  // middleware (built for mutations) never wraps the open response.
  app.use(eventsRouter);
  // Authed Solana RPC proxy — keeps the paid RPC key out of the browser.
  app.use(solanaRpcRouter);
  app.use(idempotencyMiddleware());
  app.use(userWalletsRouter);
  app.use(automationAgentsRouter);
  app.use(organizationsRouter);
  app.use(organizationInvitesRouter);
  app.use(opsRouter);
  app.use(treasuryWalletsRouter);
  app.use(walletAuthorizationsRouter);
  app.use(counterpartyWalletsRouter);
  app.use(invoicesRouter);
  app.use(billsRouter);
  app.use(paymentOrdersRouter);
  app.use(proposalsRouter);
  app.use(approvalsRouter);
  app.use(accountingRouter);

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      logRequestError(error, req, 400, 'validation_error');
      res.status(400).json({
        error: 'ValidationError',
        code: 'validation_error',
        message: 'Request validation failed',
        requestId: req.requestId,
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
      logRequestError(error, req, mappedError.statusCode, mappedError.code);
      res.status(mappedError.statusCode).json({
        error: mappedError.name,
        code: mappedError.code,
        message: mappedError.message,
        requestId: req.requestId,
        ...(mappedError.details === undefined ? {} : { details: mappedError.details }),
      });
      return;
    }

    if (error instanceof Error) {
      logRequestError(error, req, 400, normalizeErrorCode(error.name));
      res.status(400).json({
        error: error.name,
        code: normalizeErrorCode(error.name),
        message: error.message,
        requestId: req.requestId,
      });
      return;
    }

    logRequestError(error, req, 500, 'internal_server_error');
    res.status(500).json({
      error: 'InternalServerError',
      code: 'internal_server_error',
      message: 'Unexpected error',
      requestId: req.requestId,
    });
  });

  return app;
}

function isAllowedOrigin(origin: string) {
  if (config.corsOrigins.includes(origin)) {
    return true;
  }

  if (!config.isProduction && isLocalDevOrigin(origin)) {
    return true;
  }

  return false;
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

function logRequestError(error: unknown, req: express.Request, statusCode: number, code: string) {
  const level = statusCode >= 500 ? 'error' : 'warn';
  logger[level]('http.request.failed', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    statusCode,
    code,
    userId: req.auth?.userId ?? null,
    ...errorToLogFields(error, { includeStack: statusCode >= 500 }),
  });
}
