// What the companion knows: every category habit, who taught it, and what it
// was told to forget. Readable by anyone on the team — knowing why a bill was
// pre-filled is part of trusting it. Changed by whoever codes bills: that is
// the bill clerk's job (and an admin's, who can do everything), not something
// to escalate to an admin (Zaid, 2026-09-30).
import { prisma } from '../infra/prisma.js';
import { badRequest, forbidden, notFound } from '../infra/api-errors.js';
import { getOrgAccess } from '../approvals/permissions.js';
import { acknowledgeHabit, clearVendorCodingRule, setVendorCodingRule } from '../accounting/gl-coding.js';

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
  /** Kept (or set) by someone who codes bills; false while it is still being announced. */
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
  const canManage = canCode(access);
  return {
    canManage,
    // What someone teaching a habit by hand picks from. Only for them: a clerk
    // cannot see the vendor list otherwise, and does not need to.
    choices: canManage ? await teachingChoices(organizationId) : null,
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

/** Whoever codes bills: bill clerks, and admins. */
export function canCode(access: Awaited<ReturnType<typeof getOrgAccess>>): boolean {
  return (access?.isPrimaryOrAdmin ?? false) || (access?.capabilities.includes('bills.edit') ?? false);
}

async function assertCanCode(organizationId: string, userId: string) {
  if (!canCode(await getOrgAccess(organizationId, userId))) {
    throw forbidden('Only someone who codes bills — a bill clerk or an admin — can change what I know.');
  }
}

/** Keep an announced habit: it stops being news. */
export async function keepHabit(organizationId: string, viewerUserId: string, ruleId: string) {
  await assertCanCode(organizationId, viewerUserId);
  const kept = await acknowledgeHabit(organizationId, ruleId, viewerUserId);
  if (!kept) throw notFound('No such habit.');
  return { ok: true };
}

/** Teach a habit by hand: this vendor's bills go to this category. */
export async function setHabit(organizationId: string, viewerUserId: string, counterpartyId: string, category: string) {
  await assertCanCode(organizationId, viewerUserId);
  const vendor = await prisma.counterparty.findFirst({ where: { organizationId, counterpartyId }, select: { counterpartyId: true } });
  if (!vendor) throw notFound('No such vendor.');
  const account = await resolveCategory(organizationId, category);
  if (!account) throw badRequest(`"${category}" is not one of your categories.`);
  await setVendorCodingRule({ organizationId, counterpartyId, accountId: account.id, accountName: account.name, actorUserId: viewerUserId });
  return { ok: true, category: account.name };
}

/** Forget a vendor's habit (see clearVendorCodingRule for what that does). */
export async function forgetHabit(organizationId: string, viewerUserId: string, counterpartyId: string) {
  await assertCanCode(organizationId, viewerUserId);
  const rule = await prisma.vendorCodingRule.findFirst({ where: { organizationId, counterpartyId } });
  if (!rule) throw notFound('There is no habit for this vendor.');
  await clearVendorCodingRule(organizationId, counterpartyId, viewerUserId);
  return { ok: true };
}

async function teachingChoices(organizationId: string) {
  const { listChartOfAccounts } = await import('../accounting/ocr-coding.js');
  const { DEFAULT_EXPENSE_ACCOUNTS } = await import('../accounting/default-chart.js');
  const [vendors, chart] = await Promise.all([
    prisma.counterparty.findMany({ where: { organizationId }, orderBy: { displayName: 'asc' }, select: { counterpartyId: true, displayName: true } }),
    listChartOfAccounts(organizationId).catch(() => []),
  ]);
  return {
    vendors: vendors.map((v) => ({ counterpartyId: v.counterpartyId, name: v.displayName })),
    categories: chart.length > 0 ? chart.map((a) => a.fullyQualifiedName ?? a.name) : DEFAULT_EXPENSE_ACCOUNTS.map((a) => a.name),
  };
}

/** A category name, matched to the chart the picker offers (QuickBooks when connected, else the standard list). */
export async function resolveCategory(organizationId: string, name: string): Promise<{ id: string; name: string } | null> {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const { listChartOfAccounts } = await import('../accounting/ocr-coding.js');
  const { DEFAULT_EXPENSE_ACCOUNTS } = await import('../accounting/default-chart.js');
  const chart = await listChartOfAccounts(organizationId).catch(() => []);
  if (chart.length > 0) {
    const a = chart.find((x) => (x.fullyQualifiedName ?? x.name).toLowerCase() === q || x.name.toLowerCase() === q);
    return a ? { id: a.id, name: a.fullyQualifiedName ?? a.name } : null;
  }
  const a = DEFAULT_EXPENSE_ACCOUNTS.find((x) => x.name.toLowerCase() === q);
  return a ? { id: a.id, name: a.name } : null;
}

/** The line an announced habit shows in the inbox of whoever codes bills. */
export function announce(h: Habit): string {
  const who = h.taughtBy.length === 0 ? '' : h.taughtBy.length === 1 ? `${h.taughtBy[0]} ` : `${h.taughtBy.slice(0, -1).join(', ')} and ${h.taughtBy.at(-1)} `;
  return `I learned: ${h.vendorName} goes to ${h.category}, from ${h.fromBills} ${h.fromBills === 1 ? 'bill' : 'bills'} ${who}coded that way. I'll pre-fill it on new ${h.vendorName} bills.`;
}
