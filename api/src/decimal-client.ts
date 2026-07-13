import { API_ENDPOINTS } from './api-contract.js';

export interface DecimalClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface DecimalRequestOptions {
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

// Typed client over the API contract (API_ENDPOINTS): interpolates path params,
// serializes query/body, and attaches auth + idempotency headers. Exercised by
// api-contract.test.ts; also the reference client for the documented API surface.
export class DecimalClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DecimalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(endpointId: string, options: DecimalRequestOptions = {}): Promise<T> {
    const endpoint = API_ENDPOINTS.find((item) => item.id === endpointId);
    if (!endpoint) {
      throw new Error(`Unknown Decimal endpoint "${endpointId}"`);
    }
    const url = new URL(`${this.baseUrl}${interpolatePath(endpoint.path, options.path ?? {})}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await this.fetchImpl(url, {
      method: endpoint.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 204) {
      return undefined as T;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      const message = typeof payload === 'object' && payload && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : `Decimal API request failed with status ${response.status}`;
      throw new DecimalApiError(message, response.status, payload);
    }
    return payload as T;
  }
}

export class DecimalApiError extends Error {
  readonly status: number;
  readonly payload: unknown;
  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.name = 'DecimalApiError';
  }
}

function interpolatePath(path: string, values: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (!value) {
      throw new Error(`Missing path parameter "${key}"`);
    }
    return encodeURIComponent(value);
  });
}
