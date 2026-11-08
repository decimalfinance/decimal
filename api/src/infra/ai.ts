// Which AI provider a call goes to, and one call for a single answer on either.
//
// Every AI feature runs on Claude or on OpenAI, whichever has a key. AI_PROVIDER says which goes
// first when both do; unset, Claude does. A provider whose account turns work away (no credit
// left, a key it no longer takes) is passed over for a while when the other has a key, so one
// lapsed account doesn't take every AI feature down with it. A rate limit is not that: it says
// to slow down, not that the account can't be used.
//
// A call site builds its request in OpenAI's chat shape, as it always has, and on OpenAI it goes
// exactly as built. On Claude it is translated: the system prompt apart, page images as image
// blocks, a strict JSON schema as structured output, and "JSON only" as text the JSON is taken
// out of. Claude's decoder can't hold a number or a list to a limit, so those limits are left out
// of what it is sent; every caller checks what comes back anyway. These Claude models take no
// temperature, and they think as much as the effort asked for.
//
// Tests never reach either provider: with no key nothing is called, and setChatForTests replaces
// the call.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from './logger.js';
import type { Usage } from './model-cost.js';
import { chatCompletionBody } from './openai-params.js';

export type Provider = 'anthropic' | 'openai';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// ─── Which provider ──────────────────────────────────────────────────────────

const KEY: Record<Provider, () => string> = {
  anthropic: () => config.anthropicApiKey,
  openai: () => config.openAiApiKey,
};

/** How long a provider whose account turned work away is passed over, when the other has a key. */
const PASS_OVER_MS = 10 * 60_000;
const passedOverUntil = new Map<Provider, number>();

/** The providers with a key, the one to try first first. */
export function aiProviders(): Provider[] {
  const order: Provider[] = config.aiProvider === 'openai' ? ['openai', 'anthropic'] : ['anthropic', 'openai'];
  return order.filter((provider) => Boolean(KEY[provider]()));
}

/** Where a call goes now: the first provider with a key that isn't being passed over. Null with no key at all. */
export function aiProvider(): Provider | null {
  const withKeys = aiProviders();
  return withKeys.find((provider) => (passedOverUntil.get(provider) ?? 0) <= Date.now()) ?? withKeys[0] ?? null;
}

/** No key, no AI: every feature has a way to work without it. */
export function isAiConfigured(): boolean {
  return aiProviders().length > 0;
}

/**
 * A failed call that says the account can't be used: out of credit, or a key it won't take.
 * OpenAI says so with a 429 that names insufficient_quota, which is not its rate limit; Anthropic
 * with a 400 about the credit balance.
 */
export function accountTurnedAway(provider: Provider, status: number, detail: string): boolean {
  if (status === 401 || status === 402 || status === 403) return true;
  if (provider === 'openai') return status === 429 && /insufficient_quota/.test(detail);
  return status === 400 && /credit balance/i.test(detail);
}

/** Pass this provider over for a while, if there is another to go to. */
export function noteAccountTurnedAway(provider: Provider, status: number): void {
  if (aiProviders().length < 2) return;
  passedOverUntil.set(provider, Date.now() + PASS_OVER_MS);
  logger.warn('ai.account_turned_away', { provider, status, passedOverForMs: PASS_OVER_MS });
}

export function resetAiProvidersForTests(): void {
  passedOverUntil.clear();
}

// ─── Claude, shared with the agent loop ──────────────────────────────────────

let client: Anthropic | null = null;
let clientKey = '';
let clientOverride: Anthropic | null = null;

/** Replace the Claude client with a fake that answers `messages.create`. `null` restores the real one. */
export function setClaudeClientForTests(fake: unknown): void {
  clientOverride = fake as Anthropic | null;
}

/** One client per key, made when first wanted. */
export function claudeClient(): Anthropic {
  if (clientOverride) return clientOverride;
  if (!client || clientKey !== config.anthropicApiKey) {
    client = new Anthropic({ apiKey: config.anthropicApiKey });
    clientKey = config.anthropicApiKey;
  }
  return client;
}

