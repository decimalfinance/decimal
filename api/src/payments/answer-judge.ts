// Did this message answer a question on the bill?
//
// A bill's conversation is a group chat (Zaid, 2026-10-21). Zara asks
// "@Marcus Bell are Northwind's details correct?", and the question is put to
// Marcus, but nobody clicks Answer: whoever knows simply says so. Marcus may
// reply, or Tom may, and Decimal judges whether the message answers it. So
// each message sent on a bill with an open question is read once, against
// those questions, and for each one comes back as:
//
//   answers      it gives what the question asked for. Anyone who works on
//                bills may answer; the person who asked cannot.
//   cant_answer  the person asked says they don't know. It goes back to the
//                asker.
//   withdraws    the person who asked no longer needs it: they found it, or
//                it sorted itself out.
//   none         anything else: a follow-up, "let me check", thanks, or
//                talk about something else.
//
// This is not the model-in-the-path-of-every-save that question-settle.ts
// refuses. It reads messages, not edits, only on bills with an open question,
// and what it decides moves no money: a question holds nothing, so marking one
// answered changes who is waiting on whom and nothing else.
//
// Luna decides; a plain rule decides when no model is set up or the call fails:
// whatever the person asked says counts as their answer, which is how the
// conversation read before anything judged it.
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { chatCompletionBody } from '../infra/openai-params.js';

export type AnswerVerdict = 'answers' | 'cant_answer' | 'withdraws' | 'none';
/** Who the sender is to one question. */
export type SenderRole = 'asked' | 'asker' | 'other';

export type JudgeInput = {
  billLabel: string;
  senderName: string;
  message: string;
  questions: Array<{
    billQuestionId: string;
    askedByName: string;
    askedOfName: string;
    question: string;
    senderRole: SenderRole;
  }>;
};
export type JudgeOutput = Array<{ billQuestionId: string; verdict: AnswerVerdict }>;

let override: ((input: JudgeInput) => Promise<JudgeOutput>) | null = null;
/** Replace the judge in tests. `null` restores the real one. */
export function setAnswerJudgeForTests(fn: ((input: JudgeInput) => Promise<JudgeOutput>) | null) {
  override = fn;
}

/** What each sender may do to a question, whatever the judge says. */
export function allowed(role: SenderRole, verdict: AnswerVerdict): boolean {
  if (verdict === 'answers') return role !== 'asker';
  if (verdict === 'cant_answer') return role === 'asked';
  if (verdict === 'withdraws') return role === 'asker';
  return true;
}

/** The rule used when there is no model: the person asked answers what was put to them. */
export function judgeByRule(input: JudgeInput): JudgeOutput {
  return input.questions.map((q) => ({
    billQuestionId: q.billQuestionId,
    verdict: q.senderRole === 'asked' ? 'answers' : 'none',
  }));
}

const VERDICTS: AnswerVerdict[] = ['answers', 'cant_answer', 'withdraws', 'none'];

function schemaFor(count: number) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        description: `One entry per open question, ${count} in all.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'verdict'],
          properties: {
            question: { type: 'integer', description: 'The question number from the list.' },
            verdict: { type: 'string', enum: VERDICTS },
          },
        },
      },
    },
  };
}

const ROLE_WORDS: Record<SenderRole, string> = {
  asked: 'the person this question was put to',
  asker: 'the person who asked it',
  other: 'someone else on the team, who may answer it too',
};

export async function judgeAnswer(input: JudgeInput): Promise<JudgeOutput> {
  const sane = (out: JudgeOutput) => out
    .filter((v) => input.questions.some((q) => q.billQuestionId === v.billQuestionId))
    .map((v) => {
      const q = input.questions.find((x) => x.billQuestionId === v.billQuestionId)!;
      return { billQuestionId: v.billQuestionId, verdict: allowed(q.senderRole, v.verdict) ? v.verdict : 'none' as const };
    });
  if (input.questions.length === 0) return [];
  if (override) return sane(await override(input));
  if (!config.openAiApiKey) return judgeByRule(input);

  const list = input.questions
    .map((q, i) => `${i + 1}. ${q.askedByName} asked ${q.askedOfName}: "${q.question}". ${input.senderName} is ${ROLE_WORDS[q.senderRole]}.`)
    .join('\n');
  const prompt = `The team is talking about the bill ${input.billLabel}. Open questions on it:\n${list}\n\n${input.senderName} just wrote: "${input.message}"\n\nFor each question, decide what this message does to it:\n- answers: it gives what the question asks for: a fact, a yes or no, a confirmation, a decision. Anyone may answer except the person who asked.\n- cant_answer: only from the person the question was put to: they say they don't know or can't answer it.\n- withdraws: only from the person who asked: they no longer need it (they found it, never mind, it is sorted).\n- none: anything else: a follow-up question, "let me check", thanks, or talk about something else.\nJudge from the words alone. When unsure, none.`;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
      body: JSON.stringify(chatCompletionBody({
        model: config.openAiAgentModel || config.openAiModel,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: 'You read a team\'s chat about one bill and say whether a new message settles the questions still open on it. Answer with JSON only.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'answer_verdicts', strict: true, schema: schemaFor(input.questions.length) } },
      })),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as { verdicts?: Array<{ question?: unknown; verdict?: unknown }> };
    const out: JudgeOutput = [];
    for (const v of parsed.verdicts ?? []) {
      const q = typeof v.question === 'number' ? input.questions[v.question - 1] : undefined;
      if (!q || !VERDICTS.includes(v.verdict as AnswerVerdict)) continue;
      if (out.some((o) => o.billQuestionId === q.billQuestionId)) continue;
      out.push({ billQuestionId: q.billQuestionId, verdict: v.verdict as AnswerVerdict });
    }
    return sane(out);
  } catch (error) {
    logger.warn('answer_judge.fallback', { ...(error instanceof Error ? { message: error.message } : {}) });
    return judgeByRule(input);
  }
}
