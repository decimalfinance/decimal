// Decimal's Xero app (XERO_CLIENT_ID, XERO_CLIENT_SECRET): the sign-in on Xero's
// own site, and a client that reads one organisation through Xero's Accounting
// API for the reader (xero-reader.ts). Read only. The sign-in asks to read the
// organisation's settings, contacts, bills and spend money, and nothing else.
// Posting, when it comes, asks for more, and that takes a new sign-in.
//
// A sign-in lasts 30 minutes. Its refresh token lasts 60 days unused and is
// replaced every time it is spent, so each renewal is stored at once, and renewals
// are shared: two reads at once on a lapsed sign-in spend the refresh token once.
// QuickBooks' client has the same problem and the same answer (accounting/quickbooks.ts).

import { config } from '../config.js';
import { BooksReadError } from './books.js';
import { XeroApiError, type XeroClient } from './xero-reader.js';

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const REVOKE_URL = 'https://identity.xero.com/connect/revocation';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

/**
 * Read only, area by area: apps made after 2 March 2026 get Xero's granular scopes.
 * The organisation, accounts, currencies and tracking categories are settings; bills
 * and linked transactions are invoices; spend money is bank transactions.
 * offline_access is what brings a refresh token.
 */
export const XERO_SCOPES = 'offline_access accounting.settings.read accounting.contacts.read accounting.invoices.read accounting.banktransactions.read';

const ACCESS_SECONDS = 1800;
const REFRESH_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
/** Renewed this long before it runs out, so a page in flight doesn't outlive it. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120_000;
/** Xero takes five requests at once for an organisation. One is left for anything else reading it. */
const AT_ONCE = 4;
/** How long a renewal's answer is kept for a reader that read the tokens just before it was stored. */
const RENEWAL_KEPT_MS = 60_000;

export type XeroTokens = {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  refreshExpiresAt: number;
};

/** Xero's sign-in service said no. `dead`: the refresh token is spent or revoked, and only signing in again helps. */
export class XeroSignInError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Xero's sign-in answered ${status}: ${body.slice(0, 300)}`);
    this.name = 'XeroSignInError';
  }

  get dead(): boolean {
    return this.body.includes('invalid_grant');
  }
}

export function xeroAppConfigured(): boolean {
  return Boolean(config.xeroClientId && config.xeroClientSecret);
}

export function xeroAuthorizeUrl(state: string, redirectUri: string): string {
  const query = new URLSearchParams({ response_type: 'code', client_id: config.xeroClientId, redirect_uri: redirectUri, scope: XERO_SCOPES, state });
  // A space as %20: the scopes are space-separated, and nothing else here holds a +.
  return `${AUTHORIZE_URL}?${query.toString().replace(/\+/g, '%20')}`;
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${config.xeroClientId}:${config.xeroClientSecret}`).toString('base64')}`;
}

async function tokenRequest(form: Record<string, string>): Promise<XeroTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new XeroSignInError(res.status, text);
  let json: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    throw new XeroSignInError(res.status, 'an answer that is not JSON');
  }
  // No refresh token means no offline_access, and a sign-in that dies in 30 minutes.
  if (typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string') throw new XeroSignInError(res.status, 'an answer without both tokens');
  const now = Date.now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: now + (typeof json.expires_in === 'number' ? json.expires_in : ACCESS_SECONDS) * 1000,
    refreshExpiresAt: now + REFRESH_LIFETIME_MS,
  };
}

/** The code Xero sends the browser back with, for the sign-in's tokens. It works once, within five minutes. */
export function exchangeXeroCode(code: string, redirectUri: string): Promise<XeroTokens> {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

export type XeroConnection = {
  /** The connection's own id, for removing it. */
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName: string | null;
  authEventId: string | null;
  updatedDateUtc: string | null;
};

/** Every organisation the person who signed in has connected to Decimal's app. */
export async function xeroConnections(accessToken: string): Promise<XeroConnection[]> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new XeroApiError(res.status, saidIn(text) ?? `Xero answered ${res.status} for its connections.`);
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) throw new XeroApiError(502, 'Xero answered its connections without a list.');
  return rows.flatMap((row: Record<string, unknown>) => (typeof row?.id === 'string' && typeof row.tenantId === 'string'
    ? [{
        id: row.id,
        tenantId: row.tenantId,
        tenantType: typeof row.tenantType === 'string' ? row.tenantType : '',
        tenantName: typeof row.tenantName === 'string' ? row.tenantName : null,
        authEventId: typeof row.authEventId === 'string' ? row.authEventId : null,
        updatedDateUtc: typeof row.updatedDateUtc === 'string' ? row.updatedDateUtc : null,
      }]
    : []));
}

