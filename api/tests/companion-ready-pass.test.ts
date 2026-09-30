// The quick pass through ready bills: only ready drafts, only for whoever
// sends bills on, and each one re-checked when it is sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { raw, get, post, makeWorld } from './helpers/companion-harness.js';

const readyOf = async (orgId: string, token: string) =>
  ((await get(`/organizations/${orgId}/companion/ready`, token)).bills as Array<{ billId: string; vendorName: string }>);

test('quick pass: lists the ready drafts for a clerk, and nothing for an approver or a viewer', async () => {
  const w = await makeWorld();
  const clerk = await readyOf(w.orgId, w.clerk.token);
  assert.deepEqual(clerk.map((b) => b.billId).sort(), [w.bills.steady1, w.bills.ready].sort(), 'only the bills the companion rates ready: the two Steady Supply drafts');
  assert.ok(clerk.every((b) => b.vendorName === 'Steady Supply'));
  assert.deepEqual(await readyOf(w.orgId, w.apprA.token), [], 'an approver does not send bills on');
  assert.deepEqual(await readyOf(w.orgId, w.viewer.token), []);
});

test('quick pass: sending one takes it off the list; a bill that stopped being ready is refused at the click', async () => {
  const w = await makeWorld();
  // A second ready bill from the same vendor, due sooner, comes first.
  await prisma.paymentOrder.update({ where: { paymentOrderId: w.bills.steady1 }, data: { dueAt: new Date('2026-08-01') } });
  await prisma.paymentOrder.update({ where: { paymentOrderId: w.bills.ready }, data: { dueAt: new Date('2026-09-01') } });
  const order = (await readyOf(w.orgId, w.clerk.token)).map((b) => b.billId);
  assert.deepEqual(order, [w.bills.steady1, w.bills.ready], 'soonest due first');

  await post(`/organizations/${w.orgId}/bills/${order[0]}/confirm-as-read`, {}, w.clerk.token);
  assert.deepEqual((await readyOf(w.orgId, w.clerk.token)).map((b) => b.billId), [w.bills.ready], 'sent: gone from the pass');
  assert.notEqual((await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: order[0]! } })).state, 'draft');

  // Someone asks a question on the next one between the list and the click.
  await post(`/organizations/${w.orgId}/bills/${w.bills.ready}/ask`, { askedOfUserId: w.owner.userId, question: 'Is this the right amount?' }, w.clerk.token);
  assert.deepEqual(await readyOf(w.orgId, w.clerk.token), [], 'a bill with an open question is not ready');
  const refused = await raw('POST', `/organizations/${w.orgId}/bills/${w.bills.ready}/confirm-as-read`, w.clerk.token, {});
  assert.ok(refused.status >= 400, 'the server re-checks at the click, not the list');
  assert.equal((await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: w.bills.ready } })).state, 'draft');
});
