// Bridge between the control plane and the approval engine.
// ensureEngineSetup gives every org the degenerate default the migration story
// promised: one hierarchy, one node, members as people, a 2-of-N approvers
// quorum for invoices and a 2-of-N keyholder quorum for releases — behavior-
// equivalent to the old Squads threshold, expressed as one trivial policy.
import { prisma } from '../infra/prisma.js';
import { ensureRulePack } from './protections.js';
import { submitApprovable, type SubmitResult } from './lifecycle.js';
import {
  assignSeat, createHierarchy, createNode, createPolicy, createSeat,
  ensureOrgSettings, getPolicySet, grantAuthority, upsertPolicySet, type Tx,
} from './store.js';

/** Map a control-plane user to their approval.people row, creating it if absent. */
export async function ensurePersonForUser(tx: Tx, organizationId: string, userId: string): Promise<string> {
  const existing = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM approval.people WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`;
  if (existing.length > 0) return existing[0].id;
  const user = await tx.$queryRaw<{ email: string; display_name: string }[]>`
    SELECT email, display_name FROM users WHERE user_id = ${userId}::uuid`;
  if (user.length === 0) throw new Error(`user ${userId} not found`);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO approval.people (organization_id, user_id, name, email)
    VALUES (${organizationId}::uuid, ${userId}::uuid, ${user[0].display_name}, ${user[0].email})
    ON CONFLICT (organization_id, email) DO UPDATE SET user_id = EXCLUDED.user_id
    RETURNING id`;
  return rows[0].id;
}

/**
 * Idempotent default setup. Existing orgs migrate onto the engine with zero
 * behavior change: every active member can approve, quorum = min(2, members).
 */
