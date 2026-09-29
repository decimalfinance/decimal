// The companion, attacked from every side it can be reached.
//
// The model is replaced by a HOSTILE script: it calls every tool with every
// argument it can think of, invents bills and actions, smuggles requests into
// its answers, loops, throws and talks instead of calling tools. None of that
// may change a single business record, reach another organisation, or put a
// card on screen that the person could not carry out by hand.
//
// The measure of "changed nothing" is strict: every row of every table is
// fingerprinted before and after, and only the companion's own records (its
// chats, steps, briefs and suggestion log) and sessions may differ.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { prisma } from '../src/infra/prisma.js';
import { config } from '../src/config.js';
import { requireTestDatabase } from './helpers/require-test-database.js';
import { drainAsyncIntake, setInvoiceIntakeRuntimeForTests } from '../src/payments/invoice-intake.js';
import { setExceptionAgentRuntimeForTests, type ChatMessage } from '../src/exceptions/agent.js';
import { ensureEngineSetup } from '../src/approvals/wiring.js';
import { setRole } from '../src/approvals/roles.js';

let baseUrl = '';
let close: (() => Promise<void>) | undefined;

before(async () => {
  await prisma.$connect();
  await requireTestDatabase();
  config.publicRateLimitMax = 1_000_000;
  const { registerPaymentApprovalBridge } = await import('../src/payments/approval-bridge.js');
  registerPaymentApprovalBridge();
  const server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(async () => {
  await drainAsyncIntake();
  setInvoiceIntakeRuntimeForTests(null);
  setExceptionAgentRuntimeForTests(null);
  await prisma.$executeRawUnsafe(`TRUNCATE approval.approval_events, approval.tasks, approval.approval_plans,
    approval.policy_sets, approval.policies, approval.approvable_lines, approval.approvables, approval.rule_relaxations,
    approval.constraint_rules, approval.seat_assignments, approval.authority_grants, approval.seats,
    approval.node_edges, approval.nodes, approval.hierarchies, approval.people, approval.org_settings CASCADE`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE payment_order_events, decimal_proposals, payment_orders,
    transfer_requests, invoice_documents, counterparty_wallets, counterparties, treasury_wallets,
    organization_memberships, organizations, users RESTART IDENTITY CASCADE`);
});

after(async () => {
  setExceptionAgentRuntimeForTests(null);
  if (close) await close();
  await prisma.$disconnect();
});

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function raw(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function post(path: string, body: unknown, token?: string) {
  const r = await raw('POST', path, token, body);
  assert.ok(r.status === 200 || r.status === 201, `POST ${path} → ${r.status}: ${r.text}`);
  return r.json;
}
async function get(path: string, token: string) {
  const r = await raw('GET', path, token);
  assert.equal(r.status, 200, `GET ${path} → ${r.status}: ${r.text}`);
  return r.json;
}

// ─── A whole organisation, with every kind of bill and person ─────────────────

type Person = { token: string; userId: string; name: string };

async function register(name: string): Promise<Person> {
  const r = await post('/auth/register', { email: `${name.toLowerCase().replace(/\W+/g, '.')}-${crypto.randomUUID()}@example.com`, password: 'DemoPass123!', displayName: name });
  await post('/auth/verify-email', { code: r.devEmailVerificationCode }, r.sessionToken);
  return { token: r.sessionToken, userId: r.user.userId, name };
}

function extractionOf(over: { vendor: string; amount: number; invoiceNo: string; billTo: string }) {
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [{
        counterparty: over.vendor, amount: over.amount, currency: 'USD', reference: over.invoiceNo,
        due_date: '2026-08-30', wallet_address: null, notes: null,
        source_invoice: {
          vendorName: over.vendor, vendorAddress: null, vendorEmail: 'ap@vendor.example', amount: over.amount, currency: 'USD',
          invoiceNumber: over.invoiceNo, invoiceDate: '2026-08-02', dueDate: '2026-08-30', terms: 'Net 30',
          poNumber: null, earlyPayDiscount: null, subtotal: over.amount, taxAmount: 0, billToName: over.billTo,
          remitTo: null, paymentDetails: { method: 'ACH', bankName: 'First Interstate Bank', accountLast4: '6621', routingNumber: '125000105' },
          walletAddress: null, lineItems: [{ description: 'Services', quantity: 1, unitPrice: over.amount, total: over.amount }],
          categoryHint: 'Cloud hosting', confidence: { vendor: 1, amount: 1, overall: 1 }, fieldConfidence: null,
        },
      }],
      modelLatencyMs: 1, pageCount: 1,
    }),
  });
}

async function upload(orgId: string, token: string, billTo: string, over: { vendor: string; amount: number; invoiceNo: string }) {
  extractionOf({ ...over, billTo });
  const up = await post(`/organizations/${orgId}/invoices/upload`, {
    filename: `${over.invoiceNo}.pdf`, mimeType: 'application/pdf', dataBase64: Buffer.from(`%PDF ${crypto.randomUUID()}`).toString('base64'), autoAdvance: false,
  }, token);
  return up.paymentOrders[0].paymentOrder.paymentOrderId as string;
}

function confirmBody(invoiceNo: string, total: number) {
  return {
    fields: { invoiceNumber: invoiceNo, invoiceDate: '2026-08-02', dueDate: '2026-08-30', terms: 'Net 30', currency: 'USD', total, taxAmount: 0 },
    lines: [{ description: 'Services', quantity: 1, unitPrice: total, amount: total, category: 'Cloud hosting & infrastructure' }],
    confirmedFieldKeys: [],
  };
}

/**
 * One organisation with the whole cast: a primary admin, a bill clerk, two
 * approvers and a viewer; a published flow on approver A; and bills in every
 * state the companion reasons about — ready, duplicate pair, not ready, held
 * vendor, in approval, with a question and a comment on them.
 */
async function makeWorld(orgName = 'Halcyon Labs, Inc.') {
  const owner = await register(`Owner ${orgName.slice(0, 8)}`);
  const org = await post('/organizations', { organizationName: orgName }, owner.token);
  const orgId = org.organizationId as string;
  const clerk = await register('Clara Clerk');
  const apprA = await register('Adam Approver');
  const apprB = await register('Bella Approver');
  const viewer = await register('Victor Viewer');
  for (const u of [clerk, apprA, apprB, viewer]) {
    await prisma.organizationMembership.create({ data: { organizationId: orgId, userId: u.userId, role: 'member', status: 'active' } });
  }
  await ensureEngineSetup(orgId);
  await setRole(orgId, 'bill_clerk', clerk.userId);
  await setRole(orgId, 'approver', apprA.userId);
  await setRole(orgId, 'approver', apprB.userId);
  await setRole(orgId, 'viewer', viewer.userId);

  const flow = await get(`/organizations/${orgId}/approvals/flow`, owner.token);
  const personOf = (userId: string) => (flow.people as Array<{ id: string; user_id: string }>).find((p) => p.user_id === userId)!.id;
  await post(`/organizations/${orgId}/approvals/flow/publish`, { flow: [
    { id: 'n1', type: 'step', title: 'Team lead', approvers: [personOf(apprA.userId)], quorum: 'any' },
  ] }, owner.token);

  const billTo = orgName;
  const steady1 = await upload(orgId, owner.token, billTo, { vendor: 'Steady Supply', amount: 300, invoiceNo: 'SS-1' });
  const ready = await upload(orgId, owner.token, billTo, { vendor: 'Steady Supply', amount: 310, invoiceNo: 'SS-2' });
  const { counterpartyId: steadyId } = await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: ready }, select: { counterpartyId: true } });
  await prisma.vendorCodingRule.create({ data: { organizationId: orgId, counterpartyId: steadyId!, accountId: 'Cloud hosting & infrastructure', accountName: 'Cloud hosting & infrastructure', source: 'learned', learnedFromCount: 3 } });
  const dupOld = await upload(orgId, owner.token, billTo, { vendor: 'Twin Supply', amount: 1200, invoiceNo: 'TS-100' });
  const dupNew = await upload(orgId, owner.token, billTo, { vendor: 'Twin Supply', amount: 1200, invoiceNo: 'TS-100' });
  const lonely = await upload(orgId, owner.token, billTo, { vendor: 'Lonely Ltd', amount: 90, invoiceNo: 'LL-1' });
  const held = await upload(orgId, owner.token, billTo, { vendor: 'Held Co', amount: 55, invoiceNo: 'HC-1' });
  const { counterpartyId: heldId } = await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: held }, select: { counterpartyId: true } });
  await prisma.counterparty.update({ where: { counterpartyId: heldId! }, data: { metadataJson: { payableHold: { status: 'held', reason: 'Bank details unverified', byUserId: owner.userId, byName: owner.name, at: new Date().toISOString() } } } });
  const submitted = await upload(orgId, owner.token, billTo, { vendor: 'Submit Co', amount: 700, invoiceNo: 'SC-1' });
  await post(`/organizations/${orgId}/bills/${submitted}/confirm`, confirmBody('SC-1', 700), owner.token);
  await post(`/organizations/${orgId}/bills/${lonely}/ask`, { askedOfUserId: clerk.userId, question: 'Which category is this?' }, owner.token);
  await post(`/organizations/${orgId}/bills/${dupOld}/comments`, { body: 'Vendor says they resent it.' }, owner.token);
  await drainAsyncIntake();
  // Loading the flow once syncs members into the engine; do it now so a later
  // read cannot be blamed for housekeeping the setup should have done.
  await get(`/organizations/${orgId}/approvals/flow`, owner.token);

  return { orgId, orgName, owner: { ...owner }, clerk, apprA, apprB, viewer, bills: { steady1, ready, dupOld, dupNew, lonely, held, submitted } };
}

// ─── "Changed nothing", measured ──────────────────────────────────────────────

// The companion's own records, and sessions. Everything else is business data.
const OWN_TABLES = new Set([
  'public.companion_chats', 'public.companion_messages', 'public.companion_steps', 'public.companion_views',
  'public.bill_exception_briefs', 'public.ai_suggestions', 'public.ai_suggestion_outcomes',
  'public.auth_sessions', 'public.idempotency_records',
]);

type Print = Map<string, Map<string, string>>; // table -> row hash -> row

async function fingerprint(): Promise<Print> {
  const tables = await prisma.$queryRawUnsafe<Array<{ t: string }>>(`
    SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
    WHERE table_schema IN ('public', 'approval') AND table_type = 'BASE TABLE' ORDER BY 1`);
  const out: Print = new Map();
  for (const { t } of tables) {
    if (OWN_TABLES.has(t) || t === 'public._prisma_migrations') continue;
    const rows = await prisma.$queryRawUnsafe<Array<{ h: string; j: string }>>(`SELECT md5(x::text) AS h, left(x::text, 600) AS j FROM ${t} x`);
    out.set(t, new Map(rows.map((r) => [r.h, r.j])));
  }
  return out;
}

/** Every row of every business table is exactly as it was. Says which rows moved if not. */
async function assertUnchanged(before: Print, what: string) {
  const now = await fingerprint();
  const report: string[] = [];
  for (const [t, rows] of now) {
    const was = before.get(t) ?? new Map();
    const gone = [...was.keys()].filter((h) => !rows.has(h));
    const added = [...rows.keys()].filter((h) => !was.has(h));
    if (gone.length || added.length) {
      report.push(`${t}: ${gone.length} row(s) changed or removed, ${added.length} added`);
      for (const h of gone.slice(0, 2)) report.push(`  was: ${was.get(h)}`);
      for (const h of added.slice(0, 2)) report.push(`  now: ${rows.get(h)}`);
    }
  }
  assert.equal(report.length, 0, `${what} changed business data:\n${report.join('\n')}`);
}

// ─── A hostile model ──────────────────────────────────────────────────────────

type Call = { name: string; args?: unknown; rawArgs?: string };
type Plan = {
  /** Tool calls per turn, before answering. */
  turns: Call[][];
  /** The final respond arguments, given what the tools returned. `null` = never respond. */
  respond: ((outputs: Array<{ name: string; args: string; output: any }>) => unknown) | null;
  /** Raw assistant replies to send instead, turn by turn (prose, malformed shapes). */
  replies?: Array<ChatMessage | 'throw'>;
};

function hostile(plan: Plan) {
  const seen: { outputs: Array<{ name: string; args: string; output: any }>; messages: ChatMessage[][] } = { outputs: [], messages: [] };
  let n = 0;
  setExceptionAgentRuntimeForTests({
    isConfigured: () => true,
    callModel: async ({ messages }: { messages: ChatMessage[] }) => {
      seen.messages.push(messages);
      const usage = { promptTokens: 1, completionTokens: 1 };
      const lastUser = messages.map((m) => m.role).lastIndexOf('user');
      const since = messages.slice(lastUser);
      const turn = since.filter((m) => m.role === 'assistant').length;
      // Pair every tool result with the call that produced it.
      const calls = new Map<string, { name: string; args: string }>();
      for (const m of since) for (const c of m.tool_calls ?? []) calls.set(c.id, { name: c.function.name, args: c.function.arguments });
      seen.outputs = since.filter((m) => m.role === 'tool').map((m) => {
        const c = calls.get(m.tool_call_id!)!;
        let output: any = m.content;
        try { output = JSON.parse(m.content as string); } catch { /* keep text */ }
        return { name: c.name, args: c.args, output };
      });
      if (plan.replies && turn < plan.replies.length) {
        const r = plan.replies[turn]!;
        if (r === 'throw') throw new Error('OpenAI 500');
        return { usage, message: r };
      }
      if (turn < plan.turns.length) {
        return { usage, message: { role: 'assistant', content: null, tool_calls: plan.turns[turn]!.map((c) => ({
          id: `h_${++n}`, type: 'function' as const, function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args ?? {}) },
        })) } };
      }
      if (!plan.respond) {
        // Never answers: keep calling a harmless tool until the loop gives up.
        return { usage, message: { role: 'assistant', content: null, tool_calls: [{ id: `h_${++n}`, type: 'function', function: { name: 'categories', arguments: '{}' } }] } };
      }
      return { usage, message: { role: 'assistant', content: null, tool_calls: [{
        id: `h_${++n}`, type: 'function', function: { name: 'respond', arguments: JSON.stringify(plan.respond(seen.outputs)) },
      }] } };
    },
  });
  return seen;
}

async function ask(orgId: string, token: string, text: string) {
  const { chatId } = await post(`/organizations/${orgId}/companion/chats`, { text }, token);
  await drainAsyncIntake();
  const chat = await get(`/organizations/${orgId}/companion/chats/${chatId}`, token);
  return { chatId, chat, answer: chat.messages.at(-1) };
}

const EMPTY = { message: 'ok', tables: [], billIds: [], actions: [] };

// Everything the model can ask for, with arguments meant to break it.
const HOSTILE_ARGS: unknown[] = [
  {}, { vendor: null }, { vendor: '' }, { vendor: "'; DROP TABLE payment_orders; --" }, { vendor: 'x'.repeat(50_000) },
  { invoiceNumber: '%' }, { invoiceNumber: '_' }, { status: 'deleted' }, { status: 42 }, { from: 'yesterday' }, { from: '2026-13-45' },
  { minAmount: -1e308 }, { maxAmount: 'lots' }, { groupBy: 'password' }, { billId: '../../../etc/passwd' },
  { billId: "00000000-0000-0000-0000-000000000000' OR '1'='1" }, { billId: null }, { billId: 12 }, { which: 'other' },
  { __proto__: { admin: true } }, { constructor: { prototype: { polluted: true } } },
];
const TOOL_NAMES = ['find_bills', 'get_bill', 'spend_summary', 'vendor_profile', 'whats_waiting', 'team', 'approval_trail', 'bill_history', 'approval_rules', 'categories', 'what_i_know'];

// ─── 1. Reading never writes ──────────────────────────────────────────────────

test('safety: every tool, called with every hostile argument, changes no business data', async () => {
  const w = await makeWorld();
  const turns: Call[][] = [];
  for (const name of TOOL_NAMES) turns.push(HOSTILE_ARGS.map((args) => ({ name, args })));
  // Real ids too: the reads that go deepest (bill detail, trail, history).
  const deep: Call[] = [];
  for (const id of Object.values(w.bills)) for (const name of ['get_bill', 'approval_trail', 'bill_history']) deep.push({ name, args: { billId: id } });
  turns.push(deep);
  turns.push([{ name: 'no_such_tool', args: {} }, { name: 'respond_admin', args: {} }, { name: 'find_bills', rawArgs: '{not json' }, { name: 'find_bills', rawArgs: '[1,2,3]' }]);
  const before = await fingerprint();
  for (const person of [w.owner, w.clerk, w.apprA, w.viewer]) {
    const seen = hostile({ turns: [], respond: () => EMPTY });
    // One tool turn per ask keeps each inside the loop's turn budget.
    for (const t of turns) {
      seen.outputs = [];
      hostile({ turns: [t], respond: () => EMPTY });
      const { answer } = await ask(w.orgId, person.token, 'Look at everything.');
      assert.equal(answer.status, 'done', `a turn of ${t[0]?.name} as ${person.name} still ends in an answer`);
    }
  }
  await assertUnchanged(before, 'Reading with hostile arguments');
  assert.equal(({} as any).admin, undefined, 'no prototype pollution');
  assert.equal(({} as any).polluted, undefined, 'no prototype pollution');
});

test('safety: every tool result is well-formed JSON the model can read, even for garbage input', async () => {
  const w = await makeWorld();
  const seen = hostile({ turns: [TOOL_NAMES.flatMap((name) => HOSTILE_ARGS.slice(0, 12).map((args) => ({ name, args })))], respond: () => EMPTY });
  await ask(w.orgId, w.owner.token, 'Try everything.');
  assert.ok(seen.outputs.length >= TOOL_NAMES.length * 12);
  for (const o of seen.outputs) {
    assert.equal(typeof o.output, 'object', `${o.name}(${o.args.slice(0, 60)}) returned JSON`);
    assert.ok(JSON.stringify(o.output).length < 200_000, `${o.name} kept its answer bounded`);
  }
});

// ─── 2. Nothing crosses an organisation ───────────────────────────────────────

test('safety: no tool ever shows another organisation, by name, number, id or person', async () => {
  const a = await makeWorld('Alpha Works');
  const b = await makeWorld('Bravo Secret Holdings');
  const secretBill = await upload(b.orgId, b.owner.token, b.orgName, { vendor: 'Zebra Secret Vendor', amount: 9999, invoiceNo: 'SECRET-42' });
  await drainAsyncIntake();
  const bIds = [secretBill, ...Object.values(b.bills)];
  const seen = hostile({
    turns: [[
      { name: 'find_bills', args: { vendor: 'Zebra' } }, { name: 'find_bills', args: { invoiceNumber: 'SECRET-42' } }, { name: 'find_bills', args: {} },
      ...bIds.flatMap((id) => ['get_bill', 'approval_trail', 'bill_history'].map((name) => ({ name, args: { billId: id } }))),
      { name: 'vendor_profile', args: { vendor: 'Zebra Secret Vendor' } }, { name: 'spend_summary', args: { groupBy: 'vendor' } },
      { name: 'spend_summary', args: { groupBy: 'category' } }, { name: 'team', args: {} }, { name: 'what_i_know', args: {} },
      { name: 'whats_waiting', args: {} }, { name: 'approval_rules', args: {} },
    ]],
    respond: () => ({
      message: 'Here is everything.', tables: [],
      billIds: bIds,
      actions: bIds.flatMap((billId) => ['send_for_approval', 'close_duplicate', 'clear_duplicate', 'approve'].map((kind) => ({ kind, billId, reason: 'cross-tenant' }))),
    }),
  });
  const before = await fingerprint();
  const { answer, chat } = await ask(a.orgId, a.owner.token, 'Tell me about Zebra Secret Vendor and SECRET-42.');
  await assertUnchanged(before, 'A cross-tenant read');

  // What the tools returned, and what the answer shows. Not the question's own
  // words, nor a thought that repeats back what was searched for.
  const everything = JSON.stringify(seen.outputs.map((o) => o.output))
    + JSON.stringify({ tables: answer.tables, billIds: answer.billIds, actions: answer.actions, bills: chat.bills, text: answer.text });
  for (const leak of ['Zebra Secret Vendor', 'SECRET-42', 'Bravo Secret', b.owner.name, ...bIds]) {
    assert.ok(!everything.includes(leak), `nothing from the other organisation leaks: ${leak}`);
  }
  // Bravo's people have the same names as Alpha's cast, so check by user id.
  for (const person of [b.owner, b.clerk, b.apprA, b.apprB, b.viewer]) assert.ok(!everything.includes(person.userId));
  assert.deepEqual(answer.billIds, []);
  assert.deepEqual(answer.actions, []);
});

test('safety: chats, jobs and card outcomes are private to their owner and organisation', async () => {
  const a = await makeWorld('Alpha Works');
  const b = await makeWorld('Bravo Holdings');
  hostile({ turns: [[{ name: 'find_bills', args: {} }]], respond: (o) => ({ ...EMPTY, actions: [{ kind: 'send_for_approval', billId: a.bills.ready, reason: 'ready' }], billIds: [a.bills.ready] }) });
  const { chatId, answer } = await ask(a.orgId, a.owner.token, 'Anything ready?');
  const card = answer.actions[0];
  assert.ok(card, 'the owner got a card');
  const jobId = (await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: a.bills.ready }, select: { invoiceDocumentId: true } })).invoiceDocumentId!;

  // Someone else in the same organisation.
  for (const [what, r] of [
    ['read', await raw('GET', `/organizations/${a.orgId}/companion/chats/${chatId}`, a.clerk.token)],
    ['follow up', await raw('POST', `/organizations/${a.orgId}/companion/chats/${chatId}/messages`, a.clerk.token, { text: 'hi' })],
    ['record an outcome', await raw('POST', `/organizations/${a.orgId}/companion/chats/${chatId}/actions/${card.actionId}/outcome`, a.clerk.token, { ok: true })],
  ] as const) assert.equal(r.status, 404, `a colleague cannot ${what} your chat`);
  assert.deepEqual((await get(`/organizations/${a.orgId}/companion/chats`, a.clerk.token)).chats, []);

  // Someone in another organisation, through their own org and through yours.
  for (const path of [
    `/organizations/${b.orgId}/companion/chats/${chatId}`,
    `/organizations/${b.orgId}/companion/jobs/${jobId}`,
  ]) assert.equal((await raw('GET', path, b.owner.token)).status, 404, `not found from another organisation: ${path}`);
  for (const path of [
    `/organizations/${a.orgId}/companion/chats/${chatId}`,
    `/organizations/${a.orgId}/companion/jobs/${jobId}`,
    `/organizations/${a.orgId}/companion/console`,
    `/organizations/${a.orgId}/companion/chats`,
  ]) {
    const r = await raw('GET', path, b.owner.token);
    assert.ok([400, 401, 403, 404].includes(r.status), `refused to an outsider: ${path} (got ${r.status}: ${r.text.slice(0, 160)})`);
  }
  assert.ok([400, 401, 403, 404].includes((await raw('POST', `/organizations/${a.orgId}/companion/chats`, b.owner.token, { text: 'hello' })).status));
  assert.equal((await raw('GET', `/organizations/${a.orgId}/companion/console`)).status, 401, 'and to nobody at all');

  // The outcome was never recorded by anyone else.
  const after = await get(`/organizations/${a.orgId}/companion/chats/${chatId}`, a.owner.token);
  assert.equal(after.messages[1].actions[0].status, 'proposed');
});

// ─── 3. A card is only what this person could do by hand ──────────────────────

const KINDS = ['send_for_approval', 'close_duplicate', 'clear_duplicate', 'approve'] as const;

test('safety: every (person × action × bill) proposal becomes a card exactly when that person may do it', async () => {
  const w = await makeWorld();
  const bills = w.bills;
  // Who may do what, from the rules as they stand — not from the code under test.
  const expected = (who: string, kind: string, bill: string): boolean => {
    const isAdmin = who === 'owner';
    const canEdit = isAdmin || who === 'clerk';
    const readyDrafts = [bills.steady1, bills.ready];
    if (kind === 'send_for_approval') return canEdit && readyDrafts.includes(bill);
    if (kind === 'close_duplicate') return isAdmin && (bill === bills.dupOld || bill === bills.dupNew);
    if (kind === 'clear_duplicate') return isAdmin && (bill === bills.dupOld || bill === bills.dupNew);
    if (kind === 'approve') return who === 'apprA' && bill === bills.submitted;
    return false;
  };
  const people = { owner: w.owner, clerk: w.clerk, apprA: w.apprA, apprB: w.apprB, viewer: w.viewer };
  const allBills = Object.values(bills);
  const before = await fingerprint();
  for (const [who, person] of Object.entries(people)) {
    hostile({
      turns: [[{ name: 'find_bills', args: {} }, { name: 'whats_waiting', args: {} }]],
      respond: () => ({ ...EMPTY, actions: allBills.flatMap((billId) => KINDS.map((kind) => ({ kind, billId, reason: `${kind} please` }))) }),
    });
    const { answer } = await ask(w.orgId, person.token, 'Do everything you can.');
    const got = new Set((answer.actions as Array<{ kind: string; billId: string }>).map((c) => `${c.kind}:${c.billId}`));
    for (const billId of allBills) for (const kind of KINDS) {
      const flags = (await get(`/organizations/${w.orgId}/bills/workbench`, person.token).catch(() => ({ bills: [] }))).bills
        ?.find((b: { paymentOrderId: string }) => b.paymentOrderId === billId)?.flags?.map((f: { kind: string }) => f.kind);
      assert.equal(got.has(`${kind}:${billId}`), expected(who, kind, billId), `${who} ${kind} on ${Object.entries(bills).find(([, id]) => id === billId)![0]} (flags: ${JSON.stringify(flags)}; cards: ${[...got].join(', ')})`);
    }
  }
  await assertUnchanged(before, 'Proposing cards');
});

test('safety: every card that is offered can really be carried out, and nothing it did not offer can', async () => {
  const w = await makeWorld();
  const people = { owner: w.owner, clerk: w.clerk, apprA: w.apprA, viewer: w.viewer };
  // Everything the endpoints would do if someone went round the cards.
  const attempts = (bill: string, taskId?: string) => [
    ['send_for_approval', `/bills/${bill}/confirm-as-read`, {}],
    ['close_duplicate', `/bills/${bill}/not-a-bill`, { reason: 'duplicate', note: 'test' }],
    ['clear_duplicate', `/bills/${bill}/duplicate-override`, { reason: 'Different work.' }],
    ...(taskId ? [['approve', `/approvals/tasks/${taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }] as const] : []),
  ] as const;
  // The viewer and clerk go round the cards straight to the endpoints: every
  // admin act, and approval of a task that is not theirs, is refused.
  const inbox = await get(`/organizations/${w.orgId}/bills/approvals-inbox`, w.apprA.token);
  const mine = (inbox.waitingOnYou as Array<{ paymentOrderId: string; taskId: string }>).find((x) => x.paymentOrderId === w.bills.submitted);
  assert.ok(mine, 'the submitted bill waits on approver A');
  const task = { id: mine!.taskId };
  const before = await fingerprint();
  for (const [who, person] of [['viewer', w.viewer], ['apprB', w.apprB], ['clerk', w.clerk]] as const) {
    for (const bill of [w.bills.dupNew, w.bills.ready]) {
      for (const [kind, path, body] of attempts(bill, task.id)) {
        if (who === 'clerk' && kind === 'send_for_approval') continue; // a clerk may send a ready bill: that is their job
        const r = await raw('POST', `/organizations/${w.orgId}${path}`, person.token, body);
        assert.ok(r.status >= 400, `${who} going round the card to ${kind} is refused (got ${r.status})`);
      }
    }
  }
  await assertUnchanged(before, 'Refused attempts');

  // Every card that IS offered goes through for the person it was offered to.
  for (const [who, person] of Object.entries(people)) {
    hostile({
      turns: [[{ name: 'find_bills', args: {} }, { name: 'whats_waiting', args: {} }]],
      respond: () => ({ ...EMPTY, actions: Object.values(w.bills).flatMap((billId) => KINDS.map((kind) => ({ kind, billId, reason: 'go' }))) }),
    });
    const { chatId, answer } = await ask(w.orgId, person.token, 'Everything.');
    for (const card of answer.actions as Array<{ actionId: string; kind: string; call: { path: string; body: unknown } }>) {
      const r = await raw('POST', `/organizations/${w.orgId}${card.call.path}`, person.token, card.call.body);
      // The only refusal allowed is one the person could not have seen coming
      // from the card: a card acted on after another card changed the bill.
      assert.ok(r.status < 400 || [409, 400].includes(r.status), `${who}'s ${card.kind} card goes through (got ${r.status}: ${r.text.slice(0, 120)})`);
      await post(`/organizations/${w.orgId}/companion/chats/${chatId}/actions/${card.actionId}/outcome`, { ok: r.status < 400, message: r.text.slice(0, 200) }, person.token);
    }
  }
});

