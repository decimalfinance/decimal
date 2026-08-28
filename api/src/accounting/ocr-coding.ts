// OCR-driven coding suggestion. At invoice intake we already OCR the document; this
// module turns "what the spend is for" (the extracted categoryHint + line items) into
// ranked, weighted expense-account suggestions by mapping it against the org's chart of
// accounts (names + descriptions) with the model. The result is stashed on the payment
// and surfaced as candidates in the coding inbox — the document's signal for cold-start
// vendors with no coding history yet.
//
// Deliberately document-only: vendor history is a SEPARATE, deterministic signal that
// the candidate ranker already places above these (memory/rules beat the model), so we
// don't feed history in here and double-count it.

import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { getQuickBooksForOrg } from './connections.js';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

export interface ExpenseAccount {
  id: string;
  name: string;
  description?: string | null;
}

export interface ChartAccount {
  id: string;
  name: string;
  acctNum: string | null;
  fullyQualifiedName: string;
  accountType: string;
  classification: string;
}

export type OcrSuggestion = { accountId: string; accountName: string; weight: number };

/**
 * One line's own account. The bill-level suggestion answers "what is this
 * invoice for"; this answers "what is THIS line for", which is a different
 * question on any invoice carrying more than one kind of spend.
 */
export type OcrLineCoding = {
  index: number;
  accountId: string;
  accountName: string;
  weight: number;
  why: string | null;
};

export type OcrCoding = {
  categoryHint: string | null;
  rationale: string | null;
  suggestions: OcrSuggestion[];
  lines: OcrLineCoding[];
};