/** A failed Claude call in the words the callers log and the setup keeps: who, the status and its kind. Never the request. */
export function claudeFailure(error: unknown): Error {
  if (error instanceof Anthropic.APIConnectionError && !(error instanceof Anthropic.APIUserAbortError)) return new Error('Anthropic unreachable');
  if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
    const body = error.error as { error?: { message?: unknown } } | undefined;
    const message = typeof body?.error?.message === 'string' ? body.error.message : '';
    if (accountTurnedAway('anthropic', error.status, message)) noteAccountTurnedAway('anthropic', error.status);
    // A request Claude refused says why, and that is the only way to find a bad schema.
    const why = error.status === 400 && message ? `: ${message.slice(0, 200)}` : '';
    return new Error(`Anthropic ${error.status}${error.type ? ` ${error.type}` : ''}${why}`);
  }
  return error instanceof Error ? error : new Error('the Claude call failed');
}

const IS_TYPE: Record<string, (value: unknown) => boolean> = {
  null: (value) => value === null,
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number',
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  object: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  array: (value) => Array.isArray(value),
};
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions']);
const SCHEMA_LISTS = new Set(['items', 'anyOf', 'allOf', 'oneOf', 'additionalProperties']);
/** What Claude's structured output can't enforce, and refuses to be sent. */
const LIMITS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems']);

/**
 * A JSON schema as Claude's strict mode takes it. It refuses a list of types with an enum ("Enum
 * value ... does not match declared type"), so a list becomes anyOf, one branch per type with that
 * type's enum values. JSON Schema means the same thing either way. With `withoutLimits`, the limits
 * its decoder can't hold to are left out: structured output refuses them where a tool doesn't.
 */
export function claudeSchema(schema: unknown, opts: { withoutLimits?: boolean } = {}): unknown {
  if (Array.isArray(schema)) return schema.map((inner) => claudeSchema(inner, opts));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (opts.withoutLimits && LIMITS.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && value && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, claudeSchema(inner, opts)]));
    } else {
      out[key] = SCHEMA_LISTS.has(key) ? claudeSchema(value, opts) : value;
    }
  }
  if (!Array.isArray(out.type)) return out;
  const { type: types, enum: values, description, ...rest } = out as { type: string[]; enum?: unknown[]; description?: unknown };
  const branches = types.flatMap((type) => {
    if (type === 'null') return [{ type: 'null' }];
    const allowed = values?.filter((value) => IS_TYPE[type]?.(value));
    return allowed?.length === 0 ? [] : [{ ...rest, type, ...(allowed ? { enum: allowed } : {}) }];
  });
  return { ...(description === undefined ? {} : { description }), anyOf: branches };
}

// ─── One answer ──────────────────────────────────────────────────────────────

export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** A request as the call sites have always built it for OpenAI's chat completions. */
export type ChatRequest = {
  /** The OpenAI model. On Claude, ANTHROPIC_MODEL answers instead. */
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatPart[] }>;
  max_tokens: number;
  temperature?: number;
  response_format?:
    | { type: 'json_object' }
    | { type: 'json_schema'; json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> } };
};

export type ChatAnswer = {
  /** The reply's text: with a JSON response format, the JSON. Empty when the model said nothing. */
  content: string;
  /** Why it stopped, in the provider's words. */
  finishReason: string | null;
  usage: Usage;
  /** The model that answered, as the provider names it. */
  model: string;
  provider: Provider;
};

export type ChatOptions = {
  signal?: AbortSignal;
  /** How hard the model thinks before it answers. Low unless said. */
  effort?: 'low' | 'medium' | 'high';
};

type ChatCall = (request: ChatRequest, opts: ChatOptions) => Promise<ChatAnswer>;
let chatOverride: ChatCall | null = null;

/** Replace every single-answer call with a script. `null` restores the real one. */
export function setChatForTests(fn: ChatCall | null): void {
  chatOverride = fn;
}

