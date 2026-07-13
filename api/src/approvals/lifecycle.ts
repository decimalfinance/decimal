// Lifecycle executor — two nested state machines (approval-lifecycle.md).
// Approvers act on TASKS via idempotent commands; the approvable's macro state
// only ever changes as a consequence. Every transition is an event in the
// append-only log. State columns are cached projections of that log.
import { prisma } from '../infra/prisma.js';
import { fireApprovalTransition, type ApprovalTransition } from './hooks.js';
import { compilePlan, type CompileResult } from './compile.js';
import { vetoRule } from './sod.js';
import { ApprovalEngineError, approverCommandSchema, type ApproverCommandInput } from './schemas.js';
import {
  appendEvent, createApprovable, getActivePlan, getApprovable, getTask, planTasks,
  setMacroState, setTaskState, supersedePlan, type Tx,
} from './store.js';

const OPEN_STATES = new Set(['open', 'info_requested']);
const LIVE_STATES = new Set(['scheduled', 'open', 'info_requested', 'delegated', 'pushed_back', 'escalated']);

export interface SubmitInput {
  organizationId: string;
  type: 'invoice' | 'vendor_change' | 'payment_run' | 'po';
  requesterId: string;
  entererId?: string | null;
  vendorId?: string | null;
  totalMinorBase: bigint;
  attributes?: Record<string, unknown>;
  lines: { amountMinor: bigint; currency: string; description?: string | null; dimensions?: Record<string, string> }[];
}

export interface SubmitResult {
  approvableId: string;
  macroState: string;
  planId: string | null;
  compile: CompileResult;
}

export async function submitApprovable(input: SubmitInput): Promise<SubmitResult> {
  const result = await prisma.$transaction(async (tx) => {
    const approvableId = await createApprovable(tx, input);
    return activate(tx, approvableId, 'submitted');
  });
  if (result.macroState === 'auto_approved' || result.macroState === 'rejected') {
    const approvable = await prisma.$transaction((tx) => getApprovable(tx, result.approvableId));
    if (approvable) await fireApprovalTransition(approvable, result.macroState as ApprovalTransition);
  }
  return result;
}

/** Compile (or recompile) + set macro state accordingly. Shared by submit/resubmit/material-change. */
async function activate(tx: Tx, approvableId: string, why: string): Promise<SubmitResult> {
  const approvable = (await getApprovable(tx, approvableId))!;
  const compile = await compilePlan(tx, approvable);
  let macroState: string;
  if (compile.terminal === 'auto_approve') macroState = 'auto_approved';
  else if (compile.terminal === 'force_reject') macroState = 'rejected';
  else macroState = 'pending_approval';
  await setMacroState(tx, approvableId, macroState);
  await appendEvent(tx, {
    organizationId: approvable.organization_id, approvableId, planId: compile.planId,
    payload: { kind: 'activated', why, macroState },
  });
  if (macroState === 'pending_approval') {
    // Anyone away when their step opens gets their fill-in immediately.
    const { mirrorOooSubstitutes } = await import('./out-of-office.js');
    await mirrorOooSubstitutes(tx, approvableId);
  }
  return { approvableId, macroState, planId: compile.planId, compile };
}

export interface CommandEnvelope {
  taskId: string;
  actorId: string;
  command: ApproverCommandInput;
  idempotencyKey: string;
}

export interface CommandResult {
  replay: boolean;
  taskState: string;
  macroState: string;
}

