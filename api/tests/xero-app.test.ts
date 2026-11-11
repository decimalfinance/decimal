// Decimal's Xero app against a Xero that answers from memory: the sign-in's
// address, which organisation a sign-in reached, and the client that keeps a
// sign-in alive while the reader reads. Nothing here reaches the network.
//
// Renewals are shared by the refresh token they spend, and kept a minute, so each
// test spends a refresh token of its own.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { config } from '../src/config.js';
import { BooksReadError } from '../src/integrations/books.js';
import {
  authEventOf,
  connectedBy,
  httpXeroClient,
  xeroAuthorizeUrl,
  XeroSession,
  type XeroConnection,
  type XeroTokens,
  type XeroTokenStore,
} from '../src/integrations/xero-app.js';
import { XeroApiError, xeroReader } from '../src/integrations/xero-reader.js';

const realFetch = globalThis.fetch;
const saved = { id: config.xeroClientId, secret: config.xeroClientSecret };
beforeEach(() => {
  config.xeroClientId = 'test-client';
  config.xeroClientSecret = 'test-secret';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  config.xeroClientId = saved.id;
  config.xeroClientSecret = saved.secret;
});

const TOKEN_URL = 'https://identity.xero.com/connect/token';

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };

/** Xero, in memory: `answer` makes each reply, and every request is kept. */
function fakeXero(answer: (r: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const r: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? String(init.body) : '',
    };
    seen.push(r);
    return answer(r);
  }) as typeof fetch;
  return seen;
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
const issued = (n: string) => json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 1800, token_type: 'Bearer' });

const signIn = (refreshToken: string, over: Partial<XeroTokens> = {}): XeroTokens => ({
  accessToken: `access-of-${refreshToken}`,
  refreshToken,
  expiresAt: Date.now() + 30 * 60_000,
  refreshExpiresAt: Date.now() + 60 * 86_400_000,
  ...over,
});

/** The connection's row, in memory. */
function kept(start: XeroTokens) {
  const row = { tokens: start as XeroTokens | null, saves: [] as Array<{ fresh: string; spent: string }>, lost: [] as string[] };
  const store: XeroTokenStore = {
    async save(fresh, spent) {
      row.saves.push({ fresh: fresh.refreshToken, spent });
      if (row.tokens?.refreshToken === spent) row.tokens = fresh;
    },
    async stored() {
      return row.tokens;
    },
    async lost(spent) {
      row.lost.push(spent);
    },
  };
  return { row, session: new XeroSession(start, store) };
}

/** An access token as Xero writes one: a JWT whose claims name the sign-in it came from. */
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('xero app: the sign-in asks to read what Decimal reads, and to write only bills, their contacts and their files', () => {
  const url = new URL(xeroAuthorizeUrl('pay.load', 'http://localhost:3200/accounting/xero/callback'));
  assert.equal(`${url.origin}${url.pathname}`, 'https://login.xero.com/identity/connect/authorize');
  assert.equal(url.searchParams.get('client_id'), 'test-client');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3200/accounting/xero/callback');
  assert.equal(url.searchParams.get('state'), 'pay.load');
  const scopes = url.searchParams.get('scope')!.split(' ');
  assert.ok(scopes.includes('offline_access'), 'a refresh token, or the sign-in dies in half an hour');
  assert.deepEqual(scopes.filter((s) => s.endsWith('.read')).sort(), ['accounting.banktransactions.read', 'accounting.settings.read'], 'settings and spend money: read only');
  assert.deepEqual(scopes.filter((s) => s !== 'offline_access' && !s.endsWith('.read')).sort(), ['accounting.attachments', 'accounting.contacts', 'accounting.invoices'], 'what posting a bill writes');
  assert.ok(!url.search.includes('+'), 'a space goes as %20');
});

test('xero app: a sign-in reached the organisation it connected, and Decimal never guesses between several', () => {
  const conn = (id: string, tenantId: string, authEventId: string | null, over: Partial<XeroConnection> = {}): XeroConnection => ({
    id, tenantId, tenantType: 'ORGANISATION', tenantName: tenantId, authEventId, updatedDateUtc: '2026-11-11T10:00:00.0000000', ...over,
  });
  assert.equal(authEventOf(jwt({ authentication_event_id: 'evt-2', xero_userid: 'u-1' })), 'evt-2');
  assert.equal(authEventOf(jwt({ xero_userid: 'u-1' })), null);
  assert.equal(authEventOf('not a token'), null);

  const all = [conn('k1', 't-old', 'evt-1'), conn('k2', 't-new', 'evt-2'), conn('k3', 'practice', 'evt-2', { tenantType: 'PRACTICEMANAGER' })];
  assert.equal(connectedBy(all, 'evt-2')?.tenantId, 't-new', 'the organisation this sign-in connected, and not a practice');
  const both = [conn('k1', 't-a', 'evt-1', { updatedDateUtc: '2026-11-11T09:00:00' }), conn('k2', 't-b', 'evt-1', { updatedDateUtc: '2026-11-11T10:00:00' })];
  assert.equal(connectedBy(both, 'evt-1')?.tenantId, 't-b', 'two picked at once: the latest');
  assert.equal(connectedBy([conn('k1', 't-only', 'evt-0')], 'evt-9')?.tenantId, 't-only', 'none from this sign-in, but only one there is');
  assert.equal(connectedBy([conn('k1', 't-a', 'evt-0'), conn('k2', 't-b', 'evt-1')], 'evt-9'), null, 'several, none from this sign-in: no guess');
  assert.equal(connectedBy([], 'evt-1'), null);
});

