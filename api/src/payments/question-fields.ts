// Map a question to the fields it is about.
//
// "Can you confirm the vendor details?" should light up Street, City, State and
// ZIP on the person's screen — not leave them reading a sentence and hunting.
// This is the part of the job a model is genuinely good at and a human finds
// tedious: routing attention. Extraction is table stakes; knowing WHERE to look
// is not.
//
// Two rules shape everything here:
//
//   1. Closed vocabulary. The model may only return keys the draft screen can
//      actually highlight. Anything else is dropped rather than trusted, so a
//      hallucinated field name can never point somebody at nothing.
//   2. Empty is a safe answer, a wrong one is not. If the mapping fails, is
//      unparseable, or the model is not configured, we return nothing and the
//      screen behaves exactly as it does today. Highlighting the WRONG fields
//      would be worse than highlighting none, because it actively directs
//      attention away from what was asked.
import { config } from '../config.js';
import { logger } from '../infra/logger.js';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

/** Every field the draft screen renders and can highlight. */
export const HIGHLIGHTABLE_FIELDS = [
  'vendor.name', 'vendor.email',
  'remitTo.street', 'remitTo.city', 'remitTo.state', 'remitTo.zip',
  'invoiceNumber', 'invoiceDate', 'dueDate', 'terms', 'poNumber',
  'discount', 'currency', 'total', 'lineItems',
] as const;

export type HighlightableField = (typeof HIGHLIGHTABLE_FIELDS)[number];

/**
 * How much of the question a flag's own resolution would answer.
 *
 * "Please resolve this flag" is covered: settle the flag and there is nothing
 * left. "Is this ours, and should we keep paying them?" is not — clearing the
 * flag answers half of it, and closing the question there would drop the rest
 * with no trace.
 *
 * Judged ONCE, when the question is written, and stored on the question. That
 * placement is the whole design: it is a question about LANGUAGE — what did
 * this sentence ask? — not about state, and asking it per edit would make the
 * cost scale with edits, put a model in the path of every save, and leave an
 * audit trail where the same edit might settle a question today and not
 * tomorrow. Stored, resolution stays a join and stays replayable.
 */
export type QuestionScope = 'covered_by_flag' | 'asks_more';

const PROMPT = `You map a colleague's question about an invoice to the form fields it concerns.

Return ONLY JSON: {"fields": ["..."], "coveredByFlag": true|false}

Choose zero or more from this exact list, and nothing else:
${HIGHLIGHTABLE_FIELDS.join(', ')}

Rules:
- Pick the fields the asker wants checked or filled. "Confirm the vendor details" means the vendor's name, email and address fields.
- Prefer FEWER, more precise fields. Highlighting everything is the same as highlighting nothing.
- If the question is not about any specific field (for example "is this ours to pay?"), return an empty list.
- Never invent a field name. Anything outside the list is discarded.

You are also told which CHECK the question was raised from, if any. Set
"coveredByFlag" to true only when settling that check would answer the whole
question and leave nothing outstanding — "can you sort this out", "please
resolve this flag", "is this one ok?".

Set it to false when the question asks for anything beyond the check: a second
question, a judgement about the vendor, an instruction, or anything the check's
own resolution would not address. When unsure, answer false — a person writing
one more sentence costs less than a concern disappearing.`;

/**
 * Best-effort. Callers must treat [] as "no highlight" rather than an error —
 * a question that arrives without a mapping is still a perfectly good question.
 *
 * `scope` follows the same rule in the direction that matters: every failure
 * path returns 'asks_more', which means the question waits for a person. The
 * module's existing principle, applied to a second output — a wrong answer here
 * closes somebody's concern without addressing it, and no answer merely leaves
 * the product behaving as it does today.
 */
export async function fieldsForQuestion(
  question: string,
  /** The check this was raised from, when it came off a flag. */
  aboutFlag?: string | null,
): Promise<{ fields: HighlightableField[]; scope: QuestionScope }> {
  // No flag means nothing could settle it by deed, so there is nothing to judge.
  const unjudged = { fields: [] as HighlightableField[], scope: 'asks_more' as QuestionScope };
  if (!config.openAiApiKey) return unjudged;
  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
      body: JSON.stringify({
        model: config.openAiModel,
        max_tokens: 200,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PROMPT },
          {
            role: 'user',
            content: aboutFlag
              ? `Check raised: ${aboutFlag}\n\nQuestion: ${question.slice(0, 500)}`
              : `Check raised: none\n\nQuestion: ${question.slice(0, 500)}`,
          },
        ],
      }),
    });
    if (!response.ok) return unjudged;
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const raw = body.choices?.[0]?.message?.content;
    if (!raw) return unjudged;
    const parsed = JSON.parse(raw) as { fields?: unknown; coveredByFlag?: unknown };
    // The closed vocabulary is enforced HERE, not in the prompt. A prompt is a
    // request; this is the guarantee.
    const allowed = new Set<string>(HIGHLIGHTABLE_FIELDS);
    const fields = Array.isArray(parsed.fields)
      ? [...new Set(parsed.fields.filter((f): f is HighlightableField => typeof f === 'string' && allowed.has(f)))]
      : [];
    // Only an explicit true, and only when there was a check to be covered BY.
    const scope: QuestionScope = aboutFlag && parsed.coveredByFlag === true
      ? 'covered_by_flag'
      : 'asks_more';
    return { fields, scope };
  } catch (error) {
    logger.warn('question_fields.map_failed', {
      ...(error instanceof Error ? { message: error.message } : {}),
    });
    return unjudged;
  }
}
