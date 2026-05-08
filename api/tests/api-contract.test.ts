import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_ENDPOINTS } from '../src/api-contract.js';
import { DecimalClient } from '../src/decimal-client.js';
import { buildOpenApiSpec } from '../src/infra/openapi.js';

test('API contract has stable unique endpoint IDs and covers the backend surface', () => {
  const ids = API_ENDPOINTS.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(API_ENDPOINTS.length >= 50);
  assert.ok(API_ENDPOINTS.some((endpoint) => endpoint.id === 'payment_order_proof' && endpoint.query?.format));
  assert.ok(API_ENDPOINTS.some((endpoint) => endpoint.id === 'preview_payment_run_csv' && endpoint.scope === 'organization:read'));
});

test('OpenAPI spec is generated from the API contract', () => {
  const spec = buildOpenApiSpec();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.title, 'Decimal API');
  assert.equal(spec.paths['/organizations/{organizationId}/payment-orders/{paymentOrderId}/proof'].get.operationId, 'payment_order_proof');
  assert.equal(spec.paths['/organizations/{organizationId}/payment-runs/import-csv/preview'].post.operationId, 'preview_payment_run_csv');
  assert.deepEqual(spec.paths['/health'].get.security, []);
});

test('typed Decimal client interpolates path, query, body, and auth headers', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new DecimalClient({
    baseUrl: 'http://127.0.0.1:3100/',
    token: 'test-token',
    fetchImpl: (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const response = await client.request<{ ok: boolean }>('payment_order_proof', {
    path: {
      organizationId: 'organization-1',
      paymentOrderId: 'order-1',
    },
    query: { format: 'json' },
  });

  assert.equal(response.ok, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:3100/organizations/organization-1/payment-orders/order-1/proof?format=json');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer test-token');
});