export async function executeCommand(envelope: CommandEnvelope): Promise<CommandResult> {
  const command = approverCommandSchema.parse(envelope.command);
  const outcome = await prisma.$transaction(async (tx) => {
    const task = await getTask(tx, envelope.taskId);
    if (!task) throw new ApprovalEngineError('unknown_task');
    const plan = await tx.$queryRaw<{ approvable_id: string }[]>`
      SELECT approvable_id FROM approval.approval_plans WHERE id = ${task.plan_id}::uuid`;
    const approvable = (await getApprovable(tx, plan[0].approvable_id))!;

    // Idempotent replay: same key → return current state, apply nothing.
    const logged = await appendEvent(tx, {
      organizationId: approvable.organization_id, approvableId: approvable.id,
      planId: task.plan_id, taskId: task.id, actorId: envelope.actorId, actingAsSeat: task.seat_id,
      idempotencyKey: envelope.idempotencyKey,
      payload: { kind: 'command', command },
    });
    if (logged.replay) {
      const current = (await getTask(tx, envelope.taskId))!;
      return { result: { replay: true, taskState: current.state, macroState: approvable.macro_state }, transition: null };
    }

    // Authorization is the engine's job, not the UI's.
    const requesterCommands = new Set(['provide_info', 'recall', 'resubmit']);
    if (requesterCommands.has(command.kind)) {
      if (envelope.actorId !== approvable.requester_id) throw new ApprovalEngineError('forbidden_role');
    } else if (envelope.actorId !== task.person_id) {
      throw new ApprovalEngineError('forbidden_role');
    }

    switch (command.kind) {
      case 'approve': {
        requireOpen(task.state);
        // SoD re-checked at decision time — roles change mid-flight.
        const veto = await vetoRule(tx, approvable, envelope.actorId);
        if (veto && !veto.relaxed) throw new ApprovalEngineError('sod_violation', `vetoed by ${veto.rule}`, { rule: veto.rule });
        if (veto?.relaxed) {
          // The badge's source of truth: this approval happened under a relaxed protection.
          await appendEvent(tx, {
            organizationId: approvable.organization_id, approvableId: approvable.id,
            planId: task.plan_id, taskId: task.id, actorId: envelope.actorId,
            payload: { kind: 'sod', outcome: { kind: 'relaxed_exception', rule: veto.rule, person: envelope.actorId } },
          });
        }
        await setTaskState(tx, task.id, 'approved');
        await settleStep(tx, approvable.organization_id, approvable.id, task.plan_id, task.step_index);
        break;
      }
      case 'reject': {
        requireOpen(task.state);
        await setTaskState(tx, task.id, 'rejected');
        await closeLiveTasks(tx, task.plan_id, 'obsolete');
        await setMacroState(tx, approvable.id, 'rejected');
        break;
      }
      case 'request_info': {
        requireOpen(task.state);
        await setTaskState(tx, task.id, 'info_requested');
        await setMacroState(tx, approvable.id, 'returned_for_info');
        break;
      }
      case 'provide_info': {
        const tasks = await planTasks(tx, task.plan_id);
        for (const t of tasks.filter((t) => t.state === 'info_requested')) await setTaskState(tx, t.id, 'open');
        await setMacroState(tx, approvable.id, 'pending_approval');
        break;
      }
      case 'delegate': {
        requireOpen(task.state);
        const veto = await vetoRule(tx, approvable, command.to);
        if (veto && !veto.relaxed) throw new ApprovalEngineError('sod_violation', `delegate vetoed by ${veto.rule}`, { rule: veto.rule }); // assignment-time check
        await setTaskState(tx, task.id, 'delegated');
        await tx.$executeRaw`
          INSERT INTO approval.tasks (plan_id, step_index, seat_id, person_id, state, sla_deadline)
          VALUES (${task.plan_id}::uuid, ${task.step_index}, ${task.seat_id}::uuid, ${command.to}::uuid, 'open', ${task.sla_deadline})`;
        break;
      }
      case 'push_back': {
        requireOpen(task.state);
        if (task.step_index === 0) throw new ApprovalEngineError('invalid_state', 'nothing before step 0');
        await setTaskState(tx, task.id, 'pushed_back');
        const tasks = await planTasks(tx, task.plan_id);
        for (const t of tasks.filter((t) => t.step_index === task.step_index - 1 && t.state === 'approved')) {
          await setTaskState(tx, t.id, 'open');
        }
        break;
      }
      case 'add_approver': {
        requireOpen(task.state);
        // v1: person targets only for ad-hoc adds (any participant may add; removal is admin-only)
        if (command.target.kind !== 'person') throw new ApprovalEngineError('invalid_state', 'v1 add_approver takes a person target');
        const veto = await vetoRule(tx, approvable, command.target.personId);
        if (veto && !veto.relaxed) throw new ApprovalEngineError('sod_violation', `added approver vetoed by ${veto.rule}`, { rule: veto.rule });
        await tx.$executeRaw`
          INSERT INTO approval.tasks (plan_id, step_index, seat_id, person_id, state)
          VALUES (${task.plan_id}::uuid, ${task.step_index}, NULL, ${command.target.personId}::uuid, 'open')`;
        break;
      }
      case 'hold': await setMacroState(tx, approvable.id, 'on_hold'); break;
      case 'resume': await setMacroState(tx, approvable.id, 'pending_approval'); break;
      case 'recall': {
        await closeLiveTasks(tx, task.plan_id, 'obsolete');
        await setMacroState(tx, approvable.id, 'cancelled');
        break;
      }
      case 'resubmit': {
        if (!['rejected', 'cancelled'].includes(approvable.macro_state)) {
          throw new ApprovalEngineError('invalid_state', 'resubmit only after rejection/recall');
        }
        const old = await getActivePlan(tx, approvable.id);
        const fresh = await activate(tx, approvable.id, 'resubmitted');
        if (old && fresh.planId) await supersedePlan(tx, old.id, fresh.planId);
        break;
      }
    }

    const finalTask = (await getTask(tx, envelope.taskId))!;
    const finalApprovable = (await getApprovable(tx, approvable.id))!;
    return {
      result: { replay: false, taskState: finalTask.state, macroState: finalApprovable.macro_state },
      transition: approvable.macro_state !== finalApprovable.macro_state
        && ['approved', 'auto_approved', 'rejected'].includes(finalApprovable.macro_state)
        ? { approvable: finalApprovable, to: finalApprovable.macro_state as ApprovalTransition }
        : null,
    };
  });
  if (outcome.transition) await fireApprovalTransition(outcome.transition.approvable, outcome.transition.to);
  return outcome.result;
}

