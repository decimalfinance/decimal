// Shared harness for the companion's tests: a real server, a whole
// organisation with every kind of bill and person, a hostile scripted model,
// and a strict "changed nothing" fingerprint of every business table.
//
// Importing it registers the server and the per-test database wipe.
//
// (What follows was the top of companion-safety.test.ts.)
//
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
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/infra/prisma.js';
import { config } from '../../src/config.js';
import { requireTestDatabase } from './require-test-database.js';
import { drainAsyncIntake, setInvoiceIntakeRuntimeForTests } from '../../src/payments/invoice-intake.js';
import { setExceptionAgentRuntimeForTests, type ChatMessage } from '../../src/exceptions/agent.js';
import { ensureEngineSetup } from '../../src/approvals/wiring.js';
import { setRole } from '../../src/approvals/roles.js';

export let baseUrl = '';
let close: (() => Promise<void>) | undefined;

before(async () => {
  await prisma.$connect();
  await requireTestDatabase();
  config.publicRateLimitMax = 1_000_000;
  const { registerPaymentApprovalBridge } = await import('../../src/payments/approval-bridge.js');
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

export async function raw(method: string, path: string, token?: string, body?: unknown) {
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
export async function post(path: string, body: unknown, token?: string) {
  const r = await raw('POST', path, token, body);
  assert.ok(r.status === 200 || r.status === 201, `POST ${path} → ${r.status}: ${r.text}`);
  return r.json;
}
export async function get(path: string, token: string) {
  const r = await raw('GET', path, token);
  assert.equal(r.status, 200, `GET ${path} → ${r.status}: ${r.text}`);
  return r.json;
}

// ─── A whole organisation, with every kind of bill and person ─────────────────

export type Person = { token: string; userId: string; name: string };

export async function register(name: string): Promise<Person> {
  const r = await post('/auth/register', { email: `${name.toLowerCase().replace(/\W+/g, '.')}-${crypto.randomUUID()}@example.com`, password: 'DemoPass123!', displayName: name });
  await post('/auth/verify-email', { code: r.devEmailVerificationCode }, r.sessionToken);
  return { token: r.sessionToken, userId: r.user.userId, name };
}

export function extractionOf(over: { vendor: string; amount: number; invoiceNo: string; billTo: string; line?: string }) {
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
          walletAddress: null, lineItems: [{ description: over.line ?? 'Services', quantity: 1, unitPrice: over.amount, total: over.amount }],
          categoryHint: 'Cloud hosting', confidence: { vendor: 1, amount: 1, overall: 1 }, fieldConfidence: null,
        },
      }],
      modelLatencyMs: 1, pageCount: 1,
    }),
  });
}

export async function upload(orgId: string, token: string, billTo: string, over: { vendor: string; amount: number; invoiceNo: string; line?: string }) {
  extractionOf({ ...over, billTo });
  const up = await post(`/organizations/${orgId}/invoices/upload`, {
    filename: `${over.invoiceNo}.pdf`, mimeType: 'application/pdf', dataBase64: Buffer.from(`%PDF ${crypto.randomUUID()}`).toString('base64'), autoAdvance: false,
  }, token);
  return up.paymentOrders[0].paymentOrder.paymentOrderId as string;
}

export function confirmBody(invoiceNo: string, total: number) {
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
export async function makeWorld(orgName = 'Halcyon Labs, Inc.') {
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
  await prisma.vendorCodingRule.create({ data: { organizationId: orgId, counterpartyId: steadyId!, accountId: 'Cloud hosting & infrastructure', accountName: 'Cloud hosting & infrastructure', source: 'manual', learnedFromCount: 0 } });
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
export const OWN_TABLES = new Set([
  'public.companion_chats', 'public.companion_messages', 'public.companion_steps', 'public.companion_views',
  'public.bill_exception_briefs', 'public.ai_suggestions', 'public.ai_suggestion_outcomes',
  'public.auth_sessions', 'public.idempotency_records',
]);

export type Print = Map<string, Map<string, string>>; // table -> row hash -> row

export async function fingerprint(): Promise<Print> {
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
export async function assertUnchanged(before: Print, what: string) {
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

export type Call = { name: string; args?: unknown; rawArgs?: string };
export type Plan = {
  /** Tool calls per turn, before answering. */
  turns: Call[][];
  /** The final respond arguments, given what the tools returned. `null` = never respond. */
  respond: ((outputs: Array<{ name: string; args: string; output: any }>) => unknown) | null;
  /** Raw assistant replies to send instead, turn by turn (prose, malformed shapes). */
  replies?: Array<ChatMessage | 'throw'>;
};

export function hostile(plan: Plan) {
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

export async function ask(orgId: string, token: string, text: string) {
  const { chatId } = await post(`/organizations/${orgId}/companion/chats`, { text }, token);
  await drainAsyncIntake();
  const chat = await get(`/organizations/${orgId}/companion/chats/${chatId}`, token);
  return { chatId, chat, answer: chat.messages.at(-1) };
}

export const EMPTY = { message: 'ok', tables: [], billIds: [], actions: [] };

// Everything the model can ask for, with arguments meant to break it.
export const HOSTILE_ARGS: unknown[] = [
  {}, { vendor: null }, { vendor: '' }, { vendor: "'; DROP TABLE payment_orders; --" }, { vendor: 'x'.repeat(50_000) },
  { invoiceNumber: '%' }, { invoiceNumber: '_' }, { status: 'deleted' }, { status: 42 }, { from: 'yesterday' }, { from: '2026-13-45' },
  { minAmount: -1e308 }, { maxAmount: 'lots' }, { groupBy: 'password' }, { billId: '../../../etc/passwd' },
  { billId: "00000000-0000-0000-0000-000000000000' OR '1'='1" }, { billId: null }, { billId: 12 }, { which: 'other' },
  { __proto__: { admin: true } }, { constructor: { prototype: { polluted: true } } },
];
export const TOOL_NAMES = ['find_bills', 'get_bill', 'spend_summary', 'vendor_profile', 'whats_waiting', 'team', 'approval_trail', 'bill_history', 'approval_rules', 'categories', 'what_i_know'];

