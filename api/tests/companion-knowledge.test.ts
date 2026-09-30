// Learning you can see: a habit names who taught it, is announced to the
// admins once, can be kept or forgotten, and a forget sticks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';
import { raw, post, get, upload, makeWorld, hostile, ask, EMPTY } from './helpers/companion-harness.js';

type World = Awaited<ReturnType<typeof makeWorld>>;

/** A bill from a vendor, confirmed by `who` with every line in `category`. */
async function teach(w: World, who: { token: string }, vendor: string, invoiceNo: string, category: string, amount = 400) {
  const id = await upload(w.orgId, w.owner.token, w.orgName, { vendor, amount, invoiceNo });
  await drainAsyncIntake();
  await post(`/organizations/${w.orgId}/bills/${id}/confirm`, {
    fields: { invoiceNumber: invoiceNo, invoiceDate: '2026-08-02', dueDate: '2026-08-30', terms: 'Net 30', currency: 'USD', total: amount, taxAmount: 0 },
    lines: [{ description: 'Campaign work', quantity: 1, unitPrice: amount, amount, category }],
    confirmedFieldKeys: [],
  }, who.token);
  return id;
}

const ruleFor = (orgId: string, vendor: string) => prisma.vendorCodingRule.findFirst({ where: { organizationId: orgId, counterparty: { displayName: vendor } } });
const habitItems = async (w: World, token: string) =>
  ((await get(`/organizations/${w.orgId}/inbox`, token)).items as Array<{ key: string; habit?: { ruleId: string } | null; lines: Array<{ kind: string; text: string }> }>)
    .filter((i) => i.habit);

test('learning: three bills a clerk confirmed make a habit that names her, announced to the admins once', async () => {
  const w = await makeWorld();
  for (const n of [1, 2, 3]) await teach(w, w.clerk, 'Brightwave Media', `BW-${n}`, 'Advertising & marketing');
  const rule = await ruleFor(w.orgId, 'Brightwave Media');
  assert.ok(rule, 'learned');
  assert.equal(rule!.accountName, 'Advertising & marketing');
  assert.deepEqual(rule!.taughtBy, [w.clerk.userId], 'taught by the clerk who confirmed them');

  const ownerHabits = await habitItems(w, w.owner.token);
  const item = ownerHabits.find((i) => i.habit!.ruleId === rule!.vendorCodingRuleId);
  assert.ok(item, 'the admin hears about it');
  assert.equal(item!.lines[0]!.kind, 'learned');
  assert.equal(item!.lines[0]!.text, 'I learned: Brightwave Media goes to Advertising & marketing, from 3 bills Clara Clerk coded that way. I\'ll pre-fill it on new Brightwave Media bills.');
  assert.deepEqual(await habitItems(w, w.clerk.token), [], 'a clerk is not asked to keep it: keeping is an admin\'s call');

  // Anyone may see what it knows; only an admin may keep it.
  const k = await get(`/organizations/${w.orgId}/knowledge`, w.viewer.token);
  const habit = k.habits.find((h: { ruleId: string }) => h.ruleId === rule!.vendorCodingRuleId);
  assert.deepEqual([habit.taughtBy, habit.fromBills, habit.acknowledged, k.canManage], [['Clara Clerk'], 3, false, false]);
  assert.equal((await raw('POST', `/organizations/${w.orgId}/knowledge/${rule!.vendorCodingRuleId}/keep`, w.clerk.token, {})).status, 403);
  await post(`/organizations/${w.orgId}/knowledge/${rule!.vendorCodingRuleId}/keep`, {}, w.owner.token);
  assert.equal((await habitItems(w, w.owner.token)).some((i) => i.habit!.ruleId === rule!.vendorCodingRuleId), false, 'kept: no longer news');

  // Growing more certain is not news; changing is.
  await teach(w, w.clerk, 'Brightwave Media', 'BW-4', 'Advertising & marketing');
  assert.equal((await habitItems(w, w.owner.token)).some((i) => i.habit!.ruleId === rule!.vendorCodingRuleId), false, 'same habit, more certain');
  for (const n of [5, 6, 7]) await teach(w, w.owner, 'Brightwave Media', `BW-${n}`, 'Contractors');
  const changed = await ruleFor(w.orgId, 'Brightwave Media');
  assert.equal(changed!.accountName, 'Contractors');
  assert.deepEqual(changed!.taughtBy, [w.owner.userId]);
  const again = (await habitItems(w, w.owner.token)).find((i) => i.habit!.ruleId === changed!.vendorCodingRuleId);
  assert.match(again!.lines[0]!.text, /goes to Contractors, from 3 bills Owner Halcyon coded that way/, 'a changed habit is announced again');
});

