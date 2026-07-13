// L2 compile: (PolicySet, Approvable) → pinned ApprovalPlan. Selector picks the
// policy (first match, default guaranteed); the tree walk emits steps; targets
// resolve through L1; the L3 SoD pass vetoes; the plan is persisted with its
// exact (policy_id, version, selector_rule) provenance. routing-policy-model.md.
import { holders, isInSubtree, resolveSeat, walkUp, type ResolvedPerson } from './l1.js';
import { sodPass, type SodOutcome } from './sod.js';
import { policyBodySchema, selectorRulesSchema, type PlannedStep } from './schemas.js';
import {
  appendEvent, getLines, getPolicy, getPolicySet, insertPlan, insertTask,
  type ApprovableRow, type Tx,
} from './store.js';

interface EvalCtx {
  tx: Tx;
  approvable: ApprovableRow;
  lines: { amount_minor: bigint; dimensions: Record<string, string> }[];
  nodeHierarchy: Map<string, string>; // node id -> hierarchy id (lazy-filled)
  at: Date;
}

async function nodeHierarchyId(ctx: EvalCtx, nodeId: string): Promise<string | null> {
  if (ctx.nodeHierarchy.has(nodeId)) return ctx.nodeHierarchy.get(nodeId)!;
  const rows = await ctx.tx.$queryRaw<{ hierarchy_id: string }[]>`
    SELECT hierarchy_id FROM approval.nodes WHERE id = ${nodeId}::uuid`;
  const h = rows[0]?.hierarchy_id ?? null;
  if (h) ctx.nodeHierarchy.set(nodeId, h);
  return h;
}

async function evalPredicate(ctx: EvalCtx, pred: any): Promise<boolean> {
  switch (pred.op) {
    case 'amount_gte': return ctx.approvable.total_minor_base >= BigInt(pred.value.minorUnits);
    case 'amount_lt': return ctx.approvable.total_minor_base < BigInt(pred.value.minorUnits);
    case 'attr_eq': return ctx.approvable.attributes?.[pred.key] === pred.value;
    // Vendor split: the bill's vendor is one of the listed ones.
    case 'vendor_in': return Array.isArray(pred.vendorIds) && pred.vendorIds.includes(ctx.approvable.vendor_id ?? '');
    // Category split: any line's coding category matches.
    case 'category_in': {
      const cats = Array.isArray(ctx.approvable.attributes?.categories) ? (ctx.approvable.attributes.categories as unknown[]) : [];
      return Array.isArray(pred.categories) && cats.some((c) => pred.categories.includes(c));
    }
    case 'vendor_is_first_invoice': return ctx.approvable.attributes?.vendor_is_first_invoice === true;
    case 'po_matched_within_tolerance': return ctx.approvable.attributes?.po_matched_within_tolerance === true;
    case 'dimension_in_subtree': {
      for (const line of ctx.lines) {
        const nodeId = line.dimensions?.[pred.dimension];
        if (nodeId && (await isInSubtree(ctx.tx, nodeId, pred.node, ctx.at))) return true;
      }
      return false;
    }
    case 'and': { for (const p of pred.all) if (!(await evalPredicate(ctx, p))) return false; return true; }
    case 'or': { for (const p of pred.any) if (await evalPredicate(ctx, p)) return true; return false; }
    case 'not': return !(await evalPredicate(ctx, pred.p));
    default: return false;
  }
}

interface ResolvedStep {
  approvers: { seatId: string | null; personId: string; viaDelegation: boolean }[];
  mode: any; purpose?: string; slaHours?: number;
  /** for continue_walk remedies: remaining walk seats past the emitted one */
  walkContinuation: { seatId: string; nodeId: string }[];
  unresolvable: boolean;
}

