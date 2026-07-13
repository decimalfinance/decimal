// Raw-SQL access to the `approval` schema (engine tables are deliberately outside
// Prisma's schema — see postgres/init/002-approval-engine.sql). Everything money
// is bigint minor units; jsonb payloads validated by schemas.ts at the boundary.
import { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';

export type Tx = Prisma.TransactionClient;
export const db = () => prisma;

// --- event log ---------------------------------------------------------------

export interface AppendEventInput {
  organizationId: string;
  approvableId: string;
  planId?: string | null;
  taskId?: string | null;
  actorId?: string | null; // null = system
  actingAsSeat?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
}

/** Append to the log. Same idempotency key twice → returns the existing seq, applies nothing. */
export async function appendEvent(tx: Tx, e: AppendEventInput): Promise<{ seq: bigint; replay: boolean }> {
  if (e.idempotencyKey) {
    const existing = await tx.$queryRaw<{ seq: bigint }[]>`
      SELECT seq FROM approval.approval_events
      WHERE organization_id = ${e.organizationId}::uuid AND idempotency_key = ${e.idempotencyKey}`;
    if (existing.length > 0) return { seq: existing[0].seq, replay: true };
  }
  const rows = await tx.$queryRaw<{ seq: bigint }[]>`
    INSERT INTO approval.approval_events
      (organization_id, approvable_id, plan_id, task_id, actor_id, acting_as_seat, idempotency_key, payload)
    VALUES (${e.organizationId}::uuid, ${e.approvableId}::uuid, ${e.planId ?? null}::uuid, ${e.taskId ?? null}::uuid,
            ${e.actorId ?? null}::uuid, ${e.actingAsSeat ?? null}::uuid, ${e.idempotencyKey ?? null},
            ${JSON.stringify(e.payload)}::jsonb)
    RETURNING seq`;
  return { seq: rows[0].seq, replay: false };
}

export async function listEvents(organizationId: string, approvableId: string) {
  return prisma.$queryRaw<{ seq: bigint; at: Date; actor_id: string | null; payload: unknown }[]>`
    SELECT seq, at, actor_id, payload FROM approval.approval_events
    WHERE organization_id = ${organizationId}::uuid AND approvable_id = ${approvableId}::uuid
    ORDER BY seq`;
}

// --- approvables ---------------------------------------------------------------

export interface ApprovableRow {
  id: string;
  organization_id: string;
  type: string;
  requester_id: string;
  enterer_id: string | null;
  vendor_id: string | null;
  total_minor_base: bigint;
  macro_state: string;
  attributes: Record<string, unknown>;
}

export async function getApprovable(tx: Tx, id: string): Promise<ApprovableRow | null> {
  const rows = await tx.$queryRaw<ApprovableRow[]>`
    SELECT id, organization_id, type, requester_id, enterer_id, vendor_id, total_minor_base, macro_state, attributes
    FROM approval.approvables WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
}

export async function setMacroState(tx: Tx, id: string, state: string): Promise<void> {
  await tx.$executeRaw`UPDATE approval.approvables SET macro_state = ${state} WHERE id = ${id}::uuid`;
}

export async function getLines(tx: Tx, approvableId: string) {
  return tx.$queryRaw<{ line_no: number; amount_minor: bigint; currency: string; description: string | null; dimensions: Record<string, string> }[]>`
    SELECT line_no, amount_minor, currency, description, dimensions
    FROM approval.approvable_lines WHERE approvable_id = ${approvableId}::uuid ORDER BY line_no`;
}

// --- policies / plans / tasks ---------------------------------------------------

export async function getPolicy(tx: Tx, id: string, version: number) {
  const rows = await tx.$queryRaw<{ id: string; version: number; name: string; body: unknown }[]>`
    SELECT id, version, name, body FROM approval.policies WHERE id = ${id}::uuid AND version = ${version}`;
  return rows[0] ?? null;
}

export async function getPolicySet(tx: Tx, organizationId: string, approvableType: string) {
  const rows = await tx.$queryRaw<{ rules: unknown; default_policy_id: string; default_policy_version: number }[]>`
    SELECT rules, default_policy_id, default_policy_version FROM approval.policy_sets
    WHERE organization_id = ${organizationId}::uuid AND approvable_type = ${approvableType}`;
  return rows[0] ?? null;
}

export async function insertPlan(
  tx: Tx,
  plan: {
    approvableId: string; policyId: string; policyVersion: number; selectorRule: string;
    steps: unknown[]; sodOutcomes: unknown[];
  },
): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO approval.approval_plans (approvable_id, policy_id, policy_version, selector_rule, steps, sod_outcomes)
    VALUES (${plan.approvableId}::uuid, ${plan.policyId}::uuid, ${plan.policyVersion}, ${plan.selectorRule},
            ${JSON.stringify(plan.steps)}::jsonb, ${JSON.stringify(plan.sodOutcomes)}::jsonb)
    RETURNING id`;
  return rows[0].id;
}

export async function getActivePlan(tx: Tx, approvableId: string) {
  const rows = await tx.$queryRaw<{ id: string; steps: unknown; sod_outcomes: unknown; policy_id: string | null; policy_version: number | null }[]>`
    SELECT id, steps, sod_outcomes, policy_id, policy_version FROM approval.approval_plans
    WHERE approvable_id = ${approvableId}::uuid AND superseded_by IS NULL
    ORDER BY compiled_at DESC LIMIT 1`;
  return rows[0] ?? null;
}

export async function supersedePlan(tx: Tx, oldPlanId: string, newPlanId: string): Promise<void> {
  await tx.$executeRaw`UPDATE approval.approval_plans SET superseded_by = ${newPlanId}::uuid WHERE id = ${oldPlanId}::uuid`;
}

export interface TaskRow {
  id: string; plan_id: string; step_index: number; seat_id: string | null; person_id: string;
  state: string; escalated_ever: boolean; sla_deadline: Date | null;
}

export async function insertTask(
  tx: Tx,
  t: { planId: string; stepIndex: number; seatId: string | null; personId: string; state: string; slaDeadline?: Date | null },
): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO approval.tasks (plan_id, step_index, seat_id, person_id, state, sla_deadline)
    VALUES (${t.planId}::uuid, ${t.stepIndex}, ${t.seatId}::uuid, ${t.personId}::uuid, ${t.state}, ${t.slaDeadline ?? null})
    RETURNING id`;
  return rows[0].id;
}

export async function getTask(tx: Tx, id: string): Promise<TaskRow | null> {
  const rows = await tx.$queryRaw<TaskRow[]>`
    SELECT id, plan_id, step_index, seat_id, person_id, state, escalated_ever, sla_deadline
    FROM approval.tasks WHERE id = ${id}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

export async function planTasks(tx: Tx, planId: string): Promise<TaskRow[]> {
  return tx.$queryRaw<TaskRow[]>`
    SELECT id, plan_id, step_index, seat_id, person_id, state, escalated_ever, sla_deadline
    FROM approval.tasks WHERE plan_id = ${planId}::uuid ORDER BY step_index`;
}

export async function setTaskState(tx: Tx, id: string, state: string, opts?: { escalated?: boolean; slaDeadline?: Date | null }): Promise<void> {
  await tx.$executeRaw`
    UPDATE approval.tasks SET
      state = ${state},
      escalated_ever = escalated_ever OR ${opts?.escalated ?? false},
      sla_deadline = COALESCE(${opts?.slaDeadline ?? null}, sla_deadline)
    WHERE id = ${id}::uuid`;
}

// --- fixture/builder helpers (used by app setup code AND acceptance tests) -------

export async function ensureOrgSettings(tx: Tx, organizationId: string, baseCurrency = 'USD'): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO approval.org_settings (organization_id, base_currency)
    VALUES (${organizationId}::uuid, ${baseCurrency}) ON CONFLICT (organization_id) DO NOTHING`;
}

export async function createPerson(tx: Tx, organizationId: string, name: string, email: string): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO approval.people (organization_id, name, email) VALUES (${organizationId}::uuid, ${name}, ${email})
    ON CONFLICT (organization_id, email) DO UPDATE SET name = EXCLUDED.name
    RETURNING id`;
  return rows[0].id;
}

