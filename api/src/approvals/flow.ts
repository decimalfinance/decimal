// The approval flow builder's backend: the org's single flow as builder JSON,
// a real dry-run simulator (people + protections, no fake logic), and publish
// (translate to an engine policy, bump the version, repoint the default).
import { prisma } from '../infra/prisma.js';
import { getPolicySet, getPolicy, createPolicy, upsertPolicySet, getSodFlags, setSodFlags, type SodFlags } from './store.js';
import { isRelaxed } from './protections.js';

// Builder-side flow JSON — maps 1:1 onto the engine's policy nodes.
// A split routes by amount (default), by vendor, or by coding category.
export type FlowSplit =
  | { kind: 'vendor'; vendorIds: string[]; vendorNames: string[] }
  | { kind: 'category'; categories: string[] }
  | { kind: 'firstBill' };
export type FlowNode =
  | { id: string; type: 'step'; title: string; approvers: string[]; quorum: 'all' | 'any' | number; purpose?: string | null }
  | { id: string; type: 'if'; amountGteUsd: number; split?: FlowSplit | null; then: FlowNode[]; otherwise: FlowNode[] }
  | { id: string; type: 'auto' }
  | { id: string; type: 'notify'; people: string[] };

// The engine compares against total_minor_base, which is submitted as USDC raw
// (dollars x 10^6) — match that scale, not cents.
const USD_MINOR = 1_000_000;

// A stage's flow: the approval flow (kind 'invoice') or the review flow (kind
// 'review'). Both are the same builder JSON on their own policy set; only the
// seed-name that counts as "not yet authored" differs.
const SEED_NAME: Record<FlowKind, string> = { invoice: 'default approval', review: 'none', payment_run: 'default release' };
const PUBLISHED_NAME: Record<FlowKind, string> = { invoice: 'Company approval flow', review: 'Company review flow', payment_run: 'Payment release flow' };

export async function getFlow(organizationId: string, kind: FlowKind = 'invoice') {
  const { ensureEngineSetup, ensurePersonForUser } = await import('./wiring.js');
  await ensureEngineSetup(organizationId);
  // ensureEngineSetup only maps members→people on first setup. Sync current
  // active members every load so people invited later appear in the builder.
  const members = await prisma.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM organization_memberships
    WHERE organization_id = ${organizationId}::uuid AND status = 'active'`;
  await prisma.$transaction(async (tx) => {
    for (const m of members) await ensurePersonForUser(tx, organizationId, m.user_id);
  });
  const set = await getPolicySet(prisma, organizationId, kind);
  // Roles ride along so the builder's who-picker can show "Klaus · CFO", not
  // just a bare name.
  const people = await prisma.$queryRaw<{ id: string; name: string; email: string; user_id: string | null; roles: string[] }[]>`
    SELECT p.id, p.name, p.email, p.user_id,
      CASE WHEN om.role = 'owner' THEN ARRAY['Primary admin']
           WHEN om.role = 'admin' THEN ARRAY['Admin']
           ELSE COALESCE(array_agg(initcap(pr.role) ORDER BY pr.role) FILTER (WHERE pr.role IS NOT NULL), '{}') END AS roles
    FROM approval.people p
    LEFT JOIN approval.person_roles pr ON pr.person_id = p.id
    LEFT JOIN organization_memberships om ON om.organization_id = p.organization_id AND om.user_id = p.user_id AND om.status = 'active'
    WHERE p.organization_id = ${organizationId}::uuid AND p.status = 'active' AND p.external = false
    GROUP BY p.id, p.name, p.email, p.user_id, om.role
    ORDER BY p.name`;
  const draft = await getFlowDraft(organizationId, kind);
  // Split-condition options for the builder: real vendors + coding categories.
  const vendors = await prisma.counterparty.findMany({
    where: { organizationId },
    select: { counterpartyId: true, displayName: true },
    orderBy: { displayName: 'asc' },
    take: 500,
  }).then((rows) => rows.map((r) => ({ id: r.counterpartyId, name: r.displayName })));
  const { listChartOfAccounts } = await import('../accounting/ocr-coding.js');
  const categoryOptions = (await listChartOfAccounts(organizationId).catch(() => [])).map((a) => a.name);
  if (!set) return { flow: [], draft, people, vendors, categoryOptions, version: null };
  const policy = await getPolicy(prisma, set.default_policy_id, set.default_policy_version);
  const body: unknown[] = policy && Array.isArray(policy.body) ? (policy.body as unknown[]) : [];
  // ensureEngineSetup seeds a "default approval" policy so the engine can route
  // bills from day one. That is NOT a flow the user authored — the builder shows
  // it as blank (empty canvas) until they actually build and publish one. (Review
  // has no seed, so any published review policy is authored.)
  const authored = policy != null && policy.name !== SEED_NAME[kind];
  return {
    flow: authored ? body.map(engineNodeToFlow).filter((n): n is FlowNode => n !== null) : [],
    draft, // unpublished edits, if any — the builder loads these over the published flow
    people,
    vendors,
    categoryOptions,
    policyId: set.default_policy_id,
    version: set.default_policy_version,
  };
}

// Per-org builder draft (unpublished edits). Survives navigation/reload. Keyed by
// (org, kind) so the review flow and approval flow each keep their own draft.
type FlowKind = 'invoice' | 'review' | 'payment_run';

export async function getFlowDraft(organizationId: string, kind: FlowKind = 'invoice'): Promise<FlowNode[] | null> {
  const rows = await prisma.$queryRaw<{ body: unknown }[]>`
    SELECT body FROM approval.flow_drafts WHERE organization_id = ${organizationId}::uuid AND kind = ${kind}`;
  const body = rows[0]?.body;
  return Array.isArray(body) ? (body as FlowNode[]) : null;
}

export async function saveFlowDraft(organizationId: string, flow: FlowNode[], kind: FlowKind = 'invoice'): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO approval.flow_drafts (organization_id, kind, body, updated_at)
    VALUES (${organizationId}::uuid, ${kind}, ${JSON.stringify(flow)}::jsonb, now())
    ON CONFLICT (organization_id, kind) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`;
}