export async function ensureEngineSetup(organizationId: string): Promise<{ created: boolean }> {
  return prisma.$transaction(async (tx) => {
    const existing = await getPolicySet(tx, organizationId, 'invoice');
    await ensureRulePack(tx, organizationId); // rules-as-data: cards, relaxation FK targets, veto lookup
    // Orgs set up before review became an engine stage have an invoice policy
    // set and no review one, so this cannot sit behind the early return below.
    if (existing) {
      await ensureReviewPolicySet(tx, organizationId);
      return { created: false };
    }

    await ensureOrgSettings(tx, organizationId);
    const members = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM organization_memberships
      WHERE organization_id = ${organizationId}::uuid AND status = 'active'`;
    const peopleIds: string[] = [];
    for (const m of members) peopleIds.push(await ensurePersonForUser(tx, organizationId, m.user_id));

    const hierarchyId = await createHierarchy(tx, organizationId, 'company', 'reporting');
    const root = await createNode(tx, hierarchyId, 'company');
    const quorum = Math.min(2, Math.max(1, peopleIds.length));
    // Release quorum: with 2 members, R5 rightly excludes the bill's approver, leaving
    // exactly one eligible keyholder — quorum 2 would deadlock every release (H4).
    const releaseQuorum = peopleIds.length >= 3 ? 2 : 1;
    const approvers = await createSeat(tx, root, 'approvers', 'group', quorum);
    const keyholders = await createSeat(tx, root, 'keyholders', 'group', releaseQuorum);
    for (const p of peopleIds) {
      await assignSeat(tx, approvers, p);
      await assignSeat(tx, keyholders, p);
    }
    await grantAuthority(tx, approvers, 'invoice_approval', root);
    await grantAuthority(tx, keyholders, 'payment_release', root);

    const invoicePolicy = await createPolicy(tx, organizationId, 'invoice', 'default approval', [
      {
        type: 'step',
        targets: [{ kind: 'holders', authority: 'invoice_approval', scope: root }],
        step: { mode: 'quorum', m: quorum },
        onUnresolvable: { kind: 'seat', seatId: approvers },
        slaHours: 72,
        purpose: 'approval',
      },
    ]);
    await upsertPolicySet(tx, organizationId, 'invoice', [], invoicePolicy.id, invoicePolicy.version);

    const releasePolicy = await createPolicy(tx, organizationId, 'payment_run', 'default release', [
      {
        type: 'step',
        targets: [{ kind: 'holders', authority: 'payment_release', scope: root }],
        step: { mode: 'quorum', m: releaseQuorum },
        onUnresolvable: { kind: 'seat', seatId: keyholders },
        purpose: 'payment release',
      },
    ]);
    await upsertPolicySet(tx, organizationId, 'payment_run', [], releasePolicy.id, releasePolicy.version);
    await ensureReviewPolicySet(tx, organizationId);
    return { created: true };
  });
}

/**
 * Stage 1 of the pipeline, as a real policy set.
 *
 * The default is deliberately a quorum of ONE against every member: today a
 * single person confirms a bill and it moves on, and turning review into an
 * engine stage must not silently start requiring two. What it buys is not a
 * stricter gate — it is that a bill in review now has a TASK, which is what
 * makes request_info, delegate, push_back and the overdue sweep reachable
 * before a bill has been confirmed. Orgs that want a real review quorum change
 * it in the Flow Builder, which has been publishing to this policy set all
 * along with nothing to execute it.
 */
export async function ensureReviewPolicySet(tx: Tx, organizationId: string): Promise<void> {
  if (await getPolicySet(tx, organizationId, 'review')) return;

  const members = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM organization_memberships
    WHERE organization_id = ${organizationId}::uuid AND status = 'active'`;
  const peopleIds: string[] = [];
  for (const m of members) peopleIds.push(await ensurePersonForUser(tx, organizationId, m.user_id));

  // Reuse the org's existing hierarchy root rather than making a second one.
  const rootRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT n.id FROM approval.nodes n
    JOIN approval.hierarchies h ON h.id = n.hierarchy_id
    WHERE h.organization_id = ${organizationId}::uuid
    ORDER BY n.id LIMIT 1`;
  if (rootRows.length === 0) return; // no hierarchy yet — the fresh-org path will call us again
  const root = rootRows[0]!.id;

  const reviewers = await createSeat(tx, root, 'reviewers', 'group', 1);
  for (const p of peopleIds) await assignSeat(tx, reviewers, p);
  await grantAuthority(tx, reviewers, 'invoice_review', root);

  const reviewPolicy = await createPolicy(tx, organizationId, 'review', 'default review', [
    {
      type: 'step',
      targets: [{ kind: 'holders', authority: 'invoice_review', scope: root }],
      step: { mode: 'quorum', m: 1 },
      onUnresolvable: { kind: 'seat', seatId: reviewers },
      slaHours: 48,
      purpose: 'review',
    },
  ]);
  await upsertPolicySet(tx, organizationId, 'review', [], reviewPolicy.id, reviewPolicy.version);
}

/**
 * Stage 1: put a freshly-extracted bill into REVIEW as an engine approvable.
 *
 * Called at intake, not at confirm. That is the whole point — until this
 * existed, a bill sat outside the engine until someone confirmed it, so the
 * eleven commands the engine already implements (request_info, delegate,
 * push_back, escalate, recall...) were unreachable at exactly the moment a
 * reviewer most needs them: when a flag says something is wrong and they want
 * to ask someone rather than approve or bin it.
 */
export async function submitBillForReview(input: {
  organizationId: string;
  requesterUserId: string;
  totalMinorBase: bigint;
  vendorId?: string | null;
  attributes?: Record<string, unknown>;
  lines: { amountMinor: bigint; currency: string; description?: string | null; dimensions?: Record<string, string> }[];
}): Promise<SubmitResult> {
  await ensureEngineSetup(input.organizationId);
  const requesterId = await prisma.$transaction((tx) => ensurePersonForUser(tx, input.organizationId, input.requesterUserId));
  return submitApprovable({
    organizationId: input.organizationId,
    type: 'review',
    requesterId,
    vendorId: input.vendorId ?? null,
    totalMinorBase: input.totalMinorBase,
    attributes: input.attributes,
    lines: input.lines,
  });
}

/**
 * Pipeline hook (coding-before-approval order): call after GL coding populates
 * line dimensions; the returned approvable drives the payment order's approval
 * segment. Requester defaults to the uploading user.
 */
export async function submitInvoiceForApproval(input: {
  organizationId: string;
  requesterUserId: string;
  totalMinorBase: bigint;
  vendorId?: string | null;
  attributes?: Record<string, unknown>;
  lines: { amountMinor: bigint; currency: string; description?: string | null; dimensions?: Record<string, string> }[];
}): Promise<SubmitResult> {
  await ensureEngineSetup(input.organizationId);
  const requesterId = await prisma.$transaction((tx) => ensurePersonForUser(tx, input.organizationId, input.requesterUserId));
  return submitApprovable({
    organizationId: input.organizationId,
    type: 'invoice',
    requesterId,
    vendorId: input.vendorId ?? null,
    totalMinorBase: input.totalMinorBase,
    attributes: input.attributes,
    lines: input.lines,
  });
}
