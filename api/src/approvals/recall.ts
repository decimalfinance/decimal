/**
 * Recall as a request, not a button.
 *
 * A recall throws away approvals that real people gave. The engine used to let
 * the requester do that alone and instantly: click, and two colleagues' sign-off
 * evaporated with no reason recorded and nobody asked. This module makes it a
 * decision somebody owns.
 *
 *   request  -> the bill freezes on the spot, reason recorded
 *   grant    -> the recall happens: tasks obsolete, bill back to draft
 *   deny     -> the bill resumes exactly where it stood, approvals intact
 *   withdraw -> the asker changed their mind, same restore as deny
 *
 * Freezing on the *request* rather than on the decision is deliberate. Left
 * running, a third approver can approve into a bill everyone already knows is
 * wrong — and the grant then destroys three approvals instead of two.
 *
 * Two of the four outcomes cost nothing, which is the point: raising a request
 * has to be safe, or people quietly pay the wrong bill instead of asking.
 */
import { prisma } from '../infra/prisma.js';
import type { Tx } from './store.js';
import { appendEvent, getApprovable, getActivePlan, setMacroState } from './store.js';
import { closeLiveTasks } from './lifecycle.js';
import { fireApprovalTransition, type ApprovalTransition } from './hooks.js';
import { ApprovalEngineError } from './schemas.js';

/** States a bill can be recalled *out of*. */
const RECALLABLE = new Set(['pending_approval', 'returned_for_info', 'on_hold']);

export interface RecallRequestRow {
  id: string;
  organization_id: string;
  approvable_id: string;
  requested_by: string;
  requested_by_name: string | null;
  reason: string;
  state: 'pending' | 'granted' | 'denied' | 'withdrawn';
  paused_from: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
}

const SELECT_ROW = `
  r.id::text, r.organization_id::text AS organization_id, r.approvable_id::text AS approvable_id,
  r.requested_by::text AS requested_by, rp.name AS requested_by_name,
  r.reason, r.state, r.paused_from,
  r.decided_by::text AS decided_by, dp.name AS decided_by_name,
  r.decided_at, r.decision_note, r.created_at`;

/**
 * Is this person a primary admin or admin of the org?
 *
 * Resolved the same way the compiler's last-resort approver search does it —
 * engine person joined to the workspace membership — because the engine holds
 * people and the control plane holds standing, and only the join knows both.
 */
export async function isOrgAdmin(tx: Tx, organizationId: string, personId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT true AS ok FROM approval.people p
    JOIN organization_memberships om
      ON om.user_id = p.user_id AND om.organization_id = p.organization_id
    WHERE p.id = ${personId}::uuid
      AND p.organization_id = ${organizationId}::uuid
      AND om.role IN ('primary_admin', 'admin') AND om.status = 'active' AND p.status = 'active'`;
  return rows.length > 0;
}

/**
 * Can this person decide a recall themselves? Same question isOrgAdmin answers,
 * for callers who are not already inside a transaction.
 */
export async function canDecideRecall(organizationId: string, personId: string): Promise<boolean> {
  return prisma.$transaction((tx) => isOrgAdmin(tx, organizationId, personId));
}

// --- raising -----------------------------------------------------------------

export interface RequestRecallInput {
  approvableId: string;
  actorId: string;
  reason: string;
  idempotencyKey?: string;
}

/**
 * The requester asks for their bill back, and the bill stops moving.
 *
 * Only the person whose request it is may raise one. An approver who wants
 * changes already has reject and request_info; an admin who wants the bill out
 * has the send-back route. This is the submitter's door, and it is the one door
 * that was missing.
 */
export async function requestRecall(input: RequestRecallInput): Promise<{
  requestId: string;
  macroState: string;
  pausedFrom: string;
}> {
  const reason = input.reason.trim();
  if (!reason) throw new ApprovalEngineError('missing_reason', 'A recall needs a reason.');

  const outcome = await prisma.$transaction(async (tx) => {
    const approvable = await getApprovable(tx, input.approvableId);
    if (!approvable) throw new ApprovalEngineError('invalid_state', 'Unknown bill.');

    if (input.actorId !== approvable.requester_id) {
      throw new ApprovalEngineError('forbidden_role', 'Only the person who submitted this bill can ask for it back.');
    }
    if (['approved', 'auto_approved'].includes(approvable.macro_state)) {
      throw new ApprovalEngineError('invalid_state', 'This bill is already approved — an admin can send it back to draft.');
    }
    if (!RECALLABLE.has(approvable.macro_state)) {
      throw new ApprovalEngineError('invalid_state', `This bill is ${approvable.macro_state} — there is nothing in approval to recall.`);
    }

    const pausedFrom = approvable.macro_state;
    // Freeze first: everything after this happens to a bill nobody can approve.
    if (pausedFrom !== 'on_hold') await setMacroState(tx, input.approvableId, 'on_hold');

    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO approval.recall_requests
        (organization_id, approvable_id, requested_by, reason, paused_from)
      VALUES (${approvable.organization_id}::uuid, ${input.approvableId}::uuid,
              ${input.actorId}::uuid, ${reason}, ${pausedFrom})
      RETURNING id::text`;
    const requestId = rows[0]!.id;

    const plan = await getActivePlan(tx, input.approvableId);
    await appendEvent(tx, {
      organizationId: approvable.organization_id,
      approvableId: input.approvableId,
      planId: plan?.id ?? null,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey ?? null,
      payload: { kind: 'recall_requested', requestId, reason, pausedFrom },
    });

    return { requestId, pausedFrom, approvable };
  });

  // Hooks fire after the transaction, never inside it.
  await fireApprovalTransition({ ...outcome.approvable, macro_state: 'on_hold' }, 'on_hold');
  return { requestId: outcome.requestId, macroState: 'on_hold', pausedFrom: outcome.pausedFrom };
}