test('xero app: every read names the organisation, asks for JSON, and sends a where clause whole', async () => {
  const seen = fakeXero(() => json({ Invoices: [] }));
  const { session } = kept(signIn('refresh-where'));
  await httpXeroClient('tenant-1', session).get('Invoices', { where: 'Type=="ACCPAY" && Date>=DateTime(2024,11,11)', Statuses: 'SUBMITTED,AUTHORISED,PAID', page: '1' });
  const [r] = seen;
  assert.equal(r!.headers['xero-tenant-id'], 'tenant-1');
  assert.equal(r!.headers.authorization, 'Bearer access-of-refresh-where');
  assert.equal(r!.headers.accept, 'application/json');
  const url = new URL(r!.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://api.xero.com/api.xro/2.0/Invoices');
  assert.equal(url.searchParams.get('where'), 'Type=="ACCPAY" && Date>=DateTime(2024,11,11)');
  assert.equal(url.searchParams.get('Statuses'), 'SUBMITTED,AUTHORISED,PAID');
  assert.ok(url.search.includes('%26%26') && !url.search.includes('+'), url.search);
});

test('xero app: a sign-in about to run out is renewed first, and the new pair kept in place of the one spent', async () => {
  const { row, session } = kept(signIn('refresh-soon', { expiresAt: Date.now() + 60_000 }));
  const seen = fakeXero((r) => (r.url === TOKEN_URL ? issued('soon-2') : json({ Organisations: [] })));
  await httpXeroClient('t', session).get('Organisation');
  assert.equal(seen[0]!.url, TOKEN_URL);
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(seen[0]!.headers.authorization, `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`);
  const form = new URLSearchParams(seen[0]!.body);
  assert.deepEqual([form.get('grant_type'), form.get('refresh_token')], ['refresh_token', 'refresh-soon']);
  assert.equal(seen[1]!.headers.authorization, 'Bearer access-soon-2');
  assert.deepEqual(row.saves, [{ fresh: 'refresh-soon-2', spent: 'refresh-soon' }]);
});

test('xero app: turned away, the sign-in is renewed once and the read asked again', async () => {
  const { row, session } = kept(signIn('refresh-401'));
  let refused = false;
  const seen = fakeXero((r) => {
    if (r.url === TOKEN_URL) return issued('401-2');
    if (!refused) {
      refused = true;
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
    }
    return json({ Accounts: [] });
  });
  assert.deepEqual(await httpXeroClient('t', session).get('Accounts'), { Accounts: [] });
  assert.deepEqual(seen.map((r) => (r.url === TOKEN_URL ? 'renew' : r.headers.authorization)), ['Bearer access-of-refresh-401', 'renew', 'Bearer access-401-2']);
  assert.deepEqual(row.saves, [{ fresh: 'refresh-401-2', spent: 'refresh-401' }]);
});

test('xero app: reads at once on a lapsed sign-in spend its refresh token once', async () => {
  const start = signIn('refresh-shared', { expiresAt: Date.now() - 1000 });
  const a = kept(start);
  const b = kept(start);
  let renewals = 0;
  fakeXero(async (r) => {
    if (r.url !== TOKEN_URL) return json({ Currencies: [] });
    renewals += 1;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    return issued('shared-2');
  });
  await Promise.all([httpXeroClient('t', a.session).get('Currencies'), httpXeroClient('t', b.session).get('Currencies'), httpXeroClient('t', a.session).get('Currencies')]);
  assert.equal(renewals, 1, 'a second renewal would spend a refresh token Xero has already replaced');
});

test('xero app: a dead refresh token marks the connection lost, and the reader hears sign_in_lost', async () => {
  const { row, session } = kept(signIn('refresh-dead', { expiresAt: Date.now() - 1000 }));
  fakeXero((r) => (r.url === TOKEN_URL ? json({ error: 'invalid_grant' }, { status: 400 }) : json({})));
  await assert.rejects(xeroReader(httpXeroClient('t', session)).closingDate(), (e: unknown) => e instanceof BooksReadError && e.kind === 'sign_in_lost');
  assert.deepEqual(row.lost, ['refresh-dead']);
});

test('xero app: a refresh token another read spent first is no loss: what that read kept is used', async () => {
  const { row, session } = kept(signIn('refresh-spent', { expiresAt: Date.now() - 1000 }));
  row.tokens = signIn('refresh-newer');
  const seen = fakeXero((r) => (r.url === TOKEN_URL ? json({ error: 'invalid_grant' }, { status: 400 }) : json({ Accounts: [] })));
  await httpXeroClient('t', session).get('Accounts');
  assert.deepEqual(row.lost, []);
  assert.equal(seen.at(-1)!.headers.authorization, 'Bearer access-of-refresh-newer');
});

test('xero app: a write carries its key, a file goes as its bytes, and a sign-in that only reads says to sign in again', async () => {
  const { session } = kept(signIn('refresh-writes'));
  const client = httpXeroClient('tenant-w', session);
  const sent: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body });
    return json({ Invoices: [{ InvoiceID: 'inv-1' }] });
  }) as typeof fetch;

  assert.deepEqual(await client.put('Invoices', { Invoices: [{ Type: 'ACCPAY' }] }, 'decimal_x_bill_1'), { Invoices: [{ InvoiceID: 'inv-1' }] });
  const put = sent[0]!;
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, 'https://api.xero.com/api.xro/2.0/Invoices');
  assert.equal(put.headers.get('idempotency-key'), 'decimal_x_bill_1');
  assert.equal(put.headers.get('content-type'), 'application/json');
  assert.equal(put.headers.get('xero-tenant-id'), 'tenant-w');
  assert.deepEqual(JSON.parse(String(put.body)), { Invoices: [{ Type: 'ACCPAY' }] });

  const bytes = Buffer.from('%PDF-1.4 the invoice');
  await client.upload('Invoices/inv-1/Attachments/bill%201.pdf', bytes, 'application/pdf', 'decimal_file_inv-1');
  const upload = sent[1]!;
  assert.equal(upload.url, 'https://api.xero.com/api.xro/2.0/Invoices/inv-1/Attachments/bill%201.pdf');
  assert.equal(upload.headers.get('content-type'), 'application/pdf');
  assert.equal(upload.headers.get('idempotency-key'), 'decimal_file_inv-1');
  assert.ok(Buffer.from(upload.body as Uint8Array).equals(bytes), 'the file as it is');
  assert.equal(sent.filter((r) => r.method === 'GET').length, 0);

  // A sign-in from before Decimal posted to Xero only reads: posting asks for a new one.
  fakeXero(() => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="insufficent_scope"' } }));
  await assert.rejects(client.put('Invoices', {}, 'k'), (e: unknown) => e instanceof XeroApiError && e.status === 403 && /sign in to Xero again/.test(e.message));

  // A bill refused for several reasons says each.
  fakeXero(() => json({ ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [
    { ValidationErrors: [{ Message: 'Account code \'485\' has been archived, or deleted.' }, { Message: 'The TaxType code \'X\' does not exist.' }] },
  ] }, { status: 400 }));
  await assert.rejects(client.put('Invoices', {}, 'k'), (e: unknown) => e instanceof XeroApiError && e.status === 400
    && e.message === 'Xero said: Account code \'485\' has been archived, or deleted. The TaxType code \'X\' does not exist.');
});

