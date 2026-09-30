// Learning by line, in the background: a category a person settles for a line
// fills in the next line like it — whoever the vendor — and nothing about a
// vendor is learned. What I know shows it; whoever codes bills can forget one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';
import { raw, post, get, upload, makeWorld, hostile, ask, EMPTY } from './helpers/companion-harness.js';

type World = Awaited<ReturnType<typeof makeWorld>>;

const FIELDS = (invoiceNo: string, amount: number) => ({ invoiceNumber: invoiceNo, invoiceDate: '2026-08-02', dueDate: '2026-08-30', terms: 'Net 30', currency: 'USD', total: amount, taxAmount: 0 });

/** Upload a bill whose one line reads `line`, and return its id, read. */
async function bill(w: World, vendor: string, invoiceNo: string, line: string, amount = 400) {
  const id = await upload(w.orgId, w.owner.token, w.orgName, { vendor, amount, invoiceNo, line });
  await drainAsyncIntake();
  return id;
}
const draftOf = (w: World, id: string, token = w.clerk.token) => get(`/organizations/${w.orgId}/bills/${id}/draft`, token);
const remembered = async (w: World, line: string) =>
  ((await get(`/organizations/${w.orgId}/knowledge`, w.clerk.token)).lines as Array<{ description: string; category: string; invoiceNumber: string; by: string }>)
    .filter((l) => l.description.toLowerCase().startsWith(line.toLowerCase().slice(0, 12)));

/** Confirm a bill whose one line reads `description`, in `category`. */
async function settle(w: World, id: string, invoiceNo: string, description: string, category: string, amount = 400) {
  await post(`/organizations/${w.orgId}/bills/${id}/confirm`, {
    fields: FIELDS(invoiceNo, amount),
    lines: [{ description, quantity: 1, unitPrice: amount, amount, category }],
    confirmedFieldKeys: [],
  }, w.clerk.token);
}

test('line memory: a line a clerk confirmed fills in the next line like it, from any vendor, and says where it came from', async () => {
  const w = await makeWorld();
  const first = await bill(w, 'Brightwave Media', 'BW-1', 'Stock photography licenses (8)');
  await settle(w, first, 'BW-1', 'Stock photography licenses (8)', 'Taxes & licenses');

  const next = (await draftOf(w, await bill(w, 'Pixel Foundry', 'PF-1', 'Stock photography licenses (20)'))).lines[0];
  assert.equal(next.category, 'Taxes & licenses', 'the same kind of line, from a different vendor, gets what the team settled');
  assert.equal(next.categoryFrom.kind, 'memory');
  assert.equal(next.categoryFrom.invoiceNumber, 'BW-1');
  assert.equal(next.categoryFrom.by, 'Clara Clerk');

  const other = (await draftOf(w, await bill(w, 'Brightwave Media', 'BW-2', 'Social media management — August'))).lines[0];
  assert.notEqual(other.categoryFrom?.kind, 'memory', 'a different thing from the same vendor is not coded like the licenses');

  assert.equal(await prisma.vendorCodingRule.count({ where: { organizationId: w.orgId, source: 'learned' } }), 0, 'nothing about a vendor was learned');
});

test('line memory: a category changed on a saved draft teaches too; one left as proposed does not', async () => {
  const w = await makeWorld();
  const a = await bill(w, 'Brightwave Media', 'BW-1', 'Brand workshop facilitation');
  const proposed = (await draftOf(w, a)).lines[0];
  const saveWith = (category: string | null) => post(`/organizations/${w.orgId}/bills/${a}/save`, {
    fields: FIELDS('BW-1', 400), lines: [{ description: proposed.description, quantity: 1, unitPrice: 400, amount: 400, category }], confirmedFieldKeys: [],
  }, w.clerk.token);
  await saveWith(proposed.category);
  assert.deepEqual(await remembered(w, 'Brand workshop'), [], 'saved as proposed: not a lesson');
  const changed = proposed.category === 'Taxes & licenses' ? 'Travel' : 'Taxes & licenses';
  await saveWith(changed);
  assert.deepEqual((await remembered(w, 'Brand workshop')).map((l) => [l.category, l.invoiceNumber, l.by]), [[changed, 'BW-1', 'Clara Clerk']],
    'changed and saved: a lesson, before the bill is confirmed');
  const b = await bill(w, 'Other Vendor', 'OV-1', 'Brand workshop facilitation');
  assert.equal((await draftOf(w, b)).lines[0].category, changed);
});