// --- deciding ----------------------------------------------------------------

export interface DecideRecallInput {
  requestId: string;
  actorId: string;
  grant: boolean;
  note?: string;
  idempotencyKey?: string;
}

/**
 * An admin answers. Granting is the only path that destroys anything.
 *
 * Self-decision is allowed when the asker is themselves a primary admin or admin —
 * they could already unwind the bill by other means, so refusing here would
 * only cost them a step without protecting anyone, and a one-admin org would
 * deadlock outright. The row records who asked and who decided, so a
 * self-granted recall is visible as one rather than disguised as review.
 *
 * That reasoning runs one step further than it used to: if making an admin
 * decide their own request protects nobody, neither does making them take the
 * step. requestBillRecall grants it for them on the spot. This function is
 * still the only thing that grants — the shortcut calls it rather than
 * repeating it — so the recorded outcome is identical either way.
 */
export async function decideRecall(input: DecideRecallInput): Promise<{
  state: 'granted' | 'denied';
  macroState: string;
}> {
  const outcome = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{
      id: string; organization_id: string; approvable_id: string;
      requested_by: string; state: string; paused_from: string;
    }[]>`
      SELECT id::text, organization_id::text AS organization_id, approvable_id::text AS approvable_id,
             requested_by::text AS requested_by, state, paused_from
      FROM approval.recall_requests WHERE id = ${input.requestId}::uuid`;
    const request = rows[0];
    if (!request) throw new ApprovalEngineError('invalid_state', 'Unknown recall request.');
    if (request.state !== 'pending') {
      throw new ApprovalEngineError('invalid_state', `This request was already ${request.state}.`);
    }
    if (!(await isOrgAdmin(tx, request.organization_id, input.actorId))) {
      throw new ApprovalEngineError('forbidden_role', 'Only a primary admin or admin can decide a recall.');
    }

    const approvable = (await getApprovable(tx, request.approvable_id))!;
    const plan = await getActivePlan(tx, request.approvable_id);

    let nextState: string;
    if (input.grant) {
      if (plan) await closeLiveTasks(tx, plan.id, 'obsolete');
      await setMacroState(tx, request.approvable_id, 'cancelled');
      nextState = 'cancelled';
    } else {
      // Back exactly where it was — not a blanket 'pending_approval', which
      // would drag a bill parked on an unanswered question into the queue.
      await setMacroState(tx, request.approvable_id, request.paused_from);
      nextState = request.paused_from;
    }

    await tx.$executeRaw`
      UPDATE approval.recall_requests
      SET state = ${input.grant ? 'granted' : 'denied'},
          decided_by = ${input.actorId}::uuid,
          decided_at = now(),
          decision_note = ${input.note?.trim() || null}
      WHERE id = ${input.requestId}::uuid`;

    await appendEvent(tx, {
      organizationId: request.organization_id,
      approvableId: request.approvable_id,
      planId: plan?.id ?? null,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey ?? null,
      payload: {
        kind: 'recall_decided',
        requestId: input.requestId,
        granted: input.grant,
        selfDecided: input.actorId === request.requested_by,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      },
    });

    return { approvable, nextState };
  });

  await fireApprovalTransition(
    { ...outcome.approvable, macro_state: outcome.nextState },
    outcome.nextState as ApprovalTransition,
  );
  return { state: input.grant ? 'granted' : 'denied', macroState: outcome.nextState };
}

