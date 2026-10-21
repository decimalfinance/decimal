// The inbox: one item per bill, every line derived from state, nothing ever
// shown twice. Every ask is a question on the bill; there are no nudges.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';
import { setAskClassifierForTests, classifyAskByRule } from '../src/companion/ask-classifier.js';
import { setAnswerJudgeForTests } from '../src/payments/answer-judge.js';
import { failedFileLine } from '../src/companion/inbox.js';
import { READ_FAILED_ON_OUR_SIDE } from '../src/payments/documents.js';
import {
  raw, post, get, makeWorld, fingerprint, assertUnchanged, hostile, ask, EMPTY,
} from './helpers/companion-harness.js';

type Line = { kind: string; text: string; lead: string; quote: string | null; who: { name: string; avatarUrl: string | null } | null; isNew: boolean; from?: string | null; questionId?: string };
type Item = { key: string; billId: string | null; lines: Line[]; isNew: boolean };
const inboxOf = async (orgId: string, token: string) => (await get(`/organizations/${orgId}/inbox`, token)) as { items: Item[]; count: number; newCount: number };
const itemFor = (inbox: { items: Item[] }, billId: string) => inbox.items.find((i) => i.billId === billId);

test('inbox: each person sees their own work, one item per bill', async () => {
  setAskClassifierForTests(null);
  const w = await makeWorld();
  const clerk = await inboxOf(w.orgId, w.clerk.token);
  // The clerk was asked about Lonely Ltd AND reviews it: one item, two lines.
  const lonely = itemFor(clerk, w.bills.lonely)!;
  assert.deepEqual(lonely.lines.map((l) => l.kind), ['question', 'review'], 'the question first: somebody is waiting on the answer');
  assert.match(lonely.lines[0]!.text, /asked: “Which category is this\?”/);
  assert.equal(clerk.items.filter((i) => i.billId === w.bills.lonely).length, 1, 'never the same bill twice');
  assert.equal(itemFor(clerk, w.bills.ready)!.lines[0]!.kind, 'sign_off');
  assert.equal(itemFor(clerk, w.bills.submitted), undefined, 'not the clerk\'s approval');
  assert.equal(new Set(clerk.items.map((i) => i.key)).size, clerk.items.length, 'keys are unique');

  const approver = await inboxOf(w.orgId, w.apprA.token);
  assert.deepEqual(approver.items.map((i) => i.billId), [w.bills.submitted], 'an approver sees only what waits on them');
  assert.equal(approver.items[0]!.lines[0]!.kind, 'approval');

  assert.deepEqual((await inboxOf(w.orgId, w.apprB.token)).items, [], 'nothing waits on the other approver');
  assert.deepEqual((await inboxOf(w.orgId, w.viewer.token)).items, [], 'a viewer has nothing to do');
  const owner = await inboxOf(w.orgId, w.owner.token);
  assert.equal(itemFor(owner, w.bills.lonely)!.lines.some((l) => l.kind === 'question'), false, 'the owner asked that question; it is not theirs to answer');
});

test('inbox: a question is a line on the existing item, and makes it new until seen', async () => {
  const w = await makeWorld();
  await post(`/organizations/${w.orgId}/inbox/seen`, { billId: w.bills.submitted }, w.apprA.token);
  let box = await inboxOf(w.orgId, w.apprA.token);
  assert.equal(itemFor(box, w.bills.submitted)!.isNew, false, 'seen');

  await new Promise((r) => setTimeout(r, 5));
  await post(`/organizations/${w.orgId}/bills/${w.bills.submitted}/ask`, { askedOfUserId: w.apprA.userId, question: 'While you are in there, can you check the tax line?' }, w.owner.token);
  box = await inboxOf(w.orgId, w.apprA.token);
  const item = itemFor(box, w.bills.submitted)!;
  assert.deepEqual(item.lines.map((l) => l.kind), ['question', 'approval'], 'layered onto the approval, not a second item');
  assert.equal(item.lines[0]!.from, w.owner.name.trim());
  assert.equal(item.isNew, true, 'something new in it');
  assert.equal(box.newCount, 1);
});