export async function createHierarchy(tx: Tx, organizationId: string, name: string, type: string): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO approval.hierarchies (organization_id, name, type) VALUES (${organizationId}::uuid, ${name}, ${type}) RETURNING id`;
  return rows[0].id;
}

export async function createNode(tx: Tx, hierarchyId: string, name: string, parentId?: string): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO approval.nodes (hierarchy_id, name) VALUES (${hierarchyId}::uuid, ${name}) RETURNING id`;
  const nodeId = rows[0].id;
  if (parentId) {
    await tx.$executeRaw`INSERT INTO approval.node_edges (child_id, parent_id) VALUES (${nodeId}::uuid, ${parentId}::uuid)`;
  }
  return nodeId;
}

export async function createSeat(tx: Tx, nodeId: string, name: string, kind: 'single' | 'group' = 'single', quorum?: number): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO approval.seats (node_id, name, kind, quorum) VALUES (${nodeId}::uuid, ${name}, ${kind}, ${quorum ?? null}) RETURNING id`;
  return rows[0].id;
}

// Separation-of-duties switches (approval.org_settings). Each maps to one of the
// engine's veto rules; ON here means the org has OPTED OUT of that separation.
// Defaults (all false) preserve fully-separated behavior.
export type SodFlags = { reviewerCanApprove: boolean; submitterCanApprove: boolean; approverCanRelease: boolean };

export async function getSodFlags(tx: Tx, organizationId: string): Promise<SodFlags> {
  const rows = await tx.$queryRaw<{ reviewer_can_approve: boolean; submitter_can_approve: boolean; approver_can_release: boolean }[]>`
    SELECT reviewer_can_approve, submitter_can_approve, approver_can_release
    FROM approval.org_settings WHERE organization_id = ${organizationId}::uuid`;
  const r = rows[0];
  return {
    reviewerCanApprove: r?.reviewer_can_approve ?? false,
    submitterCanApprove: r?.submitter_can_approve ?? false,
    approverCanRelease: r?.approver_can_release ?? false,
  };
}

export async function setSodFlags(tx: Tx, organizationId: string, flags: SodFlags): Promise<void> {
  await ensureOrgSettings(tx, organizationId);
  await tx.$executeRaw`
    UPDATE approval.org_settings
    SET reviewer_can_approve = ${flags.reviewerCanApprove},
        submitter_can_approve = ${flags.submitterCanApprove},
        approver_can_release = ${flags.approverCanRelease}
    WHERE organization_id = ${organizationId}::uuid`;
}

// Org bill ceiling (policy P1): a hard cap no bill may cross without the
// primary admin raising it. NULL = no ceiling configured.
export async function getBillCeilingMinor(tx: Tx, organizationId: string): Promise<bigint | null> {
  const rows = await tx.$queryRaw<{ bill_ceiling_minor: bigint | null }[]>`
    SELECT bill_ceiling_minor FROM approval.org_settings WHERE organization_id = ${organizationId}::uuid`;
  return rows[0]?.bill_ceiling_minor ?? null;
}

export async function setBillCeilingMinor(tx: Tx, organizationId: string, ceilingMinor: bigint | null): Promise<void> {
  await ensureOrgSettings(tx, organizationId);
  await tx.$executeRaw`
    UPDATE approval.org_settings
    SET bill_ceiling_minor = ${ceilingMinor}
    WHERE organization_id = ${organizationId}::uuid`;
}

export async function assignSeat(
  tx: Tx, seatId: string, personId: string,
  kind: 'permanent' | 'acting' | 'delegate' = 'permanent', effFrom?: Date, effTo?: Date,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO approval.seat_assignments (seat_id, person_id, kind, eff_from, eff_to)
    VALUES (${seatId}::uuid, ${personId}::uuid, ${kind}, ${effFrom ?? new Date()}, ${effTo ?? null})`;
}

