// The setup harness's saved state and limits. The model is scripted, so these
// are about what the harness does around it: who gets a turn, what survives, what
// goes on the receipt, and where it stops.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { drainBackgroundWork } from '../src/infra/background.js';
import { setExceptionAgentRuntimeForTests, type ModelCall } from '../src/exceptions/agent.js';
import { SETUP_TOKEN_LIMIT, SETUP_TURN_LIMIT, sweepSetups, wake, withReceipt } from '../src/integrations/setup/harness.js';
import { raw, post, get, register } from './helpers/companion-harness.js';

type Seen = { system: string; messages: Array<{ role: string; content?: string | null }>; tools: string[]; maxTokens: number };

const says = (message: string) => ({
  role: 'assistant' as const,
  content: null,
  tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'respond', arguments: JSON.stringify({ message }) } }],
});

/** The model says whatever `reply` returns and records what it was shown. */
function scriptModel(reply: (seen: Seen, call: number) => Promise<string> | string, usage = { promptTokens: 100, completionTokens: 10 }) {
  const calls: Seen[] = [];
  const callModel: ModelCall = async ({ messages, tools, maxTokens }) => {
    const seen: Seen = {
      system: String(messages[0]?.content ?? ''),
      messages: messages.slice(1).map((m) => ({ role: m.role, content: m.content })),
      tools: tools.map((t) => t.name),
      maxTokens,
    };
    calls.push(seen);
    return { message: says(await reply(seen, calls.length)), usage };
  };
  setExceptionAgentRuntimeForTests({ callModel, isConfigured: () => true });
  return calls;
}

let orgs = 0;
async function makeOrg() {
  const owner = await register('Olive Owner');
  orgs += 1;
  const org = await post('/organizations', { organizationName: `Larkspur Freight ${orgs}` }, owner.token);
  return { owner, orgId: org.organizationId as string };
}

const setupsPath = (orgId: string) => `/organizations/${orgId}/integrations/quickbooks/setups`;
const setupPath = (orgId: string, setupId: string) => `/organizations/${orgId}/integrations/setups/${setupId}`;

async function start(world: { orgId: string; owner: { token: string } }) {
  const view = await post(setupsPath(world.orgId), {}, world.owner.token);
  await drainBackgroundWork();
  return view.setupId as string;
}

const say = (world: { orgId: string; owner: { token: string } }, setupId: string, text: string) =>
  post(`${setupPath(world.orgId, setupId)}/messages`, { text }, world.owner.token);

const view = (world: { orgId: string; owner: { token: string } }, setupId: string) => get(setupPath(world.orgId, setupId), world.owner.token);

const receipt = (world: { orgId: string; owner: { token: string } }, setupId: string) => get(`${setupPath(world.orgId, setupId)}/receipt`, world.owner.token);

beforeEach(() => setExceptionAgentRuntimeForTests(null));

test('setup: starting one gets the agent talking; starting again comes back to the same one', async () => {
  const world = await makeOrg();
  const calls = scriptModel(() => 'Hello. Let me explain what happens next.');
  const setupId = await start(world);

  const first = await view(world, setupId);
  assert.equal(first.status, 'open');
  assert.equal(first.running, false);
  assert.deepEqual(first.messages.map((m: { role: string; text: string }) => [m.role, m.text]), [['assistant', 'Hello. Let me explain what happens next.']]);
  assert.match(calls[0]!.messages.at(-1)!.content!, /^\[Decimal: .* Nobody typed this\.\]$/, 'nobody typed it, and the model is told so');

  const again = await post(setupsPath(world.orgId), {}, world.owner.token);
  assert.equal(again.setupId, setupId);
  await drainBackgroundWork();
  assert.equal(calls.length, 1, 'no second greeting');
});

