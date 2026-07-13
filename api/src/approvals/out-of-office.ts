// Out-of-office fill-ins (flow-research P1). While a person is away, their OPEN
// approval tasks gain a fill-in for their chosen substitute:
//   - 'any' / N-of-M steps: a SHADOW task — either of them may act (Vic.ai's
//     model; an extra candidate can only help these modes).
//   - 'all' steps: the original task is DELEGATED to the substitute — 'all'
//     counts non-delegated tasks, so mirroring would wrongly require both.
// SoD rules veto unfit substitutes (the engine re-checks at decision time too).
import { prisma } from '../infra/prisma.js';
import { vetoRule } from './sod.js';
import { appendEvent, getActivePlan, getApprovable, insertTask, planTasks, setTaskState, type Tx } from './store.js';

interface OooRow { person_id: string; substitute_person_id: string }

async function activeOoo(tx: Tx, organizationId: string, now: Date): Promise<Map<string, string>> {
  const rows = await tx.$queryRaw<OooRow[]>`
    SELECT person_id, substitute_person_id FROM approval.out_of_office
    WHERE organization_id = ${organizationId}::uuid AND starts_at <= ${now} AND ends_at > ${now}`;
  return new Map(rows.map((r) => [r.person_id, r.substitute_person_id]));
}

/**
 * Ensure every open task held by an away person has its fill-in. Idempotent —
 * safe to call whenever tasks open (activation, step advance, OOO scheduling).
 */
export async function mirrorOooSubstitutes(tx: Tx, approvableId: string, now = new Date()): Promise<number> {
  const approvable = await getApprovable(tx, approvableId);
  if (!approvable || !['pending_approval', 'returned_for_info'].includes(approvable.macro_state)) return 0;
  const ooo = await activeOoo(tx, approvable.organization_id, now);
  if (ooo.size === 0) return 0;
  const plan = await getActivePlan(tx, approvableId);
  if (!plan) return 0;
  const steps: Array<{ index: number; step: { mode: string } }> = Array.isArray(plan.steps) ? (plan.steps as never) : [];
  const tasks = await planTasks(tx, plan.id);
  let mirrored = 0;

  for (const task of tasks.filter((t) => t.state === 'open')) {
    const substitute = ooo.get(task.person_id);
    if (!substitute) continue;
    // The substitute must be fit to act on THIS bill (no self-approval etc.).
    const veto = await vetoRule(tx, approvable, substitute);
    if (veto && !veto.relaxed) continue;
    // Already covered? (their own task, or an earlier mirror)
    const covered = tasks.some((t) => t.step_index === task.step_index && t.person_id === substitute
      && !['obsolete', 'vetoed'].includes(t.state));
    if (covered) continue;

    const mode = steps.find((s) => s.index === task.step_index)?.step.mode ?? 'all';
    if (mode === 'all') {
      // 'all' counts every non-delegated task — hand the slot over instead.
      await setTaskState(tx, task.id, 'delegated');
    }
    await insertTask(tx, {
      planId: plan.id, stepIndex: task.step_index, seatId: null,
      personId: substitute, state: 'open', slaDeadline: task.sla_deadline,
    });
    await appendEvent(tx, {
      organizationId: approvable.organization_id, approvableId, planId: plan.id, taskId: task.id,
      payload: { kind: 'ooo_substitute', awayPersonId: task.person_id, substitutePersonId: substitute, stepIndex: task.step_index, mode },
    });
    mirrored++;
  }
  return mirrored;
}

/** Everything currently waiting on a person, mirrored now — used when OOO is scheduled. */
export async function mirrorPersonOpenTasks(organizationId: string, personId: string): Promise<number> {
  const approvableIds = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT a.id FROM approval.tasks t
    JOIN approval.approval_plans p ON p.id = t.plan_id AND p.superseded_by IS NULL
    JOIN approval.approvables a ON a.id = p.approvable_id
    WHERE t.person_id = ${personId}::uuid AND t.state = 'open'
      AND a.organization_id = ${organizationId}::uuid`;
  let total = 0;
  for (const { id } of approvableIds) {
    total += await prisma.$transaction((tx) => mirrorOooSubstitutes(tx, id));
  }
  return total;
}

export async function getOutOfOffice(organizationId: string, personId: string) {
  const rows = await prisma.$queryRaw<{ substitute_person_id: string; substitute_name: string; ends_at: Date }[]>`
    SELECT o.substitute_person_id, p.name AS substitute_name, o.ends_at
    FROM approval.out_of_office o
    JOIN approval.people p ON p.id = o.substitute_person_id
    WHERE o.organization_id = ${organizationId}::uuid AND o.person_id = ${personId}::uuid AND o.ends_at > now()`;
  const row = rows[0];
  return row ? { substitutePersonId: row.substitute_person_id, substituteName: row.substitute_name, endsAt: row.ends_at.toISOString() } : null;
}

export async function setOutOfOffice(organizationId: string, personId: string, substitutePersonId: string, endsAt: Date) {
  if (substitutePersonId === personId) throw new Error('Pick someone else as your fill-in.');
  if (endsAt.getTime() <= Date.now()) throw new Error('Pick a date in the future.');
  const valid = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM approval.people
    WHERE id = ${substitutePersonId}::uuid AND organization_id = ${organizationId}::uuid AND status = 'active' AND external = false`;
  if (valid.length === 0) throw new Error('That person is not on the team.');
  await prisma.$executeRaw`
    INSERT INTO approval.out_of_office (organization_id, person_id, substitute_person_id, ends_at)
    VALUES (${organizationId}::uuid, ${personId}::uuid, ${substitutePersonId}::uuid, ${endsAt})
    ON CONFLICT (organization_id, person_id)
    DO UPDATE SET substitute_person_id = EXCLUDED.substitute_person_id, ends_at = EXCLUDED.ends_at, starts_at = now()`;
  // Bills already waiting on them get the fill-in immediately.
  const mirrored = await mirrorPersonOpenTasks(organizationId, personId);
  return { ok: true, mirrored };
}

export async function clearOutOfOffice(organizationId: string, personId: string) {
  await prisma.$executeRaw`
    DELETE FROM approval.out_of_office
    WHERE organization_id = ${organizationId}::uuid AND person_id = ${personId}::uuid`;
  return { ok: true };
}
