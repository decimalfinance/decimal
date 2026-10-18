// Learning by vendor + line, in the background: a category a person settles for
// a line fills in that vendor's next line like it, and never another vendor's.
// What I know shows it; whoever codes bills can forget one.
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
  ((await get(`/organizations/${w.orgId}/knowledge`, w.clerk.token)).lines as Array<{ vendorName: string; description: string; category: string; invoiceNumber: string; by: string }>)
    .filter((l) => l.description.toLowerCase().startsWith(line.toLowerCase().slice(0, 12)));
const vendorOf = async (id: string) => (await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: id }, select: { counterpartyId: true } })).counterpartyId!;

/** Confirm a bill whose one line reads `description`, in `category`. */
async function settle(w: World, id: string, invoiceNo: string, description: string, category: string, amount = 400) {
  await post(`/organizations/${w.orgId}/bills/${id}/confirm`, {
    fields: FIELDS(invoiceNo, amount),
    lines: [{ description, quantity: 1, unitPrice: amount, amount, category }],
    confirmedFieldKeys: [],
  }, w.clerk.token);
}

test("line memory: a line a clerk confirmed fills in the vendor's next line like it, says where it came from, and never another vendor's", async () => {
  const w = await makeWorld();
  const first = await bill(w, 'Brightwave Media', 'BW-1', 'Stock photography licenses (8)');
  await settle(w, first, 'BW-1', 'Stock photography licenses (8)', 'Taxes & licenses');

  const next = (await draftOf(w, await bill(w, 'Brightwave Media', 'BW-3', 'Stock photography licenses (20)'))).lines[0];
  assert.equal(next.category, 'Taxes & licenses', "the same kind of line from the same vendor gets what the team settled");
  assert.equal(next.categoryFrom.kind, 'memory');
  assert.equal(next.categoryFrom.invoiceNumber, 'BW-1');
  assert.equal(next.categoryFrom.by, 'Clara Clerk');

  const elsewhere = (await draftOf(w, await bill(w, 'Pixel Foundry', 'PF-1', 'Stock photography licenses (20)'))).lines[0];
  assert.notEqual(elsewhere.categoryFrom?.kind, 'memory', "another vendor's lines with the same words are a guess, not known");

  const other = (await draftOf(w, await bill(w, 'Brightwave Media', 'BW-2', 'Social media management — August'))).lines[0];
  assert.notEqual(other.categoryFrom?.kind, 'memory', 'a different thing from the same vendor is not coded like the licenses');

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
  assert.deepEqual((await remembered(w, 'Brand workshop')).map((l) => [l.vendorName, l.category, l.invoiceNumber, l.by]), [['Brightwave Media', changed, 'BW-1', 'Clara Clerk']],
    'changed and saved: a lesson for that vendor, before the bill is confirmed');
  const b = await bill(w, 'Brightwave Media', 'BW-2', 'Brand workshop facilitation');
  assert.equal((await draftOf(w, b)).lines[0].category, changed);
  assert.equal((await draftOf(w, b)).lines[0].categoryFrom.kind, 'memory');
});