async function resolveTarget(ctx: EvalCtx, target: any): Promise<{ people: (ResolvedPerson & { seatId: string | null })[]; continuation: { seatId: string; nodeId: string }[]; unresolvable: boolean; ladderSeats?: { seatId: string }[] }> {
  const at = ctx.at;
  switch (target.kind) {
    case 'person':
      return { people: [{ personId: target.personId, viaDelegation: false, seatId: null }], continuation: [], unresolvable: false };
    case 'seat': {
      const people = (await resolveSeat(ctx.tx, target.seatId, at)).map((p) => ({ ...p, seatId: target.seatId as string }));
      return { people, continuation: [], unresolvable: people.length === 0 };
    }
    case 'holders': {
      const seats = await holders(ctx.tx, target.authority, target.scope, at);
      const people: (ResolvedPerson & { seatId: string | null })[] = [];
      for (const s of seats) for (const p of await resolveSeat(ctx.tx, s, at)) people.push({ ...p, seatId: s });
      return { people, continuation: [], unresolvable: people.length === 0 };
    }
    case 'relative': { // dimension_owner:<dim> — the seat(s) on the line's dimension node
      const dim = String(target.ref).slice('dimension_owner:'.length);
      const people: (ResolvedPerson & { seatId: string | null })[] = [];
      for (const line of ctx.lines) {
        const nodeId = line.dimensions?.[dim];
        if (!nodeId) continue;
        const seats = await ctx.tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM approval.seats WHERE node_id = ${nodeId}::uuid`;
        for (const s of seats) for (const p of await resolveSeat(ctx.tx, s.id, at)) people.push({ ...p, seatId: s.id });
      }
      return { people, continuation: [], unresolvable: people.length === 0 };
    }
    case 'walk': {
      // entry = each line's dimension node belonging to the target hierarchy; union across lines.
      // Emits the tiered ladder chain[0..coveredIndex]; seats past the coverer feed continue_walk.
      const people: (ResolvedPerson & { seatId: string | null })[] = [];
      const continuation: { seatId: string; nodeId: string }[] = [];
      const ladder: { seatId: string }[] = [];
      let sawEntry = false;
      let covered = false;
      for (const line of ctx.lines) {
        for (const nodeId of Object.values(line.dimensions ?? {})) {
          const h = await nodeHierarchyId(ctx, nodeId);
          if (h !== target.hierarchy) continue;
          sawEntry = true;
          const walk = await walkUp(ctx.tx, {
            entryNodeId: nodeId, authority: target.authority,
            amountMinorBase: ctx.approvable.total_minor_base, at,
          });
          if (walk.coveredIndex >= 0) {
            covered = true;
            for (const s of walk.chain.slice(0, walk.coveredIndex + 1)) {
              ladder.push({ seatId: s.seatId });
              for (const p of await resolveSeat(ctx.tx, s.seatId, at)) people.push({ ...p, seatId: s.seatId });
            }
            continuation.push(...walk.chain.slice(walk.coveredIndex + 1).map((s) => ({ seatId: s.seatId, nodeId: s.nodeId })));
          }
        }
      }
      // A4: walk reached the root uncovered → unresolvable (alert, not a silent stall)
      return { people, continuation, unresolvable: !sawEntry || !covered, ladderSeats: ladder };
    }
    default:
      return { people: [], continuation: [], unresolvable: true };
  }
}

export interface CompileResult {
  planId: string | null;
  terminal: 'auto_approve' | 'force_reject' | null;
  terminalReason?: string;
  steps: PlannedStep[];
  sodOutcomes: SodOutcome[];
  alerts: string[];
}

/** Walk the policy tree, resolve, veto, persist. Does NOT touch macro state — lifecycle owns that. */
export async function compilePlan(tx: Tx, approvable: ApprovableRow, at = new Date()): Promise<CompileResult> {
  const set = await getPolicySet(tx, approvable.organization_id, approvable.type);
  if (!set) throw new Error(`no policy set for ${approvable.type} in org ${approvable.organization_id}`);
  const rules = selectorRulesSchema.parse(set.rules ?? []);
  const lines = await getLines(tx, approvable.id);
  const ctx: EvalCtx = { tx, approvable, lines, nodeHierarchy: new Map(), at };

  let policyId = set.default_policy_id;
  let policyVersion = set.default_policy_version;
  let selectorRule = 'default';
  for (let i = 0; i < rules.length; i++) {
    if (await evalPredicate(ctx, rules[i].when)) {
      policyId = rules[i].usePolicy;
      policyVersion = rules[i].usePolicyVersion;
      selectorRule = String(i);
      break;
    }
  }
  const policy = await getPolicy(tx, policyId, policyVersion);
  if (!policy) throw new Error(`policy ${policyId} v${policyVersion} not found`);
  const body = policyBodySchema.parse(policy.body) as any[];

  const resolved: ResolvedStep[] = [];
  const alerts: string[] = [];
  let terminal: CompileResult['terminal'] = null;
  let terminalReason: string | undefined;

  async function walkNodes(nodes: any[]): Promise<boolean> { // returns false when a terminal stopped compilation
    for (const node of nodes) {
      switch (node.type) {
        case 'condition': {
          const hit = await evalPredicate(ctx, node.if);
          const branch = hit ? node.then : (node.else ?? []);
          if (!(await walkNodes(branch))) return false;
          break;
        }
        case 'terminal':
          terminal = node.outcome;
          terminalReason = node.reason;
          return false;
        case 'notify':
          break; // v1: notify emits an event post-persist; non-blocking by design
        case 'marker':
          break; // builder forward marker — display-only, contributes nothing
        case 'step': {
          const r = await resolveTarget(ctx, node.targets[0]);

          // A single walk target = a tiered ladder: one SEQUENTIAL step per chain seat
          // (A1 semantics: everyone below the covering grant approves, in order).
          if (node.targets.length === 1 && node.targets[0].kind === 'walk' && (r.ladderSeats?.length ?? 0) > 0) {
            const shared = [...r.continuation]; // shared by reference: continue_walk consumes globally
            const perSeat = new Map<string, (ResolvedPerson & { seatId: string | null })[]>();
            for (const p of r.people) {
              const list = perSeat.get(p.seatId!) ?? [];
              list.push(p);
              perSeat.set(p.seatId!, list);
            }
            for (const seat of r.ladderSeats!) {
              resolved.push({
                approvers: dedupe(perSeat.get(seat.seatId) ?? []), mode: node.step, purpose: node.purpose,
                slaHours: node.slaHours, walkContinuation: shared, unresolvable: false,
              });
            }
            break;
          }

          const people = [...r.people];
          const continuation = [...r.continuation];
          let unresolvable = r.unresolvable;
          for (const t of node.targets.slice(1)) {
            const more = await resolveTarget(ctx, t);
            people.push(...more.people);
            continuation.push(...more.continuation);
            unresolvable = unresolvable && more.unresolvable;
          }
          if (people.length === 0 && node.onUnresolvable) {
            const fb = await resolveTarget(ctx, node.onUnresolvable);
            people.push(...fb.people);
            alerts.push(`step "${node.purpose ?? 'unnamed'}" unresolvable — fell back`);
            unresolvable = fb.people.length === 0;
          }
          resolved.push({
            approvers: dedupe(people), mode: node.step, purpose: node.purpose,
            slaHours: node.slaHours, walkContinuation: continuation, unresolvable,
          });
          break;
        }
      }
    }
    return true;
  }
  await walkNodes(body);

  if (terminal) {
    await appendEvent(tx, {
      organizationId: approvable.organization_id, approvableId: approvable.id,
      payload: { kind: 'plan_terminal', outcome: terminal, reason: terminalReason, policyId, policyVersion, selectorRule },
    });
    return { planId: null, terminal, terminalReason, steps: [], sodOutcomes: [], alerts };
  }

  // L3 pass — routing proposed, constraints veto (with continue_walk remedies)
  const sodOutcomes = await sodPass(tx, approvable, resolved, at);

  const steps: PlannedStep[] = resolved.map((s, i) => ({
    index: i,
    step: s.mode,
    approvers: s.approvers,
    purpose: s.purpose ?? null,
    slaHours: s.slaHours ?? null,
  }));
  // Last-resort resolution for emptied steps (fail-closed but ACTIONABLE).
  // Preference order matters — assigning the owner when the owner IS the
  // requester deadlocked every 2-person org (BUG-default-flow-deadlock):
  //   1. non-requester holders of the prebuilt Approver role — real people
  //      who can actually act;
  //   2. the org owner, even as requester (true solo case): a recorded
  //      self-approval — behind the R1 opt-in ceremony — beats a silent pass.
  const emptied = steps.filter((s) => s.approvers.length === 0);
  if (emptied.length > 0) {
    const requesterId = approvable.requester_id;
    const entererId = approvable.enterer_id ?? null;
    const approverHolders = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT p.id FROM approval.people p
      JOIN approval.person_roles pr ON pr.person_id = p.id
      WHERE p.organization_id = ${approvable.organization_id}::uuid
        AND pr.role = 'approver' AND p.status = 'active'
        AND p.id != ${requesterId}::uuid
        AND (${entererId}::uuid IS NULL OR p.id != ${entererId}::uuid)`;
    let assignees = approverHolders.map((r) => r.id);
    let how = 'the Approver role holders';
    if (assignees.length === 0) {
      // No approver-role holders: admins hold every capability (Ramp rule),
      // so a non-requester ADMIN is the next-best real second pair of eyes —
      // before falling all the way to the owner-submitter (testbench 006 §2).
      const adminRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM approval.people p
        JOIN organization_memberships om
          ON om.user_id = p.user_id AND om.organization_id = p.organization_id
        WHERE p.organization_id = ${approvable.organization_id}::uuid
          AND om.role IN ('owner', 'admin') AND om.status = 'active' AND p.status = 'active'
          AND p.id != ${requesterId}::uuid
          AND (${entererId}::uuid IS NULL OR p.id != ${entererId}::uuid)`;
      assignees = adminRows.map((r) => r.id);
      how = 'the admins as approvers of last resort';
    }
    if (assignees.length === 0) {
      const ownerRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM approval.people p
        JOIN organization_memberships om
          ON om.user_id = p.user_id AND om.organization_id = p.organization_id
        WHERE p.organization_id = ${approvable.organization_id}::uuid
          AND om.role = 'owner' AND om.status = 'active' AND p.status = 'active'
        LIMIT 1`;
      assignees = ownerRows[0] ? [ownerRows[0].id] : [];
      how = 'the owner as approver of last resort';
    }
    for (const s of emptied) {
      if (assignees.length > 0) {
        for (const personId of assignees) s.approvers.push({ seatId: null, personId, viaDelegation: false });
        alerts.push(`step ${s.index} had no approvers after SoD/resolution — assigned to ${how}`);
      } else {
        alerts.push(`step ${s.index} has no approvers after SoD/resolution — needs attention`);
      }
    }
  }

  // Quorum sanity: a step demanding more sign-offs than it has eligible
  // approvers can NEVER settle (the other half of the 2-person deadlock —
  // quorum 2 with the requester excluded leaves one person against m=2).
  for (const s of steps) {
    if (s.step.mode === 'quorum' && s.approvers.length > 0 && s.step.m > s.approvers.length) {
      alerts.push(`step ${s.index} quorum lowered ${s.step.m} → ${s.approvers.length}: not enough eligible approvers`);
      s.step = { mode: 'quorum', m: s.approvers.length };
    }
  }

  const planId = await insertPlan(tx, {
    approvableId: approvable.id, policyId, policyVersion, selectorRule,
    steps: steps.map((s) => ({ ...s })), sodOutcomes,
  });
  await appendEvent(tx, {
    organizationId: approvable.organization_id, approvableId: approvable.id, planId,
    payload: { kind: 'plan_compiled', policyId, policyVersion, selectorRule, stepCount: steps.length, sodOutcomes, alerts },
  });

  // Materialize tasks: step 0 open (SLA armed), later steps scheduled.
  for (const s of steps) {
    const open = s.index === 0;
    const sla = open && s.slaHours ? new Date(at.getTime() + s.slaHours * 3_600_000) : null;
    for (const a of s.approvers) {
      await insertTask(tx, {
        planId, stepIndex: s.index, seatId: a.seatId, personId: a.personId,
        state: open ? 'open' : 'scheduled', slaDeadline: sla,
      });
    }
  }
  return { planId, terminal: null, steps, sodOutcomes, alerts };
}

function dedupe(people: { seatId: string | null; personId: string; viaDelegation: boolean }[]) {
  const seen = new Set<string>();
  return people.filter((p) => (seen.has(p.personId) ? false : (seen.add(p.personId), true)));
}
