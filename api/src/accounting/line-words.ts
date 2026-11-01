// What a bill line says, as words to compare: the same purchase reads the same once
// quantities, dates and months are gone. Learning from Decimal's own bills and
// studying a company's past bills both go by this.

const MONTHS = new Set(['jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july',
  'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december']);
const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'to', 'in', 'on', 'with', 'per', 'x', 'at', 'by', 'from', 'qty', 'ea', 'each']);

/** The words that say what a line is: lower-cased, singular, without quantities, dates or months. */
export function lineTokens(description: string): Set<string> {
  const words = description.toLowerCase()
    .replace(/\([^)]*\d[^)]*\)/g, ' ')          // "(8)", "(4 assets)"
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !/\d/.test(w) && !MONTHS.has(w) && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return new Set(words);
}

/** One key per kind of line: its words, sorted. */
export function lineKey(description: string): string {
  return [...lineTokens(description)].sort().join(' ');
}

export function lineSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}