test('inbox: each line says who it comes from, with their own words apart, and is counted as a line', async () => {
  const w = await makeWorld();
  const owner = w.owner.name.trim();
  const adam = itemFor(await inboxOf(w.orgId, w.apprA.token), w.bills.submitted)!;
  const approval = adam.lines.find((l) => l.kind === 'approval')!;
  assert.equal(approval.lead, `${owner} sent it for your approval`, 'the first step: whoever sent it');
  assert.equal(approval.who?.name, owner);
  assert.equal(approval.quote, null);

  const clerk = await inboxOf(w.orgId, w.clerk.token);
  const lonely = itemFor(clerk, w.bills.lonely)!;
  const question = lonely.lines.find((l) => l.kind === 'question')!;
  assert.equal(question.lead, `${owner} asked`);
  assert.equal(question.quote, 'Which category is this?');
  assert.equal(question.text, `${owner} asked: “Which category is this?”`);
  assert.equal(question.who?.name, owner);
  assert.equal(lonely.lines.find((l) => l.kind === 'review')!.who, null, 'what Decimal raises comes from nobody');
  assert.equal(itemFor(clerk, w.bills.ready)!.lines[0]!.lead, 'Checked and ready to send for approval');
  assert.equal(clerk.count, clerk.items.reduce((n, i) => n + i.lines.length, 0), 'one bill can want two things, and both count');
});

test('inbox: a bill sent back says who sent it back and why, to whoever reviews bills', async () => {
  const w = await makeWorld();
  const detail = await get(`/organizations/${w.orgId}/bills/${w.bills.submitted}/detail`, w.apprA.token);
  await post(`/organizations/${w.orgId}/approvals/tasks/${detail.viewer.openTaskId}/command`, {
    command: { kind: 'reject', reason: 'The PO number is for the March order.' }, idempotencyKey: crypto.randomUUID(),
  }, w.apprA.token);
  const back = itemFor(await inboxOf(w.orgId, w.clerk.token), w.bills.submitted)!.lines.find((l) => l.kind === 'sent_back')!;
  assert.equal(back.lead, 'Adam Approver sent it back');
  assert.equal(back.quote, 'The PO number is for the March order.');
  assert.equal(back.who?.name, 'Adam Approver');
  assert.equal(itemFor(await inboxOf(w.orgId, w.apprA.token), w.bills.submitted), undefined, 'it has left the approver\'s');
});

test('inbox: a reply waits for its asker until they open the bill after it; there is nothing to tick', async () => {
  const w = await makeWorld();
  setAnswerJudgeForTests(async (input) => input.questions.map((q) => ({ billQuestionId: q.billQuestionId, verdict: 'answers' as const })));
  try {
    await post(`/organizations/${w.orgId}/bills/${w.bills.lonely}/messages`, { body: 'Office supplies, like the last one.' }, w.clerk.token);
  } finally {
    setAnswerJudgeForTests(null);
  }
  const reply = itemFor(await inboxOf(w.orgId, w.owner.token), w.bills.lonely)!.lines.find((l) => l.kind === 'reply')!;
  assert.equal(reply.lead, 'Clara Clerk answered');
  assert.equal(reply.quote, 'Office supplies, like the last one.');
  assert.equal(reply.isNew, true);
  assert.ok(itemFor(await inboxOf(w.orgId, w.owner.token), w.bills.lonely)!.lines.some((l) => l.kind === 'reply'), 'reading the Inbox is not reading the answer');

  await new Promise((r) => setTimeout(r, 5));
  await post(`/organizations/${w.orgId}/inbox/seen`, { billId: w.bills.lonely }, w.owner.token);
  const after = itemFor(await inboxOf(w.orgId, w.owner.token), w.bills.lonely);
  assert.equal(after?.lines.some((l) => l.kind === 'reply') ?? false, false, 'opening the bill shows the answer in its thread: that is reading it');
});

test('inbox: a file no bill came out of says whose fault it was, never the raw error', () => {
  assert.equal(failedFileLine(READ_FAILED_ON_OUR_SIDE), 'Something went wrong while reading it', 'ours: the file is fine');
  assert.equal(failedFileLine(null), 'Something went wrong while reading it');
  assert.equal(failedFileLine('No bill could be made from this document. Acme: the amount is missing'), 'No bill came out of it');
  assert.equal(failedFileLine('This file is password protected. Remove the password and upload it again.'), 'This file is password protected', 'anything else written for a reader: its first sentence');
});