export async function clearFlowDraft(organizationId: string, kind: FlowKind = 'invoice'): Promise<void> {
  await prisma.$executeRaw`DELETE FROM approval.flow_drafts WHERE organization_id = ${organizationId}::uuid AND kind = ${kind}`;
}

function engineNodeToFlow(node: unknown, index = 0): FlowNode | null {
  if (typeof node !== 'object' || node === null) return null;
  const n = node as Record<string, unknown>;
  const id = `n${Math.random().toString(36).slice(2, 9)}`;
  if (n.type === 'step') {
    const targets = Array.isArray(n.targets) ? n.targets : [];
    const approvers = targets
      .map((t) => (typeof t === 'object' && t && (t as Record<string, unknown>).kind === 'person'
        ? String((t as Record<string, unknown>).personId) : null))
      .filter((v): v is string => Boolean(v));
    const step = (n.step ?? {}) as Record<string, unknown>;
    const quorum: FlowNode & { type: 'step' } extends never ? never : ('all' | 'any' | number) =
      step.mode === 'all' ? 'all' : step.mode === 'any' ? 'any' : Number(step.m ?? 1);
    return { id, type: 'step', title: String(n.purpose ?? `Approval step ${index + 1}`), approvers, quorum, purpose: n.purpose ? String(n.purpose) : null };
  }
  if (n.type === 'condition') {
    const pred = (n.if ?? {}) as Record<string, unknown>;
    const meta = (n.meta ?? {}) as Record<string, unknown>;
    const thenNodes = (Array.isArray(n.then) ? n.then : []).map(engineNodeToFlow).filter((x): x is FlowNode => x !== null);
    const elseNodes = (Array.isArray(n.else) ? n.else : []).map(engineNodeToFlow).filter((x): x is FlowNode => x !== null);
    if (pred.op === 'vendor_in') {
      const vendorIds = Array.isArray(pred.vendorIds) ? (pred.vendorIds as string[]) : [];
      const vendorNames = Array.isArray(meta.vendorNames) ? (meta.vendorNames as string[]) : [];
      return { id, type: 'if', amountGteUsd: 0, split: { kind: 'vendor', vendorIds, vendorNames }, then: thenNodes, otherwise: elseNodes };
    }
    if (pred.op === 'category_in') {
      const categories = Array.isArray(pred.categories) ? (pred.categories as string[]) : [];
      return { id, type: 'if', amountGteUsd: 0, split: { kind: 'category', categories }, then: thenNodes, otherwise: elseNodes };
    }
    if (pred.op === 'vendor_is_first_invoice') {
      return { id, type: 'if', amountGteUsd: 0, split: { kind: 'firstBill' }, then: thenNodes, otherwise: elseNodes };
    }
    const minor = pred.op === 'amount_gte' && typeof pred.value === 'object' && pred.value
      ? Number((pred.value as Record<string, unknown>).minorUnits ?? 0) : 0;
    return { id, type: 'if', amountGteUsd: minor / USD_MINOR, then: thenNodes, otherwise: elseNodes };
  }
  if (n.type === 'terminal') return { id, type: 'auto' };
  if (n.type === 'marker') return { id, type: 'auto' };
  if (n.type === 'notify') {
    const targets = Array.isArray(n.targets) ? n.targets : [];
    return { id, type: 'notify', people: targets.map((t) => String((t as Record<string, unknown>).personId ?? '')).filter(Boolean) };
  }
  return null;
}

