// L1 hierarchy substrate — the three query primitives (hierarchy-data-model.md).
// All effective-dated; delegation-aware. Recursive CTEs over approval.node_edges.
import type { Tx } from './store.js';

export interface ResolvedPerson { personId: string; viaDelegation: boolean }

/** Current person(s) for a seat at `at`. Active delegate assignments take precedence. */
export async function resolveSeat(tx: Tx, seatId: string, at: Date): Promise<ResolvedPerson[]> {
  const rows = await tx.$queryRaw<{ person_id: string; kind: string }[]>`
    SELECT sa.person_id, sa.kind
    FROM approval.seat_assignments sa
    JOIN approval.people p ON p.id = sa.person_id AND p.status = 'active'
    WHERE sa.seat_id = ${seatId}::uuid
      AND sa.eff_from <= ${at} AND (sa.eff_to IS NULL OR sa.eff_to > ${at})`;
  const delegates = rows.filter((r) => r.kind === 'delegate');
  const source = delegates.length > 0 ? delegates : rows;
  const seen = new Set<string>();
  return source
    .filter((r) => (seen.has(r.person_id) ? false : (seen.add(r.person_id), true)))
    .map((r) => ({ personId: r.person_id, viaDelegation: r.kind === 'delegate' }));
}

export interface WalkResult {
  /** Every grant-bearing seat from entry to root, bottom-up. */
  chain: { seatId: string; nodeId: string; covering: boolean }[];
  /** Index of the first covering grant; -1 = A4 insufficient authority (alert, never a silent stall). */
  coveredIndex: number;
}

/**
 * The tiered-ladder primitive: every seat holding `authority` from `entryNodeId`
 * up to the root. The emitted approval chain is chain[0..coveredIndex] — everyone
 * below the first grant that covers `amountMinorBase` (NULL max = unlimited).
 * Seats past coveredIndex exist for the L3 continue_walk remedy.
 */
export async function walkUp(
  tx: Tx,
  args: { entryNodeId: string; authority: string; amountMinorBase: bigint; at: Date },
): Promise<WalkResult> {
  const rows = await tx.$queryRaw<{ seat_id: string; node_id: string; depth: number; max_amount_minor: bigint | null }[]>`
    WITH RECURSIVE chain(node_id, depth) AS (
      SELECT ${args.entryNodeId}::uuid, 0
      UNION ALL
      SELECT e.parent_id, c.depth + 1
      FROM approval.node_edges e JOIN chain c ON e.child_id = c.node_id
      WHERE e.kind = 'primary' AND e.eff_from <= ${args.at} AND (e.eff_to IS NULL OR e.eff_to > ${args.at})
    )
    SELECT s.id AS seat_id, c.node_id, c.depth, g.max_amount_minor
    FROM chain c
    JOIN approval.seats s ON s.node_id = c.node_id
    JOIN approval.authority_grants g ON g.seat_id = s.id AND g.authority_type = ${args.authority}
    ORDER BY c.depth`;
  const chain = rows.map((r) => ({
    seatId: r.seat_id,
    nodeId: r.node_id,
    covering: r.max_amount_minor === null || BigInt(r.max_amount_minor) >= args.amountMinorBase,
  }));
  return { chain, coveredIndex: chain.findIndex((s) => s.covering) };
}

/** All seats holding `authority` over `scopeNodeId` (grant at the node or an ancestor with inherits_down). */
export async function holders(tx: Tx, authority: string, scopeNodeId: string, at: Date): Promise<string[]> {
  const rows = await tx.$queryRaw<{ seat_id: string }[]>`
    WITH RECURSIVE anc(node_id) AS (
      SELECT ${scopeNodeId}::uuid
      UNION ALL
      SELECT e.parent_id FROM approval.node_edges e JOIN anc a ON e.child_id = a.node_id
      WHERE e.kind = 'primary' AND e.eff_from <= ${at} AND (e.eff_to IS NULL OR e.eff_to > ${at})
    )
    SELECT DISTINCT g.seat_id
    FROM approval.authority_grants g
    WHERE g.authority_type = ${authority}
      AND (g.scope_node_id = ${scopeNodeId}::uuid
           OR (g.inherits_down AND g.scope_node_id IN (SELECT node_id FROM anc)))`;
  return rows.map((r) => r.seat_id);
}

/** Is `nodeId` within the subtree rooted at `maybeAncestor` (inclusive)? */
export async function isInSubtree(tx: Tx, nodeId: string, maybeAncestor: string, at: Date): Promise<boolean> {
  if (nodeId === maybeAncestor) return true;
  const rows = await tx.$queryRaw<{ found: boolean }[]>`
    WITH RECURSIVE anc(node_id) AS (
      SELECT ${nodeId}::uuid
      UNION ALL
      SELECT e.parent_id FROM approval.node_edges e JOIN anc a ON e.child_id = a.node_id
      WHERE e.eff_from <= ${at} AND (e.eff_to IS NULL OR e.eff_to > ${at})
    )
    SELECT true AS found FROM anc WHERE node_id = ${maybeAncestor}::uuid LIMIT 1`;
  return rows.length > 0;
}
