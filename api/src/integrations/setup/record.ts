// A setup's saved state. The harness keeps nothing in memory between turns: it
// reads this, takes a turn, and writes back. The event log is append-only and is
// both the receipt of what happened and the queue of what still wants a turn.

import { Prisma, type IntegrationSetup } from '@prisma/client';
import { prisma } from '../../infra/prisma.js';

export const SETUP_SYSTEMS = ['quickbooks'] as const;
export type SetupSystem = (typeof SETUP_SYSTEMS)[number];

/** Longer than a turn can take, so only a dead process ever loses one. */
const TURN_LEASE_SECONDS = 240;

export async function appendEvent(
  setupId: string,
  kind: string,
  payload: Record<string, unknown> = {},
  options: { actorUserId?: string | null; wakes?: boolean } = {},
): Promise<void> {
  await prisma.integrationSetupEvent.create({
    data: {
      setupId,
      kind,
      payload: payload as Prisma.InputJsonValue,
      actorUserId: options.actorUserId ?? null,
      wakes: options.wakes ?? false,
    },
  });
}

/** The events that have not had their turn yet, oldest first. */
export async function pendingEvents(setup: Pick<IntegrationSetup, 'setupId' | 'handledThroughSeq'>) {
  return prisma.integrationSetupEvent.findMany({
    where: { setupId: setup.setupId, wakes: true, seq: { gt: setup.handledThroughSeq } },
    orderBy: { seq: 'asc' },
  });
}

/**
 * Take the turn, if nobody holds it. One atomic update, so two wake-ups cannot
 * both start one: the loser finds no row and leaves, and the holder looks for new
 * events again when it lets go.
 */
export async function claimTurn(setupId: string): Promise<IntegrationSetup | null> {
  const rows = await prisma.$queryRaw<Array<{ setup_id: string }>>`
    UPDATE integration_setups
    SET turn_lease_until = NOW() + make_interval(secs => ${TURN_LEASE_SECONDS}::double precision), updated_at = NOW()
    WHERE setup_id = ${setupId}::uuid AND status = 'open'
      AND (turn_lease_until IS NULL OR turn_lease_until < NOW())
    RETURNING setup_id`;
  if (rows.length === 0) return null;
  return prisma.integrationSetup.findUnique({ where: { setupId } });
}

export async function releaseTurn(setupId: string): Promise<void> {
  await prisma.integrationSetup.updateMany({ where: { setupId }, data: { turnLeaseUntil: null } });
}

/** Open setups with a turn owed and nobody holding it: what a restart leaves behind. */
export async function setupsOwedATurn(limit = 20): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ setup_id: string }>>`
    SELECT s.setup_id
    FROM integration_setups s
    WHERE s.status = 'open'
      AND (s.turn_lease_until IS NULL OR s.turn_lease_until < NOW())
      AND EXISTS (
        SELECT 1 FROM integration_setup_events e
        WHERE e.setup_id = s.setup_id AND e.wakes AND e.seq > s.handled_through_seq)
    ORDER BY s.updated_at
    LIMIT ${limit}`;
  return rows.map((r) => r.setup_id);
}

/** The setup under way for this organisation and system, if there is one. */
export async function liveSetup(organizationId: string, system: string): Promise<IntegrationSetup | null> {
  return prisma.integrationSetup.findFirst({ where: { organizationId, system, status: { in: ['open', 'stopped'] } } });
}