test('inbox: there are no nudges, and nobody reads another team\'s inbox', async () => {
  const w = await makeWorld();
  const other = await makeWorld('Other Org Ltd');
  // Nudges were removed on 2026-10-14: every ask is a question on the bill.
  assert.equal((await raw('POST', `/organizations/${w.orgId}/inbox/nudge`, w.owner.token, { billId: w.bills.ready, toUserId: w.clerk.userId, text: 'Look at this.' })).status, 404);
  assert.equal((await raw('POST', `/organizations/${w.orgId}/inbox/asks/${crypto.randomUUID()}/done`, w.clerk.token, {})).status, 404);
  // Nobody else's inbox, and not from outside.
  assert.ok([400, 403, 404].includes((await raw('GET', `/organizations/${w.orgId}/inbox`, other.owner.token)).status));
  assert.ok([400, 404].includes((await raw('POST', `/organizations/${w.orgId}/inbox/seen`, w.clerk.token, { billId: other.bills.ready })).status));
});

test('inbox: the rule that decides how an ask lands, when there is no model', () => {
  const base = { recipientName: 'Adam', billLabel: 'Submit Co SC-1' };
  assert.equal(classifyAskByRule({ ...base, existing: ['Your approval'], message: 'Please approve this.' }).decision, 'covered');
  assert.equal(classifyAskByRule({ ...base, existing: ['Your approval'], message: 'Approve it but check the tax line first.' }).decision, 'new');
  assert.equal(classifyAskByRule({ ...base, existing: ['Owner asked: "Check the tax line."'], message: 'Check the tax line.' }).decision, 'covered');
  assert.equal(classifyAskByRule({ ...base, existing: [], message: 'Which PO is this for?' }).decision, 'new');
  assert.equal(classifyAskByRule({ ...base, existing: [], message: 'Please look at the second page.' }).decision, 'new');
});

test('inbox: a companion ask becomes a question or "already has it" — and only a click sends it', async () => {
  const w = await makeWorld();
  const decisions: Array<{ message: string; existing: string[] }> = [];
  setAskClassifierForTests(async (input) => {
    decisions.push({ message: input.message, existing: input.existing });
    if (/approve/i.test(input.message) && !/tax/i.test(input.message)) return { decision: 'covered', note: 'Adam already has this: his approval is waiting.' };
    return { decision: 'new', note: 'Goes to Adam as a question on the bill.' };
  });
  const propose = (actions: unknown[]) => hostile({ turns: [[{ name: 'find_bills', args: {} }, { name: 'team', args: {} }]], respond: () => ({ ...EMPTY, actions }) });
  const a = (toPerson: string | null, message: string | null, billId = w.bills.submitted) => ({ kind: 'ask_person', billId, reason: 'chasing', toPerson, message });
  propose([
    a('Adam Approver', 'Please approve this today.'),
    a('Adam', 'While you are approving, check the tax line.'),
    a('adam approver', 'Which PO is this for?'),
    a('Nobody Real', 'Hello there.'),
    a('Approver', 'Ambiguous: two approvers.'),
    a(w.owner.name, 'To myself.'),
    a('Adam Approver', null),
    a('Adam Approver', 'x'),
  ]);
  const before = await fingerprint();
  const { chatId, answer } = await ask(w.orgId, w.owner.token, 'Chase Adam on SC-1.');
  await assertUnchanged(before, 'Proposing asks');
  const cards = answer.actions as Array<{ actionId: string; kind: string; status: string; title: string; call: { path: string; body: any } }>;
  // Only the first proposal to each person counts; later ones for the same person and bill are dropped.
  assert.deepEqual(cards.map((c) => c.kind), ['already_asked'], 'one card per person per bill; the first said he already has it');
  assert.equal(cards[0]!.status, 'info');
  assert.equal(cards[0]!.call.path, '', 'nothing to send');
  assert.match(cards[0]!.title, /Adam Approver already has this/);
  assert.equal(decisions[0]!.existing.length, 1);
  assert.match(decisions[0]!.existing[0]!, /sent it for your approval$/, 'it looked at what Adam\'s item already asks');
  const info = await post(`/organizations/${w.orgId}/companion/chats/${chatId}/actions/${cards[0]!.actionId}/outcome`, { ok: true }, w.owner.token);
  assert.equal(info.status, 'info', 'an info card cannot be "done"');

  // A question, clicked. Nothing is sent before the click.
  propose([a('Adam', 'While you are approving, can you check the tax line?')]);
  const qTurn = await ask(w.orgId, w.owner.token, 'Ask Adam to check the tax line.');
  const q = qTurn.answer.actions[0];
  assert.equal(q.kind, 'question');
  assert.equal(q.call.path, `/bills/${w.bills.submitted}/ask`);
  assert.deepEqual(q.call.body, { askedOfUserId: w.apprA.userId, question: 'While you are approving, can you check the tax line?' });
  assert.equal(itemFor(await inboxOf(w.orgId, w.apprA.token), w.bills.submitted)!.lines.length, 1, 'nothing sent before the click');
  await post(`/organizations/${w.orgId}${q.call.path}`, q.call.body, w.owner.token);
  const adam = itemFor(await inboxOf(w.orgId, w.apprA.token), w.bills.submitted)!;
  assert.deepEqual(adam.lines.map((l) => l.kind), ['question', 'approval'], 'still one item: the question leads');

  // Somebody who only views bills cannot be asked: the card says so and
  // sends nothing.
  propose([a(w.viewer.name, 'Can you look at the tax line?')]);
  const vTurn = await ask(w.orgId, w.owner.token, 'Ask Victor about it.');
  assert.deepEqual(vTurn.answer.actions.map((c: { kind: string; status: string; call: { path: string } }) => [c.kind, c.status, c.call.path]), [['cannot_ask', 'info', '']], 'nothing to send to a viewer');
  assert.match(vTurn.answer.actions[0].detail, /Victor only views bills/);
  assert.equal(itemFor(await inboxOf(w.orgId, w.viewer.token), w.bills.submitted), undefined, 'nothing reached the viewer');
  setAskClassifierForTests(null);
});

