import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { runAgent, setExceptionAgentRuntimeForTests, type ChatMessage, type ModelReply, type AgentTool } from '../src/exceptions/agent.js';

// The loop moves messages; it does not trust them. These drive it with a
// scripted model so every path is exercised without touching the network.

afterEach(() => setExceptionAgentRuntimeForTests(null));

let callSeq = 0;
const call = (name: string, args: unknown) => ({
  id: `call_${++callSeq}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) },
});
const reply = (message: Partial<ChatMessage>): ModelReply => ({
  message: { role: 'assistant', content: null, ...message },
  usage: { promptTokens: 100, completionTokens: 20 },
});

/** A model that plays back a fixed script, and records what it was sent. */
function scripted(steps: ModelReply[]) {
  const seen: ChatMessage[][] = [];
  setExceptionAgentRuntimeForTests({
    callModel: async ({ messages }) => {
      seen.push(messages.map((m) => ({ ...m })));
      const next = steps.shift();
      if (!next) throw new Error('script exhausted');
      return next;
    },
  });
  return seen;
}

const echoTool = (log: unknown[]): AgentTool => ({
  name: 'look', description: 'look', parameters: { type: 'object', properties: {} },
  run: async (args) => { log.push(args); return { saw: args }; },
});
const finish: AgentTool = {
  name: 'finish', description: 'finish', terminal: true,
  parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
};

test('a tool call, then a terminal call: the result is the terminal arguments', async () => {
  const log: unknown[] = [];
  const seen = scripted([
    reply({ tool_calls: [call('look', { at: 'this' })] }),
    reply({ tool_calls: [call('finish', { answer: 'done' })] }),
  ]);
  const run = await runAgent({ label: 't', system: 's', user: 'u', tools: [echoTool(log), finish] });
  assert.equal(run.ok, true);
  assert.ok(run.ok);
  assert.deepEqual(run.terminal, { name: 'finish', args: { answer: 'done' } });
  assert.equal(run.turns, 2);
  assert.equal(run.promptTokens, 200);
  assert.deepEqual(log, [{ at: 'this' }]);
  // What the tool returned went back to the model on the next turn.
  const toolMsg = seen[1]!.find((m) => m.role === 'tool');
  assert.deepEqual(JSON.parse(toolMsg!.content!), { saw: { at: 'this' } });
});

test('a terminal call made alongside a tool call runs after it', async () => {
  const log: unknown[] = [];
  scripted([reply({ tool_calls: [call('finish', { answer: 'x' }), call('look', { n: 1 })] })]);
  const run = await runAgent({ label: 't', system: 's', user: 'u', tools: [echoTool(log), finish] });
  assert.ok(run.ok);
  assert.deepEqual(log, [{ n: 1 }], 'the investigative call still ran');
});

test('a tool that throws is reported back to the model, not fatal', async () => {
  const boom: AgentTool = { name: 'look', description: '', parameters: { type: 'object', properties: {} }, run: async () => { throw new Error('bill not found'); } };
  const seen = scripted([
    reply({ tool_calls: [call('look', {})] }),
    reply({ tool_calls: [call('finish', { answer: 'ok' })] }),
  ]);
  const run = await runAgent({ label: 't', system: 's', user: 'u', tools: [boom, finish] });
  assert.ok(run.ok);
  const toolMsg = seen[1]!.find((m) => m.role === 'tool');
  assert.deepEqual(JSON.parse(toolMsg!.content!), { error: 'bill not found' });
});

test('a model that keeps talking instead of calling tools gets one reminder, then the run fails', async () => {
  scripted([reply({ content: 'I think it is a duplicate.' }), reply({ content: 'Really.' })]);
  const run = await runAgent({ label: 't', system: 's', user: 'u', tools: [finish] });
  assert.equal(run.ok, false);
  assert.ok(!run.ok && /stopped calling tools/.test(run.error));
});

test('running out of turns fails rather than looping', async () => {
  const log: unknown[] = [];
  scripted(Array.from({ length: 3 }, () => reply({ tool_calls: [call('look', {})] })));
  const run = await runAgent({ label: 't', system: 's', user: 'u', tools: [echoTool(log), finish], maxTurns: 3 });
  assert.equal(run.ok, false);
  assert.equal(run.turns, 3);
});

test('a failing model call is a failed run with the turn it failed on', async () => {
  setExceptionAgentRuntimeForTests({ callModel: async () => { throw new Error('OpenAI 500'); } });
  const run = await runAgent({ label: 't', system: 's', user: 'u', tools: [finish] });
  assert.ok(!run.ok);
  assert.equal(run.error, 'OpenAI 500');
  assert.equal(run.turns, 1);
});
