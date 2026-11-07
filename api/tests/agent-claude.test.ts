// The agent loop's request and reply in Claude's shape. No network: these are the
// translations either side of the call, which is where a Messages API 400 would come from.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentTool, ChatMessage } from '../src/exceptions/agent.js';
import { claudeSchema, fromClaudeReply, toClaudeRequest } from '../src/exceptions/claude.js';

type Reply = Anthropic.Beta.BetaContentBlock[];
const reply = (blocks: unknown[]) => blocks as Reply;

const respond: AgentTool = {
  name: 'respond',
  description: 'Finish this turn.',
  terminal: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['message', 'list', 'claims'],
    properties: {
      message: { type: 'string' },
      list: { type: ['string', 'null'], enum: ['lookalike_vendors', 'coded_two_ways', null], description: 'Which list goes under it.' },
      claims: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['text', 'refs'], properties: { text: { type: 'string' }, refs: { type: ['array', 'null'], items: { type: 'string' } } } },
      },
    },
  },
};
const lookUp: AgentTool = { name: 'look_up', description: 'Look something up.', parameters: { type: 'object', properties: { id: { type: 'string' } } }, run: async () => ({}) };

test('claude: a list of types becomes anyOf, each branch with only its own enum values', () => {
  const schema = claudeSchema(respond.parameters) as { properties: Record<string, unknown> };
  assert.deepEqual(schema.properties.list, {
    description: 'Which list goes under it.',
    anyOf: [{ type: 'string', enum: ['lookalike_vendors', 'coded_two_ways'] }, { type: 'null' }],
  });
  assert.deepEqual(schema.properties.message, { type: 'string' }, 'one type stays as it was');
  const claims = schema.properties.claims as { items: { properties: Record<string, unknown> } };
  assert.deepEqual(claims.items.properties.refs, { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] }, 'nested, and what belongs to a type stays on its branch');
  assert.deepEqual((respond.parameters.properties as Record<string, { type: unknown }>).list.type, ['string', 'null'], 'the tool keeps its own schema');
});

test('claude: only a terminal tool is strict', () => {
  const { tools } = toClaudeRequest([{ role: 'user', content: 'Hi' }], [lookUp, respond]);
  assert.deepEqual(tools.map((t) => [t.name, t.strict ?? false]), [['look_up', false], ['respond', true]]);
});

test('claude: the conversation starts with the person, turns alternate, and tool results go back together', () => {
  const asked: ChatMessage = {
    role: 'assistant',
    content: 'Let me look.',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'look_up', arguments: '{"id":"vendor:58"}' } },
      { id: 'call_2', type: 'function', function: { name: 'look_up', arguments: 'not json' } },
    ],
  };
  const request = toClaudeRequest([
    { role: 'system', content: 'The playbook.' },
    { role: 'assistant', content: 'Is this the right company?' },
    { role: 'assistant', content: 'Take your time.' },
    { role: 'user', content: 'Yes.' },
    asked,
    { role: 'tool', tool_call_id: 'call_1', content: '{"name":"Tania"}' },
    { role: 'tool', tool_call_id: 'call_2', content: '{"error":"no id"}' },
    { role: 'user', content: 'Use the tools.' },
  ], [lookUp]);

  assert.equal(request.system, 'The playbook.');
  assert.deepEqual(request.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(request.messages[0]!.content, [{ type: 'text', text: '(Earlier in the conversation.)' }], 'a conversation the loop starts with a reply gets a first turn');
  assert.deepEqual(request.messages[1]!.content, [{ type: 'text', text: 'Is this the right company?' }, { type: 'text', text: 'Take your time.' }]);
  assert.deepEqual(request.messages[3]!.content, [
    { type: 'text', text: 'Let me look.' },
    { type: 'tool_use', id: 'call_1', name: 'look_up', input: { id: 'vendor:58' } },
    { type: 'tool_use', id: 'call_2', name: 'look_up', input: {} },
  ]);
  assert.deepEqual(request.messages[4]!.content, [
    { type: 'tool_result', tool_use_id: 'call_1', content: '{"name":"Tania"}' },
    { type: 'tool_result', tool_use_id: 'call_2', content: '{"error":"no id"}' },
    { type: 'text', text: 'Use the tools.' },
  ], 'results first, in one turn, then what was said');
});

test('claude: a reply goes back exactly as it came, thinking and all, and is never added to', () => {
  const blocks = reply([
    { type: 'thinking', thinking: '', signature: 'sig-1' },
    { type: 'text', text: 'Looking it up.', citations: null },
    { type: 'tool_use', id: 'toolu_1', name: 'look_up', input: { id: 'vendor:58' } },
  ]);
  const message = fromClaudeReply(blocks);
  assert.equal(message.content, 'Looking it up.');
  assert.deepEqual(message.tool_calls, [{ id: 'toolu_1', type: 'function', function: { name: 'look_up', arguments: '{"id":"vendor:58"}' } }]);

  const request = toClaudeRequest([
    { role: 'user', content: 'Who is vendor 58?' },
    message,
    { role: 'assistant', content: 'One more thing.' },
    { role: 'tool', tool_call_id: 'toolu_1', content: '{}' },
  ], [lookUp]);
  assert.deepEqual(request.messages[1]!.content, [...blocks, { type: 'text', text: 'One more thing.' }]);
  assert.equal(toClaudeRequest([{ role: 'user', content: 'Again' }, message], [lookUp]).messages[1]!.content.length, 3, 'what was kept is not changed by a merge');
});

test('claude: after a fallback, only what followed the switch goes back', () => {
  const message = fromClaudeReply(reply([
    { type: 'thinking', thinking: '', signature: 'declined' },
    { type: 'tool_use', id: 'toolu_a', name: 'look_up', input: {} },
    { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
    { type: 'thinking', thinking: '', signature: 'continued' },
    { type: 'tool_use', id: 'toolu_b', name: 'look_up', input: { id: 'x' } },
  ]));
  assert.deepEqual(message.tool_calls?.map((c) => c.id), ['toolu_b']);
  const sent = toClaudeRequest([{ role: 'user', content: 'Hi' }, message], [lookUp]).messages[1]!.content as Array<{ type: string; id?: string; signature?: string }>;
  assert.deepEqual(sent.map((b) => b.signature ?? b.id ?? b.type), ['fallback', 'continued', 'toolu_b']);
});