/** The org's FULL active chart of accounts from QuickBooks; [] if not connected. */
export async function listChartOfAccounts(organizationId: string): Promise<ChartAccount[]> {
  const qb = await getQuickBooksForOrg(organizationId);
  if (!qb) return [];
  try {
    const resp = await qb.query('SELECT * FROM Account WHERE Active = true MAXRESULTS 1000');
    const accounts = (resp.QueryResponse?.Account ?? []) as Array<{
      Id: string; Name: string; AcctNum?: string; FullyQualifiedName?: string;
      AccountType?: string; Classification?: string; Description?: string;
    }>;
    return accounts.map((a) => ({
      id: a.Id,
      name: a.Name,
      acctNum: a.AcctNum ?? null,
      fullyQualifiedName: a.FullyQualifiedName ?? a.Name,
      accountType: a.AccountType ?? 'Other',
      classification: a.Classification ?? 'Other',
    }));
  } catch (error) {
    logger.warn('ocr_coding.list_accounts_failed', { organizationId, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** Expense-classification accounts only — what AI coding suggestions target. */
export async function listExpenseAccounts(organizationId: string): Promise<ExpenseAccount[]> {
  const chart = await listChartOfAccounts(organizationId);
  return chart
    .filter((a) => a.classification === 'Expense')
    .map((a) => ({ id: a.id, name: a.name, description: null }));
}

/**
 * Ask the model to map a purchase to the best-fitting expense account(s), returning a
 * one-line rationale and 1-3 ranked suggestions, each with a weight (its confidence that
 * account is correct, 0-1). Constrained to the provided account names so it can't invent
 * an account. Returns no suggestions when nothing fits or the model is unavailable.
 */
// How many invoice lines are put in front of the model at once. Descriptions
// are short, so this is a context-window guard rather than a cost one.
const MAX_CODED_LINES = 100;

export async function matchExpenseAccounts(args: {
  categoryHint: string | null;
  lineItems: { description: string }[];
  accounts: ExpenseAccount[];
}): Promise<{ rationale: string | null; suggestions: OcrSuggestion[]; lines: OcrLineCoding[] }> {
  const empty = { rationale: null, suggestions: [] as OcrSuggestion[], lines: [] as OcrLineCoding[] };
  if (!config.openAiApiKey || args.accounts.length === 0) return empty;
  const hint = args.categoryHint?.trim() || null;
  const all = args.lineItems.map((l) => l.description).filter(Boolean);
  // Ten was far too few and said nothing about it. D1 is a 22-line cloud bill,
  // and per-line coding is the entire reason that invoice exists — twelve of
  // its lines were never sent to the model at all, and the screen showed the
  // result as though every line had been considered.
  //
  // A cap still belongs here: a thousand-line invoice would blow the context
  // window. It is now high enough that a real invoice reaches it rarely, and it
  // says so out loud when it bites, because a coverage limit that nobody can
  // see reads as "all of this was coded" when it was not.
  const items = all.slice(0, MAX_CODED_LINES);
  if (all.length > items.length) {
    logger.warn('ocr_coding.lines_truncated', { total: all.length, coded: items.length });
  }
  if (!hint && items.length === 0) return empty;

  const accountList = args.accounts
    .map((a) => (a.description ? `- ${a.name} — ${a.description}` : `- ${a.name}`))
    .join('\n');
  // Both questions in one call: what the invoice is for, and what each line is
  // for. They are genuinely different — an ocean-freight invoice can carry a
  // legal review and contract labour — and asking only the first meant every
  // line inherited one answer, which is how a font licence and a photography
  // licence ended up sharing a category with everything else on the bill.
  const prompt =
    `Code a vendor invoice to general-ledger expense accounts.\n\n` +
    `Purchase: ${hint ?? items[0]}\n` +
    (items.length ? `Lines:\n${items.map((d, i) => `  ${i}. ${d}`).join('\n')}\n` : '') +
    `\nExpense accounts (name — description):\n${accountList}\n\n` +
    `Return JSON only:\n` +
    `{ "rationale": "one short sentence on why",\n` +
    `  "suggestions": [ { "account": "<exact name from the list>", "weight": <0.0-1.0> } ],\n` +
    `  "lines": [ { "index": <line number>, "account": "<exact name from the list>", "weight": <0.0-1.0>, "why": "<a few words>" } ] }\n` +
    `- suggestions: 1-3 accounts for the invoice as a whole, most likely first.\n` +
    `- lines: one entry per line above, in order. Judge each line ON ITS OWN.\n` +
    `- Lines on one invoice often belong to DIFFERENT accounts. Do not assume they match each other or the invoice as a whole.\n` +
    `- Match on the account DESCRIPTION, not on words it happens to share with a line. A software licence is not a government licence.\n` +
    `- Use the EXACT account name from the list. Omit a line, or return suggestions: [], if nothing fits.`;

  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
      body: JSON.stringify({
        model: config.openAiModel,
        // Sized to the invoice, because the answer grows with it.
        //
        // This was a flat 900, chosen for a ten-line invoice — the same ten the
        // input was capped at. The two numbers were a matched pair and nothing
        // said so, so lifting the input cap alone truncated the reply mid-array
        // and the JSON failed to parse. That is worse than the bug it replaced:
        // ten lines coded became NONE coded.
        //
        // A per-line entry — index, account name, weight, a few words of why —
        // runs about 45 tokens, plus room for the rationale and the bill-level
        // suggestions.
        max_tokens: Math.min(4000, 300 + items.length * 45),
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You map purchases to GL expense accounts. Respond with JSON only, using exact account names from the provided list.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!response.ok) return empty;
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const raw = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as {
      rationale?: unknown;
      suggestions?: Array<{ account?: unknown; weight?: unknown }>;
      lines?: Array<{ index?: unknown; account?: unknown; weight?: unknown; why?: unknown }>;
    };
    const byName = new Map<string, ExpenseAccount>();
    for (const a of args.accounts) byName.set(a.name.toLowerCase(), a);
    const suggestions: OcrSuggestion[] = [];
    for (const s of raw.suggestions ?? []) {
      const acct = byName.get(String(s.account ?? '').trim().toLowerCase());
      if (!acct || suggestions.some((x) => x.accountId === acct.id)) continue;
      const weight = Math.max(0, Math.min(1, Number(s.weight) || 0));
      suggestions.push({ accountId: acct.id, accountName: acct.name, weight });
    }
    suggestions.sort((a, b) => b.weight - a.weight);

    // Per-line answers, constrained the same way: an account the model did not
    // pick from the list is not an account, and an index outside the invoice is
    // not a line.
    const lines: OcrLineCoding[] = [];
    for (const l of raw.lines ?? []) {
      const index = Number(l.index);
      if (!Number.isInteger(index) || index < 0 || index >= items.length) continue;
      if (lines.some((x) => x.index === index)) continue;
      const acct = byName.get(String(l.account ?? '').trim().toLowerCase());
      if (!acct) continue;
      lines.push({
        index,
        accountId: acct.id,
        accountName: acct.name,
        weight: Math.max(0, Math.min(1, Number(l.weight) || 0)),
        why: typeof l.why === 'string' ? l.why.slice(0, 120) : null,
      });
    }
    lines.sort((a, b) => a.index - b.index);

    return {
      rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 200) : null,
      suggestions: suggestions.slice(0, 3),
      lines,
    };
  } catch (error) {
    logger.warn('ocr_coding.match_failed', { error: error instanceof Error ? error.message : String(error) });
    return empty;
  }
}

/**
 * For a batch of extracted invoices, suggest weighted accounts per item. Fetches the
 * chart once. Returns null for items with no usable signal.
 */
export async function suggestOcrCodings(
  organizationId: string,
  items: Array<{ categoryHint: string | null; lineItems: { description: string }[] }>,
): Promise<Array<OcrCoding | null>> {
  const hasAnySignal = items.some((i) => i.categoryHint?.trim() || i.lineItems.length > 0);
  const qboAccounts = hasAnySignal ? await listExpenseAccounts(organizationId) : [];
  // No books connected yet → suggest against the builtin standard chart so
  // coding works from day one (the real chart takes over once connected).
  const { DEFAULT_EXPENSE_ACCOUNTS } = await import('./default-chart.js');
  const accounts = qboAccounts.length > 0 ? qboAccounts : (hasAnySignal ? DEFAULT_EXPENSE_ACCOUNTS : []);
  return Promise.all(
    items.map(async (item): Promise<OcrCoding | null> => {
      const categoryHint = item.categoryHint?.trim() || null;
      if (!categoryHint && item.lineItems.length === 0) return null;
      const { rationale, suggestions, lines } = accounts.length
        ? await matchExpenseAccounts({ categoryHint, lineItems: item.lineItems, accounts })
        : { rationale: null, suggestions: [], lines: [] };
      return { categoryHint, rationale, suggestions, lines };
    }),
  );
}