test('inbox: a hostile model cannot aim an ask at the wrong person, bill or organisation', async () => {
  const w = await makeWorld();
  const other = await makeWorld('Other Org Ltd');
  setAskClassifierForTests(async () => ({ decision: 'new', note: 'ok' }));
  hostile({
    turns: [[{ name: 'find_bills', args: {} }]],
    respond: () => ({ ...EMPTY, actions: [
      { kind: 'ask_person', billId: w.bills.ready, reason: 'r', toPerson: other.clerk.name + ' of Other Org', message: 'hi there' },
      { kind: 'ask_person', billId: other.bills.ready, reason: 'r', toPerson: 'Clara Clerk', message: 'foreign bill' },
      { kind: 'ask_person', billId: w.bills.ready, reason: 'r', toPerson: other.clerk.userId, message: 'by id' },
      { kind: 'ask_person', billId: w.bills.ready, reason: 'r', toPerson: 'Clara Clerk', message: 'y'.repeat(5000), call: { path: '/evil' } },
    ] }),
  });
  const { answer } = await ask(w.orgId, w.owner.token, 'Ask people things.');
  const cards = answer.actions as Array<{ kind: string; call: { path: string; body: any } }>;
  assert.equal(cards.length, 1, 'only the ask to a real teammate about a real bill here');
  assert.equal(cards[0]!.call.path, `/bills/${w.bills.ready}/ask`);
  assert.equal(cards[0]!.call.body.askedOfUserId, w.clerk.userId);
  assert.ok(cards[0]!.call.body.question.length <= 500, 'the message is clamped');
  setAskClassifierForTests(null);
});

test('inbox: mark all as read clears every "new", and each item says where its bill stands', async () => {
  const w = await makeWorld();
  const box = await inboxOf(w.orgId, w.clerk.token);
  assert.ok(box.newCount > 1, 'a fresh inbox is all new');
  const lonely = itemFor(box, w.bills.lonely) as unknown as { status: string | null; dueAt: string | null };
  assert.equal(typeof lonely.status, 'string');
  assert.ok(lonely.dueAt, 'with its due date');
  const r = await post(`/organizations/${w.orgId}/inbox/seen-all`, {}, w.clerk.token);
  assert.equal(r.marked, box.items.filter((i) => i.billId).length);
  assert.equal((await inboxOf(w.orgId, w.clerk.token)).newCount, 0);
  assert.ok((await inboxOf(w.orgId, w.owner.token)).newCount > 0, 'only the clerk\'s, not everyone\'s');
});

test('inbox: a bill with no invoice number (a statement) does not break the inbox or its bill note', async () => {
  const w = await makeWorld();
  await prisma.paymentOrder.update({ where: { paymentOrderId: w.bills.lonely }, data: { invoiceNumber: null } });
  const box = await inboxOf(w.orgId, w.clerk.token);
  const item = box.items.find((i) => i.billId === w.bills.lonely)!;
  assert.equal(item.invoiceNumber, null);
  assert.equal(item.vendorName, 'Lonely Ltd');
  assert.ok((await get(`/organizations/${w.orgId}/bills/${w.bills.lonely}/companion`, w.clerk.token)).did);
});