function flowNodeToEngine(node: FlowNode): unknown | null {
  if (node.type === 'step') {
    return {
      type: 'step',
      targets: node.approvers.map((personId) => ({ kind: 'person', personId })),
      step: node.quorum === 'all' ? { mode: 'all' } : node.quorum === 'any' ? { mode: 'any' } : { mode: 'quorum', m: node.quorum },
      onUnresolvable: { kind: 'person', personId: node.approvers[0] ?? '' },
      ...(node.purpose || node.title ? { purpose: node.purpose ?? node.title } : {}),
    };
  }
  if (node.type === 'if') {
    const branches = {
      then: node.then.map(flowNodeToEngine).filter((n) => n !== null),
      else: node.otherwise.map(flowNodeToEngine).filter((n) => n !== null),
    };
    if (node.split?.kind === 'vendor') {
      return { type: 'condition', if: { op: 'vendor_in', vendorIds: node.split.vendorIds }, meta: { vendorNames: node.split.vendorNames }, ...branches };
    }
    if (node.split?.kind === 'category') {
      return { type: 'condition', if: { op: 'category_in', categories: node.split.categories }, ...branches };
    }
    if (node.split?.kind === 'firstBill') {
      return { type: 'condition', if: { op: 'vendor_is_first_invoice' }, ...branches };
    }
    return {
      type: 'condition',
      if: { op: 'amount_gte', value: { minorUnits: String(Math.round(node.amountGteUsd * USD_MINOR)), currency: 'USD' } },
      ...branches,
    };
  }
  // Branch terminator — steps above stand; compiles to a no-op marker so the
  // published body ROUND-TRIPS the builder's explicit forwards (dropping it
  // made every publish look reverted on reload). Never engine 'terminal':
  // that would auto-approve the whole bill and discard the steps.
  if (node.type === 'auto') return { type: 'marker', kind: 'forward' };
  if (node.type === 'notify') return { type: 'notify', targets: node.people.map((personId) => ({ kind: 'person', personId })) };
  return null;
}

export async function publishFlow(organizationId: string, flow: FlowNode[], kind: FlowKind = 'invoice') {
  const body = flow.map(flowNodeToEngine).filter((n) => n !== null);
  const set = await getPolicySet(prisma, organizationId, kind);
  const result = await prisma.$transaction(async (tx) => {
    const version = set ? set.default_policy_version + 1 : 1;
    const policy = await createPolicy(tx, organizationId, kind, PUBLISHED_NAME[kind], body, set?.default_policy_id, version);
    await upsertPolicySet(tx, organizationId, kind, [], policy.id, policy.version);
    return { policyId: policy.id, version: policy.version };
  });
  await clearFlowDraft(organizationId, kind); // the draft is now the published flow
  return result;
}

// The Review stage: who must fill/confirm a bill's details before it can enter
// approval. Same builder power as approval (steps · quorum · amount splits), on
// its own 'review' policy set.
export const getReviewFlow = (organizationId: string) => getFlow(organizationId, 'review');
export const publishReviewFlow = (organizationId: string, flow: FlowNode[]) => publishFlow(organizationId, flow, 'review');

// The Payment stage as a full flow (steps · quorums · splits) on the
// payment_run policy — complex releases, same grammar as the other stages.
export const getPaymentFlow = (organizationId: string) => getFlow(organizationId, 'payment_run');
export const publishPaymentFlow = (organizationId: string, flow: FlowNode[]) => publishFlow(organizationId, flow, 'payment_run');

// Separation-of-duties settings — the org's own choice of how strictly the three
// stages must be staffed by different people. Read/written as plain switches.
export async function getSodSettings(organizationId: string) {
  const { ensureEngineSetup } = await import('./wiring.js');
  await ensureEngineSetup(organizationId);
  return getSodFlags(prisma, organizationId);
}

export async function setSodSettings(organizationId: string, flags: SodFlags) {
  await prisma.$transaction((tx) => setSodFlags(tx, organizationId, flags));
}