function requireOpen(state: string): void {
  if (!OPEN_STATES.has(state)) throw new ApprovalEngineError('step_already_closed', `task is ${state}`);
}

/** Step-mode completion: all / any / quorum(m). Completing the last step approves the approvable. */
async function settleStep(tx: Tx, organizationId: string, approvableId: string, planId: string, stepIndex: number): Promise<void> {
  const plan = await getActivePlan(tx, approvableId);
  if (!plan || plan.id !== planId) return; // superseded mid-flight — nothing to settle
  const steps = plan.steps as { index: number; step: { mode: string; m?: number }; slaHours: number | null }[];
  const mode = steps.find((s) => s.index === stepIndex)?.step ?? { mode: 'all' };
  const tasks = await planTasks(tx, planId);
  const inStep = tasks.filter((t) => t.step_index === stepIndex);
  const approvals = inStep.filter((t) => t.state === 'approved').length;
  // delegated tasks transferred their duty to a replacement task — they don't count toward 'all'
  const needed = mode.mode === 'any' ? 1 : mode.mode === 'quorum' ? (mode.m ?? 1)
    : inStep.filter((t) => !['obsolete', 'vetoed', 'delegated'].includes(t.state)).length;
  if (approvals < needed) return;

  // satisfied — close siblings that are no longer needed
  for (const t of inStep.filter((t) => LIVE_STATES.has(t.state))) await setTaskState(tx, t.id, 'obsolete');
  await appendEvent(tx, {
    organizationId, approvableId, planId,
    payload: { kind: 'step_satisfied', stepIndex, mode },
  });

  const next = steps.find((s) => s.index === stepIndex + 1);
  if (!next) {
    await setMacroState(tx, approvableId, 'approved');
    await appendEvent(tx, { organizationId, approvableId, planId, payload: { kind: 'approved' } });
    return;
  }
  const sla = next.slaHours ? new Date(Date.now() + next.slaHours * 3_600_000) : null;
  for (const t of tasks.filter((t) => t.step_index === next.index && t.state === 'scheduled')) {
    await setTaskState(tx, t.id, 'open', { slaDeadline: sla });
  }
  // The step just opened — cover anyone in it who is away.
  const { mirrorOooSubstitutes } = await import('./out-of-office.js');
  await mirrorOooSubstitutes(tx, approvableId);
}

