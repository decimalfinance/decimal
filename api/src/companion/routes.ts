// The companion's routes. Any member may read their console: what it contains
// is filtered to their own work inside getCompanionConsole, not gated here.
import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { notFound } from '../infra/api-errors.js';
import { asyncRoute } from '../infra/route-helpers.js';
import { getCompanionConsole, getCompanionJob } from './today.js';

export const companionRouter = Router();

const orgParams = z.object({ organizationId: z.string().uuid() });
const jobParams = orgParams.extend({ jobId: z.string().uuid() });

companionRouter.get('/organizations/:organizationId/companion/console', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  res.json(await getCompanionConsole(organizationId, req.auth!.userId));
}));

companionRouter.get('/organizations/:organizationId/companion/jobs/:jobId', asyncRoute(async (req, res) => {
  const { organizationId, jobId } = jobParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const job = await getCompanionJob(organizationId, req.auth!.userId, jobId);
  if (!job) throw notFound('No such job.');
  res.json(job);
}));