test('setup: it is for admins, in their own organisation, and only for systems it knows', async () => {
  const world = await makeOrg();
  scriptModel(() => 'Hello.');
  const setupId = await start(world);

  const member = await register('Mina Member');
  await prisma.organizationMembership.create({ data: { organizationId: world.orgId, userId: member.userId, role: 'member', status: 'active' } });
  assert.equal((await raw('POST', setupsPath(world.orgId), member.token, {})).status, 403);
  assert.equal((await raw('GET', setupPath(world.orgId, setupId), member.token)).status, 403);
  assert.equal((await raw('POST', `${setupPath(world.orgId, setupId)}/messages`, member.token, { text: 'Hi' })).status, 403);
  assert.equal((await raw('GET', `${setupPath(world.orgId, setupId)}/receipt`, member.token)).status, 403);

  const other = await makeOrg();
  assert.equal((await raw('GET', setupPath(other.orgId, setupId), other.owner.token)).status, 404, 'another organisation\'s setup does not exist for them');
  assert.equal((await raw('POST', `${setupPath(other.orgId, setupId)}/messages`, other.owner.token, { text: 'Hi' })).status, 404);

  assert.equal((await raw('POST', `/organizations/${world.orgId}/integrations/freshbooks/setups`, world.owner.token, {})).status, 400);
  assert.equal((await raw('POST', `${setupPath(world.orgId, setupId)}/messages`, world.owner.token, { text: '   ' })).status, 400, 'an empty message');
});

test('setup: each turn is rebuilt from the record: the conversation so far, and the words it runs on', async () => {
  const world = await makeOrg();
  const calls = scriptModel((_seen, n) => `Answer ${n}`);
  const setupId = await start(world);
  await say(world, setupId, 'Which company will this connect?');
  await drainBackgroundWork();
  await say(world, setupId, 'Larkspur, please');
  await drainBackgroundWork();

  const last = calls.at(-1)!;
  assert.deepEqual(last.messages.map((m) => [m.role, m.content]), [
    ['assistant', 'Answer 1'],
    ['user', 'Which company will this connect?'],
    ['assistant', 'Answer 2'],
    ['user', 'Larkspur, please'],
  ]);
  assert.match(last.system, /setting up QuickBooks Online/);
  assert.equal(last.tools.at(-1), 'respond');
  assert.equal(last.maxTokens, 4000, 'more than the one line an investigation needs');
  assert.deepEqual((await view(world, setupId)).messages.map((m: { text: string }) => m.text),
    ['Answer 1', 'Which company will this connect?', 'Answer 2', 'Larkspur, please', 'Answer 3']);
});

test('setup: two wake-ups at once take one turn', async () => {
  const world = await makeOrg();
  const calls = scriptModel(() => 'Hello.');
  const setupId = await start(world);
  const before = calls.length;
  await prisma.integrationSetupEvent.create({ data: { setupId, kind: 'signed_in', wakes: true } });
  wake(setupId);
  wake(setupId);
  wake(setupId);
  await drainBackgroundWork();
  assert.equal(calls.length, before + 1);
  assert.equal((await view(world, setupId)).messages.length, 2, 'one answer');
});

test('setup: a message sent during a turn waits for it, then gets its own', async () => {
  const world = await makeOrg();
  let letGo: () => void = () => {};
  const held = new Promise<void>((resolve) => { letGo = resolve; });
  const calls = scriptModel(async (_seen, n) => {
    if (n === 2) await held;
    return `Answer ${n}`;
  });
  const setupId = await start(world);
  await say(world, setupId, 'First thing');
  while (calls.length < 2) await new Promise((resolve) => { setTimeout(resolve, 5); });

  const during = await say(world, setupId, 'Wait, wrong company');
  assert.equal(during.running, true, 'the first answer is still being worked on');
  letGo();
  await drainBackgroundWork();

  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.messages.at(-1)!.content, 'Wait, wrong company');
  const texts = (await view(world, setupId)).messages.map((m: { text: string }) => m.text);
  assert.equal(texts.at(-1), 'Answer 3');
  assert.ok(texts.includes('Answer 2'));
});