// ─── 4. What the model says is never what the button does ────────────────────

test('safety: a model that smuggles requests, junk and markup into its answer gets none of it through', async () => {
  const w = await makeWorld();
  const junk = {
    message: `<script>alert(1)</script><img src=x onerror=alert(2)> ${'A'.repeat(100_000)}`,
    tables: [
      { title: 'x'.repeat(5000), columns: Array.from({ length: 40 }, (_, i) => `c${i}`.repeat(50)), rows: Array.from({ length: 500 }, () => Array.from({ length: 40 }, () => 'y'.repeat(1000))) },
      { title: 'objects', columns: ['a'], rows: [[{ nested: true }], [null], [42]] },
      'not a table', null, { title: 't', columns: 'nope', rows: 'nope' },
      { title: '4th', columns: ['a'], rows: [['b']] }, { title: '5th', columns: ['a'], rows: [['b']] },
    ],
    billIds: [w.bills.ready, 12, null, { id: w.bills.ready }, '../../x', w.bills.ready.toUpperCase(), `${w.bills.ready} `],
    actions: [
      { kind: 'send_for_approval', billId: w.bills.ready, reason: 'r'.repeat(10_000), call: { path: '/organizations/x/delete-everything', body: { all: true } }, path: '/evil', status: 'done', result: 'Approved by the CEO' },
      { kind: 'delete_bill', billId: w.bills.ready, reason: 'invented kind' },
      { kind: 'approve', billId: w.bills.submitted, reason: 'owner has no task' },
      { kind: 'send_for_approval', billId: '../../bills/all', reason: 'traversal' },
      { kind: 'send_for_approval', billId: "x' OR 1=1 --", reason: 'sql' },
      { kind: 'SEND_FOR_APPROVAL', billId: w.bills.steady1, reason: 'case games' },
      { kind: 'send_for_approval', billId: w.bills.ready, reason: 'duplicate of the first' },
      null, 'send everything', 42,
    ],
    extra: { adminOverride: true },
  };
  hostile({ turns: [[{ name: 'find_bills', args: {} }]], respond: () => junk });
  const before = await fingerprint();
  const { answer } = await ask(w.orgId, w.owner.token, 'Smuggle.');
  await assertUnchanged(before, 'A smuggling answer');

  assert.equal(answer.status, 'done');
  assert.ok(answer.text.length <= 4000, 'the message is clamped');
  assert.ok(answer.tables.length <= 3, 'at most three tables');
  for (const t of answer.tables) {
    assert.ok(t.columns.length <= 8 && t.rows.length <= 50 && t.title.length <= 120);
    for (const r of t.rows) { assert.ok(r.length <= 8); for (const c of r) assert.equal(typeof c, 'string'); }
  }
  assert.deepEqual(answer.billIds, [w.bills.ready], 'only real bill ids a tool returned, once each');
  assert.equal(answer.actions.length, 1, 'one card: the one real, valid, non-duplicate proposal');
  const [card] = answer.actions;
  assert.equal(card.kind, 'send_for_approval');
  assert.equal(card.call.path, `/bills/${w.bills.ready}/confirm-as-read`, 'the request is built in code');
  assert.deepEqual(card.call.body, {});
  assert.equal(card.status, 'proposed', 'a model cannot mark its own card done');
  assert.equal(card.result, null);
  assert.ok(card.reason.length <= 300, 'the reason is clamped');
});