/** Which sign-in an access token came from. Xero writes it into the token, and onto each connection that sign-in made. */
export function authEventOf(accessToken: string): string | null {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { authentication_event_id?: unknown };
    return typeof claims.authentication_event_id === 'string' ? claims.authentication_event_id : null;
  } catch {
    return null;
  }
}

/**
 * The organisation a sign-in connected: of the connections it made, the latest.
 * When none carries its id, the only organisation there is, or nothing: Decimal
 * doesn't guess between several.
 */
export function connectedBy(connections: XeroConnection[], authEventId: string | null): XeroConnection | null {
  const organisations = connections.filter((c) => c.tenantType === 'ORGANISATION');
  const fromThis = authEventId ? organisations.filter((c) => c.authEventId === authEventId) : [];
  const pool = fromThis.length > 0 ? fromThis : organisations.length === 1 ? organisations : [];
  return [...pool].sort((a, b) => (b.updatedDateUtc ?? '').localeCompare(a.updatedDateUtc ?? ''))[0] ?? null;
}

/** The organisation stops being connected to Decimal's app. Best effort: the caller goes ahead whatever Xero says. */
export async function removeXeroConnection(accessToken: string, connectionId: string): Promise<void> {
  const res = await fetch(`${CONNECTIONS_URL}/${encodeURIComponent(connectionId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await res.arrayBuffer();
}

/** The sign-in ends: Xero refuses its refresh token from now on. Best effort, as above. */
export async function revokeXeroToken(refreshToken: string): Promise<void> {
  const res = await fetch(REVOKE_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await res.arrayBuffer();
}

/** Where a sign-in is kept between reads: the connection's row. */
export type XeroTokenStore = {
  /** Keep a renewal, in place of the tokens it spent. Its refresh token is the only one Xero takes from now on. */
  save(fresh: XeroTokens, spent: string): Promise<void>;
  /** The tokens kept now, while the connection holds. Another read may have renewed first. */
  stored(): Promise<XeroTokens | null>;
  /** The refresh token that was spent is dead, so the connection needs someone to sign in again. */
  lost(spent: string): Promise<void>;
};

/** Renewals in flight, by the refresh token they spend. */
const renewals = new Map<string, Promise<XeroTokens>>();

function renewalOf(spent: string): Promise<XeroTokens> {
  let renewal = renewals.get(spent);
  if (!renewal) {
    renewal = tokenRequest({ grant_type: 'refresh_token', refresh_token: spent });
    renewals.set(spent, renewal);
    renewal.then(
      () => setTimeout(() => renewals.delete(spent), RENEWAL_KEPT_MS).unref(),
      () => renewals.delete(spent),
    );
  }
  return renewal;
}

/** A sign-in kept alive: renewed shortly before it runs out, or when Xero turns it away. */
export class XeroSession {
  constructor(private tokens: XeroTokens, private readonly store: XeroTokenStore) {}

  get refreshToken(): string {
    return this.tokens.refreshToken;
  }

  /** An access token with at least a few minutes left. */
  async accessToken(): Promise<string> {
    if (Date.now() > this.tokens.expiresAt - RENEW_BEFORE_MS) await this.renew();
    return this.tokens.accessToken;
  }

  /** Xero turned this access token away. Renewed, unless another read has renewed it already. */
  async turnedAway(used: string): Promise<void> {
    if (this.tokens.accessToken === used) await this.renew();
  }

  /** What fails here reaches the reader as Xero would say it: a dead sign-in as a 401. */
  private async renew(): Promise<void> {
    const spent = this.tokens.refreshToken;
    let fresh: XeroTokens;
    try {
      fresh = await renewalOf(spent);
    } catch (error) {
      if (!(error instanceof XeroSignInError)) throw error;
      if (error.dead) {
        // Spent already, by a read that kept what it got.
        const stored = await this.store.stored().catch(() => null);
        if (stored && stored.refreshToken !== spent) {
          this.tokens = stored;
          return;
        }
        await this.store.lost(spent);
        throw new XeroApiError(401, 'The Xero sign-in has stopped working. Someone has to sign in to Xero again.');
      }
      if (error.status >= 500) throw new XeroApiError(503, 'Xero’s sign-in isn’t answering.');
      throw new XeroApiError(400, `Xero’s sign-in refused Decimal (${error.status}).`);
    }
    this.tokens = fresh;
    await this.store.save(fresh, spent);
  }
}

/** Requests in flight per organisation, and those waiting a turn. A turn is handed straight to the next in line. */
const lanes = new Map<string, { running: number; waiting: Array<() => void> }>();

async function inTurn<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  const lane = lanes.get(tenantId) ?? { running: 0, waiting: [] };
  lanes.set(tenantId, lane);
  if (lane.running < AT_ONCE) lane.running += 1;
  else await new Promise<void>((resolve) => { lane.waiting.push(resolve); });
  try {
    return await work();
  } finally {
    const next = lane.waiting.shift();
    if (next) next();
    else {
      lane.running -= 1;
      if (lane.running === 0) lanes.delete(tenantId);
    }
  }
}

/** Each key and value escaped whole: a where clause holds spaces, quotes, = and &&. */
function queryOf(query: Record<string, string>): string {
  const pairs = Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

/** Xero's own words for a refusal, when it sends some. */
function saidIn(text: string): string | null {
  try {
    const body = JSON.parse(text) as { Detail?: unknown; Message?: unknown; Title?: unknown; Elements?: Array<{ ValidationErrors?: Array<{ Message?: unknown }> }> };
    const said = [body.Detail, body.Elements?.[0]?.ValidationErrors?.[0]?.Message, body.Message, body.Title].find((w) => typeof w === 'string' && w.trim());
    return typeof said === 'string' ? said.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** A 401 for a scope the sign-in never asked for. Xero spells it insufficent_scope. */
const scopeMissing = (res: Response) => /insuf+ici?ent_scope/i.test(res.headers.get('www-authenticate') ?? '');

/** One organisation, read through Xero's API on a kept sign-in. */
export function httpXeroClient(tenantId: string, session: XeroSession): XeroClient {
  return {
    tenantId,
    get: (endpoint, query = {}) => inTurn(tenantId, async () => {
      const ask = async (accessToken: string) => fetch(`${API_BASE}/${endpoint}${queryOf(query)}`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': tenantId, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      let used = await session.accessToken();
      let res = await ask(used);
      if (res.status === 401 && !scopeMissing(res)) {
        await res.arrayBuffer();
        await session.turnedAway(used);
        used = await session.accessToken();
        res = await ask(used);
      }
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new XeroApiError(502, `Xero answered ${endpoint} in a form Decimal can’t read.`);
        }
      }
      if (res.status === 401 && scopeMissing(res)) {
        // Decimal's mistake, not the person's: signing in again asks for the same.
        throw new BooksReadError('refused', `Xero won’t let Decimal read ${endpoint}: the sign-in doesn’t ask for it.`);
      }
      if (res.status === 401) throw new XeroApiError(401, 'Xero no longer accepts this sign-in. Someone has to sign in to Xero again.');
      // The organisation was disconnected from Decimal's app on Xero's side.
      if (res.status === 403 && /Authentication ?Unsuccessful|Authorization ?Unsuccessful/i.test(text)) {
        throw new XeroApiError(401, 'This organisation isn’t connected to Decimal in Xero any more. Someone has to sign in to Xero again.');
      }
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after') ?? NaN);
        const problem = res.headers.get('x-rate-limit-problem');
        throw new XeroApiError(429, `Xero asked Decimal to slow down${problem ? ` (its ${problem} limit)` : ''}.`, Number.isFinite(after) && after >= 0 ? after : null);
      }
      const said = saidIn(text);
      throw new XeroApiError(res.status, said ? `Xero said: ${said}` : `Xero answered ${res.status} for ${endpoint}.`);
    }),
  };
}
