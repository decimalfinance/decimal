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
  ) {}

  get realmId(): string {
    return this.tokens.realmId;
  }

  get currentTokens(): QboTokens {
    return this.tokens;
  }

  // ---- OAuth ----

  static authorizeUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: config.quickbooksClientId,
      response_type: 'code',
      scope: SCOPE,
      redirect_uri: requireRedirectUri(),
      state,
    });
    return `${AUTHORIZE_URL}?${p.toString()}`;
  }

  static async exchangeCode(code: string, realmId: string): Promise<QboTokens> {
    const json = await QuickBooks.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: requireRedirectUri(),
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
    const json = await QuickBooks.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
    });
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
      });
    };

    let res = await doFetch();
    if (res.status === 401) {
      await this.refresh();
      res = await doFetch();
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new QboError(res.status, json);
    return json as T;
  }

  // ---- the calls our GL-sync flow needs ----

  query<T = any>(sql: string): Promise<T> {
    return this.request<T>('GET', '/query', { query: { query: sql } });
  }

  readEntity<T = any>(entity: string, id: string): Promise<T> {
    return this.request<T>('GET', `/${entity}/${id}`);
  }

  createAccount<T = any>(body: unknown, requestId?: string): Promise<T> {
    return this.request<T>('POST', '/account', { body, requestId });
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

/** Escape a value for use inside a QBO query string literal (single quotes). */
export function qboLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
