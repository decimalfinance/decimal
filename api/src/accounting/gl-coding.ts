// GL coding: the coding a person confirmed in review, as the row the QuickBooks
// sync posts a bill from (payment_order_gl_codings), and the decision log of
// what was suggested against what was kept.
//
// Nothing here predicts a category. That is decided on the draft, in review,
// and learned per vendor + line (line-memory.ts).

import { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';

const PROVIDER = 'quickbooks';

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
   *  signal; rides the decision log. */
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
  // Nothing is learned here: categories are learned per vendor + line
  // (line-memory.ts), from the lines people settle.
  return saved;
}

// ─── The coding a person confirmed in review ────────────────────────────────
// Review is where categories are chosen: each line's category is a NAME from
// the picker (the QuickBooks chart when connected, the standard list when
// not). This turns the confirmed lines into a coding row with account ids, so
// the bill can be posted to QuickBooks at approval. A name the chart does not
// have lands on the catch-all, and the sync says which one.

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
