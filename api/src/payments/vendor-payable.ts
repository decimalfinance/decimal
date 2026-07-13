// Vendor payable gate (policy P0 — SYNTHESIS-decimal-policies.md).
// Approvals decide who signs off; THIS decides whether the vendor can be paid
// at all — and it always wins. Two severities (Tipalti's model):
//   held    — payments pause pending review; any ADMIN can set or release.
//   blocked — terminal; only the PRIMARY ADMIN can set or lift it.
// Entry half: a held/blocked vendor's bills can't leave Review (blocking flag
// + confirm refusal). The release-time re-check ships with the funded-release
// bench work.
import type { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';

export type PayableHold = {
  status: 'held' | 'blocked';
  reason: string;
  byUserId: string;
  byName: string;
  at: string;
};

export function readPayableHold(metadata: unknown): PayableHold | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const h = (metadata as Record<string, unknown>).payableHold;
  if (!h || typeof h !== 'object') return null;
  const r = h as Record<string, unknown>;
  if (r.status !== 'held' && r.status !== 'blocked') return null;
  return {
    status: r.status,
    reason: typeof r.reason === 'string' ? r.reason : '',
    byUserId: typeof r.byUserId === 'string' ? r.byUserId : '',
    byName: typeof r.byName === 'string' ? r.byName : 'an admin',
    at: typeof r.at === 'string' ? r.at : '',
  };
}

export function describePayableHold(vendorName: string, hold: PayableHold): string {
  const why = hold.reason ? ` — ${hold.byName}: “${hold.reason}”` : ` by ${hold.byName}`;
  return hold.status === 'blocked'
    ? `${vendorName} is blocked${why}. Bills for a blocked vendor can't proceed; only the primary admin can unblock them.`
    : `Payments to ${vendorName} are on hold${why}. An admin can release the hold from the Vendors page.`;
}

export async function setVendorPayableStatus(args: {
  organizationId: string;
  counterpartyId: string;
  status: 'payable' | 'held' | 'blocked';
  reason: string | null;
  actorUserId: string;
  actorName: string;
}) {
  const vendor = await prisma.counterparty.findFirst({
    where: { organizationId: args.organizationId, counterpartyId: args.counterpartyId },
    select: { counterpartyId: true, displayName: true, metadataJson: true },
  });
  if (!vendor) throw new Error('Vendor not found');

  const metadata = (vendor.metadataJson && typeof vendor.metadataJson === 'object' && !Array.isArray(vendor.metadataJson)
    ? vendor.metadataJson : {}) as Record<string, unknown>;
  const previous = readPayableHold(metadata);

  const next = { ...metadata } as Record<string, unknown>;
  if (args.status === 'payable') {
    delete next.payableHold;
  } else {
    next.payableHold = {
      status: args.status,
      reason: args.reason ?? '',
      byUserId: args.actorUserId,
      byName: args.actorName,
      at: new Date().toISOString(),
    } satisfies PayableHold;
  }
  // The status CHANGE is itself audited — kept forever in the vendor record.
  const history = Array.isArray(next.payableHistory) ? (next.payableHistory as unknown[]) : [];
  next.payableHistory = [
    ...history.slice(-19),
    { from: previous?.status ?? 'payable', to: args.status, reason: args.reason ?? '', byUserId: args.actorUserId, byName: args.actorName, at: new Date().toISOString() },
  ];

  const updated = await prisma.counterparty.update({
    where: { counterpartyId: vendor.counterpartyId },
    data: { metadataJson: next as Prisma.InputJsonValue },
  });
  logger.info('vendor_payable.status_changed', {
    organizationId: args.organizationId,
    counterpartyId: vendor.counterpartyId,
    from: previous?.status ?? 'payable',
    to: args.status,
    byUserId: args.actorUserId,
  });
  return updated;
}