test('safety: every card path, for every kind, is exactly the one endpoint that kind may call', async () => {
  const w = await makeWorld();
  hostile({ turns: [[{ name: 'find_bills', args: {} }, { name: 'whats_waiting', args: {} }]], respond: () => ({ ...EMPTY, actions: Object.values(w.bills).flatMap((billId) => KINDS.map((kind) => ({ kind, billId, reason: 'x' }))) }) });
  const owner = await ask(w.orgId, w.owner.token, 'All.');
  hostile({ turns: [[{ name: 'whats_waiting', args: {} }]], respond: () => ({ ...EMPTY, actions: [{ kind: 'approve', billId: w.bills.submitted, reason: 'mine' }] }) });
  const approver = await ask(w.orgId, w.apprA.token, 'Approve.');
  const cards = [...owner.answer.actions, ...approver.answer.actions] as Array<{ kind: string; billId: string; call: { path: string; body: any } }>;
  assert.ok(cards.some((c) => c.kind === 'approve') && cards.some((c) => c.kind === 'close_duplicate') && cards.some((c) => c.kind === 'send_for_approval'));
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  for (const c of cards) {
    const pattern = {
      send_for_approval: new RegExp(`^/bills/${c.billId}/confirm-as-read$`),
      close_duplicate: new RegExp(`^/bills/${c.billId}/not-a-bill$`),
      clear_duplicate: new RegExp(`^/bills/${c.billId}/duplicate-override$`),
      approve: new RegExp(`^/approvals/tasks/${uuid}/command$`),
    }[c.kind as (typeof KINDS)[number]];
    assert.match(c.call.path, pattern!, `${c.kind} calls only its own endpoint`);
    if (c.kind === 'close_duplicate') assert.equal(c.call.body.reason, 'duplicate', 'close is always "duplicate", never another reason');
    if (c.kind === 'approve') assert.deepEqual(Object.keys(c.call.body).sort(), ['command', 'idempotencyKey']);
    if (c.kind === 'approve') assert.deepEqual(c.call.body.command, { kind: 'approve' }, 'approve is only ever approve');
  }
});