test('xero app: what Xero refuses reaches the reader named', async () => {
  const { session } = kept(signIn('refresh-refusals'));
  const client = httpXeroClient('t', session);

  // A scope the sign-in never asked for is Decimal's mistake: no renewal, and signing in again wouldn't help.
  const seen = fakeXero(() => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="insufficent_scope"' } }));
  await assert.rejects(client.get('LinkedTransactions'), (e: unknown) => e instanceof BooksReadError && e.kind === 'refused' && /LinkedTransactions/.test(e.message));
  assert.equal(seen.length, 1);

  fakeXero(() => json({}, { status: 429, headers: { 'Retry-After': '7', 'X-Rate-Limit-Problem': 'minute' } }));
  await assert.rejects(client.get('Contacts'), (e: unknown) => e instanceof XeroApiError && e.status === 429 && e.retryAfterSeconds === 7 && /minute/.test(e.message));

  // Disconnected from Decimal's app on Xero's side: the sign-in no longer reaches it.
  fakeXero(() => json({ Type: null, Title: 'Forbidden', Status: 403, Detail: 'AuthenticationUnsuccessful' }, { status: 403 }));
  await assert.rejects(client.get('Invoices'), (e: unknown) => e instanceof XeroApiError && e.status === 401);

  fakeXero(() => json({ ErrorNumber: 16, Type: 'QueryParseException', Message: 'No property or field Foo exists' }, { status: 400 }));
  await assert.rejects(client.get('Invoices'), (e: unknown) => e instanceof XeroApiError && e.status === 400 && e.message === 'Xero said: No property or field Foo exists');

  fakeXero(() => new Response('<html>busy</html>', { status: 200 }));
  await assert.rejects(client.get('Invoices'), (e: unknown) => e instanceof XeroApiError && e.status === 502);
});

test('xero app: no more than four requests at once for one organisation', async () => {
  let running = 0;
  let most = 0;
  fakeXero(async () => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    running -= 1;
    return json({ Contacts: [] });
  });
  const { session } = kept(signIn('refresh-busy'));
  const client = httpXeroClient('t-busy', session);
  await Promise.all(Array.from({ length: 10 }, () => client.get('Contacts')));
  assert.equal(most, 4, 'Xero takes five at once; one is left for anything else');
});