// The org owner's person id — the standing fallback approver/releaser.
async function ownerPersonId(organizationId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM approval.people p
    JOIN organization_memberships om ON om.user_id = p.user_id AND om.organization_id = p.organization_id
    WHERE p.organization_id = ${organizationId}::uuid AND om.role = 'owner' AND om.status = 'active' AND p.status = 'active'
    LIMIT 1`;
  return rows[0]?.id ?? null;
}

export type ReleaseConfig = { approvers: string[]; quorum: 'all' | 'any' | number };

// The payment-release control point: who must sign to release money once a bill
// has passed approval. It's a single signer set + quorum (the payment_run
// policy), distinct from the approval flow — approved is not paid.
export async function getReleaseConfig(organizationId: string) {
  const { ensureEngineSetup } = await import('./wiring.js');
  await ensureEngineSetup(organizationId);
  const people = await prisma.$queryRaw<{ id: string; name: string; email: string; user_id: string | null; roles: string[] }[]>`
    SELECT p.id, p.name, p.email, p.user_id,
      CASE WHEN om.role = 'owner' THEN ARRAY['Primary admin']
           WHEN om.role = 'admin' THEN ARRAY['Admin']
           ELSE COALESCE(array_agg(initcap(pr.role) ORDER BY pr.role) FILTER (WHERE pr.role IS NOT NULL), '{}') END AS roles
    FROM approval.people p
    LEFT JOIN approval.person_roles pr ON pr.person_id = p.id
    LEFT JOIN organization_memberships om ON om.organization_id = p.organization_id AND om.user_id = p.user_id AND om.status = 'active'
    WHERE p.organization_id = ${organizationId}::uuid AND p.status = 'active' AND p.external = false
    GROUP BY p.id, p.name, p.email, p.user_id, om.role
    ORDER BY p.name`;
  const set = await getPolicySet(prisma, organizationId, 'payment_run');
  let approvers: string[] = [];
  let quorum: 'all' | 'any' | number = 'any';
  let configured = false;
  if (set) {
    const policy = await getPolicy(prisma, set.default_policy_id, set.default_policy_version);
    // The seed 'default release' points at a holders seat, not people the owner
    // chose — treat that as "not configured yet" so the UI prompts them.
    configured = policy != null && policy.name !== 'default release';
    if (configured && Array.isArray(policy!.body)) {
      const step = (policy!.body as Array<Record<string, unknown>>).find((n) => n?.type === 'step');
      if (step) {
        approvers = (Array.isArray(step.targets) ? step.targets : [])
          .map((t) => (typeof t === 'object' && t && (t as Record<string, unknown>).kind === 'person' ? String((t as Record<string, unknown>).personId) : null))
          .filter((v): v is string => Boolean(v));
        const mode = (step.step as Record<string, unknown> | undefined)?.mode;
        quorum = mode === 'all' ? 'all' : mode === 'any' ? 'any' : Number((step.step as Record<string, unknown>)?.m ?? 1);
      }
    }
  }
  return { approvers, quorum, configured, people };
}

export async function publishReleaseConfig(organizationId: string, config: ReleaseConfig) {
  const validIds = new Set(
    (await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM approval.people WHERE organization_id = ${organizationId}::uuid AND status = 'active' AND external = false`
    ).map((p) => p.id),
  );
  const approvers = config.approvers.filter((id) => validIds.has(id));
  if (approvers.length === 0) throw new Error('Pick at least one person who can release payments.');
  const quorumMax = config.quorum;
  const releaseStep = {
    type: 'step',
    targets: approvers.map((personId) => ({ kind: 'person', personId })),
    step: quorumMax === 'all' ? { mode: 'all' } : quorumMax === 'any' ? { mode: 'any' } : { mode: 'quorum', m: Math.min(quorumMax, approvers.length) },
    onUnresolvable: { kind: 'person', personId: (await ownerPersonId(organizationId)) ?? approvers[0] },
    purpose: 'payment release',
  };
  const set = await getPolicySet(prisma, organizationId, 'payment_run');
  return prisma.$transaction(async (tx) => {
    const version = set ? set.default_policy_version + 1 : 1;
    const policy = await createPolicy(tx, organizationId, 'payment_run', 'Payment release', [releaseStep], set?.default_policy_id, version);
    await upsertPolicySet(tx, organizationId, 'payment_run', [], policy.id, policy.version);
    return { policyId: policy.id, version: policy.version };
  });
}

// How a sample bill answers a split — amount (default), vendor, or category.
function splitMatches(node: FlowNode & { type: 'if' }, sample: { amountUsd: number; vendorId?: string | null; category?: string | null; firstBill?: boolean | null }): boolean {
  if (node.split?.kind === 'vendor') return Boolean(sample.vendorId && node.split.vendorIds.includes(sample.vendorId));
  if (node.split?.kind === 'category') return Boolean(sample.category && node.split.categories.includes(sample.category));
  if (node.split?.kind === 'firstBill') return Boolean(sample.firstBill);
  return sample.amountUsd >= node.amountGteUsd;
}