async function closeLiveTasks(tx: Tx, planId: string, to: string): Promise<void> {
  const tasks = await planTasks(tx, planId);
  for (const t of tasks.filter((t) => LIVE_STATES.has(t.state))) await setTaskState(tx, t.id, to);
}

// --- change semantics ---------------------------------------------------------

/**
 * Material change: before any decision → silent recompile; after ≥1 decision →
 * invalidate collected approvals, recompile, restart (routing-policy-model.md table).
 */
export async function applyMaterialChange(
  approvableId: string,
  change: { totalMinorBase?: bigint; vendorId?: string | null },
): Promise<SubmitResult> {
  return prisma.$transaction(async (tx) => {
    const approvable = (await getApprovable(tx, approvableId))!;
    const plan = await getActivePlan(tx, approvableId);
    const tasks = plan ? await planTasks(tx, plan.id) : [];
    const decided = tasks.some((t) => t.state === 'approved' || t.state === 'rejected');

    // the pending_approval lock trigger guards direct edits — go through draft
    await setMacroState(tx, approvableId, 'draft');
    if (change.totalMinorBase !== undefined) {
      await tx.$executeRaw`UPDATE approval.approvables SET total_minor_base = ${change.totalMinorBase} WHERE id = ${approvableId}::uuid`;
    }
    if (change.vendorId !== undefined) {
      await tx.$executeRaw`UPDATE approval.approvables SET vendor_id = ${change.vendorId}::uuid WHERE id = ${approvableId}::uuid`;
    }
    if (plan) {
      for (const t of tasks.filter((t) => LIVE_STATES.has(t.state) || t.state === 'approved')) {
        await setTaskState(tx, t.id, 'obsolete');
      }
      await appendEvent(tx, {
        organizationId: approvable.organization_id, approvableId, planId: plan.id,
        payload: { kind: 'plan_invalidated', reason: decided ? 'material_change' : 'silent_recompile' },
      });
    }
    const fresh = await activate(tx, approvableId, decided ? 'material_change_restart' : 'silent_recompile');
    if (plan && fresh.planId) await supersedePlan(tx, plan.id, fresh.planId);
    return fresh;
  });
}

// --- release (H rows): approved invoice → payment_run approvable ----------------

/**
 * Spawn the release ceremony as a `payment_run` approvable (engine review §1).
 * Its policy (org's payment_run PolicySet) compiles to the keyholder quorum step;
 * R5 vetoes anyone who approved the source invoice, at this compile.
 */