export async function grantAuthority(
  tx: Tx, seatId: string, authorityType: string, scopeNodeId: string, maxAmountMinor?: bigint,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO approval.authority_grants (seat_id, authority_type, max_amount_minor, scope_node_id)
    VALUES (${seatId}::uuid, ${authorityType}, ${maxAmountMinor ?? null}, ${scopeNodeId}::uuid)`;
}

export async function createPolicy(
  tx: Tx, organizationId: string, approvableType: string, name: string, body: unknown[], id?: string, version = 1,
): Promise<{ id: string; version: number }> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO approval.policies (id, version, organization_id, approvable_type, name, body)
    VALUES (COALESCE(${id ?? null}::uuid, gen_random_uuid()), ${version}, ${organizationId}::uuid, ${approvableType}, ${name}, ${JSON.stringify(body)}::jsonb)
    RETURNING id`;
  return { id: rows[0].id, version };
}

export async function upsertPolicySet(
  tx: Tx, organizationId: string, approvableType: string,
  rules: unknown[], defaultPolicyId: string, defaultPolicyVersion: number,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO approval.policy_sets (organization_id, approvable_type, rules, default_policy_id, default_policy_version)
    VALUES (${organizationId}::uuid, ${approvableType}, ${JSON.stringify(rules)}::jsonb, ${defaultPolicyId}::uuid, ${defaultPolicyVersion})
    ON CONFLICT (organization_id, approvable_type)
    DO UPDATE SET rules = EXCLUDED.rules, default_policy_id = EXCLUDED.default_policy_id,
                  default_policy_version = EXCLUDED.default_policy_version`;
}

export async function createApprovable(
  tx: Tx,
  a: {
    organizationId: string; type: string; requesterId: string; entererId?: string | null; vendorId?: string | null;
    totalMinorBase: bigint; attributes?: Record<string, unknown>;
    lines: { amountMinor: bigint; currency: string; description?: string | null; dimensions?: Record<string, string> }[];
  },
): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO approval.approvables (organization_id, type, requester_id, enterer_id, vendor_id, total_minor_base, attributes)
    VALUES (${a.organizationId}::uuid, ${a.type}, ${a.requesterId}::uuid, ${a.entererId ?? null}::uuid,
            ${a.vendorId ?? null}::uuid, ${a.totalMinorBase}, ${JSON.stringify(a.attributes ?? {})}::jsonb)
    RETURNING id`;
  const id = rows[0].id;
  for (let i = 0; i < a.lines.length; i++) {
    const l = a.lines[i];
    await tx.$executeRaw`
      INSERT INTO approval.approvable_lines (approvable_id, line_no, amount_minor, currency, description, dimensions)
      VALUES (${id}::uuid, ${i + 1}, ${l.amountMinor}, ${l.currency}, ${l.description ?? null}, ${JSON.stringify(l.dimensions ?? {})}::jsonb)`;
  }
  return id;
}