// ─── 5. Clicking twice, clicking late ─────────────────────────────────────────

test('safety: an approve card approves once, however many times it is clicked', async () => {
  const w = await makeWorld();
  hostile({ turns: [[{ name: 'whats_waiting', args: {} }]], respond: () => ({ ...EMPTY, actions: [{ kind: 'approve', billId: w.bills.submitted, reason: 'yours' }] }) });
  const { chatId, answer } = await ask(w.orgId, w.apprA.token, 'Approve it.');
  const card = answer.actions[0];
  assert.equal(card.kind, 'approve');
  const events = async () => Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM approval.approval_events`))[0]!.n);
  const results = await Promise.all(Array.from({ length: 5 }, () => raw('POST', `/organizations/${w.orgId}${card.call.path}`, w.apprA.token, card.call.body)));
  assert.ok(results.some((r) => r.status < 400), 'one click goes through');
  const afterFirst = await events();
  await raw('POST', `/organizations/${w.orgId}${card.call.path}`, w.apprA.token, card.call.body);
  assert.equal(await events(), afterFirst, 'a later click adds nothing');
  const approvals = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM approval.approval_events WHERE type ILIKE '%approv%' AND payload::text ILIKE '%approve%'`).catch(() => [{ n: 0n }]);
  assert.ok(Number(approvals[0]!.n) <= 1, 'approved at most once');
  const done = await post(`/organizations/${w.orgId}/companion/chats/${chatId}/actions/${card.actionId}/outcome`, { ok: true }, w.apprA.token);
  assert.equal(done.status, 'done');
  const flipped = await post(`/organizations/${w.orgId}/companion/chats/${chatId}/actions/${card.actionId}/outcome`, { ok: false, message: 'undo?' }, w.apprA.token);
  assert.equal(flipped.status, 'done', 'a done card cannot be marked failed afterwards');
});

