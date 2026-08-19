/**
 * What a non-invoice document says, checked against what we already hold.
 *
 * A statement of account is not a threat to be refused — it is the vendor
 * telling you what they think you owe, which is checkable. The useful answer
 * is not "this is a statement" but:
 *
 *   MER-8801  $12,400  they say paid    — we have it, paid
 *   MER-8842  $13,150  they say open    — we have it, waiting on Marcus
 *   MER-8890   $9,800  they say open    — WE DO NOT HAVE THIS
 *
 * That last row is the reason vendors send statements at all, and the reason
 * to read one rather than bin it. The first row is the dangerous one: an
 * invoice already settled, sitting on a document somebody could have paid.
 *
 * Deliberately a query, not a model call. Matching a reference to a bill is a
 * join on invoice number and vendor; making it probabilistic would buy nothing
 * and cost the reliability of the one part a person acts on.
 */
import { prisma } from '../infra/prisma.js';
import { normalizeInvoiceNumber } from './duplicate-check.js';

export type StatedStatus = 'paid' | 'open' | 'overdue' | 'unknown';

export interface ReconciledRow {
  reference: string | null;
  date: string | null;
  amountUsd: number | null;
  /** What the document claims about this row. */
  statedStatus: StatedStatus | null;
  /** What we hold, if anything. */
  held: {
    paymentOrderId: string;
    invoiceNumber: string | null;
    state: string;
    /** Plain words for the screen: "paid", "in approval", "still a draft". */
    where: string;
  } | null;
}

export interface StatementReconciliation {
  rows: ReconciledRow[];
  /** References on the statement that we hold no bill for — the useful gap. */
  missing: number;
  /** Rows the statement itself marks paid — the double-payment risk. */
  alreadyPaid: number;
}

/** Where a bill has got to, in words a person would use. */
function whereItIs(state: string): string {
  switch (state) {
    case 'draft': return 'still a draft';
    case 'submitted': return 'in approval';
    case 'proposed': return 'waiting to be paid';
    case 'executed': return 'paid';
    case 'settled': return 'paid';
    case 'cancelled': return 'cancelled';
    default: return state;
  }
}

export async function reconcileStatement(input: {
  organizationId: string;
  /** Exclude the statement's own payment order from the search. */
  excludePaymentOrderId: string;
  counterpartyId: string | null;
  rows: Array<{ reference?: string | null; date?: string | null; amount?: number | null; status?: string | null }>;
}): Promise<StatementReconciliation> {
  const rows = input.rows ?? [];
  if (rows.length === 0) return { rows: [], missing: 0, alreadyPaid: 0 };

  // One query for every reference on the document, not one per row.
  const candidates = await prisma.paymentOrder.findMany({
    where: {
      organizationId: input.organizationId,
      paymentOrderId: { not: input.excludePaymentOrderId },
      ...(input.counterpartyId ? { counterpartyId: input.counterpartyId } : {}),
    },
    select: { paymentOrderId: true, invoiceNumber: true, state: true },
  });
  const byNumber = new Map<string, { paymentOrderId: string; invoiceNumber: string | null; state: string }>();
  for (const c of candidates) {
    const key = normalizeInvoiceNumber(c.invoiceNumber);
    if (!key) continue;
    // Keep the furthest-along bill for a number: if a reference matches both a
    // cancelled attempt and a paid one, "paid" is the answer that matters.
    const existing = byNumber.get(key);
    if (!existing || rank(c.state) > rank(existing.state)) byNumber.set(key, c);
  }

  const out: ReconciledRow[] = rows.map((r) => {
    const key = normalizeInvoiceNumber(r.reference ?? null);
    const hit = key ? byNumber.get(key) ?? null : null;
    const stated = (['paid', 'open', 'overdue', 'unknown'] as const).find((s) => s === r.status) ?? null;
    return {
      reference: r.reference ?? null,
      date: r.date ?? null,
      amountUsd: typeof r.amount === 'number' ? r.amount : null,
      statedStatus: stated,
      held: hit
        ? {
          paymentOrderId: hit.paymentOrderId,
          invoiceNumber: hit.invoiceNumber,
          state: hit.state,
          where: whereItIs(hit.state),
        }
        : null,
    };
  });

  return {
    rows: out,
    missing: out.filter((r) => r.reference && !r.held).length,
    alreadyPaid: out.filter((r) => r.statedStatus === 'paid').length,
  };
}

/** How far along a bill is, for picking the most meaningful of several. */
function rank(state: string): number {
  switch (state) {
    case 'settled': return 5;
    case 'executed': return 4;
    case 'proposed': return 3;
    case 'submitted': return 2;
    case 'draft': return 1;
    default: return 0;
  }
}