test('setup: a turn cut off by a restart runs again, and leaves one answer', async () => {
  const world = await makeOrg();
  const calls = scriptModel((_seen, n) => `Answer ${n}`);
  const setupId = await start(world);

  // A process died mid-turn: the person's message is on the log, an answer is half
  // written, and the lease is still running.
  const message = await prisma.integrationSetupMessage.create({ data: { setupId, role: 'user', text: 'Are you there?' } });
  await prisma.integrationSetupEvent.create({ data: { setupId, kind: 'message', wakes: true, payload: { messageId: message.messageId } } });
  await prisma.integrationSetupMessage.create({ data: { setupId, role: 'assistant', status: 'running', thoughts: [{ text: 'Half way', at: 'then' }] } });
  await prisma.integrationSetup.update({ where: { setupId }, data: { turnLeaseUntil: new Date(Date.now() + 60_000) } });

  assert.equal(await sweepSetups(), 0, 'a lease still running means someone may be on it');
  await drainBackgroundWork();
  assert.equal(calls.length, 1);

  await prisma.integrationSetup.update({ where: { setupId }, data: { turnLeaseUntil: new Date(Date.now() - 1_000) } });
  assert.equal(await sweepSetups(), 1);
  await drainBackgroundWork();

  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.messages.at(-1)!.content, 'Are you there?');
  const after = await view(world, setupId);
  assert.equal(after.running, false);
  assert.deepEqual(after.messages.map((m: { text: string }) => m.text), ['Answer 1', 'Are you there?', 'Answer 2'], 'the half-written answer became this one');
  assert.deepEqual(after.messages.at(-1).thoughts, [], 'its old steps went with it');
  assert.equal(await sweepSetups(), 0, 'nothing owed now');
});

test('setup: the receipt says which words, which model and what each turn cost, and adds up', async () => {
  const world = await makeOrg();
  scriptModel((_seen, n) => `Answer ${n}`, { promptTokens: 1000, completionTokens: 50 });
  const setupId = await start(world);
  await say(world, setupId, 'Go on');
  await drainBackgroundWork();

  const { events, tokensUsed, turnsUsed } = await receipt(world, setupId);
  assert.deepEqual(events.map((e: { kind: string }) => e.kind), ['started', 'turn', 'message', 'turn']);
  assert.equal(events[0].actorUserId, world.owner.userId, 'who started it');
  assert.equal(events[2].actorUserId, world.owner.userId, 'who said it');
  const turn = events[3].payload;
  assert.equal(turn.ok, true);
  assert.equal(turn.finishedWith, 'respond');
  assert.ok(turn.model);
  assert.match(turn.playbook, /^[0-9a-f]{12}$/);
  assert.equal(turn.modelCalls, 1);
  assert.equal(turn.promptTokens, 1000);
  assert.equal(turnsUsed, 2);
  assert.equal(tokensUsed, 2100);
});

test('setup: a tool call goes on the receipt with what it asked and what it brought back, or how it failed', async () => {
  const world = await makeOrg();
  scriptModel(() => 'Hello.');
  const setupId = await start(world);
  const seen = new Set<string>(['old-record']);
  const [lookUp] = withReceipt(setupId, [{
    name: 'look_up',
    description: 'test',
    parameters: {},
    run: async (args) => {
      if (args.fail) throw new Error('QuickBooks answered 503.');
      seen.add('vendor-56');
      return { found: 1 };
    },
  }], seen);

  assert.deepEqual(await lookUp!.run!({ name: 'Delta' }), { found: 1 });
  await assert.rejects(lookUp!.run!({ fail: true }), /503/);

  const { events } = await receipt(world, setupId);
  const toolCalls = events.filter((e: { kind: string }) => e.kind === 'tool_call').map((e: { payload: Record<string, unknown> }) => e.payload);
  assert.equal(toolCalls[0].tool, 'look_up');
  assert.deepEqual(toolCalls[0].args, { name: 'Delta' });
  assert.equal(toolCalls[0].ok, true);
  assert.deepEqual(toolCalls[0].refs, ['vendor-56'], 'only what this call brought back');
  assert.equal(toolCalls[1].ok, false);
  assert.equal(toolCalls[1].error, 'QuickBooks answered 503.');
});