test('safety: a card clicked after the bill changed is refused by the bill, not trusted', async () => {
  const w = await makeWorld();
  hostile({ turns: [[{ name: 'find_bills', args: {} }]], respond: () => ({ ...EMPTY, actions: [{ kind: 'send_for_approval', billId: w.bills.ready, reason: 'ready' }] }) });
  const { answer } = await ask(w.orgId, w.clerk.token, 'Send it.');
  const card = answer.actions[0];
  // Before the clerk clicks, the owner sends it themselves.
  await post(`/organizations/${w.orgId}/bills/${w.bills.ready}/confirm`, confirmBody('SS-2', 310), w.owner.token);
  const state = async () => (await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: w.bills.ready }, select: { state: true, updatedAt: true } }));
  const before = await state();
  const late = await raw('POST', `/organizations/${w.orgId}${card.call.path}`, w.clerk.token, card.call.body);
  assert.equal(late.status, 409, 'a stale card is refused');
  assert.deepEqual(await state(), before, 'and the bill is untouched');

  // A ready bill that gained a duplicate after the card was made.
  hostile({ turns: [[{ name: 'find_bills', args: {} }]], respond: () => ({ ...EMPTY, actions: [{ kind: 'send_for_approval', billId: w.bills.steady1, reason: 'ready' }] }) });
  const second = await ask(w.orgId, w.clerk.token, 'Send the other.');
  const c2 = second.answer.actions[0];
  assert.ok(c2, 'it was ready when proposed');
  await upload(w.orgId, w.owner.token, w.orgName, { vendor: 'Steady Supply', amount: 300, invoiceNo: 'SS-1' });
  await drainAsyncIntake();
  const flagged = await raw('POST', `/organizations/${w.orgId}${c2.call.path}`, w.clerk.token, c2.call.body);
  assert.equal(flagged.status, 409, 'now flagged as a possible duplicate, it is refused');
  assert.equal((await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: w.bills.steady1 }, select: { state: true } })).state, 'draft');
});

