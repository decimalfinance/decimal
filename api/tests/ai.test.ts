// Which provider a call goes to, and a single answer's request and reply in Claude's shape.
// No network: the provider choice is config, and Claude's client is a fake.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../src/config.js';
import {
  accountTurnedAway, aiProvider, aiProviders, chat, claudeFailure, isAiConfigured, jsonObjectIn,
  noteAccountTurnedAway, resetAiProvidersForTests, setClaudeClientForTests, toClaudeChat,
} from '../src/infra/ai.js';
import { exceptionAgentModel } from '../src/exceptions/agent.js';

const saved = { anthropic: config.anthropicApiKey, openai: config.openAiApiKey, provider: config.aiProvider, model: config.anthropicModel };
afterEach(() => {
  config.anthropicApiKey = saved.anthropic;
  config.openAiApiKey = saved.openai;
  config.aiProvider = saved.provider;
  config.anthropicModel = saved.model;
  resetAiProvidersForTests();
  setClaudeClientForTests(null);
});

function keys(anthropic: boolean, openai: boolean, provider: 'anthropic' | 'openai' | null = null) {
  config.anthropicApiKey = anthropic ? 'test-anthropic' : '';
  config.openAiApiKey = openai ? 'test-openai' : '';
  config.aiProvider = provider;
}

test('ai: whichever provider has a key; Claude first unless AI_PROVIDER says OpenAI; no key, no AI', () => {
  keys(true, true);
  assert.deepEqual(aiProviders(), ['anthropic', 'openai']);
  assert.equal(aiProvider(), 'anthropic');
  keys(true, true, 'openai');
  assert.equal(aiProvider(), 'openai');
  keys(true, false, 'openai');
  assert.equal(aiProvider(), 'anthropic', 'a preference for a provider with no key goes nowhere');
  keys(false, true);
  assert.equal(aiProvider(), 'openai');
  keys(false, false);
  assert.equal(aiProvider(), null);
  assert.equal(isAiConfigured(), false);
});

test('ai: the agent loop starts on the model of the provider a call goes to', () => {
  keys(true, true);
  assert.equal(exceptionAgentModel(), config.anthropicAgentModel);
  keys(true, true, 'openai');
  assert.equal(exceptionAgentModel(), config.openAiAgentModel || config.openAiModel);
});

test('ai: an account that turns work away is passed over while the other has a key, and only then', () => {
  keys(true, true);
  noteAccountTurnedAway('anthropic', 400);
  assert.equal(aiProvider(), 'openai');
  resetAiProvidersForTests();
  keys(true, false);
  noteAccountTurnedAway('anthropic', 400);
  assert.equal(aiProvider(), 'anthropic', 'with nowhere else to go, it keeps trying the one it has');
});

test('ai: out of credit and a key refused turn work away; a rate limit or a bad request does not', () => {
  assert.equal(accountTurnedAway('openai', 429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'), true);
  assert.equal(accountTurnedAway('openai', 429, '{"error":{"code":"rate_limit_exceeded"}}'), false);
  assert.equal(accountTurnedAway('openai', 401, ''), true);
  assert.equal(accountTurnedAway('anthropic', 400, 'Your credit balance is too low to access the Anthropic API.'), true);
  assert.equal(accountTurnedAway('anthropic', 400, 'tools.0.input_schema: invalid'), false);
  assert.equal(accountTurnedAway('anthropic', 429, 'Number of request tokens has exceeded your rate limit'), false);
});

test('ai: a Claude failure says who, the status and why, and one out of credit passes Claude over', () => {
  keys(true, true);
  const outOfCredit = new Anthropic.APIError(
    400,
    { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
    'credit',
    new Headers(),
    'invalid_request_error',
  );
  assert.match(claudeFailure(outOfCredit).message, /^Anthropic 400 invalid_request_error: Your credit balance is too low/);
  assert.equal(aiProvider(), 'openai');
});

test('ai: on Claude the system prompt goes apart, page images become image blocks, and the person speaks first', () => {
  const { system, messages, format } = toClaudeChat({
    model: 'gpt-6-luna',
    max_tokens: 100,
    messages: [
      { role: 'system', content: 'Read the bill.' },
      { role: 'user', content: [{ type: 'text', text: '=== PAGE 1 of 1 ===' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'user', content: 'The total was wrong; read it again.' },
    ],
  });
  assert.equal(system, 'Read the bill.');
  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'text', text: '=== PAGE 1 of 1 ===' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'The total was wrong; read it again.' },
    ],
  }], 'two turns from the person in a row are one turn');
  assert.equal(format, null);
});

test('ai: a strict schema goes to Claude without the limits its decoder refuses, and a list of types as anyOf', () => {
  const { format } = toClaudeChat({
    model: 'gpt-6-luna',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'x' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'n',
        strict: true,
        schema: {
          type: 'object', additionalProperties: false, required: ['box', 'page', 'note'],
          properties: { box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, page: { type: 'integer', minimum: 1 }, note: { type: ['string', 'null'] } },
        },
      },
    },
  });
  assert.deepEqual(format, {
    type: 'json_schema',
    schema: {
      type: 'object', additionalProperties: false, required: ['box', 'page', 'note'],
      properties: { box: { type: 'array', items: { type: 'number' } }, page: { type: 'integer' }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    },
  });
});

test('ai: an image Claude cannot take is refused before the call', () => {
  assert.throws(
    () => toClaudeChat({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/heic;base64,AAAA' } }] }] }),
    /PNG, JPEG, GIF or WebP/,
  );
});

test('ai: "JSON only" comes back as the JSON, fenced or with words around it', () => {
  assert.equal(jsonObjectIn('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(jsonObjectIn('Here it is: {"a":{"b":2}} and that is all.'), '{"a":{"b":2}}');
  assert.equal(jsonObjectIn('{"a":1}'), '{"a":1}');
});

test('ai: on Claude, one answer: no temperature, room to think, the JSON taken out of the text, the tokens split', async () => {
  keys(true, false);
  config.anthropicModel = 'claude-haiku-5-5';
  let sent: Record<string, unknown> | null = null;
  setClaudeClientForTests({
    messages: {
      create: async (body: Record<string, unknown>) => {
        sent = body;
        return {
          model: 'claude-haiku-5-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }],
          usage: { input_tokens: 900, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
        };
      },
    },
  });
  const answer = await chat({
    model: 'gpt-6-luna',
    max_tokens: 200,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: 'JSON only.' }, { role: 'user', content: 'Go.' }],
  });
  assert.equal(answer.provider, 'anthropic');
  assert.equal(answer.model, 'claude-haiku-5-5');
  assert.equal(answer.content, '{"ok":true}');
  assert.deepEqual(answer.usage, { promptTokens: 1000, completionTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0 });
  assert.ok(sent);
  const body = sent as Record<string, unknown>;
  assert.equal(body.model, 'claude-haiku-5-5', "Claude's model, not the OpenAI one the site names");
  assert.equal(body.max_tokens, 4200);
  assert.equal('temperature' in body, false, 'these models take none');
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.system, 'JSON only.');
});

test('ai: on Claude, a reply cut off or declined is an error, not half an answer', async () => {
  keys(true, false);
  for (const stop of ['max_tokens', 'refusal']) {
    setClaudeClientForTests({ messages: { create: async () => ({ model: 'm', stop_reason: stop, content: [{ type: 'text', text: '{"a":' }], usage: { input_tokens: 1, output_tokens: 1 } }) } });
    await assert.rejects(chat({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }), /^Error: Anthropic (ran out of output tokens|declined)/);
  }
});
