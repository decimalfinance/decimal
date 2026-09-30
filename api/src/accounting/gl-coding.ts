// GL coding: predict which expense account a payment should post to, learned from
// how this vendor's prior payments were coded, and persist the operator's decision.
// Phase 1 of the coding agent: per-vendor memory lookup (the QuickBooks finding that
// reusing the customer's own past coding beats a model). No LLM. The persisted row
// doubles as the decision log (predicted vs confirmed, source, confidence, override).
// Repeated decisions promote into per-vendor memory in `vendor_coding_rules`.

import { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';

const PROVIDER = 'quickbooks';
// Drop OCR suggestions the model is barely confident about — let frequency/default fill in.
const MIN_OCR_WEIGHT = 0.15;
type OcrCodingShape = {
  rationale?: string | null;
  suggestions?: Array<{ accountId: string; accountName: string | null; weight: number }>;
  // legacy single-suggestion shape, for payments coded before weighted suggestions existed
  suggestedAccountId?: string | null;
  suggestedAccountName?: string | null;
};

export interface GlCodingPrediction {
  codedExpenseAccountId: string | null;
  codedExpenseAccountName: string | null;
  predictionSource: 'vendor_rule' | 'vendor_history' | 'default' | 'none';
  confidenceScore: number | null;
  supportCount: number; // how many prior codings backed the suggestion
}

/**
 * Predict the expense account for a payment: the most-common account this vendor's
 * prior payments were coded to (confidence = its share), else the org default.
 */
/**
 * Predict, and record what we predicted.
 *
 * The prediction is logged BEFORE anyone sees it, whatever they do next. Storing
 * only the code that ends up on the bill makes "we suggested it", "we suggested
 * something else and were overridden" and "nobody consulted us" the same row —
 * and none of that is recoverable afterwards. GL coding is the biggest source of
 * suggestions in the product and was the one not recording any of this.
 */
export async function predictGlExpenseAccount(
  organizationId: string,
  paymentOrderId: string,
): Promise<GlCodingPrediction> {
  const prediction = await predictGlExpenseAccountInner(organizationId, paymentOrderId);
  if (prediction.codedExpenseAccountName) {
    const { logSuggestion } = await import('../payments/suggestion-log.js');
    await logSuggestion({
      organizationId,
      stage: 'gl_coding',
      subjectType: 'payment_order',
      subjectId: paymentOrderId,
      suggested: {
        accountId: prediction.codedExpenseAccountId,
        accountName: prediction.codedExpenseAccountName,
      },
      confidence: prediction.confidenceScore,
      // The waterfall step that won — a rule, vendor memory, or the model. A
      // change in accuracy should be attributable to which arm produced it.
      producer: `gl-coding/${prediction.predictionSource}`,
      inputs: { supportCount: prediction.supportCount },
    });
  }
  return prediction;
}

async function predictGlExpenseAccountInner(
  organizationId: string,
  paymentOrderId: string,
): Promise<GlCodingPrediction> {
  const order = await prisma.paymentOrder.findFirst({
    where: { paymentOrderId, organizationId },
    include: { counterparty: true, counterpartyWallet: true },
  });
  if (!order) return { codedExpenseAccountId: null, codedExpenseAccountName: null, predictionSource: 'none', confidenceScore: null, supportCount: 0 };

  const vendorLabel = order.counterparty?.displayName ?? order.counterpartyWallet?.label ?? null;
  // The vendor's coding RULE outranks raw history — it IS the consolidated,
  // inspectable form of that history (or a person's explicit instruction).
  if (order.counterpartyId) {
    const rule = await getVendorCodingRule(organizationId, order.counterpartyId);
    if (rule) {
      return {
        codedExpenseAccountId: rule.accountId,
        codedExpenseAccountName: rule.accountName,
        predictionSource: 'vendor_rule',
        confidenceScore: rule.source === 'manual' ? 1 : null,
        supportCount: rule.learnedFromCount,
      };
    }
  }
  // Match this vendor's prior codings: by counterparty when we have one (most precise),
  // else by the wallet label that the sync uses as the QBO vendor name.
  const vendorFilter = order.counterpartyId
    ? { counterpartyId: order.counterpartyId }
    : vendorLabel
      ? { counterpartyWallet: { label: vendorLabel } }
      : null;

  if (vendorFilter) {
    const past = await prisma.paymentOrderGlCoding.findMany({
      where: { organizationId, provider: PROVIDER, paymentOrderId: { not: paymentOrderId }, paymentOrder: vendorFilter },
      select: { codedExpenseAccountId: true, codedExpenseAccountName: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    if (past.length > 0) {
      const counts = new Map<string, { n: number; name: string | null }>();
      for (const p of past) {
        const cur = counts.get(p.codedExpenseAccountId) ?? { n: 0, name: p.codedExpenseAccountName };
        counts.set(p.codedExpenseAccountId, { n: cur.n + 1, name: cur.name ?? p.codedExpenseAccountName });
      }
      const [topId, top] = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      return {
        codedExpenseAccountId: topId,
        codedExpenseAccountName: top.name,
        predictionSource: 'vendor_history',
        confidenceScore: top.n / past.length,
        supportCount: past.length,
      };
    }
  }

  // Cold start: fall back to the org's default expense account.
  const map = await prisma.accountingAccountMap.findFirst({ where: { organizationId, provider: PROVIDER } });
  if (map?.defaultExpenseAccountId) {
    return {
      codedExpenseAccountId: map.defaultExpenseAccountId,
      codedExpenseAccountName: map.defaultExpenseAccountName ?? null,
      predictionSource: 'default',
      confidenceScore: null,
      supportCount: 0,
    };
  }
  return { codedExpenseAccountId: null, codedExpenseAccountName: null, predictionSource: 'none', confidenceScore: null, supportCount: 0 };
}

export interface CodedLine {
  accountId: string;
  accountName?: string | null;
  amount: number;
  description?: string | null;
}

export interface SetGlCodingInput {
  /** Coded lines (account + amount + description), summing to the payment amount. */
  lines?: CodedLine[];
  /** Single-account shorthand (a one-line coding for the full amount). */
  codedExpenseAccountId?: string;
  codedExpenseAccountName?: string | null;
  /** What the agent suggested (so we can record whether the operator overrode it). */
  predictedAccountId?: string | null;
  predictedAccountName?: string | null;
  predictionSource?: string | null;
  confidenceScore?: number | null;
  /** Operator overrides for the Bill header (vendor name, invoice #, bill date). */
  billHeader?: { vendorName?: string | null; invoiceNumber?: string | null; billDate?: string | null };
  /** One sentence on WHY the suggestion was overridden — low friction, high
   *  signal; rides the decision log and informs the vendor rule. */
  correctionNote?: string | null;
}

/** Persist the operator's coded lines for a payment (the sync builds the Bill from them). */
export async function setPaymentOrderGlCoding(
  organizationId: string,
  paymentOrderId: string,
  input: SetGlCodingInput,
  actorUserId: string | null,
) {
  let lines = input.lines?.filter((l) => l.accountId) ?? [];
  if (lines.length === 0) {
    if (!input.codedExpenseAccountId) throw new Error('A coding needs at least one account.');
    const order = await prisma.paymentOrder.findFirst({ where: { paymentOrderId, organizationId }, select: { amountRaw: true } });
    const amount = order ? Number(order.amountRaw) / 1e6 : 0;
    lines = [{ accountId: input.codedExpenseAccountId, accountName: input.codedExpenseAccountName ?? null, amount, description: null }];
  }
  // What the operator did with the suggestion. Matched against the most recent
  // gl_coding suggestion for this bill rather than a threaded id, because the
  // caller does not carry one — good enough to learn from, and it costs nothing
  // when there was no suggestion to override.
  try {
    const { logSuggestionOutcome } = await import('../payments/suggestion-log.js');
    const last = await prisma.aiSuggestion.findFirst({
      where: { organizationId, stage: 'gl_coding', subjectId: paymentOrderId },
      orderBy: { createdAt: 'desc' },
      select: { aiSuggestionId: true, suggested: true },
    });
    if (last) {
      const proposed = (last.suggested ?? {}) as { accountId?: string | null };
      const suggestedId = proposed.accountId ?? '';
      const chosenId = lines[0]?.accountId ?? input.codedExpenseAccountId ?? '';
      await logSuggestionOutcome({
        aiSuggestionId: last.aiSuggestionId,
        // 'edited' is the informative one: the delta between what we proposed
        // and what they kept is the only thing that says where we were wrong.
        outcome: chosenId && suggestedId === chosenId ? 'accepted' : 'edited',
        finalValue: { accountId: chosenId, accountName: lines[0]?.accountName ?? input.codedExpenseAccountName ?? null },
        decidedByUserId: actorUserId,
      });
    }
  } catch {
    // Instrumentation must never block someone coding a bill.
  }

  // normalize: 2dp amounts, trimmed descriptions
  const normalized = lines.map((l) => ({
    accountId: l.accountId,
    accountName: l.accountName ?? null,
    amount: Math.round((Number(l.amount) || 0) * 100) / 100,
    description: (l.description ?? '').trim() || null,
  }));
  const primary = normalized[0];
  const wasOverridden = !!input.predictedAccountId && input.predictedAccountId !== primary.accountId;
  const data = {
    organizationId,
    codedExpenseAccountId: primary.accountId,
    codedExpenseAccountName: primary.accountName,
    lines: normalized as unknown as Prisma.InputJsonValue,
    billHeader: {
      vendorName: input.billHeader?.vendorName?.trim() || null,
      invoiceNumber: input.billHeader?.invoiceNumber?.trim() || null,
      billDate: input.billHeader?.billDate?.trim() || null,
    } as unknown as Prisma.InputJsonValue,
    predictedAccountId: input.predictedAccountId ?? null,
    predictedAccountName: input.predictedAccountName ?? null,
    predictionSource: input.predictionSource ?? null,
    confidenceScore: input.confidenceScore ?? null,
    wasOverridden,
    acceptedByUserId: actorUserId,
    acceptedAt: new Date(),
    metadataJson: {
      ...(wasOverridden && input.correctionNote?.trim() ? { correctionNote: input.correctionNote.trim() } : {}),
    } as unknown as Prisma.InputJsonValue,
  };
  const saved = await prisma.paymentOrderGlCoding.upsert({
    where: { paymentOrderId },
    create: { paymentOrderId, provider: PROVIDER, ...data },
    update: data,
  });
  // Codings no longer promote into a vendor rule. A vendor sells different
  // things, so what is learned is per kind of LINE (line-memory.ts), from the
  // lines people settle; a vendor default exists only when a person sets one.
  return saved;
}

// ─── Vendor defaults ────────────────────────────────────────────────────────
// A default category for a vendor, set by a person: the last resort for a line
// that nothing else speaks to (line memory, the model, the document). Rules
// are no longer learned from history (2026-10-01): learning is per kind of
// line (line-memory.ts). Older 'learned' rows still apply, as the same last
// resort, until someone removes them.

export async function getVendorCodingRule(organizationId: string, counterpartyId: string) {
  return prisma.vendorCodingRule.findUnique({
    where: { organizationId_counterpartyId_provider: { organizationId, counterpartyId, provider: PROVIDER } },
  });
}

export async function listVendorCodingRules(organizationId: string) {
  return prisma.vendorCodingRule.findMany({ where: { organizationId, provider: PROVIDER } });
}

export async function setVendorCodingRule(args: {
  organizationId: string;
  counterpartyId: string;
  accountId: string;
  accountName: string | null;
  actorUserId: string;
}) {
  const data = {
    accountId: args.accountId,
    accountName: args.accountName,
    source: 'manual',
    setByUserId: args.actorUserId,
    // A person set it: nothing to announce, and any forget is lifted.
    acknowledgedAt: new Date(),
    acknowledgedByUserId: args.actorUserId,
  };
  await prisma.forgottenHabit.deleteMany({ where: { organizationId: args.organizationId, counterpartyId: args.counterpartyId } });
  return prisma.vendorCodingRule.upsert({
    where: { organizationId_counterpartyId_provider: { organizationId: args.organizationId, counterpartyId: args.counterpartyId, provider: PROVIDER } },
    create: { organizationId: args.organizationId, counterpartyId: args.counterpartyId, provider: PROVIDER, ...data },
    update: data,
  });
}

/**
 * Forget a vendor's habit. It stops at once: drafts nobody has saved are
 * re-coded without it the next time they are read (the habit is applied
 * live), and confirmed bills keep what was confirmed. The forget is
 * remembered, so the same history cannot teach it straight back.
 */
export async function clearVendorCodingRule(organizationId: string, counterpartyId: string, actorUserId: string | null = null) {
  const existing = await prisma.vendorCodingRule.findFirst({ where: { organizationId, counterpartyId, provider: PROVIDER } });
  await prisma.vendorCodingRule.deleteMany({ where: { organizationId, counterpartyId, provider: PROVIDER } });
  // Only a LEARNED habit is remembered as forgotten. Removing a default a
  // person set is different: it stops overriding the history, and learning
  // from that history resumes.
  if (existing?.source !== 'learned') return;
  await prisma.forgottenHabit.upsert({
    where: { organizationId_counterpartyId: { organizationId, counterpartyId } },
    create: { organizationId, counterpartyId, accountName: existing?.accountName ?? null, forgottenByUserId: actorUserId },
    update: { accountName: existing?.accountName ?? null, forgottenAt: new Date(), forgottenByUserId: actorUserId },
  });
}

export interface GlCandidate {
  accountId: string;
  accountName: string | null;
  reason: 'rule' | 'vendor_history' | 'ocr' | 'frequent' | 'default';
  count?: number;
  /** For `ocr`: the model's confidence (0-1) this account is right, and its rationale. */
  weight?: number;
  rationale?: string | null;
}

function rankAccounts(rows: Array<{ codedExpenseAccountId: string; codedExpenseAccountName: string | null }>) {
  const counts = new Map<string, { name: string | null; n: number }>();
  for (const r of rows) {
    const cur = counts.get(r.codedExpenseAccountId) ?? { name: r.codedExpenseAccountName, n: 0 };
    counts.set(r.codedExpenseAccountId, { name: cur.name ?? r.codedExpenseAccountName, n: cur.n + 1 });
  }
  return [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
}

/**
 * Up to 3 ranked candidate expense accounts to OFFER (not pre-fill): this vendor's
 * history first, then the org's most-used accounts, then the default. OCR-derived
 * "what is this invoice for" candidates will slot in here later without UI changes.
 */
export async function predictGlCandidates(
  organizationId: string,
  paymentOrderId: string,
): Promise<{ candidates: GlCandidate[]; vendorLabel: string | null }> {
  const order = await prisma.paymentOrder.findFirst({ where: { paymentOrderId, organizationId }, include: { counterparty: true, counterpartyWallet: true } });
  if (!order) return { candidates: [], vendorLabel: null };
  const vendorLabel = order.counterparty?.displayName ?? order.counterpartyWallet?.label ?? null;
  const seen = new Set<string>();
  const out: GlCandidate[] = [];
  const add = (accountId: string | null | undefined, accountName: string | null, reason: GlCandidate['reason'], meta?: { count?: number; weight?: number; rationale?: string | null }) => {
    if (accountId && !seen.has(accountId) && out.length < 3) { seen.add(accountId); out.push({ accountId, accountName, reason, ...meta }); }
  };

  // Tier 0 — the vendor's coding RULE (explicit or learned): rules beat
  // everything below, and the candidate says which kind it is.
  if (order.counterpartyId) {
    const rule = await getVendorCodingRule(organizationId, order.counterpartyId);
    if (rule) {
      add(rule.accountId, rule.accountName, 'rule', {
        count: rule.learnedFromCount || undefined,
        rationale: rule.source === 'manual'
          ? 'Set by your team on the vendor'
          : `Learned from ${rule.learnedFromCount} agreeing bill${rule.learnedFromCount === 1 ? '' : 's'}`,
      });
    }
  }

  const vendorFilter = order.counterpartyId
    ? { counterpartyId: order.counterpartyId }
    : vendorLabel ? { counterpartyWallet: { label: vendorLabel } } : null;
  if (vendorFilter) {
    const past = await prisma.paymentOrderGlCoding.findMany({ where: { organizationId, provider: PROVIDER, paymentOrderId: { not: paymentOrderId }, paymentOrder: vendorFilter }, select: { codedExpenseAccountId: true, codedExpenseAccountName: true }, take: 200 });
    for (const [id, v] of rankAccounts(past)) add(id, v.name, 'vendor_history', { count: v.n });
  }
  // OCR: the document's own signal — accounts the invoice's line items were matched to at
  // intake, each with the model's weight. Ranks below the vendor's history (memory beats
  // the document) but above org frequency / the default; weak guesses are dropped.
  const ocr = (order.metadataJson as { ocrCoding?: OcrCodingShape } | null)?.ocrCoding;
  const ocrSuggestions = ocr?.suggestions
    ?? (ocr?.suggestedAccountId ? [{ accountId: ocr.suggestedAccountId, accountName: ocr.suggestedAccountName ?? null, weight: 1 }] : []);
  for (const s of ocrSuggestions) {
    // Builtin-chart suggestions (made before QuickBooks was connected) are for
    // the draft screen only — never candidates for a real QuickBooks coding.
    if (typeof s.accountId === 'string' && s.accountId.startsWith('builtin:')) continue;
    if (s.weight >= MIN_OCR_WEIGHT) add(s.accountId, s.accountName, 'ocr', { weight: s.weight, rationale: ocr?.rationale ?? null });
  }
  if (out.length < 3) {
    const orgPast = await prisma.paymentOrderGlCoding.findMany({ where: { organizationId, provider: PROVIDER }, select: { codedExpenseAccountId: true, codedExpenseAccountName: true }, take: 500, orderBy: { createdAt: 'desc' } });
    for (const [id, v] of rankAccounts(orgPast)) add(id, v.name, 'frequent');
  }
  if (out.length < 3) {
    const map = await prisma.accountingAccountMap.findFirst({ where: { organizationId, provider: PROVIDER } });
    add(map?.defaultExpenseAccountId, map?.defaultExpenseAccountName ?? null, 'default');
  }
  return { candidates: out, vendorLabel };
}

// ─── The coding a person confirmed in review ────────────────────────────────
// Review is where categories are chosen: each line's category is a NAME from
// the picker (the QuickBooks chart when connected, the standard list when
// not). This turns the confirmed lines into a coding row with account ids, so
// the bill can be posted to QuickBooks at approval and so vendor habits learn
// from what people actually confirm. A name the chart does not have lands on
// the catch-all, and the sync says which one.

type ReviewLine = { description?: string | null; amount?: number | null; category?: string | null };

export async function recordReviewCoding(organizationId: string, paymentOrderId: string, actorUserId: string | null) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    select: { amountRaw: true, invoiceNumber: true, metadataJson: true },
  });
  const verification = (order?.metadataJson as { verification?: { lines?: ReviewLine[]; fields?: Record<string, unknown> } } | null)?.verification;
  const lines = (verification?.lines ?? []).filter((l) => (l.description ?? '').trim() || Number(l.amount));
  if (!order || lines.length === 0) return null;

  const { listChartOfAccounts } = await import('./ocr-coding.js');
  const { DEFAULT_EXPENSE_ACCOUNTS, UNCATEGORIZED_ACCOUNT } = await import('./default-chart.js');
  const chart = await listChartOfAccounts(organizationId).catch(() => []);
  const key = (s: string) => s.trim().toLowerCase();
  const byName = new Map<string, { id: string; name: string }>();
  if (chart.length > 0) {
    for (const a of chart) {
      byName.set(key(a.fullyQualifiedName ?? a.name), { id: a.id, name: a.fullyQualifiedName ?? a.name });
      if (!byName.has(key(a.name))) byName.set(key(a.name), { id: a.id, name: a.fullyQualifiedName ?? a.name });
    }
  } else {
    for (const a of DEFAULT_EXPENSE_ACCOUNTS) byName.set(key(a.name), { id: a.id, name: a.name });
  }
  const coded = lines.map((l) => {
    const account = l.category ? byName.get(key(l.category)) : undefined;
    return {
      accountId: account?.id ?? UNCATEGORIZED_ACCOUNT.id,
      accountName: account?.name ?? l.category ?? UNCATEGORIZED_ACCOUNT.name,
      amount: Number(l.amount) || 0,
      description: l.description ?? null,
    };
  });
  const billDate = typeof verification?.fields?.invoiceDate === 'string' ? verification.fields.invoiceDate : null;
  return setPaymentOrderGlCoding(organizationId, paymentOrderId, {
    lines: coded,
    predictionSource: 'review',
    billHeader: { invoiceNumber: order.invoiceNumber, billDate },
  }, actorUserId);
}