// The live simulator: resolve a sample bill through a (possibly unsaved) flow
// using the org's REAL people and REAL protections — same rules the engine
// applies at compile time.
export async function simulateFlow(organizationId: string, flow: FlowNode[], sample: { amountUsd: number; requesterPersonId: string | null; vendorId?: string | null; category?: string | null; firstBill?: boolean | null }) {
  const people = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM approval.people WHERE organization_id = ${organizationId}::uuid AND status = 'active'`;
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const requester = sample.requesterPersonId;
  const r1Relaxed = requester ? await isRelaxed(prisma, organizationId, 'R1', requester) : false;
  // The owner is the standing fallback: if excluding the requester empties a
  // step, it goes to the owner rather than deadlocking.
  const ownerRows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM approval.people p
    JOIN organization_memberships om ON om.user_id = p.user_id AND om.organization_id = p.organization_id
    WHERE p.organization_id = ${organizationId}::uuid AND om.role = 'owner' AND om.status = 'active' AND p.status = 'active'
    LIMIT 1`;
  const ownerId = ownerRows[0]?.id ?? null;

  const chain: Array<{ personId: string; name: string; step: string; why: string; kind: 'always' | 'added' | 'standin' }> = [];
  const notes: string[] = [];
  let stuck: string | null = null;
  let autoApproved = false;

  const walk = (nodes: FlowNode[], added: boolean) => {
    for (const node of nodes) {
      if (stuck) return;
      if (node.type === 'auto') { autoApproved = true; return; }
      if (node.type === 'notify') continue;
      if (node.type === 'if') {
        const matches = splitMatches(node, sample);
        walk(matches ? node.then : node.otherwise, matches ? true : added);
        return;
      }
      // step
      const eligible = node.approvers.filter((p) => !(requester && p === requester && !r1Relaxed));
      const removed = node.approvers.length - eligible.length;
      const needed = node.quorum === 'all' ? node.approvers.length : node.quorum === 'any' ? 1 : node.quorum;

      // If excluding the requester leaves too few approvers, the owner stands in
      // (unless the owner is the requester, is already listed, or the step needs
      // everyone — "all" can't be covered by a stand-in).
      let approvers = eligible;
      let ownerStandin = false;
      if (eligible.length < needed) {
        const canOwnerHelp = node.quorum !== 'all' && ownerId && ownerId !== requester
          && !node.approvers.includes(ownerId) && eligible.length + 1 >= needed;
        if (canOwnerHelp) {
          approvers = [...eligible, ownerId!];
          ownerStandin = true;
        } else {
          const reqName = requester ? nameOf.get(requester) ?? 'the requester' : 'the requester';
          stuck = `${reqName} submitted this bill, so they can't approve their own "${node.title}" step — and no one else can cover it. `
            + `Add another approver to this step, or make sure your owner or an admin can step in.`;
          return;
        }
      }
      if ((removed > 0 || ownerStandin) && requester) {
        const dest = ownerStandin ? `${nameOf.get(ownerId!) ?? 'the owner'} (owner) as a stand-in` : eligible.map((p) => nameOf.get(p)).join(', ');
        notes.push(`${nameOf.get(requester) ?? 'The requester'} submitted this bill, so their "${node.title}" step goes to ${dest} instead — no one approves their own request.`);
      }
      // Show the WHOLE pool — hiding people beyond the quorum made "2 of 3"
      // read as "exactly these two" (and dropped the third name entirely).
      const quorumNote = node.quorum === 'all' || approvers.length <= 1 ? ''
        : needed === 1 ? ' · any one of them' : ` · any ${needed} of the ${approvers.length}`;
      for (const personId of approvers) {
        const isStandin = ownerStandin && personId === ownerId;
        chain.push({
          personId,
          name: nameOf.get(personId) ?? 'Unknown',
          step: node.title,
          why: isStandin ? `owner stand-in for ${nameOf.get(requester!) ?? 'requester'}`
            : removed > 0 ? `stand-in for ${nameOf.get(requester!) ?? 'requester'}`
            : added ? `added · over threshold${quorumNote}` : `always${quorumNote}`,
          kind: (removed > 0 || ownerStandin) ? 'standin' : added ? 'added' : 'always',
        });
      }
    }
  };
  walk(flow, false);

  return {
    stuck,
    chain,
    notes,
    summary: stuck
      ? null
      : `${chain.length} ${chain.length === 1 ? 'person' : 'people'}, in order · ${autoApproved ? 'then approved automatically' : 'fully approved, then paid'}`,
  };
}

// ─── Pipeline simulator ─────────────────────────────────────────────────────
// Resolve a sample bill through all three stages (Review → Approve → Release)
// using real people, the org's separation-of-duties switches, and owner stand-in.
type PipelineChainEntry = { personId: string; name: string; step: string; why: string; kind: 'always' | 'added' | 'standin' };
type StageResult = { chain: PipelineChainEntry[]; notes: string[]; stuck: string | null; resolvedIds: string[] };

