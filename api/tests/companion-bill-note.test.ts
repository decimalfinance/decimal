// The companion on a bill's own screen: what it did, what it needs from you,
// where the bill stands — and a chat where "this bill" means that bill.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { raw, get, post, makeWorld, hostile, fingerprint, assertUnchanged, EMPTY } from './helpers/companion-harness.js';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';

const noteOf = (orgId: string, billId: string, token: string) => get(`/organizations/${orgId}/bills/${billId}/companion`, token);

test('bill note: says what it did, whether the bill is ready, and where its categories came from', async () => {
  const w = await makeWorld();
  const ready = await noteOf(w.orgId, w.bills.ready, w.owner.token);
  assert.deepEqual(ready.verdict, { ready: true, reason: null });
  assert.deepEqual(ready.habit, { category: 'Cloud hosting & infrastructure', source: 'learned', fromBills: 3 });
  assert.ok(ready.did.length > 0, 'the steps it took reading the document');
  assert.ok(ready.did.every((s: { status: string; text: string }) => ['done', 'noted', 'failed', 'running'].includes(s.status) && s.text));
  assert.equal(ready.chatId, null);

  const dup = await noteOf(w.orgId, w.bills.dupNew, w.owner.token);
  assert.equal(dup.verdict.ready, false);
  assert.match(dup.verdict.reason, /duplicate/i, 'the one reason it needs a person');
  assert.equal(dup.habit, null, 'no habit: categories are a guess');

  const submitted = await noteOf(w.orgId, w.bills.submitted, w.owner.token);
  assert.equal(submitted.verdict, null, 'past review: no ready-or-not verdict');
  assert.ok(submitted.standing, 'but it says where the bill stands');
});

test('bill note: what the viewer\'s inbox wants of them on this bill, and nothing of anyone else\'s', async () => {
  const w = await makeWorld();
  const clerk = await noteOf(w.orgId, w.bills.lonely, w.clerk.token);
  assert.ok(clerk.waiting.some((l: { kind: string; text: string }) => l.kind === 'question' && /Which category is this\?/.test(l.text)), 'the clerk was asked');
  const approver = await noteOf(w.orgId, w.bills.lonely, w.apprA.token).catch(() => null);
  assert.ok(approver === null || !approver.waiting.some((l: { kind: string }) => l.kind === 'question'), 'the approver was not');
});

test('bill note: another organisation\'s bill is not found, and reading a note changes nothing', async () => {
  const w = await makeWorld();
  const other = await makeWorld('Other Co');
  assert.equal((await raw('GET', `/organizations/${w.orgId}/bills/${other.bills.ready}/companion`, w.owner.token)).status, 404);
  assert.ok([400, 403, 404].includes((await raw('GET', `/organizations/${other.orgId}/bills/${other.bills.ready}/companion`, w.owner.token)).status), 'not a member: refused');
  const before = await fingerprint();
  for (const id of Object.values(w.bills)) await noteOf(w.orgId, id, w.clerk.token);
  await assertUnchanged(before, 'reading bill notes');
});

test('bill chat: asked on a bill, the model is told which bill "this" is; the chat is found again from the bill', async () => {
  const w = await makeWorld();
  const seen = hostile({ turns: [[{ name: 'get_bill', args: { billId: w.bills.lonely } }]], respond: () => ({ ...EMPTY, message: 'It is a Lonely Ltd bill.' }) });
  const { chatId } = await post(`/organizations/${w.orgId}/companion/chats`, { text: 'Why is this one here?', billId: w.bills.lonely }, w.clerk.token);
  await drainAsyncIntake();
  const firstUser = seen.messages[0]!.find((m) => m.role === 'user')!.content as string;
  assert.match(firstUser, new RegExp(`Asked on the screen of the bill Lonely Ltd LL-1, billId ${w.bills.lonely}`));
  assert.match(firstUser, /Why is this one here\?$/);
  const bill = seen.outputs.find((o) => o.name === 'get_bill')!.output;
  assert.ok('duplicateInvestigation' in bill, 'get_bill says what the duplicate check concluded, when it has');
  assert.equal(bill.duplicateInvestigation, null, 'nothing, for a bill with no investigation');

  const chat = await get(`/organizations/${w.orgId}/companion/chats/${chatId}`, w.clerk.token);
  assert.equal(chat.messages[0].text, 'Why is this one here?', 'what the person wrote is kept as written');
  assert.equal(chat.title, 'Lonely Ltd LL-1: Why is this one here?');
  assert.equal((await noteOf(w.orgId, w.bills.lonely, w.clerk.token)).chatId, chatId);
  assert.equal((await noteOf(w.orgId, w.bills.lonely, w.owner.token)).chatId, null, 'a chat is its asker\'s own');

  // A follow-up still knows the bill.
  await post(`/organizations/${w.orgId}/companion/chats/${chatId}/messages`, { text: 'And who asked about it?' }, w.clerk.token);
  await drainAsyncIntake();
  const followUser = seen.messages.at(-1)!.filter((m) => m.role === 'user').at(-1)!.content as string;
  assert.match(followUser, /Lonely Ltd LL-1/);

  // A bill in another organisation cannot be the subject.
  const other = await makeWorld('Other Co');
  assert.equal((await raw('POST', `/organizations/${w.orgId}/companion/chats`, w.clerk.token, { text: 'hi', billId: other.bills.ready })).status, 404);
});