test('line memory: readiness needs every line to be one the team settled from that vendor; forgetting a line stops it, for that vendor only, and only an editor may', async () => {
  const w = await makeWorld();
  const desc = 'Analytics retainer';
  const a = await bill(w, 'Brightwave Media', 'BW-1', desc);
  const b = await bill(w, 'Brightwave Media', 'BW-2', desc);
  const ready = async () => ((await get(`/organizations/${w.orgId}/companion/ready`, w.clerk.token)).bills as Array<{ billId: string }>).map((x) => x.billId);
  assert.equal((await ready()).includes(b), false, 'a first guess is not ready');
  await settle(w, a, 'BW-1', desc, 'Advertising & marketing');
  assert.equal((await ready()).includes(b), true, 'every line matches one the team settled from this vendor: ready');
  const p1 = await bill(w, 'Pixel Foundry', 'PF-1', desc);
  await settle(w, p1, 'PF-1', desc, 'Contractors');

  const brightwave = await vendorOf(a);
  assert.equal((await raw('POST', `/organizations/${w.orgId}/knowledge/lines/forget`, w.apprA.token, { counterpartyId: brightwave, description: desc })).status, 403, 'not an approver');
  assert.equal((await raw('POST', `/organizations/${w.orgId}/knowledge/lines/forget`, w.clerk.token, { counterpartyId: await vendorOf(w.bills.lonely), description: desc })).status, 404, 'not a line that vendor sends');
  assert.ok((await raw('POST', `/organizations/${w.orgId}/knowledge/lines/forget`, w.clerk.token, { counterpartyId: brightwave, description: desc })).status < 400);
  assert.deepEqual((await remembered(w, desc)).map((l) => [l.vendorName, l.category]), [['Pixel Foundry', 'Contractors']], "forgotten for Brightwave; Pixel Foundry's line is its own");
  const forgotten = (await get(`/organizations/${w.orgId}/knowledge`, w.clerk.token)).forgotten[0];
  assert.deepEqual([forgotten.vendorName, forgotten.by], ['Brightwave Media', 'Clara Clerk']);
  assert.equal((await ready()).includes(b), false, 'back to a first guess');
  const c = await bill(w, 'Brightwave Media', 'BW-3', desc);
  assert.notEqual((await draftOf(w, c)).lines[0].categoryFrom?.kind, 'memory', 'new lines like it are no longer filled in from it');

  await settle(w, c, 'BW-3', desc, 'Advertising & marketing');
  assert.deepEqual((await remembered(w, desc)).map((l) => l.vendorName), ['Brightwave Media', 'Pixel Foundry'], 'settled again after the forget: it teaches again');
});

test('vendor defaults are gone: nothing sets a category for a whole vendor, and the companion cannot propose one', async () => {
  const w = await makeWorld();
  const lonelyVendor = await vendorOf(w.bills.lonely);
  hostile({ turns: [[{ name: 'find_bills', args: {} }]], respond: () => ({ ...EMPTY, actions: [
    { kind: 'save_habit', billId: w.bills.lonely, reason: 'Lonely Ltd is always travel.', toPerson: null, message: null, focus: null },
    { kind: 'forget_habit', billId: w.bills.ready, reason: 'Steady changed what they sell.', toPerson: null, message: null, focus: null },
  ] }) });
  assert.deepEqual((await ask(w.orgId, w.clerk.token, 'Make Lonely Ltd always travel.')).answer.actions, [], 'no such card');
  assert.equal((await raw('PUT', `/organizations/${w.orgId}/knowledge/habits`, w.clerk.token, { counterpartyId: lonelyVendor, category: 'Travel' })).status, 404);
  assert.equal((await raw('PUT', `/organizations/${w.orgId}/counterparties/${lonelyVendor}/coding-rule`, w.owner.token, { accountId: 'Travel' })).status, 404);
  const k = await get(`/organizations/${w.orgId}/knowledge`, w.clerk.token);
  assert.deepEqual(Object.keys(k).sort(), ['canManage', 'forgotten', 'lines'], 'What I know is lines, and lines forgotten');
});

test('line memory: a bill whose categories a person changed and saved is not "a first guess"', async () => {
  const w = await makeWorld();
  const desc = 'Stock photography licenses (8)';
  const a = await bill(w, 'Brightwave Media', 'BW-1', desc);
  await bill(w, 'Brightwave Media', 'BW-0', 'Something else entirely');
  const ready = async () => ((await get(`/organizations/${w.orgId}/companion/ready`, w.clerk.token)).bills as Array<{ billId: string }>).map((x) => x.billId);
  assert.equal((await ready()).includes(a), false, 'proposed by the model: a first guess');
  const proposed = (await draftOf(w, a)).lines[0];
  const changed = proposed.category === 'Taxes & licenses' ? 'Travel' : 'Taxes & licenses';
  await post(`/organizations/${w.orgId}/bills/${a}/save`, {
    fields: FIELDS('BW-1', 400), lines: [{ description: desc, quantity: 1, unitPrice: 400, amount: 400, category: changed }], confirmedFieldKeys: [],
  }, w.clerk.token);
  assert.equal((await ready()).includes(a), true, 'recoded by a person and saved: known, so ready');
});