// --- withdrawing -------------------------------------------------------------

/** The asker changed their mind. Same restore as a denial, no admin needed. */
export async function withdrawRecall(input: {
  requestId: string;
  actorId: string;
  idempotencyKey?: string;
}): Promise<{ macroState: string }> {
  const outcome = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{
      organization_id: string; approvable_id: string;
      requested_by: string; state: string; paused_from: string;
    }[]>`
      SELECT organization_id::text AS organization_id, approvable_id::text AS approvable_id,
             requested_by::text AS requested_by, state, paused_from
      FROM approval.recall_requests WHERE id = ${input.requestId}::uuid`;
    const request = rows[0];
    if (!request) throw new ApprovalEngineError('invalid_state', 'Unknown recall request.');
    if (request.state !== 'pending') {
      throw new ApprovalEngineError('invalid_state', `This request was already ${request.state}.`);
    }
    if (input.actorId !== request.requested_by) {
      throw new ApprovalEngineError('forbidden_role', 'Only the person who asked can take the request back.');
    }

    const approvable = (await getApprovable(tx, request.approvable_id))!;
    const plan = await getActivePlan(tx, request.approvable_id);
    await setMacroState(tx, request.approvable_id, request.paused_from);
    await tx.$executeRaw`
      UPDATE approval.recall_requests
      SET state = 'withdrawn', decided_by = ${input.actorId}::uuid, decided_at = now()
      WHERE id = ${input.requestId}::uuid`;
    await appendEvent(tx, {
      organizationId: request.organization_id,
      approvableId: request.approvable_id,
      planId: plan?.id ?? null,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey ?? null,
      payload: { kind: 'recall_withdrawn', requestId: input.requestId },
    });
    return { approvable, nextState: request.paused_from };
  });

  await fireApprovalTransition(
    { ...outcome.approvable, macro_state: outcome.nextState },
    outcome.nextState as ApprovalTransition,
  );
  return { macroState: outcome.nextState };
}

// --- reading -----------------------------------------------------------------

/** The open request on a bill, if there is one. */
export async function openRecallRequest(approvableId: string): Promise<RecallRequestRow | null> {
  const rows = await prisma.$queryRawUnsafe<RecallRequestRow[]>(`
    SELECT ${SELECT_ROW}
    FROM approval.recall_requests r
    LEFT JOIN approval.people rp ON rp.id = r.requested_by
    LEFT JOIN approval.people dp ON dp.id = r.decided_by
    WHERE r.approvable_id = $1::uuid AND r.state = 'pending'`, approvableId);
  return rows[0] ?? null;
}

/** Every request ever raised against a bill, newest first — the bill's history. */
export async function recallHistory(approvableId: string): Promise<RecallRequestRow[]> {
  return prisma.$queryRawUnsafe<RecallRequestRow[]>(`
    SELECT ${SELECT_ROW}
    FROM approval.recall_requests r
    LEFT JOIN approval.people rp ON rp.id = r.requested_by
    LEFT JOIN approval.people dp ON dp.id = r.decided_by
    WHERE r.approvable_id = $1::uuid
    ORDER BY r.created_at DESC`, approvableId);
}

/** The admin's queue: what is waiting on a decision across the org. */
export async function pendingRecallRequests(organizationId: string): Promise<RecallRequestRow[]> {
  return prisma.$queryRawUnsafe<RecallRequestRow[]>(`
    SELECT ${SELECT_ROW}
    FROM approval.recall_requests r
    LEFT JOIN approval.people rp ON rp.id = r.requested_by
    LEFT JOIN approval.people dp ON dp.id = r.decided_by
    WHERE r.organization_id = $1::uuid AND r.state = 'pending'
    ORDER BY r.created_at`, organizationId);
}
