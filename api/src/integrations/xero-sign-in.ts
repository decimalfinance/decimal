// Signing in to Xero, and disconnecting. With Decimal's Xero app (xero-app.ts) the
// sign-in is Xero's own: the sign-in button asks this for Xero's address, the
// person picks their organisation there and allows Decimal to read it, and Xero
// sends the browser to the callback here, which keeps the sign-in, tells the setup,
// and sends the browser back to the setup.
//
// Without the app, on the bench, the sign-in is pretend: it connects the made-up
// organisation and is over by the time it answers, so the browser goes straight
// back to the setup, on whatever origin it is on.

import { Router, type Response } from 'express';
import { z } from 'zod';
import { callbackRedirectUri, safeFrontendOrigin, signState, verifyState, type OAuthState } from '../accounting/oauth-state.js';
import { assertOrganizationAdmin } from '../auth/organization-access.js';
import { config } from '../config.js';
import { ApiError, notFound } from '../infra/api-errors.js';
import { errorToLogFields, logger } from '../infra/logger.js';
import { asyncRoute, sendJson } from '../infra/route-helpers.js';
import { noteDisconnected, noteSignedIn, noteSignInFailed } from './setup/service.js';
import { authEventOf, connectedBy, exchangeXeroCode, xeroAppConfigured, xeroAuthorizeUrl, xeroConnections } from './xero-app.js';
import { disconnectXero, saveXeroConnection, saveXeroSignIn, xeroAvailable, xeroFixture } from './xero-connector.js';

const SYSTEM = 'xero';
const CALLBACK_PATH = '/accounting/xero/callback';
const orgParams = z.object({ organizationId: z.string().uuid() });
const setupScreen = (organizationId: string) => `/organizations/${organizationId}/integrations/${SYSTEM}`;

// ---- the callback Xero sends the browser to (no session: the signed state says whose it is) ----

export const publicXeroRouter = Router();

/** Back to the setup, whose conversation says how the sign-in went. */
function backToSetup(res: Response, state: OAuthState | null) {
  const base = state?.frontendOrigin || config.publicFrontendUrl;
  if (base && state) {
    res.redirect(`${base}${setupScreen(state.organizationId)}`);
    return;
  }
  res.status(400).type('html').send('<p>The Xero sign-in couldn’t be finished here. Close this tab and start it again from Decimal.</p>');
}

publicXeroRouter.get(CALLBACK_PATH, asyncRoute(async (req, res) => {
  let state: OAuthState | null = null;
  try {
    state = verifyState(String(req.query.state ?? ''));
  } catch {
    state = null;
  }
  // Another system's sign-in is not this one's to finish. Nor is one nobody signed for: it says nothing to anyone.
  if (!state || state.system !== SYSTEM) {
    backToSetup(res, null);
    return;
  }
  if (req.query.error) {
    // Cancelled, or refused by Xero (a scope it doesn't know, say): its words, for whoever has to fix it.
    logger.info('xero.sign_in_not_given', { organizationId: state.organizationId, error: String(req.query.error).slice(0, 100), description: String(req.query.error_description ?? '').slice(0, 300) });
    await noteSignInFailed(state.organizationId, SYSTEM, String(req.query.error));
    backToSetup(res, state);
    return;
  }
  try {
    const code = String(req.query.code ?? '');
    const redirectUri = state.redirectUri ?? callbackRedirectUri(req, CALLBACK_PATH);
    if (!code || !redirectUri) throw new Error('Xero came back without a code.');
    const tokens = await exchangeXeroCode(code, redirectUri);
    // Only the tokens and which organisation they reach. Signing in reads nothing else and writes nothing.
    const connection = connectedBy(await xeroConnections(tokens.accessToken), authEventOf(tokens.accessToken));
    if (!connection) throw new Error('No Xero organisation came back with the sign-in.');
    await saveXeroConnection(state.organizationId, connection.tenantId, tokens);
    await noteSignedIn(state.organizationId, SYSTEM, connection.tenantId);
  } catch (error) {
    logger.warn('xero.sign_in_failed', { organizationId: state.organizationId, ...errorToLogFields(error) });
    await noteSignInFailed(state.organizationId, SYSTEM, 'failed');
  }
  backToSetup(res, state);
}));

// ---- the sign-in button, and disconnecting ----

export const xeroRouter = Router();

xeroRouter.get('/organizations/:organizationId/integrations/xero/sign-in', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  if (xeroAppConfigured()) {
    const frontendOrigin = safeFrontendOrigin(typeof req.query.frontendOrigin === 'string' ? req.query.frontendOrigin : req.get('origin'));
    const redirectUri = callbackRedirectUri(req, CALLBACK_PATH);
    if (!redirectUri) throw new ApiError(400, 'no_host', 'The request didn’t say which host it was for.');
    sendJson(res, { authorizeUrl: xeroAuthorizeUrl(signState(organizationId, frontendOrigin, redirectUri, SYSTEM), redirectUri) });
    return;
  }
  if (!xeroFixture()) throw notFound('Xero isn’t available here.');
  const tenantId = await saveXeroSignIn(organizationId);
  await noteSignedIn(organizationId, SYSTEM, tenantId);
  sendJson(res, { authorizeUrl: setupScreen(organizationId) });
}));

xeroRouter.delete('/organizations/:organizationId/integrations/xero', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  if (!xeroAvailable()) throw notFound('Xero isn’t available here.');
  await disconnectXero(organizationId);
  await noteDisconnected(organizationId, SYSTEM);
  res.status(204).end();
}));
