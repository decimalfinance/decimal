import express from 'express';
import { requireAuth } from './auth.js';
import { addressLabelsRouter } from './routes/address-labels.js';
import { addressesRouter } from './routes/addresses.js';
import { config } from './config.js';
import { approvalsRouter } from './routes/approvals.js';
import { destinationsRouter } from './routes/destinations.js';
import { authRouter } from './routes/auth.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { internalRouter } from './routes/internal.js';
import { organizationsRouter } from './routes/organizations.js';
import { opsRouter } from './routes/ops.js';
import { payeesRouter } from './routes/payees.js';
import { paymentOrdersRouter } from './routes/payment-orders.js';
import { paymentRequestsRouter } from './routes/payment-requests.js';
import { transferRequestsRouter } from './routes/transfer-requests.js';

export function createApp() {
  const app = express();

  app.use((req, res, next) => {
    const origin = req.header('origin');
    const allowOrigin =
      origin && (origin === config.corsOrigin || isLocalDevOrigin(origin))
        ? origin
        : config.corsOrigin;

    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use(express.json());

  app.use(healthRouter);
  app.use(authRouter);
  app.use(internalRouter);
  app.use(requireAuth());
  app.use(addressLabelsRouter);
  app.use(organizationsRouter);
  app.use(opsRouter);
  app.use(addressesRouter);
  app.use(approvalsRouter);
  app.use(destinationsRouter);
  app.use(payeesRouter);
  app.use(paymentRequestsRouter);
  app.use(paymentOrdersRouter);
  app.use(transferRequestsRouter);
  app.use(eventsRouter);

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof Error) {
      res.status(400).json({
        error: error.name,
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      error: 'InternalServerError',
      message: 'Unexpected error',
    });
  });

  return app;
}

function isLocalDevOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}