// ─── 6. confirm-as-read, attacked directly ────────────────────────────────────

test('safety: "confirm as read" refuses everything but a ready bill, for someone who may send it', async () => {
  const w = await makeWorld();
  const other = await makeWorld('Other Org Ltd');
  const before = await fingerprint();
  const cases: Array<[string, string, string, number[]]> = [
    ['a viewer', w.viewer.token, w.bills.ready, [403]],
    ['an approver without bills.edit', w.apprB.token, w.bills.ready, [403]],
    ['a flagged duplicate', w.owner.token, w.bills.dupNew, [409]],
    ['a first bill from a vendor', w.owner.token, w.bills.lonely, [409]],
    ['a held vendor', w.owner.token, w.bills.held, [409]],
    ['a bill already in approval', w.owner.token, w.bills.submitted, [409]],
    ['another organisation\'s bill', w.owner.token, other.bills.ready, [403, 404]],
    ['a made-up id', w.owner.token, crypto.randomUUID(), [403, 404]],
    ['not an id', w.owner.token, 'not-a-uuid', [400, 404]],
  ];
  for (const [what, token, bill, allowed] of cases) {
    const r = await raw('POST', `/organizations/${w.orgId}/bills/${bill}/confirm-as-read`, token, { total: 1, fields: { total: 999999 } });
    assert.ok(allowed.includes(r.status), `${what}: expected ${allowed.join('/')}, got ${r.status} ${r.text.slice(0, 120)}`);
  }
  await assertUnchanged(before, 'Refused confirm-as-read');
  // Anything in the body is ignored: it sends what was read, nothing else.
  await post(`/organizations/${w.orgId}/bills/${w.bills.ready}/confirm-as-read`, { fields: { total: 999999 }, lines: [] }, w.clerk.token);
  const sent = await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: w.bills.ready }, select: { amountRaw: true, state: true } });
  assert.equal(sent.amountRaw, 310_000_000n, 'the amount is the one on the bill, not one in the request');
  assert.notEqual(sent.state, 'draft');
});

