// QuickBooks Online client. OAuth (with daily refresh-token rotation) + the
// Accounting API calls the GL-sync flow needs. Validated end-to-end against the
// sandbox in the qbo-spike before porting here.
//
// Environment-aware: `config.quickbooksEnvironment` selects the sandbox vs
// production API host. Same Intuit app, two key sets — sandbox now, real
// customer companies later, no code change.

import { config } from '../config.js';

const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '75';
// OAuth endpoints are the same host for sandbox + production.
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
// Intuit times a request out at 120 seconds. Past that, nothing is coming.
const REQUEST_TIMEOUT_MS = 130_000;

function apiBase(): string {
  return config.quickbooksEnvironment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function requireRedirectUri(): string {
  if (!config.quickbooksRedirectUri) {
    throw new Error('QUICKBOOKS_REDIRECT_URI is not configured.');
  }
  return config.quickbooksRedirectUri;
}

export interface QboTokens {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms when the access token expires
  refreshExpiresAt: number; // epoch ms when the refresh token expires
}

export class QboError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`QBO ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'QboError';
  }

  /** True when the refresh token is dead (revoked/expired) — connection needs re-auth. */
  get isAuthInvalid(): boolean {
    const s = typeof this.body === 'string' ? this.body : this.body ? JSON.stringify(this.body) : '';
    return s.includes('invalid_grant');
  }
}

/** Intuit's first error from a body, if it has one. It can arrive on a 200. */
export function faultOf(body: unknown): { code: string | null; message: string } | null {
  if (typeof body === 'string') return body ? { code: null, message: body.slice(0, 300) } : null;
  const fault = (body as { Fault?: { Error?: Array<{ code?: unknown; Message?: unknown; Detail?: unknown }> } } | null)?.Fault;
  if (!fault) return null;
  const first = fault.Error?.[0];
  const words = [first?.Message, first?.Detail].filter((w): w is string => typeof w === 'string' && w.length > 0);
  return { code: first?.code === undefined ? null : String(first.code), message: words.join(': ') || 'QuickBooks returned an error.' };
}

/**
 * Why QuickBooks refused, for the person who has to do something about it. The raw
 * error goes in the log; this goes on the screen, and the first sentence reaches
 * the Inbox.
 */
export function plainQboReason(error: unknown): string {
  if (!(error instanceof QboError)) return error instanceof Error ? error.message : String(error);
  const fault = faultOf(error.body);
  switch (fault?.code) {
    case '6240':
      return 'A customer, vendor or employee in QuickBooks already has this vendor\'s name, and QuickBooks needs them to differ. Rename one of them there, then retry.';
    case '6140':
      return 'QuickBooks already has a bill with this number. Check whether this one is already in your books. If it isn\'t, change the number on the bill or turn off the duplicate warning in QuickBooks, then retry.';
    case '6200':
    case '6210':
      return 'QuickBooks says this bill\'s date is in a closed period. Change the date on the bill, or reopen the period in QuickBooks, then retry.';
    case '610':
    case '2500':
      return 'This bill uses something that has been made inactive or deleted in QuickBooks: its vendor or one of its categories. Make it active there, or pick another on the bill, then retry.';
    case '120':
    case '3100':
    case '5020':
      return 'QuickBooks won\'t let this sign-in do that. An admin needs to sign in again.';
    default:
  }
  if (error.isAuthInvalid || error.status === 401 || fault?.code === '3200') return 'The QuickBooks sign-in has stopped working. An admin needs to sign in again.';
  if (error.status === 403) return 'QuickBooks won\'t let this sign-in do that. An admin needs to sign in again.';
  if (error.status === 429) return 'QuickBooks asked Decimal to slow down. It will try again by itself.';
  // Its body may be an outage page. The status says enough.
  if (error.status >= 500) return 'QuickBooks isn\'t answering. Decimal will try again by itself.';
  return fault ? `QuickBooks said: ${fault.message}` : `QuickBooks answered ${error.status}.`;
}

function basicAuth(): string {
  return 'Basic ' + Buffer.from(`${config.quickbooksClientId}:${config.quickbooksClientSecret}`).toString('base64');
}

function tokensFromResponse(realmId: string, json: any): QboTokens {
  const now = Date.now();
  return {
    realmId,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
    refreshExpiresAt: now + (json.x_refresh_token_expires_in ?? 8_640_000) * 1000,
  };
}

type RequestOpts = {
  query?: Record<string, string>;
  body?: unknown;
  requestId?: string;
};

export class QuickBooks {
  constructor(
    private tokens: QboTokens,
    private onTokensChanged?: (t: QboTokens) => void | Promise<void>,
    // Fired when a token refresh fails because the refresh token is dead, so the
    // owner can mark the connection as needing re-auth.
    private onAuthInvalid?: () => void | Promise<void>,
  ) {}

  get realmId(): string {
    return this.tokens.realmId;
  }

  get currentTokens(): QboTokens {
    return this.tokens;
  }

  // ---- OAuth ----

  static authorizeUrl(state: string, redirectUri?: string): string {
    const p = new URLSearchParams({
      client_id: config.quickbooksClientId,
      response_type: 'code',
      scope: SCOPE,
      redirect_uri: redirectUri ?? requireRedirectUri(),
      state,
    });
    return `${AUTHORIZE_URL}?${p.toString()}`;
  }

  static async exchangeCode(code: string, realmId: string, redirectUri?: string): Promise<QboTokens> {
    const json = await QuickBooks.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri ?? requireRedirectUri(),
    });
    return tokensFromResponse(realmId, json);
  }

  private static async tokenRequest(form: Record<string, string>): Promise<any> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(form),
    });
    const text = await res.text();
    if (!res.ok) throw new QboError(res.status, text);
    return text ? JSON.parse(text) : {};
  }

  /** Revoke the refresh token (disconnect). Best-effort. */
  async revoke(): Promise<void> {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { Authorization: basicAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: this.tokens.refreshToken }),
    });
  }

  private async refresh(): Promise<void> {
    let json: any;
    try {
      json = await QuickBooks.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
      });
    } catch (error) {
      // A dead refresh token can't be recovered automatically — signal the owner
      // so the connection is flagged for re-auth instead of failing silently.
      if (error instanceof QboError && error.isAuthInvalid) {
        await this.onAuthInvalid?.();
      }
      throw error;
    }
    // The refresh token rotates roughly daily — persist whatever comes back.
    this.tokens = tokensFromResponse(this.tokens.realmId, json);
    await this.onTokensChanged?.(this.tokens);
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() > this.tokens.expiresAt - 5 * 60 * 1000) {
      await this.refresh();
    }
  }

  // ---- low-level request: auto-refresh + retry-once on 401 ----

  async request<T = any>(method: 'GET' | 'POST', path: string, opts: RequestOpts = {}): Promise<T> {
    await this.ensureFresh();

    const doFetch = () => {
      const params = new URLSearchParams({ minorversion: MINOR_VERSION, ...(opts.query ?? {}) });
      if (opts.requestId) params.set('requestid', opts.requestId);
      const url = `${apiBase()}/v3/company/${this.tokens.realmId}${path}?${params.toString()}`;
      return fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.tokens.accessToken}`,
          Accept: 'application/json',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    };

    let res = await doFetch();
    if (res.status === 401) {
      await this.refresh();
      res = await doFetch();
    }
    const text = await res.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // An outage page, not an API answer. It still has to arrive as a QboError.
        throw new QboError(res.status, text);
      }
    }
    if (!res.ok) throw new QboError(res.status, body);
    // A 200 can carry a refusal too, and nothing above this should have to look for one.
    if ((body as { Fault?: unknown }).Fault) throw new QboError(res.status, body);
    return body as T;
  }

  // ---- the calls our GL-sync flow needs ----

  query<T = any>(sql: string): Promise<T> {
    return this.request<T>('GET', '/query', { query: { query: sql } });
  }

  readEntity<T = any>(entity: string, id: string): Promise<T> {
    return this.request<T>('GET', `/${entity}/${id}`);
  }

  createVendor<T = any>(body: unknown, requestId?: string): Promise<T> {
    return this.request<T>('POST', '/vendor', { body, requestId });
  }

  createBill<T = any>(body: unknown, requestId: string): Promise<T> {
    return this.request<T>('POST', '/bill', { body, requestId });
  }

  createBillPayment<T = any>(body: unknown, requestId: string): Promise<T> {
    return this.request<T>('POST', '/billpayment', { body, requestId });
  }

  cdc<T = any>(entities: string[], changedSince: string): Promise<T> {
    return this.request<T>('GET', '/cdc', { query: { entities: entities.join(','), changedSince } });
  }
}

/** A value inside a QuickBooks query's quotes. Intuit's documented form: 'Adam\'s Candy Shop'. */
export function qboLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
