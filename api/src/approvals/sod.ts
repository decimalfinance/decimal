// L3 — separation-of-duties veto pass. Routing proposes, constraints veto
// (sod-constraints.md). v1 ships the always-on core of the standard pack:
//   R1 requester may not approve their own approvable        (same_approvable)
//   R2 the person who entered/coded it may not approve it    (same_approvable)
//   R5 an approver of the source invoice may not release it  (payment_run compile)
//   R7 submitter of a payout-detail change may not verify it (vendor_change ≡ R1)
// Remedy: continue_walk where a walk continuation exists, else removal + alert.
// Org-configurable rules/relaxations ride approval.constraint_rules later.
import { resolveSeat } from './l1.js';
import { isRelaxed, type RuleCode } from './protections.js';
import { getSodFlags, type ApprovableRow, type SodFlags, type Tx } from './store.js';

export type SodOutcome =
  | { kind: 'veto_rerouted'; rule: string; removed: string; replacedWith: string }
  | { kind: 'veto_removed'; rule: string; removed: string }
  | { kind: 'veto_blocked'; rule: string; person: string }
  | { kind: 'relaxed_exception'; rule: string; person: string };

interface MutableStep {
  approvers: { seatId: string | null; personId: string; viaDelegation: boolean }[];
  walkContinuation: { seatId: string; nodeId: string }[];
}

export interface VetoResult { rule: string; relaxed: boolean }

/**
 * Which rule (if any) applies to this person for this approvable? Decision-time
 * uses the same check. A relaxed rule passes through with `relaxed: true` — the
 * caller keeps the person but records/stamps the exception (the badge's source).
 */
export async function vetoRule(tx: Tx, approvable: ApprovableRow, personId: string, flags?: SodFlags): Promise<VetoResult | null> {
  const f = flags ?? await getSodFlags(tx, approvable.organization_id);
  const hit = await rawVetoRule(tx, approvable, personId, f);
  if (!hit) return null;
  const relaxed = await isRelaxed(tx, approvable.organization_id, hit as RuleCode, personId);
  return { rule: hit, relaxed };
}

async function rawVetoRule(tx: Tx, approvable: ApprovableRow, personId: string, flags: SodFlags): Promise<string | null> {
  // R1 protects the LIABILITY decision (and R7 its vendor_change form). The release
  // ceremony is guarded by R5 (approver of the source may not release) — the bill's
  // requester may hold a release key: requester ≠ approver ≠ ... is already satisfied.
  // Each rule is skipped when the org has opted out of that separation (org_settings).
  if (!flags.submitterCanApprove && personId === approvable.requester_id && approvable.type !== 'payment_run') {
    return approvable.type === 'vendor_change' ? 'R7' : 'R1';
  }
  if (!flags.reviewerCanApprove && approvable.enterer_id && personId === approvable.enterer_id) return 'R2';
  if (!flags.approverCanRelease && approvable.type === 'payment_run') {
    const sourceId = approvable.attributes?.sourceApprovableId;
    if (typeof sourceId === 'string') {
      const rows = await tx.$queryRaw<{ actor_id: string }[]>`
        SELECT actor_id::text AS actor_id FROM approval.approval_events
        WHERE approvable_id = ${sourceId}::uuid
          AND payload->>'kind' = 'command' AND payload->'command'->>'kind' = 'approve'
          AND actor_id = ${personId}::uuid
        LIMIT 1`;
      if (rows.length > 0) return 'R5';
    }
  }
  return null;
}

export async function sodPass(tx: Tx, approvable: ApprovableRow, steps: MutableStep[], at: Date): Promise<SodOutcome[]> {
  const outcomes: SodOutcome[] = [];
  const flags = await getSodFlags(tx, approvable.organization_id);
  for (const step of steps) {
    const kept: MutableStep['approvers'] = [];
    for (const a of step.approvers) {
      const veto = await vetoRule(tx, approvable, a.personId, flags);
      if (!veto) { kept.push(a); continue; }
      if (veto.relaxed) {
        kept.push(a);
        outcomes.push({ kind: 'relaxed_exception', rule: veto.rule, person: a.personId });
        continue;
      }
      const rule = veto.rule;
      // remedy: continue_walk — next seat in the chain whose occupant survives the same rules
      let replaced = false;
      while (step.walkContinuation.length > 0 && !replaced) {
        const next = step.walkContinuation.shift()!;
        for (const p of await resolveSeat(tx, next.seatId, at)) {
          const pv = await vetoRule(tx, approvable, p.personId, flags);
          if ((!pv || pv.relaxed) && !kept.some((k) => k.personId === p.personId)) {
            kept.push({ seatId: next.seatId, personId: p.personId, viaDelegation: p.viaDelegation });
            outcomes.push({ kind: 'veto_rerouted', rule, removed: a.personId, replacedWith: p.personId });
            replaced = true;
            break;
          }
        }
      }
      if (!replaced) outcomes.push({ kind: 'veto_removed', rule, removed: a.personId });
    }
    step.approvers = kept;
  }
  return outcomes;
}