// One stage's routing. `excluded` maps a personId → why they can't act here
// (e.g. "reviewed this bill"); the owner stands in if an exclusion empties a step.
function resolveStage(flow: FlowNode[], opts: {
  amountUsd: number; vendorId?: string | null; category?: string | null; firstBill?: boolean | null;
  excluded: Map<string, string>; ownerId: string | null; nameOf: Map<string, string>;
}): StageResult {
  const chain: PipelineChainEntry[] = [];
  const notes: string[] = [];
  const resolvedIds: string[] = [];
  let stuck: string | null = null;

  const walk = (nodes: FlowNode[], added: boolean) => {
    for (const node of nodes) {
      if (stuck) return;
      if (node.type === 'auto' || node.type === 'notify') continue;
      if (node.type === 'if') {
        const matches = splitMatches(node, opts);
        walk(matches ? node.then : node.otherwise, matches || added);
        return; // parity with simulateFlow: the chosen branch carries the rest
      }
      const eligible = node.approvers.filter((p) => !opts.excluded.has(p));
      const removedIds = node.approvers.filter((p) => opts.excluded.has(p));
      const needed = node.quorum === 'all' ? node.approvers.length : node.quorum === 'any' ? 1 : node.quorum;

      let acting = eligible;
      let ownerStandin = false;
      if (eligible.length < needed) {
        const canOwner = node.quorum !== 'all' && opts.ownerId && !opts.excluded.has(opts.ownerId)
          && !node.approvers.includes(opts.ownerId) && eligible.length + 1 >= needed;
        if (canOwner) { acting = [...eligible, opts.ownerId!]; ownerStandin = true; }
        else {
          stuck = removedIds.length
            ? `Everyone set for "${node.title}" is excluded from this stage, and the owner can't cover it — add another person to this step.`
            : `"${node.title}" has no one assigned who can act — add a person to this step.`;
          return;
        }
      }
      for (const rid of removedIds) {
        notes.push(`${opts.nameOf.get(rid) ?? 'Someone'} ${opts.excluded.get(rid)}, so they can't act on "${node.title}".`);
      }
      if (ownerStandin && opts.ownerId) {
        notes.push(`"${node.title}" fell to ${opts.nameOf.get(opts.ownerId) ?? 'the owner'} (owner) as a stand-in.`);
      }
      // Display the WHOLE pool with the quorum spelled out — slicing to the
      // quorum size made "2 of 3" read as exactly-these-two. resolvedIds keeps
      // the quorum-sized subset: it drives downstream SoD exclusions, and
      // excluding people who may never act would overstate the conflicts.
      const quorumNote = node.quorum === 'all' || acting.length <= 1 ? ''
        : needed === 1 ? ' · any one of them' : ` · any ${needed} of the ${acting.length}`;
      for (const [idx, personId] of acting.entries()) {
        const isStandin = ownerStandin && personId === opts.ownerId;
        chain.push({
          personId, name: opts.nameOf.get(personId) ?? 'Unknown', step: node.title,
          why: isStandin ? 'owner stand-in' : removedIds.length ? 'stand-in' : added ? `over threshold${quorumNote}` : `every bill${quorumNote}`,
          kind: (removedIds.length || ownerStandin) ? 'standin' : added ? 'added' : 'always',
        });
        if (node.quorum === 'all' || idx < Math.max(1, needed)) resolvedIds.push(personId);
      }
    }
  };
  walk(flow, false);
  return { chain, notes, stuck, resolvedIds };
}

