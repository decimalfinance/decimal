import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCompletionBody } from '../src/infra/openai-params.js';

// What each model accepts was probed against the live API; these pin the
// translation so a call site cannot quietly send a body Luna rejects.

test('an older model is sent exactly what the call site built', () => {
  const body = { model: 'gpt-4.1-mini', temperature: 0, max_tokens: 1500, messages: [] };
  assert.deepEqual(chatCompletionBody(body), body);
});

test('with tools, a reasoning model gets effort none and keeps temperature', () => {
  const out = chatCompletionBody({ model: 'gpt-6-luna', temperature: 0, max_tokens: 1500, messages: [], tools: [{}] });
  assert.equal(out.reasoning_effort, 'none', 'Chat Completions refuses tools with reasoning');
  assert.equal(out.temperature, 0, 'temperature 0 is accepted with reasoning off');
  assert.equal(out.max_completion_tokens, 1500);
  assert.ok(!('max_tokens' in out), 'max_tokens is rejected outright');
});

test('without tools, a reasoning model reasons, drops temperature, and gets headroom', () => {
  const out = chatCompletionBody({ model: 'gpt-6-luna', temperature: 0, max_tokens: 4096, messages: [], response_format: { type: 'json_object' } });
  assert.equal(out.reasoning_effort, 'low');
  assert.ok(!('temperature' in out), 'temperature 0 is rejected with reasoning on');
  assert.equal(out.max_completion_tokens, 4096 + 4000, 'reasoning is counted against the limit');
  assert.deepEqual(out.response_format, { type: 'json_object' });
});
