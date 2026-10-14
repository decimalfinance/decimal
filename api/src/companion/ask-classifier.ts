// How a new ask lands in someone's inbox item.
//
// Zaid's rule: a person's inbox must never show the same thing twice. When
// someone wants to ask Priya something about a bill, look at what her item for
// that bill already asks of her, and decide:
//
//   covered  everything it asks is already there ("approve BW-2219" when her
//            approval is already waiting) — send nothing, tell the sender she
//            already has it
//   new      anything else — it goes to her as a question on the bill. There
//            is no other kind of ask (nudges were removed on 2026-10-14)
//
// Luna decides; a plain rule decides when no model is set up or the call fails.
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { chatCompletionBody } from '../infra/openai-params.js';

export type AskDecision = { decision: 'covered' | 'new'; note: string };
export type AskInput = { recipientName: string; billLabel: string; existing: string[]; message: string };

let override: ((input: AskInput) => Promise<AskDecision>) | null = null;
/** Replace the classifier in tests. `null` restores the real one. */
export function setAskClassifierForTests(fn: ((input: AskInput) => Promise<AskDecision>) | null) {
  override = fn;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** The rule used when there is no model: exact repeats and approval asks are covered; anything else is new. */
export function classifyAskByRule(input: AskInput): AskDecision {
  const msg = norm(input.message);
  const already = input.existing.map(norm);
  if (already.some((e) => e === msg || (e.length > 12 && (e.includes(msg) || msg.includes(e))))) {
    return { decision: 'covered', note: `${input.recipientName} has already been asked this.` };
  }
  const aboutApproving = /\b(approve|approval|sign off|signoff)\b/.test(msg) && !/\b(check|verify|confirm|look at|review)\b/.test(msg);
  if (aboutApproving && already.some((e) => /\byour approval\b/.test(e))) {
    return { decision: 'covered', note: `${input.recipientName}'s approval is already waiting on this bill.` };
  }
  return { decision: 'new', note: `Goes to ${input.recipientName} as a question on the bill.` };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'note'],
  properties: {
    decision: { type: 'string', enum: ['covered', 'new'] },
    note: { type: 'string', description: 'One short sentence for the person sending it, e.g. "Priya already has this: her approval has been waiting 2 days."' },
  },
};

export async function classifyAsk(input: AskInput): Promise<AskDecision> {
  if (override) return override(input);
  if (!config.openAiApiKey) return classifyAskByRule(input);
  const existing = input.existing.length ? input.existing.map((e) => `- ${e}`).join('\n') : '- (nothing yet)';
  const prompt = `${input.recipientName}'s inbox item for ${input.billLabel} currently asks them to:\n${existing}\n\nA colleague wants to ask ${input.recipientName}: "${input.message}"\n\nDecide:\n- covered: everything this asks is already in the item (for example asking them to approve when their approval is already waiting). Nothing new would be sent.\n- new: anything else. It goes to them as a question on the bill.\nThen write a one-sentence note for the colleague sending it, in the third person about ${input.recipientName}. For covered, say what ${input.recipientName} already has, e.g. "${input.recipientName}'s approval on this bill is already waiting, so there is nothing new to send." For new, say it goes to them as a question. Never say it holds or stops the bill: nothing does.`;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
      body: JSON.stringify(chatCompletionBody({
        model: config.openAiAgentModel || config.openAiModel,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: 'You keep a colleague\'s inbox free of repeats. Answer with JSON only.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'ask_decision', strict: true, schema: SCHEMA } },
      })),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as Partial<AskDecision>;
    if (parsed.decision !== 'covered' && parsed.decision !== 'new') throw new Error('bad decision');
    return { decision: parsed.decision, note: String(parsed.note ?? '').slice(0, 240) || classifyAskByRule(input).note };
  } catch (error) {
    logger.warn('ask_classifier.fallback', { ...(error instanceof Error ? { message: error.message } : {}) });
    return classifyAskByRule(input);
  }
}
