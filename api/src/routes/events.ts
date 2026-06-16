import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { subscribeOrgEvents } from '../infra/event-bus.js';
import { asyncRoute } from '../infra/route-helpers.js';

export const eventsRouter = Router();

const paramsSchema = z.object({
  organizationId: z.string().uuid(),
});

// Server-Sent Events stream of live changes for one organization. The frontend
// opens this with a Bearer token (via fetch, since native EventSource can't
// send headers) and invalidates its TanStack queries whenever an event lands,
// so a co-signer's screen updates the instant a proposal changes — no polling.
eventsRouter.get(
  '/organizations/:organizationId/events',
  asyncRoute(async (req, res) => {
    const { organizationId } = paramsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering (nginx / Cloudflare tunnel) so events flush now.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // Reconnect hint for the client, then open the stream.
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');

    const unsubscribe = subscribeOrgEvents(organizationId, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Heartbeat keeps the connection from idling out through the tunnel/proxies.
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }),
);
