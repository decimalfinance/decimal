// What a model call costs, priced from the tokens the provider says it used.
//
// List prices in US dollars per million tokens, checked 2026-11-08: Claude's from
// Anthropic's model reference, gpt-6-luna's from third-party price lists, because
// OpenAI's own page couldn't be reached. A model that isn't listed costs null: a
// price is never guessed.
//
// Cached input is billed differently on each side. Claude bills a cache write at
// 1.25x input (the five-minute cache) and a read at a fraction of it. OpenAI caches
// by itself, charges nothing to write, and bills a read at its cached-input price.

export type Usage = {
  /** Every prompt token, read from a cache or not. */
  promptTokens: number;
  completionTokens: number;
  /** The part of promptTokens read from a cache. */
  cacheReadTokens?: number;
  /** The part of promptTokens written to a cache. Claude reports these; OpenAI doesn't charge for them. */
  cacheWriteTokens?: number;
};

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Price = Rates & { above?: { promptTokens: number } & Rates };

const PER_MILLION: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // Haiku's price rises for a prompt over 100K tokens.
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    above: { promptTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  // So does gpt-6-luna's, for a prompt over 272K tokens.
  'gpt-6-luna': {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.1,
    above: { promptTokens: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.2 },
  },
};

export function costUsd(model: string, usage: Usage): number | null {
  const price = PER_MILLION[model];
  if (!price) return null;
  const rates = price.above && usage.promptTokens > price.above.promptTokens ? price.above : price;
  const read = usage.cacheReadTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, usage.promptTokens - read - written);
  return (fresh * rates.input + read * rates.cacheRead + written * rates.cacheWrite + usage.completionTokens * rates.output) / 1_000_000;
}

/** Two usages as one. */
export function addUsage(a: Usage, b: Usage): Required<Usage> {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

/** Dollars as a person reads them: cents, or a fraction of a cent. */
export function dollars(amount: number | null): string {
  if (amount === null) return 'cost unknown';
  return amount >= 0.01 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}