test('line memory: readiness needs every line to be one the team settled; forgetting a line stops it, and only an editor may', async () => {
  const w = await makeWorld();
  const desc = 'Analytics retainer';
  const a = await bill(w, 'Brightwave Media', 'BW-1', desc);
  const b = await bill(w, 'Brightwave Media', 'BW-2', desc);
  const ready = async () => ((await get(`/organizations/${w.orgId}/companion/ready`, w.clerk.token)).bills as Array<{ billId: string }>).map((x) => x.billId);
  assert.equal((await ready()).includes(b), false, 'a first guess is not ready');
  await settle(w, a, 'BW-1', desc, 'Advertising & marketing');
  assert.equal((await ready()).includes(b), true, 'every line matches one the team settled: ready');

  assert.equal((await raw('POST', `/organizations/${w.orgId}/knowledge/lines/forget`, w.apprA.token, { description: desc })).status, 403, 'not an approver');
  assert.ok((await raw('POST', `/organizations/${w.orgId}/knowledge/lines/forget`, w.clerk.token, { description: desc })).status < 400);
  assert.deepEqual(await remembered(w, desc), [], 'forgotten');
  assert.equal((await get(`/organizations/${w.orgId}/knowledge`, w.clerk.token)).forgotten[0].by, 'Clara Clerk');
  assert.equal((await ready()).includes(b), false, 'back to a first guess');
  const c = await bill(w, 'Brightwave Media', 'BW-3', desc);
  assert.notEqual((await draftOf(w, c)).lines[0].categoryFrom?.kind, 'memory', 'new lines like it are no longer filled in from it');

  await settle(w, c, 'BW-3', desc, 'Advertising & marketing');
  assert.equal((await remembered(w, desc)).length, 1, 'settled again after the forget: it teaches again');
});

test('vendor defaults: set by hand only, the last resort for a line; the companion proposes them for whoever codes bills', async () => {
  const w = await makeWorld();
  const proposals = [
    { kind: 'save_habit', billId: w.bills.lonely, reason: 'Lonely Ltd is always travel.', toPerson: null, message: null, category: 'travel' },
    { kind: 'save_habit', billId: w.bills.held, reason: 'Made up.', toPerson: null, message: null, category: 'Not A Real Category' },
    { kind: 'forget_habit', billId: w.bills.ready, reason: 'Steady changed what they sell.', toPerson: null, message: null, category: null },
    { kind: 'forget_habit', billId: w.bills.lonely, reason: 'No default to remove.', toPerson: null, message: null, category: null },
  ];
  hostile({ turns: [[{ name: 'find_bills', args: {} }]], respond: () => ({ ...EMPTY, actions: proposals }) });
  assert.deepEqual((await ask(w.orgId, w.apprA.token, 'Tidy up the defaults.')).answer.actions, [], 'not for an approver');

  hostile({ turns: [[{ name: 'find_bills', args: {} }]], respond: () => ({ ...EMPTY, actions: proposals }) });
  const cards = (await ask(w.orgId, w.clerk.token, 'Tidy up the defaults.')).answer.actions as Array<{ kind: string; title: string; call: { method: string; path: string; body: any } }>;
  assert.deepEqual(cards.map((c) => c.kind), ['save_habit', 'forget_habit']);
  const lonelyVendor = (await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: w.bills.lonely }, select: { counterpartyId: true } })).counterpartyId;
  assert.deepEqual(cards[0]!.call, { method: 'PUT', path: '/knowledge/habits', body: { counterpartyId: lonelyVendor, category: 'Travel' } });
  assert.equal(cards[0]!.title, 'Set a default: Lonely Ltd → Travel');
  assert.ok((await raw(cards[0]!.call.method, `/organizations/${w.orgId}${cards[0]!.call.path}`, w.clerk.token, cards[0]!.call.body)).status < 400);
  const k = await get(`/organizations/${w.orgId}/knowledge`, w.viewer.token);
  assert.ok(k.vendorDefaults.some((d: { vendorName: string; category: string; setBy: string }) => d.vendorName === 'Lonely Ltd' && d.category === 'Travel' && d.setBy === 'Clara Clerk'));
  assert.equal(k.choices, null, 'a viewer gets no choices to set one');
  assert.ok((await raw(cards[1]!.call.method, `/organizations/${w.orgId}${cards[1]!.call.path}`, w.clerk.token, {})).status < 400);
  assert.equal(await prisma.vendorCodingRule.count({ where: { organizationId: w.orgId, counterparty: { displayName: 'Steady Supply' } } }), 0);
});
