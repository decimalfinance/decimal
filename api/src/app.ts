import express from 'express';
import { requireAuth } from './auth.js';
import { addressesRouter } from './routes/addresses.js';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { labelsRouter } from './routes/labels.js';
import { objectsRouter } from './routes/objects.js';
import { organizationsRouter } from './routes/organizations.js';
import { workspacesRouter } from './routes/workspaces.js';

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
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use(express.json());

  app.use(healthRouter);
  app.use(authRouter);
  app.use(requireAuth());
  app.use(organizationsRouter);
  app.use(workspacesRouter);
  app.use(addressesRouter);
  app.use(labelsRouter);
  app.use(objectsRouter);
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