test('learning: forgetting stops a habit at once, un-prefills drafts nobody saved, and is not relearned from old history', async () => {
  const w = await makeWorld();
  for (const n of [1, 2, 3]) await teach(w, w.clerk, 'Brightwave Media', `BW-${n}`, 'Advertising & marketing');
  const draft = await upload(w.orgId, w.owner.token, w.orgName, { vendor: 'Brightwave Media', amount: 400, invoiceNo: 'BW-9' });
  await drainAsyncIntake();
  const before = await get(`/organizations/${w.orgId}/bills/${draft}/draft`, w.owner.token);
  assert.equal(before.codingSuggestionSource?.kind, 'rule', 'a new draft is pre-filled from the habit');
  assert.equal(before.lines[0].category, 'Advertising & marketing');

  const { counterpartyId } = (await ruleFor(w.orgId, 'Brightwave Media'))!;
  assert.equal((await raw('DELETE', `/organizations/${w.orgId}/counterparties/${counterpartyId}/coding-rule`, w.clerk.token)).status, 403, 'a clerk cannot forget it');
  await raw('DELETE', `/organizations/${w.orgId}/counterparties/${counterpartyId}/coding-rule`, w.owner.token);
  assert.equal(await ruleFor(w.orgId, 'Brightwave Media'), null, 'forgotten at once');
  const after = await get(`/organizations/${w.orgId}/bills/${draft}/draft`, w.owner.token);
  assert.notEqual(after.codingSuggestionSource?.kind, 'rule', 'the draft nobody saved is no longer pre-filled from it');
  const k = await get(`/organizations/${w.orgId}/knowledge`, w.owner.token);
  assert.deepEqual(k.forgotten.map((f: { vendorName: string; category: string; by: string }) => [f.vendorName, f.category, f.by]), [['Brightwave Media', 'Advertising & marketing', w.owner.name.trim()]]);
  const confirmedEarlier = await prisma.paymentOrderGlCoding.count({ where: { organizationId: w.orgId, codedExpenseAccountName: 'Advertising & marketing' } });
  assert.equal(confirmedEarlier, 3, 'confirmed bills keep what was confirmed');

  // One more bill the same way: not enough to relearn — the old three do not count.
  await teach(w, w.clerk, 'Brightwave Media', 'BW-4', 'Advertising & marketing');
  assert.equal(await ruleFor(w.orgId, 'Brightwave Media'), null, 'not relearned from the history it was told to forget');
  for (const n of [5, 6]) await teach(w, w.clerk, 'Brightwave Media', `BW-${n}`, 'Advertising & marketing');
  const relearned = await ruleFor(w.orgId, 'Brightwave Media');
  assert.ok(relearned, 'three bills confirmed since the forget teach it again');
  assert.equal(relearned!.learnedFromCount, 3);
  assert.equal(relearned!.acknowledgedAt, null, 'and it is announced again');
  assert.equal(await prisma.forgottenHabit.count({ where: { organizationId: w.orgId } }), 0);
});

