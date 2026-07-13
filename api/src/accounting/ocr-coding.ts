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

export type OcrCoding = {
  categoryHint: string | null;
  rationale: string | null;
  suggestions: OcrSuggestion[];
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
export async function matchExpenseAccounts(args: {
  categoryHint: string | null;
  lineItems: { description: string }[];
  accounts: ExpenseAccount[];
}): Promise<{ rationale: string | null; suggestions: OcrSuggestion[] }> {
  const empty = { rationale: null, suggestions: [] as OcrSuggestion[] };
  if (!config.openAiApiKey || args.accounts.length === 0) return empty;
  const hint = args.categoryHint?.trim() || null;
  const items = args.lineItems.map((l) => l.description).filter(Boolean).slice(0, 10);
  if (!hint && items.length === 0) return empty;

  const accountList = args.accounts
    .map((a) => (a.description ? `- ${a.name} — ${a.description}` : `- ${a.name}`))
    .join('\n');
  const prompt =
    `Map this vendor purchase to the best-fitting general-ledger expense account(s).\n\n` +
    `Purchase: ${hint ?? items[0]}\n` +
    (items.length ? `Line items:\n${items.map((d) => `  - ${d}`).join('\n')}\n` : '') +
    `\nExpense accounts (name — description):\n${accountList}\n\n` +
    `Return JSON only:\n` +
    `{ "rationale": "one short sentence on why", "suggestions": [ { "account": "<exact name from the list>", "weight": <0.0-1.0> } ] }\n` +
    `- suggestions: 1-3 accounts, most likely first. weight = your probability this is the correct account.\n` +
    `- Use the EXACT account name from the list. Return suggestions: [] if nothing fits.`;

  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
      body: JSON.stringify({
        model: config.openAiModel,
        max_tokens: 220,
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
    return { rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 200) : null, suggestions: suggestions.slice(0, 3) };
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
      const { rationale, suggestions } = accounts.length
        ? await matchExpenseAccounts({ categoryHint, lineItems: item.lineItems, accounts })
        : { rationale: null, suggestions: [] };
      return { categoryHint, rationale, suggestions };
    }),
  );
}
