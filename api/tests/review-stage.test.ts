// Review as a real engine stage.
//
// Before this, a bill sat OUTSIDE the approval engine until someone confirmed
// it. The engine already implemented request_info, delegate, push_back,
// escalate and recall — but none of them were reachable at the one moment a
// reviewer most needs them: when a flag says something is wrong and they want
// to ask someone rather than approve the bill or bin it.
//
// A published review flow could never execute either: policy sets are keyed by
// approvable type, and 'review' was not a permitted type.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { planTasks, getActivePlan } from '../src/approvals/store.js';
import { executeCommand, spawnInvoiceFromReview } from '../src/approvals/lifecycle.js';
import { submitBillForReview } from '../src/approvals/wiring.js';

const ORG = '00000000-0000-0000-0000-0000000e5001';
const USER = '00000000-0000-0000-0000-0000000e5002';
const usd = (n: number) => BigInt(Math.round(n * 100));

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE approval.approval_events, approval.tasks, approval.approval_plans,
    approval.policy_sets, approval.approvable_lines, approval.approvables, approval.rule_relaxations,
    approval.constraint_rules, approval.seat_assignments, approval.authority_grants, approval.seats,
    approval.node_edges, approval.nodes, approval.hierarchies, approval.people, approval.org_settings CASCADE`);
  await prisma.$executeRawUnsafe(`TRUNCATE approval.policies CASCADE`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE organization_memberships, organizations, users CASCADE`);
  await prisma.$executeRaw`INSERT INTO users (user_id, email, display_name) VALUES (${USER}::uuid, 'solo@t.local', 'Solo Operator')`;
  await prisma.$executeRaw`INSERT INTO organizations (organization_id, organization_name) VALUES (${ORG}::uuid, 'Solo Org')`;
  await prisma.$executeRaw`INSERT INTO organization_memberships (organization_id, user_id, role, status)
    VALUES (${ORG}::uuid, ${USER}::uuid, 'owner', 'active')`;
});

async function submitOne() {
  return submitBillForReview({
    organizationId: ORG,
    requesterUserId: USER,
    totalMinorBase: usd(4820),
    lines: [{ amountMinor: usd(4820), currency: 'USD' }],
  });
}

test('a bill entering review becomes an engine approvable with a live task', async () => {
  const result = await submitOne();
  assert.equal(result.macroState, 'pending_approval');
  assert.ok(result.planId, 'review must compile to a plan');
  const tasks = await planTasks(prisma, result.planId!);
  assert.ok(tasks.length > 0, 'review must produce at least one task to act on');
});

// The regression that would have bitten on the very first real bill: R1 says a
// submitter may not approve their own liability. Review is not the liability
// decision — it is checking that what we extracted matches the document, and
// the person who forwarded the bill is exactly who should check it. If R1
// applied here, a one-person org would deadlock immediately: the forwarder is
// the requester, R1 strips them from their own review step, and nobody is left.
test('the person who forwarded the bill can review it (R1 must not veto)', async () => {
  const result = await submitOne();
  const tasks = await planTasks(prisma, result.planId!);
  const person = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM approval.people WHERE organization_id = ${ORG}::uuid AND user_id = ${USER}::uuid`;
  assert.ok(tasks.some((t: any) => t.person_id === person[0]!.id),
    'the requester must be assignable to their own review task');
});

test('a reviewer can ask a question instead of approving or binning the bill', async () => {
  const result = await submitOne();
  const [task] = await planTasks(prisma, result.planId!);
  await executeCommand({
    taskId: (task as any).id,
    actorId: (task as any).person_id,
    idempotencyKey: 'ask-1',
    // The engine requires naming WHO is asked and WHAT — a parked bill always
    // records the question and its owner, so it can never become nobody's.
    command: { kind: 'request_info', question: 'Is this bill actually ours? It names another company.', from: (task as any).person_id } as never,
  });
  const parked = await planTasks(prisma, result.planId!);
  assert.equal((parked[0] as any).state, 'info_requested');
  const approvable = await prisma.$queryRaw<{ macro_state: string }[]>`
    SELECT macro_state FROM approval.approvables WHERE id = ${result.approvableId}::uuid`;
  assert.equal(approvable[0]!.macro_state, 'returned_for_info', 'the bill parks, it does not die');
});

test('answering un-parks the bill without approving it', async () => {
  const result = await submitOne();
  const [task] = await planTasks(prisma, result.planId!);
  const t = task as any;
  await executeCommand({ taskId: t.id, actorId: t.person_id, idempotencyKey: 'ask-2', command: { kind: 'request_info', question: 'Is this ours?', from: t.person_id } as never });
  await executeCommand({ taskId: t.id, actorId: t.person_id, idempotencyKey: 'answer-2', command: { kind: 'provide_info', answer: 'Confirmed — Halcyon Labs is our subsidiary.' } as never });
  const resumed = await planTasks(prisma, result.planId!);
  assert.equal((resumed[0] as any).state, 'open', 'the answer returns the task to open');
  const approvable = await prisma.$queryRaw<{ macro_state: string }[]>`
    SELECT macro_state FROM approval.approvables WHERE id = ${result.approvableId}::uuid`;
  assert.equal(approvable[0]!.macro_state, 'pending_approval');
});

test('a completed review spawns the approval stage, carrying the amount', async () => {
  const result = await submitOne();
  const [task] = await planTasks(prisma, result.planId!);
  const t = task as any;
  await executeCommand({ taskId: t.id, actorId: t.person_id, idempotencyKey: 'approve-1', command: { kind: 'approve' } as never });

  const reviewed = await prisma.$queryRaw<{ macro_state: string }[]>`
    SELECT macro_state FROM approval.approvables WHERE id = ${result.approvableId}::uuid`;
  assert.ok(['approved', 'auto_approved'].includes(reviewed[0]!.macro_state), 'review must complete');

  const invoice = await spawnInvoiceFromReview(result.approvableId);
  const row = await prisma.$queryRaw<{ type: string; total_minor_base: bigint; attributes: any }[]>`
    SELECT type, total_minor_base, attributes FROM approval.approvables WHERE id = ${invoice.approvableId}::uuid`;
  assert.equal(row[0]!.type, 'invoice');
  assert.equal(row[0]!.total_minor_base, usd(4820));
  assert.equal(row[0]!.attributes.reviewApprovableId, result.approvableId,
    'the approval stage must point back at the review it came from');
});
