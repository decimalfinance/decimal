// GL coding: predict which expense account a payment should post to, learned from
// how this vendor's prior payments were coded, and persist the operator's decision.
// Phase 1 of the coding agent: per-vendor memory lookup (the QuickBooks finding that
// reusing the customer's own past coding beats a model). No LLM. The persisted row
// doubles as the decision log (predicted vs confirmed, source, confidence, override)
// that a later consolidation step promotes into `coding_rules`.

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
  predictionSource: 'vendor_history' | 'default' | 'none';
  confidenceScore: number | null;
  supportCount: number; // how many prior codings backed the suggestion
}

/**
 * Predict the expense account for a payment: the most-common account this vendor's
 * prior payments were coded to (confidence = its share), else the org default.
 */
export async function predictGlExpenseAccount(
  organizationId: string,
  paymentOrderId: string,
): Promise<GlCodingPrediction> {
  const order = await prisma.paymentOrder.findFirst({
    where: { paymentOrderId, organizationId },
    include: { counterparty: true, counterpartyWallet: true },
  });
  if (!order) return { codedExpenseAccountId: null, codedExpenseAccountName: null, predictionSource: 'none', confidenceScore: null, supportCount: 0 };

  const vendorLabel = order.counterparty?.displayName ?? order.counterpartyWallet?.label ?? null;
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
  };
  return prisma.paymentOrderGlCoding.upsert({
    where: { paymentOrderId },
    create: { paymentOrderId, provider: PROVIDER, ...data },
    update: data,
  });
}

export interface GlCandidate {
  accountId: string;
  accountName: string | null;
  reason: 'vendor_history' | 'ocr' | 'frequent' | 'default';
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

/** The coding inbox: settled payments not yet in QuickBooks, each with its coding + candidates. */
export async function getCodingInbox(organizationId: string) {
  const orders = await prisma.paymentOrder.findMany({
    where: { organizationId, state: 'settled', accountingSyncs: { none: { provider: PROVIDER, status: 'synced' } } },
    include: {
      counterparty: true,
      counterpartyWallet: true,
      glCoding: true,
      accountingSyncs: { where: { provider: PROVIDER }, take: 1, orderBy: { createdAt: 'desc' } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const items = [];
  for (const o of orders) {
    const { candidates } = await predictGlCandidates(organizationId, o.paymentOrderId);
    items.push({
      paymentOrderId: o.paymentOrderId,
      vendorLabel: o.counterparty?.displayName ?? o.counterpartyWallet?.label ?? null,
      amountUsdc: Number(o.amountRaw) / 1e6,
      invoiceNumber: o.invoiceNumber,
      createdAt: o.createdAt,
      coding: o.glCoding
        ? {
            accountId: o.glCoding.codedExpenseAccountId,
            accountName: o.glCoding.codedExpenseAccountName,
            lines: Array.isArray(o.glCoding.lines) ? o.glCoding.lines : [],
            billHeader: (o.glCoding.billHeader ?? {}) as Record<string, unknown>,
          }
        : null,
      candidates,
      syncStatus: o.accountingSyncs[0]?.status ?? null,
    });
  }
  return items;
}
