// One place that knows what each OpenAI model accepts on Chat Completions.
//
// The GPT-5/6 family (gpt-6-luna and friends) are reasoning models, and they
// differ from gpt-4.1-mini in three ways that each fail a request outright:
//
//   - `max_tokens` is rejected; the limit is `max_completion_tokens`, and the
//     model's own reasoning is counted against it, so it needs headroom.
//   - Function tools are only accepted with `reasoning_effort: 'none'` on
//     Chat Completions (tools with reasoning need the Responses API).
//   - `temperature: 0` is only accepted with reasoning off.
//
// Every call site builds its body as it always did and passes it through here,
// so switching models is a config change, not an edit in five files.
// Probed against the live API on 2026-09-30.

type Body = Record<string, unknown> & { model: string };

/** Extra output budget for the model's reasoning when it is on. */
const REASONING_HEADROOM = 4000;

export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|gpt-6|o\d)/.test(model);
}

export function chatCompletionBody(body: Body, opts: { effort?: 'none' | 'low' | 'medium' | 'high' } = {}): Body {
  if (!isReasoningModel(body.model)) return body;
  const { max_tokens: maxTokens, temperature, ...rest } = body;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const effort = hasTools ? 'none' : (opts.effort ?? 'low');
  const limit = typeof maxTokens === 'number' ? maxTokens : undefined;
  return {
    ...rest,
    reasoning_effort: effort,
    ...(effort === 'none' && temperature !== undefined ? { temperature } : {}),
    ...(limit !== undefined ? { max_completion_tokens: effort === 'none' ? limit : limit + REASONING_HEADROOM } : {}),
  };
}