test('learning: a habit a person sets needs no announcement, and lifts a forget', async () => {
  const w = await makeWorld();
  for (const n of [1, 2, 3]) await teach(w, w.clerk, 'Brightwave Media', `BW-${n}`, 'Advertising & marketing');
  const { counterpartyId } = (await ruleFor(w.orgId, 'Brightwave Media'))!;
  await raw('DELETE', `/organizations/${w.orgId}/counterparties/${counterpartyId}/coding-rule`, w.owner.token);
  const set = await raw('PUT', `/organizations/${w.orgId}/counterparties/${counterpartyId}/coding-rule`, w.owner.token, { accountId: 'builtin:travel', accountName: 'Travel' });
  assert.ok(set.status < 400, set.text);
  const rule = await ruleFor(w.orgId, 'Brightwave Media');
  assert.equal(rule!.source, 'manual');
  assert.ok(rule!.acknowledgedAt, 'set by a person: nothing to announce');
  assert.equal((await habitItems(w, w.owner.token)).some((i) => i.habit!.ruleId === rule!.vendorCodingRuleId), false);
  assert.equal(await prisma.forgottenHabit.count({ where: { organizationId: w.orgId } }), 0, 'the forget is lifted');
  const k = await get(`/organizations/${w.orgId}/knowledge`, w.clerk.token);
  assert.equal(k.habits.find((h: { ruleId: string }) => h.ruleId === rule!.vendorCodingRuleId).setBy, w.owner.name.trim());
});

test('learning: the companion can propose remembering or forgetting a habit — for admins, through the vendor routes', async () => {
  const w = await makeWorld();
  const proposals = [
    { kind: 'save_habit', billId: w.bills.lonely, reason: 'Lonely Ltd is always travel.', toPerson: null, message: null, category: 'travel' },
    { kind: 'save_habit', billId: w.bills.held, reason: 'Made up.', toPerson: null, message: null, category: 'Not A Real Category' },
    { kind: 'save_habit', billId: w.bills.ready, reason: 'Already so.', toPerson: null, message: null, category: 'Cloud hosting & infrastructure' },
    { kind: 'forget_habit', billId: w.bills.ready, reason: 'Steady changed what they sell.', toPerson: null, message: null, category: null },
    { kind: 'forget_habit', billId: w.bills.lonely, reason: 'No habit to forget.', toPerson: null, message: null, category: null },
  ];
  hostile({ turns: [[{ name: 'find_bills', args: {} }]], respond: () => ({ ...EMPTY, actions: proposals }) });
  const clerkTurn = await ask(w.orgId, w.clerk.token, 'Tidy up the habits.');
  assert.deepEqual(clerkTurn.answer.actions, [], 'habits are an admin\'s to change');

  hostile({ turns: [[{ name: 'find_bills', args: {} }]], respond: () => ({ ...EMPTY, actions: proposals }) });
  const { answer } = await ask(w.orgId, w.owner.token, 'Tidy up the habits.');
  const cards = answer.actions as Array<{ kind: string; title: string; call: { method: string; path: string; body: any } }>;
  assert.deepEqual(cards.map((c) => c.kind), ['save_habit', 'forget_habit'], 'only a real new category, and a habit that exists');
  const [save, forget] = cards;
  const lonelyVendor = (await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: w.bills.lonely }, select: { counterpartyId: true } })).counterpartyId;
  assert.deepEqual(save!.call, { method: 'PUT', path: `/counterparties/${lonelyVendor}/coding-rule`, body: { accountId: 'builtin:travel', accountName: 'Travel' } });
  assert.equal(save!.title, 'Remember: Lonely Ltd goes to Travel');
  assert.equal(forget!.call.method, 'DELETE');
  assert.equal(forget!.title, 'Forget: Steady Supply goes to Cloud hosting & infrastructure');

  // Clicked, as the admin.
  assert.ok((await raw(save!.call.method, `/organizations/${w.orgId}${save!.call.path}`, w.owner.token, save!.call.body)).status < 400);
  assert.equal((await ruleFor(w.orgId, 'Lonely Ltd'))?.accountName, 'Travel');
  assert.ok((await raw(forget!.call.method, `/organizations/${w.orgId}${forget!.call.path}`, w.owner.token, {})).status < 400);
  assert.equal(await ruleFor(w.orgId, 'Steady Supply'), null);
});