export async function simulatePipeline(organizationId: string, input: {
  reviewFlow: FlowNode[]; approveFlow: FlowNode[]; releaseFlow: FlowNode[];
  amountUsd: number; submitterPersonId: string | null; vendorId?: string | null; category?: string | null; firstBill?: boolean | null; flagsOverride?: SodFlags | null;
}) {
  const people = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM approval.people WHERE organization_id = ${organizationId}::uuid AND status = 'active'`;
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const ownerId = await ownerPersonId(organizationId);
  // The Test rail passes the in-flight (possibly unsaved) switches so the preview
  // reflects what the owner is about to publish; otherwise use the stored ones.
  const flags = input.flagsOverride ?? await getSodFlags(prisma, organizationId);
  const submitter = input.submitterPersonId;

  // Review — the submitter may review their own bill (review is data entry, not authorization).
  const sampleBits = { amountUsd: input.amountUsd, vendorId: input.vendorId ?? null, category: input.category ?? null, firstBill: input.firstBill ?? null };
  const review = resolveStage(input.reviewFlow, { ...sampleBits, excluded: new Map(), ownerId, nameOf });

  // Approve — exclude reviewers (unless the org allows reviewer=approver) and the
  // submitter (unless the org allows self-approval).
  const approveExcluded = new Map<string, string>();
  if (!flags.reviewerCanApprove) for (const id of review.resolvedIds) approveExcluded.set(id, 'reviewed this bill');
  if (!flags.submitterCanApprove && submitter) approveExcluded.set(submitter, 'submitted this bill');
  const approve = resolveStage(input.approveFlow, { ...sampleBits, excluded: approveExcluded, ownerId, nameOf });

  // Release — exclude approvers (unless the org allows approver=releaser).
  const releaseExcluded = new Map<string, string>();
  if (!flags.approverCanRelease) for (const id of approve.resolvedIds) releaseExcluded.set(id, 'approved this bill');
  const release = resolveStage(input.releaseFlow, { ...sampleBits, excluded: releaseExcluded, ownerId, nameOf });

  return { review, approve, release, stuck: review.stuck ?? approve.stuck ?? release.stuck ?? null, flags };
}

// AI assist: natural language + the current flow + the org's people → a new
// flow tree + a one-sentence explanation. The model only ever returns a flow
// tree and words; it never touches the engine. We validate its output against
// the flow shape and the real roster, then simulate it so the assistant can
// report the outcome (and catch a deadlock in plain words).
import { config } from '../config.js';
import { logger } from '../infra/logger.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// Progress hooks so the streaming route can narrate real steps (reading →
// drafting → checking) and drop the flow onto the canvas mid-generation. All
// optional — the non-streaming route just calls assistFlow(org, msg, flow).
export type AssistOpts = {
  onStatus?: (step: string, label: string) => void;
  onFlow?: (flow: FlowNode[]) => void;
  signal?: AbortSignal;
};

type AssistResult = { flow: FlowNode[]; explanation: string; outcome: string | null; deadlock: boolean; clarify?: string | null };

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

// The tools the agent can call. Read tools let it learn the org and test its own
// design; the two terminal tools are how it hands back an answer.
const ASSIST_TOOLS = [
  { type: 'function', function: { name: 'list_members', description: 'List everyone on the team with their name, email, and the approval roles they hold. Call this before deciding who approves.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'list_roles', description: 'List the approval roles that exist in this org and who holds each (some may have no holder yet).', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'simulate_flow', description: 'Dry-run a flow for a sample bill and see exactly who it routes to, or whether it would get stuck. Use this to check your design before submitting.', parameters: { type: 'object', properties: { flow: { type: 'array', description: 'the FlowNode[] to test' }, amountUsd: { type: 'number' }, requesterPersonId: { type: ['string', 'null'] } }, required: ['flow', 'amountUsd'], additionalProperties: false } } },
  { type: 'function', function: { name: 'submit_flow', description: 'Finalize. Provide the approval flow to apply and one plain-language sentence explaining what it does.', parameters: { type: 'object', properties: { flow: { type: 'array', description: 'the FlowNode[] to apply' }, explanation: { type: 'string' } }, required: ['flow', 'explanation'], additionalProperties: false } } },
  { type: 'function', function: { name: 'request_clarification', description: 'Ask the user ONE short question when the request is genuinely too vague to build safely. Prefer building with a stated assumption when you reasonably can.', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false } } },
];

const ASSIST_SYSTEM =
  `You are Decimal's approval-flow assistant. You design a company's bill-approval flow — a tree of nodes.\n` +
  `A FlowNode is one of:\n` +
  `  { "id": string, "type": "step", "title": string, "approvers": string[] (person ids), "quorum": "all"|"any"|number }\n` +
  `  { "id": string, "type": "if", "amountGteUsd": number, "then": FlowNode[], "otherwise": FlowNode[] }\n` +
  `Work like an agent: FIRST call list_members (and list_roles if the person mentions a role) to learn the real team — never guess who holds a role. ` +
  `When the user names a role like "the CFO", route that step to whoever actually holds it. If nobody holds a named role, route to the most senior available person and say so plainly. ` +
  `Test your design with simulate_flow before finalizing. When confident, call submit_flow with the flow and a one-sentence, jargon-free explanation. ` +
  `If the request is genuinely too vague to build safely, call request_clarification with one short question — but prefer building with a clearly-stated assumption when you reasonably can. ` +
  `Rules: approvers must be real person ids from list_members. "quorum": "any" = any one approves, "all" = everyone, a number = that many. Put required steps before an "if". A branch needing no extra approval is []. Never mention crypto, wallets, "quorum", "policy", or "node" in the explanation.`;

export async function assistFlow(organizationId: string, message: string, currentFlow: FlowNode[], opts: AssistOpts = {}): Promise<AssistResult> {
  const { onStatus, onFlow, signal } = opts;
  // Org data the tools serve — fetched once, handed to the model only when it asks.
  const people = await prisma.$queryRaw<{ id: string; name: string; email: string; roles: string[] }[]>`
    SELECT p.id, p.name, p.email,
      CASE WHEN om.role = 'owner' THEN ARRAY['Primary admin']
           WHEN om.role = 'admin' THEN ARRAY['Admin']
           ELSE COALESCE(array_agg(initcap(pr.role) ORDER BY pr.role) FILTER (WHERE pr.role IS NOT NULL), '{}') END AS roles
    FROM approval.people p
    LEFT JOIN approval.person_roles pr ON pr.person_id = p.id
    LEFT JOIN organization_memberships om ON om.organization_id = p.organization_id AND om.user_id = p.user_id AND om.status = 'active'
    WHERE p.organization_id = ${organizationId}::uuid AND p.status = 'active' AND p.external = false
    GROUP BY p.id, p.name, p.email, om.role
    ORDER BY p.name`;
  if (people.length === 0) {
    return { flow: currentFlow, explanation: 'Add teammates as members first — an approval flow needs people to route to.', outcome: null, deadlock: false };
  }
  if (!config.openAiApiKey) {
    return { flow: currentFlow, explanation: 'The assistant is unavailable right now. You can still edit the flow directly on the canvas.', outcome: null, deadlock: false };
  }
  const validIds = new Set(people.map((p) => p.id));
  const { ROLE_DEFINITIONS } = await import('./permissions.js');
  const rolesList = ROLE_DEFINITIONS.map((d) => ({ role: d.name, holders: people.filter((p) => p.roles.includes(d.name)).map((p) => p.name) }));

  const messages: ChatMessage[] = [
    { role: 'system', content: ASSIST_SYSTEM },
    { role: 'user', content: `Current flow (JSON): ${JSON.stringify(currentFlow)}\nThe person says: "${message}"\nReturn the UPDATED flow (keep what they didn't ask to change).` },
  ];

  const finalOutcome = async (flow: FlowNode[]): Promise<{ outcome: string | null; deadlock: boolean }> => {
    const sim = await simulateFlow(organizationId, flow, { amountUsd: 12000, requesterPersonId: null });
    if (sim.stuck) return { outcome: null, deadlock: true };
    if (sim.chain.length > 0) return { outcome: `A $12,000 bill would go to ${sim.chain.map((c) => c.name.split(' ')[0]).join(' → ')}, then get paid.`, deadlock: false };
    return { outcome: 'A bill would be approved automatically with no sign-offs.', deadlock: false };
  };

  let result: AssistResult | null = null;
  try {
    for (let turn = 0; turn < 6 && !result; turn += 1) {
      const reply = await callOpenAiWithTools(messages, signal);
      messages.push(reply);
      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) {
        // The model answered in prose without a tool — treat as an explanation, no change.
        result = { flow: currentFlow, explanation: (reply.content ?? 'Updated the flow.').slice(0, 240), outcome: null, deadlock: false };
        break;
      }
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* leave empty */ }
        let toolOut: unknown;
        switch (call.function.name) {
          case 'list_members':
            onStatus?.('members', 'Looking up your team');
            toolOut = people.map((p) => ({ personId: p.id, name: p.name, email: p.email, roles: p.roles }));
            break;
          case 'list_roles':
            onStatus?.('roles', 'Checking who holds which role');
            toolOut = rolesList;
            break;
          case 'simulate_flow': {
            onStatus?.('testing', 'Testing who a bill would go to');
            const f = sanitizeFlow(args.flow, validIds) ?? [];
            const sim = await simulateFlow(organizationId, f, { amountUsd: typeof args.amountUsd === 'number' ? args.amountUsd : 12000, requesterPersonId: typeof args.requesterPersonId === 'string' ? args.requesterPersonId : null });
            toolOut = { routesTo: sim.chain.map((c) => ({ name: c.name, step: c.step, why: c.why })), stuck: sim.stuck ?? null };
            break;
          }
          case 'submit_flow': {
            onStatus?.('drafting', 'Drawing the flow');
            const f = sanitizeFlow(args.flow, validIds);
            if (!f || f.length === 0) { toolOut = { error: 'The flow was empty or invalid — build at least one step.' }; break; }
            onFlow?.(f);
            const { outcome, deadlock } = await finalOutcome(f);
            result = { flow: f, explanation: (typeof args.explanation === 'string' ? args.explanation : 'Updated the flow.').slice(0, 240), outcome, deadlock };
            toolOut = { ok: true };
            break;
          }
          case 'request_clarification': {
            const q = (typeof args.question === 'string' ? args.question : 'Could you say a bit more about how bills should be approved?').slice(0, 280);
            result = { flow: currentFlow, explanation: q, clarify: q, outcome: null, deadlock: false };
            toolOut = { ok: true };
            break;
          }
          default:
            toolOut = { error: 'unknown tool' };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolOut) });
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error; // the route turns this into a clean stop
    logger.warn('flow_assist.failed', { organizationId, ...(error instanceof Error ? { message: error.message } : {}) });
    return { flow: currentFlow, explanation: "I couldn't work that out just now — try rephrasing, or edit the flow on the canvas.", outcome: null, deadlock: false };
  }

  return result ?? { flow: currentFlow, explanation: "I couldn't finish that — try rephrasing what you'd like.", outcome: null, deadlock: false };
}

