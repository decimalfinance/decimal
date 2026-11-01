// What a finished setup comes to, as data. Go writes it; fixed code reads it when a
// bill is coded and posted. It is checked on the way out, as any stored JSON is.

import { z } from 'zod';
import { prisma } from '../../infra/prisma.js';

const OUTCOME = z.object({
  companyId: z.string().nullable(),
  postingFrom: z.string(),
  /** Closed through this date, as the person said. Null means never closed. */
  closingDate: z.string().nullable(),
  /** Look-alike vendors the person said are one: a bill for any of them goes to useVendorId. */
  vendorLinks: z.array(z.object({ useVendorId: z.string(), vendorIds: z.array(z.string()) })),
  /** What the person said a line coded two ways should be. A null category means ask each time. */
  lineChoices: z.array(z.object({ vendorId: z.string(), line: z.string().nullable(), categoryId: z.string().nullable() })),
  categoriesInUse: z.array(z.string()),
  cantPost: z.array(z.string()),
});

export type SetupOutcome = z.infer<typeof OUTCOME>;

/** The latest finished setup for these books. Null when there is none, or it can't be read. */
export async function readOutcome(organizationId: string, system: string, companyId: string): Promise<SetupOutcome | null> {
  const setup = await prisma.integrationSetup.findFirst({
    where: { organizationId, system, companyId, status: 'done' },
    orderBy: { updatedAt: 'desc' },
    select: { outcome: true },
  });
  const parsed = OUTCOME.safeParse(setup?.outcome);
  return parsed.success ? parsed.data : null;
}
