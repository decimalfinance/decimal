// What a model call costs, and what a run of the agent loop adds up to. No network.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { exceptionAgentModel, runAgent, setExceptionAgentRuntimeForTests, type AgentTool, type ModelReply } from '../src/exceptions/agent.js';
import { costUsd, dollars } from '../src/infra/model-cost.js';

afterEach(() => setExceptionAgentRuntimeForTests(null));

const near = (actual: number | null, expected: number, what: string) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);
};

test('cost: each kind of token at its own rate, and a model with no listed price costs null', () => {
  near(costUsd('claude-opus-5-5', { promptTokens: 1_000_000, completionTokens: 0 }), 4, 'fresh input');
  near(costUsd('claude-opus-5-5', { promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 1_000_000 }), 0.2, 'read from cache');
  near(costUsd('claude-opus-5-5', { promptTokens: 1_000_000, completionTokens: 0, cacheWriteTokens: 1_000_000 }), 5, 'written to cache');
  near(costUsd('claude-opus-5-5', { promptTokens: 0, completionTokens: 1_000_000 }), 20, 'output');
  near(costUsd('claude-opus-5-5', { promptTokens: 30_000, completionTokens: 500, cacheReadTokens: 20_000, cacheWriteTokens: 8_000 }), (2_000 * 4 + 20_000 * 0.2 + 8_000 * 5 + 500 * 20) / 1e6, 'a turn, mixed');
  assert.equal(costUsd('a-model-nobody-priced', { promptTokens: 10, completionTokens: 10 }), null);
});

test('cost: a long prompt is billed at the higher rate, for that call', () => {
  near(costUsd('claude-haiku-5-5', { promptTokens: 100_000, completionTokens: 1_000 }), (100_000 * 0.1 + 1_000 * 0.5) / 1e6, 'at the line');
  near(costUsd('claude-haiku-5-5', { promptTokens: 100_001, completionTokens: 1_000 }), (100_001 * 0.5 + 1_000 * 2.5) / 1e6, 'over it');
  near(costUsd('gpt-6-luna', { promptTokens: 300_000, completionTokens: 0 }), 300_000 * 0.2 / 1e6, "gpt-6-luna's line is higher");
});

test('cost: shown in cents, or to a hundredth of a cent below one', () => {
  assert.equal(dollars(1.234), '$1.23');
  assert.equal(dollars(0.00125), '$0.0013');
  assert.equal(dollars(null), 'cost unknown');
});

test('cost: a run adds up what each call cost, so two long prompts are not priced as one longer one', async () => {
  const respond: AgentTool = { name: 'respond', description: 'Finish.', terminal: true, parameters: { type: 'object', properties: {} } };
  const lookUp: AgentTool = { name: 'look_up', description: 'Look.', parameters: { type: 'object', properties: {} }, run: async () => ({ found: true }) };
  const usage = { promptTokens: 60_000, completionTokens: 400, cacheReadTokens: 50_000, cacheWriteTokens: 9_000 };
  let calls = 0;
  setExceptionAgentRuntimeForTests({
    isConfigured: () => true,
    callModel: async (): Promise<ModelReply> => {
      calls += 1;
      const name = calls === 1 ? 'look_up' : 'respond';
      return { message: { role: 'assistant', content: null, tool_calls: [{ id: `c${calls}`, type: 'function', function: { name, arguments: '{}' } }] }, usage };
    },
  });
  const run = await runAgent({ label: 'cost', system: 'Test.', user: 'Go.', tools: [respond, lookUp] });
  assert.equal(run.ok, true);
  assert.equal(run.turns, 2);
  assert.deepEqual(
    { promptTokens: run.promptTokens, completionTokens: run.completionTokens, cacheReadTokens: run.cacheReadTokens, cacheWriteTokens: run.cacheWriteTokens },
    { promptTokens: 120_000, completionTokens: 800, cacheReadTokens: 100_000, cacheWriteTokens: 18_000 },
  );
  const each = costUsd(exceptionAgentModel(), usage);
  if (each === null) assert.equal(run.costUsd, null, 'no listed price, no total');
  else near(run.costUsd, each * 2, 'the sum of its calls');
});
