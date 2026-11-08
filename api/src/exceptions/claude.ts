// The agent loop on Claude.
//
// The loop in agent.ts speaks OpenAI's chat shape, and so do its callers and what they
// keep. This turns a request in that shape into a Messages API request, and the reply
// back, so neither the loop nor its callers change with the model behind them.
//
// What Claude needs that the chat shape doesn't say:
//   - A reply goes back exactly as it came. Claude's thinking is signed and bound to the
//     conversation, so a reply rebuilt from the loop's copy would be refused. The blocks
//     themselves are kept beside the loop's copy, and they are what is sent back.
//   - A call can't be forced to use a tool. The loop already reminds a reply in prose once,
//     and a terminal tool is strict, so what it carries has the shape asked for.
//   - A conversation starts with the person, and turns alternate. The loop's copy needn't.
//
// Tests never reach Claude: setExceptionAgentRuntimeForTests replaces the whole model call.
import type Anthropic from '@anthropic-ai/sdk';
import { claudeClient, claudeFailure, claudeSchema } from '../infra/ai.js';
import type { AgentTool, ChatMessage, ModelCall } from './agent.js';

export { claudeSchema };

type Block = Anthropic.Beta.BetaContentBlockParam;
type Turn = { role: 'user' | 'assistant'; content: Block[] };

/** Thinking can't be turned off on Claude Opus 5.5. This is how much of it a call gets. */
const EFFORT = 'medium' as const;
/** Thinking is output too, so the loop's budget per call is a floor here, not a cap. */
const LEAST_OUTPUT_TOKENS = 16_000;
/** On a policy decline the call runs again, server-side, on the model Anthropic picks for that kind of decline. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** The models that have one. Claude Haiku 5.5 has none. */
const HAS_FALLBACK = /^claude-(opus|sonnet)-/;
/** Where a conversation the loop starts with a reply needs a first turn from the person. */
const BEFORE_A_REPLY = '(Earlier in the conversation.)';
/** Where it ends without one. */
const AFTER_A_REPLY = '(Carry on.)';

/** What Claude sent, per reply the loop holds, to send back unchanged. */
const sentAsIs = new WeakMap<ChatMessage, Block[]>();

function argsOf(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const textBlock = (text: string | null | undefined): Block[] => (text?.trim() ? [{ type: 'text', text }] : []);

/** The loop's request as a Messages API request: system apart, turns alternating, the person first. */
export function toClaudeRequest(messages: ChatMessage[], tools: AgentTool[]) {
  const system: string[] = [];
  const turns: Turn[] = [];
  const add = (role: Turn['role'], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = turns.at(-1);
    // A copy: blocks kept to send back unchanged are never added to.
    if (last?.role === role) last.content = [...last.content, ...blocks];
    else turns.push({ role, content: [...blocks] });
  };
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content?.trim()) system.push(message.content);
    } else if (message.role === 'user') {
      add('user', textBlock(message.content));
    } else if (message.role === 'tool') {
      add('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: message.content ?? '' }]);
    } else {
      add('assistant', sentAsIs.get(message) ?? [
        ...textBlock(message.content),
        ...(message.tool_calls ?? []).map((call): Block => ({ type: 'tool_use', id: call.id, name: call.function.name, input: argsOf(call.function.arguments) })),
      ]);
    }
  }
  if (turns[0]?.role !== 'user') turns.unshift({ role: 'user', content: textBlock(BEFORE_A_REPLY) });
  if (turns.at(-1)?.role !== 'user') turns.push({ role: 'user', content: textBlock(AFTER_A_REPLY) });
  return {
    system: system.join('\n\n'),
    messages: turns,
    tools: tools.map((tool): Anthropic.Beta.BetaTool => ({
      name: tool.name,
      description: tool.description,
      input_schema: claudeSchema(tool.parameters) as Anthropic.Beta.BetaTool.InputSchema,
      ...(tool.terminal ? { strict: true } : {}),
    })),
  };
}

/** Claude's reply as the loop reads it, with what Claude sent kept to send back. */
export function fromClaudeReply(content: Anthropic.Beta.BetaContentBlock[]): ChatMessage {
  // After a fallback, what the declining model started is not sent back, only what followed the switch.
  const cut = content.map((block) => block.type).lastIndexOf('fallback');
  const kept = content.filter((block, i) => i > cut || !['thinking', 'redacted_thinking', 'tool_use'].includes(block.type));
  const text = kept.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim();
  const calls = kept.flatMap((block) => (block.type === 'tool_use'
    ? [{ id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }]
    : []));
  const message: ChatMessage = { role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
  sentAsIs.set(message, kept as unknown as Block[]);
  return message;
}

/** The model call on Claude. Exported so an eval can run through it, counting what it spends. */
export const callClaude: ModelCall = async ({ model, messages, tools, signal, maxTokens }) => {
  const request = toClaudeRequest(messages, tools);
  let reply: Anthropic.Beta.BetaMessage;
  try {
    reply = await claudeClient().beta.messages.create({
      model,
      max_tokens: Math.max(maxTokens, LEAST_OUTPUT_TOKENS),
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages,
      tools: request.tools,
      tool_choice: { type: 'auto' },
      output_config: { effort: EFFORT },
      // Each call in a run repeats the one before it and adds to the end, so all but the new part is read from cache.
      cache_control: { type: 'ephemeral' },
      ...(HAS_FALLBACK.test(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    }, { signal });
  } catch (error) {
    throw claudeFailure(error);
  }
  if (reply.stop_reason === 'refusal') throw new Error(`Anthropic declined${reply.stop_details?.category ? ` (${reply.stop_details.category})` : ''}`);
  // A reply cut off mid-call would run half a tool call.
  if (reply.stop_reason === 'max_tokens') throw new Error('Anthropic ran out of output tokens');
  const read = reply.usage.cache_read_input_tokens ?? 0;
  const written = reply.usage.cache_creation_input_tokens ?? 0;
  return {
    message: fromClaudeReply(reply.content),
    // Claude counts cached input apart from the rest. Every prompt token is in promptTokens, as on OpenAI.
    usage: {
      promptTokens: reply.usage.input_tokens + read + written,
      completionTokens: reply.usage.output_tokens,
      cacheReadTokens: read,
      cacheWriteTokens: written,
    },
  };
};
