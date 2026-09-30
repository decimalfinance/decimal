// What the companion knows, for "What I know".
//
// Mostly LINE MEMORY (accounting/line-memory.ts): the kinds of line the team
// has settled a category for, learned in the background from confirmed bills
// and from categories people changed on saved drafts. Nobody teaches it on
// purpose (Zaid, 2026-10-01); this page is where you can see it, and forget a
// line it got wrong. Vendor defaults a person set by hand are listed too: they
// are the last resort for a line nothing else speaks to.
//
// Readable by anyone on the team — knowing why a bill was pre-filled is part
// of trusting it. Changed by whoever codes bills: bill clerks and admins.
import { prisma } from '../infra/prisma.js';
import { badRequest, forbidden, notFound } from '../infra/api-errors.js';
import { getOrgAccess } from '../approvals/permissions.js';
import { clearVendorCodingRule, setVendorCodingRule } from '../accounting/gl-coding.js';
import { lineKey, loadPrecedents } from '../accounting/line-memory.js';

export type RememberedLine = {
  key: string;
  /** The line as a person last saw it. */
  description: string;
  category: string;
  /** The bill it was last settled on. */
  invoiceNumber: string | null;
  billId: string;
  by: string | null;
  at: string;
  /** How many settled lines read like this one. */
  fromLines: number;
};

export type VendorDefault = {
  ruleId: string;
  counterpartyId: string;
  vendorName: string;
  category: string;
  setBy: string | null;
  since: string;
};

export async function getKnowledge(organizationId: string, viewerUserId: string) {
  const [access, precedents, defaults, forgotten] = await Promise.all([
    getOrgAccess(organizationId, viewerUserId),
    loadPrecedents(organizationId),
    prisma.vendorCodingRule.findMany({
      where: { organizationId, source: 'manual' },
      orderBy: { updatedAt: 'desc' },
      include: { counterparty: { select: { displayName: true } } },
    }),
    prisma.forgottenLine.findMany({ where: { organizationId }, orderBy: { forgottenAt: 'desc' }, take: 20 }),
  ]);
  // One entry per kind of line; precedents are newest first, so the first
  // seen is the decision in force.
  const byKey = new Map<string, { latest: (typeof precedents)[number]; count: number }>();
  for (const p of precedents) {
    const had = byKey.get(p.key);
    if (had) had.count += 1;
    else byKey.set(p.key, { latest: p, count: 1 });
  }
  const userIds = new Set<string>();
  for (const { latest } of byKey.values()) if (latest.byUserId) userIds.add(latest.byUserId);
  for (const d of defaults) if (d.setByUserId) userIds.add(d.setByUserId);
  for (const f of forgotten) if (f.forgottenByUserId) userIds.add(f.forgottenByUserId);
  const users = await prisma.user.findMany({ where: { userId: { in: [...userIds] } }, select: { userId: true, displayName: true, email: true } });
  const name = new Map(users.map((u) => [u.userId, u.displayName?.trim() || u.email]));

  const lines: RememberedLine[] = [...byKey.values()].map(({ latest, count }) => ({
    key: latest.key,
    description: latest.description,
    category: latest.category,
    invoiceNumber: latest.invoiceNumber,
    billId: latest.paymentOrderId,
    by: latest.byUserId ? name.get(latest.byUserId) ?? null : null,
    at: new Date(latest.at).toISOString(),
    fromLines: count,
  }));
  const canManage = canCode(access);
  return {
    canManage,
    // What someone setting a vendor default picks from. Only for them: a clerk
    // cannot see the vendor list otherwise, and does not need to.
    choices: canManage ? await teachingChoices(organizationId) : null,
    lines,
    vendorDefaults: defaults.map((r): VendorDefault => ({
      ruleId: r.vendorCodingRuleId,
      counterpartyId: r.counterpartyId,
      vendorName: r.counterparty.displayName,
      category: r.accountName ?? r.accountId,
      setBy: r.setByUserId ? name.get(r.setByUserId) ?? null : null,
      since: r.updatedAt.toISOString(),
    })),
    forgotten: forgotten.map((f) => ({
      description: f.description,
      category: f.category,
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

/** Set a vendor default by hand: the last resort for this vendor's lines. */
export async function setHabit(organizationId: string, viewerUserId: string, counterpartyId: string, category: string) {
  await assertCanCode(organizationId, viewerUserId);
  const vendor = await prisma.counterparty.findFirst({ where: { organizationId, counterpartyId }, select: { counterpartyId: true } });
  if (!vendor) throw notFound('No such vendor.');
  const account = await resolveCategory(organizationId, category);
  if (!account) throw badRequest(`"${category}" is not one of your categories.`);
  await setVendorCodingRule({ organizationId, counterpartyId, accountId: account.id, accountName: account.name, actorUserId: viewerUserId });
  return { ok: true, category: account.name };
}

/** Remove a vendor default. */
export async function forgetHabit(organizationId: string, viewerUserId: string, counterpartyId: string) {
  await assertCanCode(organizationId, viewerUserId);
  const rule = await prisma.vendorCodingRule.findFirst({ where: { organizationId, counterpartyId } });
  if (!rule) throw notFound('There is no default for this vendor.');
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

/**
 * Forget a kind of line: lines settled before now stop teaching its category.
 * Lines people settle from now on teach it again, so a forget is never a ban.
 */
export async function forgetLine(organizationId: string, viewerUserId: string, description: string) {
  await assertCanCode(organizationId, viewerUserId);
  const key = lineKey(description);
  if (!key) throw badRequest('That line has nothing to remember it by.');
  const current = (await loadPrecedents(organizationId)).find((p) => p.key === key);
  if (!current) throw notFound('I do not remember a line like that.');
  await prisma.forgottenLine.upsert({
    where: { organizationId_lineKey: { organizationId, lineKey: key } },
    create: { organizationId, lineKey: key, description: current.description, category: current.category, forgottenByUserId: viewerUserId },
    update: { description: current.description, category: current.category, forgottenAt: new Date(), forgottenByUserId: viewerUserId },
  });
  return { ok: true };
}