/** One answer from whichever provider a call goes to now. Throws, with the provider and status first, when it fails. */
export async function chat(request: ChatRequest, opts: ChatOptions = {}): Promise<ChatAnswer> {
  if (chatOverride) return chatOverride(request, opts);
  const provider = aiProvider();
  if (!provider) throw new Error('No AI provider has a key');
  return provider === 'anthropic' ? chatOnClaude(request, opts) : chatOnOpenAi(request, opts);
}

async function chatOnOpenAi(request: ChatRequest, opts: ChatOptions): Promise<ChatAnswer> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
    body: JSON.stringify(chatCompletionBody(request, opts.effort ? { effort: opts.effort } : {})),
    signal: opts.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (accountTurnedAway('openai', res.status, detail)) noteAccountTurnedAway('openai', res.status);
    throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    model?: string;
  };
  const choice = body.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? null,
    usage: {
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      cacheReadTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model: body.model ?? request.model,
    provider: 'openai',
  };
}

/** Thinking is output too, so the room a call asks for gets this much more for it, as on OpenAI. */
const THINKING_ROOM = 4000;

type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const IMAGE_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function claudeBlock(part: ChatPart): Anthropic.ContentBlockParam {
  if (part.type === 'text') return { type: 'text', text: part.text };
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url);
  if (!match || !IMAGE_TYPES.has(match[1]!)) throw new Error('Claude takes an image as PNG, JPEG, GIF or WebP data');
  return { type: 'image', source: { type: 'base64', media_type: match[1] as ImageType, data: match[2]! } };
}

/** The request as a Messages API request: the system prompt apart, turns alternating, the person first. */
export function toClaudeChat(request: ChatRequest) {
  const system: string[] = [];
  const messages: Anthropic.MessageParam[] = [];
  for (const message of request.messages) {
    const parts = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    if (message.role === 'system') {
      for (const part of parts) if (part.type === 'text' && part.text.trim()) system.push(part.text);
      continue;
    }
    const blocks = parts.filter((part) => part.type !== 'text' || part.text.trim()).map(claudeBlock);
    if (blocks.length === 0) continue;
    const last = messages.at(-1);
    if (last?.role === message.role) last.content = [...(last.content as Anthropic.ContentBlockParam[]), ...blocks];
    else messages.push({ role: message.role, content: blocks });
  }
  if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(Earlier in the conversation.)' }] });
  const format = request.response_format?.type === 'json_schema'
    ? { type: 'json_schema' as const, schema: claudeSchema(request.response_format.json_schema.schema, { withoutLimits: true }) as Record<string, unknown> }
    : null;
  return { system: system.join('\n\n'), messages, format };
}

/** The JSON object in a reply asked for "JSON only", which may come fenced or with a sentence around it. */
export function jsonObjectIn(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/.exec(trimmed);
  if (fenced) return fenced[1]!.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  return first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
}

async function chatOnClaude(request: ChatRequest, opts: ChatOptions): Promise<ChatAnswer> {
  const { system, messages, format } = toClaudeChat(request);
  let reply: Anthropic.Message;
  try {
    reply = await claudeClient().messages.create({
      model: config.anthropicModel,
      max_tokens: request.max_tokens + THINKING_ROOM,
      ...(system ? { system } : {}),
      messages,
      output_config: { effort: opts.effort ?? 'low', ...(format ? { format } : {}) },
    }, { signal: opts.signal });
  } catch (error) {
    throw claudeFailure(error);
  }
  if (reply.stop_reason === 'refusal') throw new Error('Anthropic declined');
  // Cut off, the JSON is half an answer.
  if (reply.stop_reason === 'max_tokens') throw new Error('Anthropic ran out of output tokens');
  const text = reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('').trim();
  const read = reply.usage.cache_read_input_tokens ?? 0;
  const written = reply.usage.cache_creation_input_tokens ?? 0;
  return {
    content: request.response_format?.type === 'json_object' && text ? jsonObjectIn(text) : text,
    finishReason: reply.stop_reason,
    usage: { promptTokens: reply.usage.input_tokens + read + written, completionTokens: reply.usage.output_tokens, cacheReadTokens: read, cacheWriteTokens: written },
    model: reply.model,
    provider: 'anthropic',
  };
}
