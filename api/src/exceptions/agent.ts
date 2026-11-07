// A small tool-calling loop for the exception agent.
//
// Modelled on the Flow Builder assistant (`assistFlow`, approvals/flow.ts), with
// three differences that matter for work nobody is watching:
//
//   - A run ends only when the model calls a TERMINAL tool, and what comes back
//     is that tool's raw arguments. Deciding whether they are any good is the
//     investigator's job, not this loop's: the loop moves messages, it does not
//     trust them.
//   - One hard timeout for the whole run. There is no Stop button on a
//     background job, so the budget has to be built in.
//   - Tokens and turns are counted, because "is the agent worth running on every
//     flagged bill" is a question about cost as much as accuracy.
//
// The loop runs on Claude when ANTHROPIC_API_KEY is set (claude.ts turns this shape
// into a Messages API request and back), and on OpenAI otherwise.
//
// Tests never reach a model: `setExceptionAgentRuntimeForTests` swaps the model
// call for a scripted one, the same seam intake uses for extraction.
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { chatCompletionBody } from '../infra/openai-params.js';
import { callClaude } from './claude.js';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export type AgentTool = {
  name: string;
  description: string;
  /** JSON schema for the arguments. */
  parameters: Record<string, unknown>;
  /**
   * A terminal tool ends the run and its arguments are the result. It is sent
   * with `strict: true`, so its schema must list every property as required.
   */
  terminal?: boolean;
  /** Required for non-terminal tools. Whatever it returns is sent back as JSON. */
  run?: (args: Record<string, unknown>) => Promise<unknown>;
};

export type ModelReply = {
  message: ChatMessage;
  usage: { promptTokens: number; completionTokens: number };
};

export type ModelCall = (request: {
  model: string;
  messages: ChatMessage[];
  tools: AgentTool[];
  signal: AbortSignal;
  maxTokens: number;
}) => Promise<ModelReply>;

export type AgentRun =
  | { ok: true; terminal: { name: string; args: Record<string, unknown> }; turns: number; latencyMs: number; promptTokens: number; completionTokens: number; model: string }
  | { ok: false; error: string; stoppedBy?: 'tokens'; turns: number; latencyMs: number; promptTokens: number; completionTokens: number; model: string };

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_OUTPUT_TOKENS = 1500;
const MAX_SEND_BACKS = 2;

function toOpenAiTools(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.terminal ? { strict: true } : {}),
    },
  }));
}

/** The real model call. Exported so an eval can run through it, counting what it spends. */
export const callOpenAi: ModelCall = async ({ model, messages, tools, signal, maxTokens }) => {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
    body: JSON.stringify(chatCompletionBody({ model, temperature: 0, max_tokens: maxTokens, messages, tools: toOpenAiTools(tools), tool_choice: 'required' })),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const body = (await res.json()) as {
    choices?: Array<{ message?: ChatMessage }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    message: body.choices?.[0]?.message ?? { role: 'assistant', content: '' },
    usage: { promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0 },
  };
};

type ExceptionAgentRuntime = { callModel: ModelCall; isConfigured: () => boolean };
const onClaude = () => Boolean(config.anthropicApiKey);
const defaultRuntime: ExceptionAgentRuntime = {
  callModel: (request) => (onClaude() ? callClaude(request) : callOpenAi(request)),
  isConfigured: () => onClaude() || Boolean(config.openAiApiKey),
};
let runtime: ExceptionAgentRuntime = defaultRuntime;

/** Swap the model for a scripted one. `null` restores the real one. */
export function setExceptionAgentRuntimeForTests(next: Partial<ExceptionAgentRuntime> | null) {
  runtime = next ? { ...defaultRuntime, ...next } : defaultRuntime;
}

/** No key means no agent — the flag behaves exactly as it did before. */
export function isExceptionAgentConfigured(): boolean {
  return runtime.isConfigured();
}

export function exceptionAgentModel(): string {
  return onClaude() ? config.anthropicAgentModel : config.openAiAgentModel || config.openAiModel;
}

