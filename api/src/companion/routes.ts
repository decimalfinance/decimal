// The companion's routes. Any member may read their briefing: what it contains
// is filtered to their own work inside getCompanionToday, not gated here.
import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { asyncRoute } from '../infra/route-helpers.js';
import { getCompanionToday } from './today.js';

export const companionRouter = Router();

const orgParams = z.object({ organizationId: z.string().uuid() });

companionRouter.get('/organizations/:organizationId/companion/today', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getCompanionToday(organizationId, req.auth!.userId));
}));
