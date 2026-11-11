// What a sign-in on another site (Intuit's, Xero's) needs from Decimal: a signed
// state that carries the organisation there and back, the callback address the
// site sends the browser to, and the screen it may send the browser back to.

import crypto from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config.js';
import { ApiError } from '../infra/api-errors.js';

function requireStateSecret(): string {
  if (!config.oauthStateSecret) {
    throw new ApiError(501, 'oauth_state_not_configured', 'OAuth state signing is not configured.');
  }
  return config.oauthStateSecret;
}

export interface OAuthState {
  organizationId: string;
  frontendOrigin: string | null;
  // The exact redirect_uri used at the authorize step — the token exchange
  // must repeat it verbatim, so it rides in the signed state.
  redirectUri: string | null;
  /** Whose sign-in it is, so one system's callback can't spend another's. States from before this was kept are QuickBooks'. */
  system: string;
}

// Only redirect back to an origin we trust (an allowed CORS origin, or a
// localhost dev origin outside production) — never an arbitrary URL.
export function safeFrontendOrigin(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const origin = new URL(raw).origin;
    if (config.corsOrigins.includes(origin)) return origin;
    if (!config.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin;
    return null;
  } catch {
    return null;
  }
}

// The OAuth redirect URI, derived from the request host so local dev
// (localhost) and prod (api.decimal.finance) both work without ever touching
// the app's settings on the other site again — every such URI is registered
// once there. The token exchange must use the exact URI from the authorize
// step; since the browser lands on that very URL, deriving from the callback
// request's host reproduces it.
export function callbackRedirectUri(req: Request, path: string, fallback: string | null = null): string | null {
  const host = req.get('host');
  if (!host) return fallback;
  // Intuit and Xero both reject IP-address redirect URIs, so the loopback IP the
  // dev frontend uses (127.0.0.1) must be presented as localhost.
  const normalized = host.replace(/^127\.0\.0\.1(?=[:/]|$)/, 'localhost').replace(/^\[::1\](?=[:/]|$)/, 'localhost');
  return `${req.protocol}://${normalized}${path}`;
}

export function signState(organizationId: string, frontendOrigin: string | null, redirectUri: string | null, system: string): string {
  const secret = requireStateSecret();
  const payload = Buffer.from(
    JSON.stringify({ organizationId, frontendOrigin, redirectUri, system, n: crypto.randomBytes(8).toString('hex') }),
    'utf8',
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest();
  return `${payload}.${sig.toString('base64url')}`;
}

export function verifyState(raw: string): OAuthState {
  const secret = requireStateSecret();
  const [payload, sig] = (raw ?? '').split('.');
  if (!payload || !sig) {
    throw new ApiError(400, 'invalid_oauth_state', 'OAuth state is invalid.');
  }
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new ApiError(400, 'invalid_oauth_state', 'OAuth state signature is invalid.');
  }
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (typeof decoded?.organizationId !== 'string') {
    throw new ApiError(400, 'invalid_oauth_state', 'OAuth state payload is invalid.');
  }
  return {
    organizationId: decoded.organizationId,
    frontendOrigin: typeof decoded.frontendOrigin === 'string' ? decoded.frontendOrigin : null,
    redirectUri: typeof decoded.redirectUri === 'string' ? decoded.redirectUri : null,
    system: typeof decoded.system === 'string' ? decoded.system : 'quickbooks',
  };
}