// One turn of the tool-calling loop: send the transcript + tool defs, get back
// the assistant's next message (which may be prose or a batch of tool calls).
async function callOpenAiWithTools(messages: ChatMessage[], signal?: AbortSignal): Promise<ChatMessage> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
    body: JSON.stringify({ model: config.openAiModel, temperature: 0, max_tokens: 1500, messages, tools: ASSIST_TOOLS, tool_choice: 'auto' }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: ChatMessage }> };
  return body.choices?.[0]?.message ?? { role: 'assistant', content: '' };
}

// Trust nothing from the model: coerce to the FlowNode shape, keep only real
// person ids, cap depth/size. Returns null if it isn't salvageable.
function sanitizeFlow(raw: unknown, validIds: Set<string>, depth = 0): FlowNode[] | null {
  if (depth > 6 || !Array.isArray(raw)) return depth === 0 ? null : [];
  const out: FlowNode[] = [];
  for (const n of raw.slice(0, 20)) {
    if (typeof n !== 'object' || n === null) continue;
    const node = n as Record<string, unknown>;
    const id = typeof node.id === 'string' ? node.id : `n${Math.random().toString(36).slice(2, 8)}`;
    if (node.type === 'step') {
      const approvers = (Array.isArray(node.approvers) ? node.approvers : []).filter((x): x is string => typeof x === 'string' && validIds.has(x));
      const q = node.quorum;
      const quorum: 'all' | 'any' | number = q === 'all' ? 'all' : typeof q === 'number' && q >= 1 ? Math.floor(q) : 'any';
      out.push({ id, type: 'step', title: typeof node.title === 'string' ? node.title.slice(0, 80) : 'Approval step', approvers, quorum });
    } else if (node.type === 'if') {
      out.push({
        id, type: 'if',
        amountGteUsd: typeof node.amountGteUsd === 'number' && node.amountGteUsd >= 0 ? node.amountGteUsd : 10000,
        then: sanitizeFlow(node.then, validIds, depth + 1) ?? [],
        otherwise: sanitizeFlow(node.otherwise, validIds, depth + 1) ?? [],
      });
    }
  }
  return out;
}