test('setup: the same call failing the same way stops being tried, and the model is told to take it to the person', async () => {
  const world = await makeOrg();
  scriptModel(() => 'Hello.');
  const setupId = await start(world);
  let tries = 0;
  const [tool] = withReceipt(setupId, [{ name: 'look_up', description: 'test', parameters: {}, run: async () => { tries += 1; throw new Error('No.'); } }], new Set());

  for (let i = 0; i < 3; i += 1) await assert.rejects(tool!.run!({ a: 1 }));
  const told = await tool!.run!({ a: 1 }) as { error: string };
  assert.match(told.error, /Stop trying it, and tell the person/);
  assert.equal(tries, 3);
  await assert.rejects(tool!.run!({ a: 2 }), 'a different question still gets asked');
  assert.equal(tries, 4);
});

test('setup: three turns in a row without an answer and it stops, says so, and a person asking again is the way back', async () => {
  const world = await makeOrg();
  const calls = scriptModel(() => 'Hello.');
  const setupId = await start(world);
  const before = calls.length;

  let failing = true;
  let attempts = 0;
  setExceptionAgentRuntimeForTests({
    callModel: async () => {
      if (failing) { attempts += 1; throw new Error('OpenAI 500'); }
      return { message: says('Back again.'), usage: { promptTokens: 1, completionTokens: 1 } };
    },
    isConfigured: () => true,
  });

  await say(world, setupId, 'Carry on');
  await drainBackgroundWork();
  assert.equal(attempts, 1, 'a model that is down gets some time, not three tries at once');
  const waiting = await view(world, setupId);
  assert.equal(waiting.status, 'open');
  assert.equal(waiting.running, true);
  assert.deepEqual(waiting.retrying, { failed: 1, of: 3, cause: 'service' }, 'someone waiting can see it is being tried again, and why');

  for (let tick = 0; tick < 4; tick += 1) {
    await sweepSetups();
    await drainBackgroundWork();
  }
  assert.equal(attempts, 3, 'it tried three times, not forever');
  assert.equal(calls.length, before);

  const stopped = await view(world, setupId);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stopReason, 'failures');
  assert.equal(stopped.running, false);
  assert.equal(stopped.retrying, null);
  const words = stopped.messages.at(-1);
  assert.equal(words.role, 'assistant');
  assert.match(words.text, /The AI service I run on isn't answering, so I've stopped rather than keep trying/);
  assert.match(words.text, /nothing has changed in your QuickBooks/);
  assert.deepEqual((await receipt(world, setupId)).events.filter((e: { kind: string }) => e.kind === 'stopped').map((e: { payload: unknown }) => e.payload), [{ reason: 'failures' }]);

  failing = false;
  await say(world, setupId, 'Try again');
  await drainBackgroundWork();
  const back = await view(world, setupId);
  assert.equal(back.status, 'open');
  assert.equal(back.stopReason, null);
  assert.equal(back.retrying, null);
  assert.equal(back.messages.at(-1).text, 'Back again.');
});

