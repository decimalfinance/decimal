// The bench's pretend Xero sign-in, and its disconnect (xero-connector.ts says why
// there is no real Xero). A sign-in button asks this for where to send the browser,
// as it asks Intuit's for QuickBooks. Here the sign-in is over by the time it
// answers: the organisation is saved, the setup hears about it, and the browser is
// sent straight back to the setup, on whatever origin it is on.

import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAdmin } from '../auth/organization-access.js';
import { notFound } from '../infra/api-errors.js';
import { asyncRoute, sendJson } from '../infra/route-helpers.js';
import { noteDisconnected, noteSignedIn } from './setup/service.js';
import { disconnectXero, saveXeroSignIn, xeroFixture } from './xero-connector.js';

export const xeroBenchRouter = Router();

const orgParams = z.object({ organizationId: z.string().uuid() });

xeroBenchRouter.get('/organizations/:organizationId/integrations/xero/sign-in', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  if (!xeroFixture()) throw notFound('Xero isn’t available here.');
  const tenantId = await saveXeroSignIn(organizationId);
  await noteSignedIn(organizationId, 'xero', tenantId);
  sendJson(res, { authorizeUrl: `/organizations/${organizationId}/integrations/xero` });
}));

xeroBenchRouter.delete('/organizations/:organizationId/integrations/xero', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  if (!xeroFixture()) throw notFound('Xero isn’t available here.');
  await disconnectXero(organizationId);
  await noteDisconnected(organizationId, 'xero');
  res.status(204).end();
}));
