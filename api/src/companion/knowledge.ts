// What the companion knows: every category habit, who taught it, and what it
// was told to forget. Readable by anyone on the team — knowing why a bill was
// pre-filled is part of trusting it — and changed only by admins, through the
// same routes the Vendors page uses.
import { prisma } from '../infra/prisma.js';
import { forbidden, notFound } from '../infra/api-errors.js';
import { getOrgAccess } from '../approvals/permissions.js';
import { acknowledgeHabit } from '../accounting/gl-coding.js';

export type Habit = {
  ruleId: string;
  counterpartyId: string;
  vendorName: string;
  category: string;
  source: 'learned' | 'manual';
  /** Learned: from how many agreeing bills. */
  fromBills: number;
  /** Learned: the people whose confirmed bills taught it. */
  taughtBy: string[];
  /** Set by hand: who. */
  setBy: string | null;
  since: string;
  /** Bills from this vendor that came in since the habit took hold. */
  billsSince: number;
  /** Kept (or set) by an admin; false while it is still being announced. */
  acknowledged: boolean;
};

export async function getKnowledge(organizationId: string, viewerUserId: string) {
  const [access, rules, forgotten] = await Promise.all([
    getOrgAccess(organizationId, viewerUserId),
    prisma.vendorCodingRule.findMany({
      where: { organizationId },
      orderBy: { updatedAt: 'desc' },
      include: { counterparty: { select: { displayName: true } } },
    }),
    prisma.forgottenHabit.findMany({ where: { organizationId }, orderBy: { forgottenAt: 'desc' }, take: 20 }),
  ]);
  const userIds = new Set<string>();
  for (const r of rules) {
    for (const id of (Array.isArray(r.taughtBy) ? r.taughtBy : []) as string[]) userIds.add(id);
    if (r.setByUserId) userIds.add(r.setByUserId);
  }
  for (const f of forgotten) if (f.forgottenByUserId) userIds.add(f.forgottenByUserId);
  const counterpartyIds = [...new Set([...rules.map((r) => r.counterpartyId), ...forgotten.map((f) => f.counterpartyId)])];
  const [users, vendors, bills] = await Promise.all([
    prisma.user.findMany({ where: { userId: { in: [...userIds] } }, select: { userId: true, displayName: true, email: true } }),
    prisma.counterparty.findMany({ where: { counterpartyId: { in: counterpartyIds } }, select: { counterpartyId: true, displayName: true } }),
    prisma.paymentOrder.findMany({ where: { organizationId, counterpartyId: { in: rules.map((r) => r.counterpartyId) } }, select: { counterpartyId: true, createdAt: true } }),
  ]);
  const name = new Map(users.map((u) => [u.userId, u.displayName?.trim() || u.email]));
  const vendor = new Map(vendors.map((v) => [v.counterpartyId, v.displayName]));

  const habits: Habit[] = rules.map((r) => ({
    ruleId: r.vendorCodingRuleId,
    counterpartyId: r.counterpartyId,
    vendorName: r.counterparty.displayName,
    category: r.accountName ?? r.accountId,
    source: r.source === 'manual' ? 'manual' : 'learned',
    fromBills: r.learnedFromCount,
    taughtBy: ((Array.isArray(r.taughtBy) ? r.taughtBy : []) as string[]).map((id) => name.get(id)).filter((n): n is string => Boolean(n)),
    setBy: r.setByUserId ? name.get(r.setByUserId) ?? null : null,
    since: r.updatedAt.toISOString(),
    billsSince: bills.filter((b) => b.counterpartyId === r.counterpartyId && b.createdAt > r.updatedAt).length,
    acknowledged: r.source === 'manual' || Boolean(r.acknowledgedAt),
  }));
  return {
    canManage: access?.isPrimaryOrAdmin ?? false,
    habits,
    forgotten: forgotten.map((f) => ({
      counterpartyId: f.counterpartyId,
      vendorName: vendor.get(f.counterpartyId) ?? 'A vendor',
      category: f.accountName,
      at: f.forgottenAt.toISOString(),
      by: f.forgottenByUserId ? name.get(f.forgottenByUserId) ?? null : null,
    })),
  };
}

/** An admin keeps an announced habit. */
export async function keepHabit(organizationId: string, viewerUserId: string, ruleId: string) {
  const access = await getOrgAccess(organizationId, viewerUserId);
  if (!access?.isPrimaryOrAdmin) throw forbidden('Only an admin can keep or forget what I learned.');
  const kept = await acknowledgeHabit(organizationId, ruleId, viewerUserId);
  if (!kept) throw notFound('No such habit.');
  return { ok: true };
}

/** The line an announced habit shows in an admin's inbox. */
export function announce(h: Habit): string {
  const who = h.taughtBy.length === 0 ? '' : h.taughtBy.length === 1 ? `${h.taughtBy[0]} ` : `${h.taughtBy.slice(0, -1).join(', ')} and ${h.taughtBy.at(-1)} `;
  return `I learned: ${h.vendorName} goes to ${h.category}, from ${h.fromBills} ${h.fromBills === 1 ? 'bill' : 'bills'} ${who}coded that way. I'll pre-fill it on new ${h.vendorName} bills.`;
}
