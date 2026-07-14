// Duplicate-bill gate (policy P0 — SYNTHESIS-decimal-policies.md).
// On irreversible rails a duplicate payment is gone, not recalled, so this is
// a BLOCK with a logged override, never a dismissable toast. Checked twice:
// at Review (flag + confirm gate) and again at release (a twin may have been
// paid while this bill sat in approval).
//
// Match rules, scoped to the same vendor (counterparty, falling back to the
// destination wallet for vendor-less orders):
//   1. same_invoice_number — normalized invoice numbers match. The classic.
//   2. same_amount_near_date — same exact amount within a 14-day window.
//      Monthly recurring bills (~30 days apart) clear the window; a true
//      resubmission lands inside it. Overridable when it's legitimate.
import { prisma } from '../infra/prisma.js';

export type DuplicateMatch = {
  paymentOrderId: string;
  invoiceNumber: string | null;
  amountRaw: bigint;
  state: string;
  createdAt: Date;
  matchKind: 'same_invoice_number' | 'same_amount_near_date';
};

export function normalizeInvoiceNumber(value: string | null | undefined): string | null {
  const normalized = (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

const NEAR_DATE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export async function findDuplicateBills(organizationId: string, input: {
  excludePaymentOrderId: string;
  counterpartyId: string | null;
  counterpartyWalletId: string;
  invoiceNumber: string | null;
  /** API/CSV orders carry their reference here — same coalesce the DB's
   *  unique index uses. */
  externalReference?: string | null;
  amountRaw: bigint;
  createdAt?: Date;
}): Promise<DuplicateMatch[]> {
  const candidates = await prisma.paymentOrder.findMany({
    where: {
      organizationId,
      paymentOrderId: { not: input.excludePaymentOrderId },
      state: { not: 'cancelled' },
      ...(input.counterpartyId
        ? { counterpartyId: input.counterpartyId }
        : { counterpartyWalletId: input.counterpartyWalletId }),
    },
    select: { paymentOrderId: true, invoiceNumber: true, externalReference: true, amountRaw: true, state: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const inv = normalizeInvoiceNumber(input.invoiceNumber ?? input.externalReference ?? null);
  const at = (input.createdAt ?? new Date()).getTime();
  const matches: DuplicateMatch[] = [];
  for (const c of candidates) {
    const cInv = normalizeInvoiceNumber(c.invoiceNumber ?? c.externalReference);
    if (inv && cInv) {
      // Both sides carry an invoice number: it IS the discriminator. Same
      // number = duplicate; different numbers = two real bills, even at the
      // same amount (weekly identical orders are legitimate).
      if (inv === cInv) matches.push({ ...c, matchKind: 'same_invoice_number' });
      continue;
    }
    if (c.amountRaw === input.amountRaw && Math.abs(c.createdAt.getTime() - at) <= NEAR_DATE_WINDOW_MS) {
      matches.push({ ...c, matchKind: 'same_amount_near_date' });
    }
  }
  return matches;
}

export type DuplicateOverride = { byUserId: string; byName: string; reason: string; at: string };

export function readDuplicateOverride(metadata: unknown): DuplicateOverride | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const o = (metadata as Record<string, unknown>).duplicateOverride;
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.byUserId !== 'string' || typeof r.reason !== 'string') return null;
  return {
    byUserId: r.byUserId,
    byName: typeof r.byName === 'string' ? r.byName : 'an admin',
    reason: r.reason,
    at: typeof r.at === 'string' ? r.at : '',
  };
}

export function describeDuplicate(match: DuplicateMatch): string {
  const amount = (Number(match.amountRaw) / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const when = match.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const ref = match.invoiceNumber ? `invoice ${match.invoiceNumber}` : 'a bill';
  const how = match.matchKind === 'same_invoice_number' ? 'the same invoice number' : `the same amount ($${amount})`;
  return `This looks like a duplicate of ${ref} from this vendor (${when}, $${amount}) — ${how}.`;
}