test('setup: a model that can\'t manage an answer is told apart from a service that isn\'t answering', async () => {
  const world = await makeOrg();
  scriptModel(() => 'Hello.');
  const setupId = await start(world);
  setExceptionAgentRuntimeForTests({
    // Prose, and never the tool that finishes a turn.
    callModel: async () => ({ message: { role: 'assistant' as const, content: 'Let me think about that.' }, usage: { promptTokens: 1, completionTokens: 1 } }),
    isConfigured: () => true,
  });

  await say(world, setupId, 'Carry on');
  await drainBackgroundWork();
  assert.deepEqual((await view(world, setupId)).retrying, { failed: 1, of: 3, cause: 'answer' });

  for (let tick = 0; tick < 4; tick += 1) {
    await sweepSetups();
    await drainBackgroundWork();
  }
  const stopped = await view(world, setupId);
  assert.equal(stopped.stopReason, 'failures');
  assert.match(stopped.messages.at(-1).text, /^I keep failing to work this out, so I've stopped rather than keep trying/);
});

test('setup: at the token limit it stops before asking the model, says so, and takes no more messages', async () => {
  const world = await makeOrg();
  const calls = scriptModel(() => 'Hello.');
  const setupId = await start(world);
  await prisma.integrationSetup.update({ where: { setupId }, data: { tokensUsed: SETUP_TOKEN_LIMIT } });
  const before = calls.length;

  await say(world, setupId, 'Carry on');
  await drainBackgroundWork();
  assert.equal(calls.length, before, 'nothing spent past the limit');
  const stopped = await view(world, setupId);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stopReason, 'token_limit');
  assert.match(stopped.messages.at(-1).text, /Someone at Decimal needs to raise the limit/);

  const refused = await raw('POST', `${setupPath(world.orgId, setupId)}/messages`, world.owner.token, { text: 'Please?' });
  assert.equal(refused.status, 409);
  assert.equal(await sweepSetups(), 0, 'and nothing wakes it');
});

test('setup: a model running past the limit mid-turn is cut off there', async () => {
  const world = await makeOrg();
  scriptModel(() => 'Hello.');
  const setupId = await start(world);
  await prisma.integrationSetup.update({ where: { setupId }, data: { tokensUsed: SETUP_TOKEN_LIMIT - 500n } });

  let modelCalls = 0;
  setExceptionAgentRuntimeForTests({
    callModel: async () => {
      modelCalls += 1;
      // Never finishing: a tool it does not have, over and over, at 400 tokens a go.
      return { message: { role: 'assistant' as const, content: null, tool_calls: [{ id: `c${modelCalls}`, type: 'function' as const, function: { name: 'look_again', arguments: '{}' } }] }, usage: { promptTokens: 390, completionTokens: 10 } };
    },
    isConfigured: () => true,
  });
  await say(world, setupId, 'Carry on');
  await drainBackgroundWork();
  assert.equal(modelCalls, 2, '400, then 800, which is past what was left');
  const stopped = await view(world, setupId);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stopReason, 'token_limit');
  assert.equal(Number((await receipt(world, setupId)).tokensUsed) > Number(SETUP_TOKEN_LIMIT), true, 'what was spent is on the record');
});

test('setup: at the turn limit it stops too', async () => {
  const world = await makeOrg();
  const calls = scriptModel(() => 'Hello.');
  const setupId = await start(world);
  await prisma.integrationSetup.update({ where: { setupId }, data: { turnsUsed: SETUP_TURN_LIMIT } });
  const before = calls.length;
  await say(world, setupId, 'Carry on');
  await drainBackgroundWork();
  assert.equal(calls.length, before);
  const stopped = await view(world, setupId);
  assert.equal(stopped.stopReason, 'turn_limit');
  assert.match(stopped.messages.at(-1).text, /limit/);
});

test('setup: with no model set up it says so and is not left spinning', async () => {
  const world = await makeOrg();
  setExceptionAgentRuntimeForTests({ isConfigured: () => false });
  const setupId = await start(world);
  const shown = await view(world, setupId);
  assert.equal(shown.running, false);
  assert.equal(shown.messages[0].status, 'failed');
  assert.match(shown.messages[0].text, /no AI model is set up/);
  assert.equal(await sweepSetups(), 0, 'and it is not owed another turn');
});
