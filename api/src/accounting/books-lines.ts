// What a finished setup learned from a company's books, in the shape bill coding reads:
// a precedent per line, against the vendor Decimal knows the bill by. So a vendor's first
// bill in Decimal is filled in from its history in the books rather than guessed at. It
// stays a proposal: a person still checks every bill.

import { prisma } from '../infra/prisma.js';
import { cleanName } from '../integrations/setup/findings.js';
import { parseOutcome } from '../integrations/setup/outcome.js';
import { playbookFor } from '../integrations/setup/playbooks.js';
import type { Precedent } from './line-memory.js';
import { lineTokens, vendorLine } from './line-words.js';
import { matchVendor, vendorsInCopy, type KnownVendor } from './vendor-match.js';

export type FromTheBooks = {
  precedents: Precedent[];
  /** Lines a person said to pick each time, so that nothing fills them in: not the books, and not a later bill. */
  askEachTime: Set<string>;
};

export async function linesFromTheBooks(organizationId: string): Promise<FromTheBooks> {
  const found: FromTheBooks = { precedents: [], askEachTime: new Set() };
  const setup = await prisma.integrationSetup.findFirst({
    where: { organizationId, status: 'done' },
    orderBy: { updatedAt: 'desc' },
    select: { system: true, companyId: true, outcome: true },
  });
  const outcome = parseOutcome(setup?.outcome);
  if (!setup?.companyId || !outcome) return found;

  // Disconnecting, or signing in to another company, deletes the copy, and this stops with it.
  const vendors = await vendorsInCopy(organizationId, setup.system, setup.companyId);
  if (vendors.length === 0) return found;
  const byName = new Map<string, KnownVendor[]>();
  for (const v of vendors) {
    const name = cleanName(v.name);
    if (name) byName.set(name, [...(byName.get(name) ?? []), v]);
  }

  const linesOf = new Map<string, typeof outcome.learnedLines>();
  for (const l of outcome.learnedLines) linesOf.set(l.vendorId, [...(linesOf.get(l.vendorId) ?? []), l]);

  const label = playbookFor(setup.system).label;
  const counterparties = await prisma.counterparty.findMany({ where: { organizationId }, select: { counterpartyId: true, displayName: true } });
  for (const c of counterparties) {
    const match = matchVendor(c.displayName, byName.get(cleanName(c.displayName)) ?? [], outcome.vendorLinks);
    if (!match || !('vendorId' in match)) continue;
    // Vendors the person said are one business teach as one.
    const family = outcome.vendorLinks.find((l) => l.vendorIds.includes(match.vendorId))?.vendorIds ?? [match.vendorId];
    for (const l of family.flatMap((id) => linesOf.get(id) ?? [])) {
      const tokens = lineTokens(l.example);
      if (tokens.size === 0) continue;
      found.precedents.push({
        key: l.line,
        description: l.example,
        tokens,
        category: l.categoryName,
        counterpartyId: c.counterpartyId,
        vendorName: c.displayName,
        paymentOrderId: null,
        invoiceNumber: l.number,
        byUserId: null,
        at: Date.parse(l.lastUsed ?? '') || Date.parse(outcome.postingFrom) || 0,
        confirmed: true,
        lines: l.lines,
        books: label,
      });
    }
    for (const choice of outcome.lineChoices) {
      if (choice.categoryId === null && choice.line && family.includes(choice.vendorId)) found.askEachTime.add(vendorLine(c.counterpartyId, choice.line));
    }
  }
  return found;
}