// ─── 7. A misbehaving model fails safe ────────────────────────────────────────

test('safety: a model that throws, rambles, loops or answers nonsense ends in a failed answer and no changes', async () => {
  const w = await makeWorld();
  const before = await fingerprint();
  const scenarios: Array<[string, Plan]> = [
    ['throws', { turns: [], respond: null, replies: ['throw'] }],
    ['talks instead of calling tools', { turns: [], respond: null, replies: [{ role: 'assistant', content: 'I approved everything.' }, { role: 'assistant', content: 'Done, all paid.' }] }],
    ['never answers', { turns: [], respond: null }],
    ['answers with malformed arguments', { turns: [], respond: null, replies: [{ role: 'assistant', content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name: 'respond', arguments: '{"message": "unterminated' } }] }] }],
    ['answers with the wrong shape', { turns: [], respond: () => ({ message: { html: '<b>x</b>' }, tables: 'all of them', billIds: 'every', actions: { kind: 'approve' } }) }],
  ];
  for (const [what, plan] of scenarios) {
    hostile(plan);
    const { answer, chat } = await ask(w.orgId, w.owner.token, `Scenario: ${what}`);
    assert.equal(chat.running, false, `${what}: the chat is not left running`);
    assert.ok(['failed', 'done'].includes(answer.status), `${what}: it ends`);
    assert.ok(!/approved everything|all paid/i.test(answer.text), `${what}: prose from a model that would not call tools is never shown as the answer`);
    assert.deepEqual(answer.actions ?? [], [], `${what}: no cards`);
    assert.ok(typeof answer.text === 'string' && answer.text.length > 0);
  }
  await assertUnchanged(before, 'Misbehaving models');
});