export async function spawnReleaseRun(sourceApprovableId: string): Promise<SubmitResult> {
  return prisma.$transaction(async (tx) => {
    const source = (await getApprovable(tx, sourceApprovableId))!;
    if (!['approved', 'auto_approved'].includes(source.macro_state)) {
      throw new ApprovalEngineError('invalid_state', 'release requires an approved approvable');
    }
    const lines = await tx.$queryRaw<{ amount_minor: bigint; currency: string }[]>`
      SELECT amount_minor, currency FROM approval.approvable_lines WHERE approvable_id = ${sourceApprovableId}::uuid`;
    const approvableId = await createApprovable(tx, {
      organizationId: source.organization_id, type: 'payment_run', requesterId: source.requester_id,
      vendorId: source.vendor_id, totalMinorBase: source.total_minor_base,
      // Routing facts ride along so payment-flow splits (category, first-bill)
      // evaluate on the release run exactly like they do on the invoice.
      attributes: {
        sourceApprovableId,
        ...(Array.isArray(source.attributes?.categories) ? { categories: source.attributes.categories } : {}),
        ...(typeof source.attributes?.vendor_is_first_invoice === 'boolean' ? { vendor_is_first_invoice: source.attributes.vendor_is_first_invoice } : {}),
      },
      lines: lines.map((l) => ({ amountMinor: l.amount_minor, currency: l.currency })),
    });
    return activate(tx, approvableId, 'release_spawned');
  });
}

// --- timers (remind → escalate; escalated flag persists) -------------------------

export async function sweepTimers(now = new Date()): Promise<{ escalated: number }> {
  return prisma.$transaction(async (tx) => {
    const overdue = await tx.$queryRaw<{ id: string; plan_id: string; step_index: number; escalated_ever: boolean; approvable_id: string; organization_id: string; requester_id: string }[]>`
      SELECT t.id, t.plan_id, t.step_index, t.escalated_ever, p.approvable_id, a.organization_id, a.requester_id
      FROM approval.tasks t
      JOIN approval.approval_plans p ON p.id = t.plan_id
      JOIN approval.approvables a ON a.id = p.approvable_id
      WHERE t.state = 'open' AND t.sla_deadline IS NOT NULL AND t.sla_deadline <= ${now}`;
    let escalated = 0;
    for (const t of overdue) {
      if (!t.escalated_ever) {
        await setTaskState(tx, t.id, 'open', { escalated: true }); // flag persists (IBM semantics)
        await appendEvent(tx, {
          organizationId: t.organization_id, approvableId: t.approvable_id, planId: t.plan_id, taskId: t.id,
          payload: { kind: 'timer', fired: 'escalation' },
        });
        // Escalate-to-owner (flow-research P1): a stalled step gains the primary
        // admin as a fill-in approver so an absent approver can never park a
        // bill forever. An aged bill escalates — it NEVER auto-denies.
        const owner = await tx.$queryRaw<{ id: string }[]>`
          SELECT pe.id FROM approval.people pe
          JOIN organization_memberships om ON om.user_id = pe.user_id AND om.organization_id = pe.organization_id
          WHERE pe.organization_id = ${t.organization_id}::uuid AND om.role = 'owner'
            AND om.status = 'active' AND pe.status = 'active'
          LIMIT 1`;
        const ownerId = owner[0]?.id ?? null;
        if (ownerId && ownerId !== t.requester_id) {
          const already = await tx.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) AS n FROM approval.tasks
            WHERE plan_id = ${t.plan_id}::uuid AND step_index = ${t.step_index}
              AND person_id = ${ownerId}::uuid AND state IN ('open', 'approved', 'info_requested')`;
          const approvable = (await getApprovable(tx, t.approvable_id))!;
          const veto = await vetoRule(tx, approvable, ownerId);
          if (Number(already[0]!.n) === 0 && (!veto || veto.relaxed)) {
            await tx.$executeRaw`
              INSERT INTO approval.tasks (plan_id, step_index, seat_id, person_id, state)
              VALUES (${t.plan_id}::uuid, ${t.step_index}, NULL, ${ownerId}::uuid, 'open')`;
            await appendEvent(tx, {
              organizationId: t.organization_id, approvableId: t.approvable_id, planId: t.plan_id, taskId: t.id,
              payload: { kind: 'timer', fired: 'escalated_to_owner', ownerPersonId: ownerId },
            });
          }
        }
        escalated++;
      }
    }
    return { escalated };
  });
}
