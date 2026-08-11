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
//   1. Closed vocabulary. The model may only return keys the review screen can
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

/** Every field the review screen renders and can highlight. */
export const HIGHLIGHTABLE_FIELDS = [
  'vendor.name', 'vendor.email',
  'remitTo.street', 'remitTo.city', 'remitTo.state', 'remitTo.zip',
  'invoiceNumber', 'invoiceDate', 'dueDate', 'terms', 'poNumber',
  'discount', 'currency', 'total', 'lineItems',
] as const;

export type HighlightableField = (typeof HIGHLIGHTABLE_FIELDS)[number];

const PROMPT = `You map a colleague's question about an invoice to the form fields it concerns.

Return ONLY JSON: {"fields": ["..."]}

Choose zero or more from this exact list, and nothing else:
${HIGHLIGHTABLE_FIELDS.join(', ')}

Rules:
- Pick the fields the asker wants checked or filled. "Confirm the vendor details" means the vendor's name, email and address fields.
- Prefer FEWER, more precise fields. Highlighting everything is the same as highlighting nothing.
- If the question is not about any specific field (for example "is this ours to pay?"), return an empty list.
- Never invent a field name. Anything outside the list is discarded.`;

/**
 * Best-effort. Callers must treat [] as "no highlight" rather than an error —
 * a question that arrives without a mapping is still a perfectly good question.
 */
export async function fieldsForQuestion(question: string): Promise<HighlightableField[]> {
  if (!config.openAiApiKey) return [];
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
          { role: 'user', content: question.slice(0, 500) },
        ],
      }),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const raw = body.choices?.[0]?.message?.content;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { fields?: unknown };
    if (!Array.isArray(parsed.fields)) return [];
    // The closed vocabulary is enforced HERE, not in the prompt. A prompt is a
    // request; this is the guarantee.
    const allowed = new Set<string>(HIGHLIGHTABLE_FIELDS);
    return [...new Set(parsed.fields.filter((f): f is HighlightableField => typeof f === 'string' && allowed.has(f)))];
  } catch (error) {
    logger.warn('question_fields.map_failed', {
      ...(error instanceof Error ? { message: error.message } : {}),
    });
    return [];
  }
}
