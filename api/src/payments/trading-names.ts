// The other names an organisation answers to, as Organisation lists them.
//
// They live on the organisation as a JSON list (`trading_names`). Each entry
// says who added it, when and off which bill, because a name the organisation
// trades under is a claim about who it is and should say who made it. Adding
// one stays on the bill ("This is us", `addOrganizationTradingName`).
//
// Taking one off keeps the entry and marks it removed, with who and when, so
// the record of the claim survives and Undo puts back that same entry rather
// than one rebuilt from whatever the page sent. Everything that matches bills
// against the names reads them through `readTradingNames`, which skips the
// removed ones, so a bill addressed to a removed name is asked about again the
// next time it is read.
import { prisma } from '../infra/prisma.js';
import type { Tx } from '../approvals/store.js';

type Entry = Record<string, unknown>;

export type TradingNameRow = {
  name: string;
  addedByName: string | null;
  addedAt: string | null;
  paymentOrderId: string | null;
  invoiceNumber: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// The earliest names were stored as bare strings.
function asEntry(raw: unknown): Entry | null {
  if (typeof raw === 'string') return { name: raw };
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Entry) : null;
}

function nameOf(raw: unknown) {
  return text(asEntry(raw)?.name);
}

function isLive(raw: unknown) {
  return Boolean(nameOf(raw)) && !asEntry(raw)?.removedAt;
}

function sameName(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/** The names in use, newest first, each with who added it and the bill it came from. */
export async function listTradingNames(organizationId: string): Promise<TradingNameRow[]> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { organizationId },
    select: { tradingNames: true },
  });
  const live = (Array.isArray(org.tradingNames) ? org.tradingNames : []).filter(isLive).map((e) => asEntry(e)!);
  const billIds = [...new Set(live.map((e) => text(e.fromPaymentOrderId)).filter((id): id is string => Boolean(id && UUID.test(id))))];
  const bills = billIds.length
    ? await prisma.paymentOrder.findMany({
        where: { organizationId, paymentOrderId: { in: billIds } },
        select: { paymentOrderId: true, invoiceNumber: true },
      })
    : [];
  const invoiceOf = new Map(bills.map((b) => [b.paymentOrderId, b.invoiceNumber]));
  return live
    .map((e) => {
      const paymentOrderId = text(e.fromPaymentOrderId);
      return {
        name: text(e.name)!,
        addedByName: text(e.addedByName),
        addedAt: text(e.addedAt),
        paymentOrderId,
        invoiceNumber: paymentOrderId ? invoiceOf.get(paymentOrderId) ?? null : null,
      };
    })
    .sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''));
}

// Read and written whole, so the organisation's row is locked while one
// change is made: two admins at once can't each write back a list without the
// other's change.
async function lockedNames(tx: Tx, organizationId: string) {
  await tx.$queryRaw`SELECT 1 FROM organizations WHERE organization_id = ${organizationId}::uuid FOR UPDATE`;
  const org = await tx.organization.findUniqueOrThrow({ where: { organizationId }, select: { tradingNames: true } });
  return Array.isArray(org.tradingNames) ? ([...org.tradingNames] as unknown[]) : [];
}

/** Takes a name off, marked removed with who did it and when. */
export async function removeTradingName(args: { organizationId: string; name: string; actorUserId: string; actorName: string }) {
  return prisma.$transaction(async (tx) => {
    const names = await lockedNames(tx, args.organizationId);
    const i = names.findIndex((e) => isLive(e) && sameName(nameOf(e)!, args.name));
    if (i < 0) return { removed: false };
    names[i] = {
      ...asEntry(names[i]),
      removedAt: new Date().toISOString(),
      removedByUserId: args.actorUserId,
      removedByName: args.actorName,
    };
    await tx.organization.update({ where: { organizationId: args.organizationId }, data: { tradingNames: names as never } });
    return { removed: true };
  });
}

/**
 * Undo: the name taken off last comes back as it was, added by the same person
 * on the same day. Nothing changes if the name is in use again already.
 */
export async function restoreTradingName(args: { organizationId: string; name: string }) {
  return prisma.$transaction(async (tx) => {
    const names = await lockedNames(tx, args.organizationId);
    if (names.some((e) => isLive(e) && sameName(nameOf(e)!, args.name))) return { restored: false };
    let i = names.length - 1;
    while (i >= 0 && !(nameOf(names[i]) && sameName(nameOf(names[i])!, args.name))) i -= 1;
    if (i < 0) return { restored: false };
    const { removedAt: _at, removedByUserId: _by, removedByName: _byName, ...entry } = asEntry(names[i])!;
    names[i] = entry;
    await tx.organization.update({ where: { organizationId: args.organizationId }, data: { tradingNames: names as never } });
    return { restored: true };
  });
}