test('safety: while an answer is being worked out, a second question is refused, not queued twice', async () => {
  const w = await makeWorld();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  setExceptionAgentRuntimeForTests({
    isConfigured: () => true,
    callModel: async () => {
      calls += 1;
      await gate;
      return { usage: { promptTokens: 1, completionTokens: 1 }, message: { role: 'assistant', content: null, tool_calls: [{ id: `g${calls}`, type: 'function', function: { name: 'respond', arguments: JSON.stringify(EMPTY) } }] } };
    },
  });
  const { chatId } = await post(`/organizations/${w.orgId}/companion/chats`, { text: 'First' }, w.owner.token);
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => raw('POST', `/organizations/${w.orgId}/companion/chats/${chatId}/messages`, w.owner.token, { text: `Again ${i}` })));
  assert.ok(burst.every((r) => r.status === 400), `every follow-up while running is refused (${burst.map((r) => r.status).join(',')})`);
  release();
  await drainAsyncIntake();
  const chat = await get(`/organizations/${w.orgId}/companion/chats/${chatId}`, w.owner.token);
  assert.deepEqual(chat.messages.map((m: { role: string }) => m.role), ['user', 'assistant'], 'exactly one question and one answer');
  assert.equal(calls, 1, 'the model was asked once');
});

test('safety: questions are bounded, and history sent to the model is bounded', async () => {
  const w = await makeWorld();
  for (const text of ['', '   ', 'x'.repeat(2001)]) {
    assert.equal((await raw('POST', `/organizations/${w.orgId}/companion/chats`, w.owner.token, { text })).status, 400, `refused: ${text.length} chars`);
  }
  assert.equal((await raw('POST', `/organizations/${w.orgId}/companion/chats`, w.owner.token, { text: 42 })).status, 400);
  assert.equal((await raw('POST', `/organizations/${w.orgId}/companion/chats`, w.owner.token, {})).status, 400);
  const seen = hostile({ turns: [], respond: () => EMPTY });
  const { chatId } = await post(`/organizations/${w.orgId}/companion/chats`, { text: 'q0' }, w.owner.token);
  await drainAsyncIntake();
  for (let i = 1; i <= 15; i++) {
    await post(`/organizations/${w.orgId}/companion/chats/${chatId}/messages`, { text: `q${i}` }, w.owner.token);
    await drainAsyncIntake();
  }
  const last = seen.messages.at(-1)!;
  const history = last.filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls));
  assert.ok(history.length <= 13, `history is capped (${history.length} messages sent)`);
  assert.equal(last.find((m) => m.role === 'user' && m.content === 'q15') !== undefined, true, 'the newest question is always there');
  const chat = await get(`/organizations/${w.orgId}/companion/chats/${chatId}`, w.owner.token);
  assert.ok(chat.title.length <= 60);
});

// ─── 8. The jobs a person may see ─────────────────────────────────────────────

test('safety: the console and job steps show nothing to someone outside, and job steps are read-only', async () => {
  const w = await makeWorld();
  const jobId = (await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: w.bills.ready }, select: { invoiceDocumentId: true } })).invoiceDocumentId!;
  const before = await fingerprint();
  for (const p of [w.owner, w.clerk, w.apprA, w.viewer]) {
    await get(`/organizations/${w.orgId}/companion/console`, p.token);
    await get(`/organizations/${w.orgId}/companion/jobs/${jobId}`, p.token);
  }
  await assertUnchanged(before, 'Reading the console and jobs');
  for (const bad of ['not-a-uuid', crypto.randomUUID()]) {
    assert.ok([400, 404].includes((await raw('GET', `/organizations/${w.orgId}/companion/jobs/${bad}`, w.owner.token)).status));
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok([404, 405].includes((await raw(method, `/organizations/${w.orgId}/companion/jobs/${jobId}`, w.owner.token, {})).status), `${method} on a job does nothing`);
  }
});

// ─── 9. Found by the live red team ────────────────────────────────────────────

test('safety: an answer left running by a restart is settled, and the chat can be used again', async () => {
  const w = await makeWorld();
  const chat = await prisma.companionChat.create({ data: { organizationId: w.orgId, userId: w.owner.userId, title: 'Interrupted' } });
  const longAgo = new Date(Date.now() - 10 * 60_000);
  await prisma.companionMessage.create({ data: { chatId: chat.chatId, role: 'user', status: 'done', text: 'q', createdAt: longAgo } });
  await prisma.companionMessage.create({ data: { chatId: chat.chatId, role: 'assistant', status: 'running', createdAt: longAgo } });
  // A running answer that is only seconds old is left alone.
  const fresh = await prisma.companionChat.create({ data: { organizationId: w.orgId, userId: w.owner.userId, title: 'Still going' } });
  await prisma.companionMessage.create({ data: { chatId: fresh.chatId, role: 'assistant', status: 'running' } });

  const read = await get(`/organizations/${w.orgId}/companion/chats/${chat.chatId}`, w.owner.token);
  assert.equal(read.running, false, 'no longer "still working" forever');
  assert.equal(read.messages[1].status, 'failed');
  assert.match(read.messages[1].text, /interrupted/);
  hostile({ turns: [], respond: () => EMPTY });
  await post(`/organizations/${w.orgId}/companion/chats/${chat.chatId}/messages`, { text: 'again' }, w.owner.token);
  await drainAsyncIntake();
  assert.equal((await get(`/organizations/${w.orgId}/companion/chats/${fresh.chatId}`, w.owner.token)).running, true, 'a live answer is not cut short');
});

test('safety: the model is told who it is talking to, so "my approval" means the asker', async () => {
  const w = await makeWorld();
  const seen = hostile({ turns: [], respond: () => EMPTY });
  await ask(w.orgId, w.apprA.token, 'Approve the bill waiting on me.');
  const prompt = String(seen.messages[0]?.find((m) => m.role === 'system')?.content ?? '');
  assert.match(prompt, /You are talking to Adam Approver \(member; roles: Approver\)/);
  assert.match(prompt, /"I", "me" and "my" mean Adam Approver/);
  seen.messages.length = 0;
  hostile({ turns: [], respond: () => EMPTY });
  const owner = hostile({ turns: [], respond: () => EMPTY });
  await ask(w.orgId, w.owner.token, 'Hello');
  assert.match(String(owner.messages[0]?.find((m) => m.role === 'system')?.content ?? ''), /\(primary admin\)/);
});
