// Protections — the SoD rule pack as data, plus relaxation mechanics.
// Design: protections-surface-design.md · review: protections-feasibility-review.md.
// One set of constraint_rules rows serves three masters: the relaxation FK target,
// the Protections page cards, and the veto lookup. R7 is non-relaxable in CODE.
import crypto from 'node:crypto';
import { prisma } from '../infra/prisma.js';
import { appendEvent, type Tx } from './store.js';

export const STANDARD_RULES = [
  { code: 'R1', name: 'No self-approval', oneLiner: 'No one can approve a bill they requested.', relaxable: true },
  { code: 'R2', name: 'Separate entry and approval', oneLiner: "Whoever enters a bill can't be its approver.", relaxable: true },
  { code: 'R5', name: "Approving isn't releasing", oneLiner: 'Approving a bill and releasing its payment are separate sign-offs.', relaxable: true },
  { code: 'R7', name: 'Verified payout changes', oneLiner: 'Changing where a vendor gets paid always requires verification.', relaxable: false },
] as const;
export type RuleCode = (typeof STANDARD_RULES)[number]['code'];

/** Idempotent: every org gets the standard pack rows (cards + relaxation FK targets). */
export async function ensureRulePack(tx: Tx, organizationId: string): Promise<void> {
  for (const r of STANDARD_RULES) {
    await tx.$executeRaw`
      INSERT INTO approval.constraint_rules (organization_id, name, cap_a, cap_b, scope, remedy, relaxable)
      SELECT ${organizationId}::uuid, ${r.code}, ${JSON.stringify({ code: r.code })}::jsonb,
             ${JSON.stringify({ oneLiner: r.oneLiner, displayName: r.name })}::jsonb,
             'same_approvable', ${JSON.stringify({ kind: 'continue_walk' })}::jsonb, ${r.relaxable}
      WHERE NOT EXISTS (
        SELECT 1 FROM approval.constraint_rules
        WHERE organization_id = ${organizationId}::uuid AND name = ${r.code})`;
  }
}

export interface ProtectionStatus {
  code: RuleCode;
  displayName: string;
  oneLiner: string;
  relaxable: boolean;
  relaxed: boolean;
  relaxedBy: string | null; // person name
  relaxedAt: Date | null;
  reviewAtHeadcount: number | null;
  scopedPeople: { id: string; name: string }[] | null; // null = everyone
}

export async function listProtections(organizationId: string): Promise<ProtectionStatus[]> {
  await prisma.$transaction((tx) => ensureRulePack(tx, organizationId));
  const rows = await prisma.$queryRaw<
    { name: string; cap_b: { oneLiner: string; displayName: string }; relaxable: boolean; ack_name: string | null; acknowledged_at: Date | null; review_at_headcount: number | null; scoped_people: { id: string; name: string }[] | null }[]
  >`
    SELECT cr.name, cr.cap_b, cr.relaxable, pe.name AS ack_name, rr.acknowledged_at, rr.review_at_headcount,
           (SELECT COALESCE(json_agg(json_build_object('id', sp.id, 'name', sp.name)), 'null'::json)
            FROM approval.people sp WHERE rr.scoped_person_ids IS NOT NULL AND sp.id = ANY(rr.scoped_person_ids)) AS scoped_people
    FROM approval.constraint_rules cr
    LEFT JOIN LATERAL (
      SELECT * FROM approval.rule_relaxations r
      WHERE r.rule_id = cr.id AND r.revoked_at IS NULL
      ORDER BY r.acknowledged_at DESC LIMIT 1
    ) rr ON true
    LEFT JOIN approval.people pe ON pe.id = rr.acknowledged_by
    WHERE cr.organization_id = ${organizationId}::uuid AND cr.active
    ORDER BY cr.name`;
  return rows.map((r) => ({
    code: r.name as RuleCode,
    displayName: r.cap_b.displayName,
    oneLiner: r.cap_b.oneLiner,
    relaxable: r.relaxable,
    relaxed: Boolean(r.acknowledged_at),
    relaxedBy: r.ack_name,
    relaxedAt: r.acknowledged_at,
    reviewAtHeadcount: r.review_at_headcount,
    scopedPeople: r.scoped_people,
  }));
}

/**
 * Is this rule relaxed FOR THIS PERSON? Org-wide relaxations (scoped_person_ids
 * NULL) cover everyone; person-scoped ones cover only the named people.
 * Safeguards are identical either way — scope changes who, never what's recorded.
 */
