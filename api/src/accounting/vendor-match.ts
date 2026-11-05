// Which vendor in the books a bill belongs to, as far as the setup can say. Nothing
// here guesses: the same name, once case, punctuation and legal form are gone, or
// a link the person made in setup. Anything else falls through to QuickBooks' own
// exact match, and then to creating the vendor the bill names.

import { prisma } from '../infra/prisma.js';
import { cleanName } from '../integrations/setup/findings.js';
import type { SetupOutcome } from '../integrations/setup/outcome.js';

export type KnownVendor = { id: string; name: string; active: boolean };

export type VendorMatch = { vendorId: string } | { problem: string } | null;

/**
 * The name an inactive vendor had. QuickBooks renames a vendor it makes inactive
 * "Name (deleted)", or "Name (deleted-2)" when that is taken, so its name looks
 * free when the vendor is still there.
 */
export function nameBeforeInactive(name: string): string {
  return name.replace(/ \(deleted(-\d+)?\)$/, '');
}

/** What to tell a person when the vendor a bill is for is inactive in QuickBooks. */
export function inactiveVendor(name: string, shownAs?: string | null): string {
  const shown = shownAs && shownAs !== name ? `, where it shows as "${shownAs}"` : '';
  return `"${name}" is inactive in QuickBooks${shown}. Make it active there, then retry.`;
}

export function matchVendor(name: string, vendors: KnownVendor[], links: SetupOutcome['vendorLinks']): VendorMatch {
  const clean = cleanName(name);
  const same = vendors.filter((v) => cleanName(v.active ? v.name : nameBeforeInactive(v.name)) === clean);
  if (same.length === 0) return null;
  // What the person said in setup comes first.
  const link = links.find((l) => same.some((v) => l.vendorIds.includes(v.id)));
  if (link) return { vendorId: link.useVendorId };
  const active = same.filter((v) => v.active);
  const exact = active.find((v) => v.name === name);
  if (exact) return { vendorId: exact.id };
  if (active.length === 1) return { vendorId: active[0]!.id };
  if (active.length > 1) {
    const names = active.map((v) => `"${v.name}"`).join(' and ');
    return { problem: `QuickBooks has more than one vendor this bill could be for: ${names}. Change the vendor's name on the bill to match one of them exactly, then retry.` };
  }
  return { problem: inactiveVendor(nameBeforeInactive(same[0]!.name), same[0]!.name) };
}

/** The vendors in the copy the study read. Disconnecting, or signing in to another company, deletes it. */
export async function vendorsInCopy(organizationId: string, system: string, companyId: string): Promise<KnownVendor[]> {
  const rows = await prisma.booksRecord.findMany({
    where: { organizationId, system, companyId, kind: 'vendor' },
    select: { recordId: true, name: true, data: true },
  });
  return rows.map((r) => ({
    id: r.recordId,
    name: r.name ?? '',
    active: (r.data as { active?: unknown } | null)?.active !== false,
  }));
}

/** From the copy. A vendor added since is found by QuickBooks' own exact match. */
export async function vendorForBill(organizationId: string, system: string, companyId: string, name: string, outcome: SetupOutcome | null): Promise<VendorMatch> {
  return matchVendor(name, await vendorsInCopy(organizationId, system, companyId), outcome?.vendorLinks ?? []);
}