export async function runAgent(args: {
  label: string;
  system: string;
  user: string;
  tools: AgentTool[];
  maxTurns?: number;
  timeoutMs?: number;
  /** Earlier turns of a conversation, placed between the system prompt and `user`. */
  history?: ChatMessage[];
  /** Output per model call. */
  maxOutputTokens?: number;
  /** Stop asking the model once this run has spent this many tokens. */
  tokenLimit?: number;
  /**
   * A last look at what the model is finishing with, for the rules code can check. What
   * this says goes back to the model as that tool's error and it tries again, twice at
   * most. After that the run ends with what it has, so a hard rule still has to be
   * enforced by whoever takes the result.
   */
  checkTerminal?: (args: Record<string, unknown>) => Promise<string | null>;
}): Promise<AgentRun> {
  const model = exceptionAgentModel();
  const maxTurns = args.maxTurns ?? 6;
  const started = Date.now();
  const signal = AbortSignal.timeout(args.timeoutMs ?? 60_000);
  const byName = new Map(args.tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [
    { role: 'system', content: args.system },
    ...(args.history ?? []),
    { role: 'user', content: args.user },
  ];
  let promptTokens = 0;
  let completionTokens = 0;
  let nudged = false;
  let sendBacks = 0;
  let turn = 0;
  const done = (turns: number) => ({ turns, latencyMs: Date.now() - started, promptTokens, completionTokens, model });

  try {
    for (turn = 1; turn <= maxTurns; turn += 1) {
      if (args.tokenLimit !== undefined && promptTokens + completionTokens >= args.tokenLimit) {
        return { ok: false, error: `reached the limit of ${args.tokenLimit} tokens`, stoppedBy: 'tokens', ...done(turn - 1) };
      }
      const reply = await runtime.callModel({ model, messages, tools: args.tools, signal, maxTokens: args.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS });
      promptTokens += reply.usage.promptTokens;
      completionTokens += reply.usage.completionTokens;
      messages.push(reply.message);

      const calls = reply.message.tool_calls ?? [];
      if (calls.length === 0) {
        // Prose instead of a tool call. One reminder, then give up rather than
        // loop on a model that has decided to chat.
        if (nudged) return { ok: false, error: 'the model stopped calling tools', ...done(turn) };
        nudged = true;
        messages.push({ role: 'user', content: 'Use the tools. Finish by calling the terminal tool with your finding.' });
        continue;
      }

      // Run the investigative calls first, in order, so a terminal call made in
      // the same turn can rely on what they returned.
      let terminal: { name: string; args: Record<string, unknown> } | null = null;
      for (const call of calls) {
        const tool = byName.get(call.function.name);
        let parsed: Record<string, unknown> = {};
        try {
          const raw = JSON.parse(call.function.arguments || '{}');
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw as Record<string, unknown>;
        } catch { /* malformed arguments are treated as empty; the tool says what is missing */ }

        if (tool?.terminal) {
          terminal ??= { name: tool.name, args: parsed };
          continue;
        }
        let output: unknown;
        if (!tool?.run) {
          output = { error: `unknown tool ${call.function.name}` };
        } else {
          try {
            output = await tool.run(parsed);
          } catch (error) {
            output = { error: error instanceof Error ? error.message : 'the tool failed' };
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      }
      if (terminal) {
        const problem = sendBacks < MAX_SEND_BACKS && args.checkTerminal ? await args.checkTerminal(terminal.args) : null;
        if (!problem) return { ok: true, terminal, ...done(turn) };
        sendBacks += 1;
        for (const call of calls) {
          if (byName.get(call.function.name)?.terminal) messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: problem }) });
        }
      }
    }
    return { ok: false, error: `no finding after ${maxTurns} turns`, ...done(maxTurns) };
  } catch (error) {
    const message = signal.aborted ? 'the investigation timed out' : error instanceof Error ? error.message : 'the model call failed';
    logger.warn('exception_agent.failed', { label: args.label, message });
    return { ok: false, error: message, ...done(turn) };
  }
}