export async function isRelaxed(tx: Tx, organizationId: string, code: RuleCode, personId: string): Promise<boolean> {
  if (code === 'R7') return false; // non-relaxable floor, enforced here not just in copy
  const rows = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT true AS ok FROM approval.rule_relaxations rr
    JOIN approval.constraint_rules cr ON cr.id = rr.rule_id
    WHERE cr.organization_id = ${organizationId}::uuid AND cr.name = ${code}
      AND rr.revoked_at IS NULL AND cr.relaxable
      AND (rr.scoped_person_ids IS NULL OR ${personId}::uuid = ANY(rr.scoped_person_ids))
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * Relax a protection. Owner-gated + re-authenticated by the caller (routes).
 * The sheet content the owner saw is hashed into the acknowledgment event —
 * "what did they agree to" gets the same provable answer as "what did they see."
 */
export async function relaxProtection(input: {
  organizationId: string;
  code: RuleCode;
  acknowledgedByPersonId: string;
  sheetContent: unknown; // exactly what was rendered to the owner
  reviewAtHeadcount?: number;
  scopedPersonIds?: string[] | null; // null/undefined = everyone
}): Promise<{ relaxed: true }> {
  return prisma.$transaction(async (tx) => {
    await ensureRulePack(tx, input.organizationId);
    const rule = await tx.$queryRaw<{ id: string; relaxable: boolean }[]>`
      SELECT id, relaxable FROM approval.constraint_rules
      WHERE organization_id = ${input.organizationId}::uuid AND name = ${input.code}`;
    if (rule.length === 0 || !rule[0].relaxable) {
      throw new Error(`protection ${input.code} cannot be relaxed`);
    }
    const sheetHash = crypto.createHash('sha256').update(JSON.stringify(input.sheetContent)).digest('hex');
    await tx.$executeRaw`
      INSERT INTO approval.rule_relaxations (rule_id, organization_id, acknowledged_by, compensating, review_at_headcount, scoped_person_ids)
      VALUES (${rule[0].id}::uuid, ${input.organizationId}::uuid, ${input.acknowledgedByPersonId}::uuid,
              ${['badge_on_every_exception', 'monthly_exceptions_digest', 'headcount_review_prompt']}::text[],
              ${input.reviewAtHeadcount ?? 6},
              ${input.scopedPersonIds && input.scopedPersonIds.length > 0 ? input.scopedPersonIds : null}::uuid[])`;
    await appendProtectionEvent(tx, input.organizationId, {
      kind: 'protection_relaxed', rule: input.code,
      acknowledgedBy: input.acknowledgedByPersonId, sheetHash,
      reviewAtHeadcount: input.reviewAtHeadcount ?? 6,
      scopedPersonIds: input.scopedPersonIds ?? null,
    });
    return { relaxed: true as const };
  });
}

/**
 * Re-tighten: one click, zero ceremony, immediate. Sweeps open tasks whose
 * assignee is newly vetoed: marks them vetoed; if that makes a quorum step
 * unsatisfiable, the alert event fires (the H4 shape, surfaced not silent).
 */
export async function revokeRelaxation(input: {
  organizationId: string;
  code: RuleCode;
  revokedByPersonId: string;
}): Promise<{ sweptTasks: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE approval.rule_relaxations rr SET revoked_at = now()
      FROM approval.constraint_rules cr
      WHERE cr.id = rr.rule_id AND cr.organization_id = ${input.organizationId}::uuid
        AND cr.name = ${input.code} AND rr.revoked_at IS NULL`;
    await appendProtectionEvent(tx, input.organizationId, {
      kind: 'protection_retightened', rule: input.code, by: input.revokedByPersonId,
    });

    // Sweep: open tasks that only existed because the rule was relaxed.
    const affected = await tx.$queryRaw<{ task_id: string; approvable_id: string; person_id: string }[]>`
      SELECT t.id AS task_id, a.id AS approvable_id, t.person_id
      FROM approval.tasks t
      JOIN approval.approval_plans p ON p.id = t.plan_id AND p.superseded_by IS NULL
      JOIN approval.approvables a ON a.id = p.approvable_id
      WHERE a.organization_id = ${input.organizationId}::uuid
        AND t.state = 'open' AND a.macro_state = 'pending_approval'
        AND (
          (${input.code} = 'R1' AND t.person_id = a.requester_id AND a.type <> 'vendor_change')
          OR (${input.code} = 'R2' AND t.person_id = a.enterer_id)
        )`;
    for (const t of affected) {
      await tx.$executeRaw`UPDATE approval.tasks SET state = 'vetoed' WHERE id = ${t.task_id}::uuid`;
      await appendEvent(tx, {
        organizationId: input.organizationId, approvableId: t.approvable_id, taskId: t.task_id,
        payload: { kind: 'sod', outcome: { kind: 'veto_blocked', rule: input.code, person: t.person_id }, cause: 'protection_retightened' },
      });
    }
    return { sweptTasks: affected.length };
  });
}

async function appendProtectionEvent(tx: Tx, organizationId: string, payload: Record<string, unknown>): Promise<void> {
  // Protection events are org-level; the log requires an approvable — use the
  // org-settings sentinel approvable created lazily for governance events.
  const sentinel = await tx.$queryRaw<{ id: string }[]>`
    SELECT a.id FROM approval.approvables a
    WHERE a.organization_id = ${organizationId}::uuid AND a.attributes->>'sentinel' = 'governance'
    LIMIT 1`;
  let approvableId = sentinel[0]?.id;
  if (!approvableId) {
    const person = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM approval.people WHERE organization_id = ${organizationId}::uuid LIMIT 1`;
    if (person.length === 0) return; // no people yet — nothing meaningful to log against
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO approval.approvables (organization_id, type, requester_id, total_minor_base, macro_state, attributes)
      VALUES (${organizationId}::uuid, 'vendor_change', ${person[0].id}::uuid, 0, 'cancelled', '{"sentinel":"governance"}'::jsonb)
      RETURNING id`;
    approvableId = rows[0].id;
  }
  await appendEvent(tx, { organizationId, approvableId, payload });
}
