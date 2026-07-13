// HTTP surface over the approval engine. Operator vocabulary only — "approval",
// "task", "reason" — the engine's internals stay behind this boundary.
import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAccess } from '../auth/organization-access.js';
import { badRequest, forbidden, notFound, conflict } from '../infra/api-errors.js';
import { asyncRoute, sendCreated, sendJson, sendList } from '../infra/route-helpers.js';
import { prisma } from '../infra/prisma.js';
import { executeCommand, submitApprovable, spawnReleaseRun } from './lifecycle.js';
import { ApprovalEngineError, approverCommandSchema } from './schemas.js';
import { getActivePlan, listEvents } from './store.js';

export const approvalsRouter = Router();

const orgParams = z.object({ organizationId: z.string().uuid() });

/** The engine acts for people; map the authed user to their approval.people row. */
async function personForUser(organizationId: string, userId: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM approval.people WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`;
  if (rows.length === 0) throw forbidden('You are not registered as an approver in this organization');
  return rows[0].id;
}

function mapEngineError(e: unknown): never {
  if (e instanceof ApprovalEngineError) {
    if (e.code === 'forbidden_role') throw forbidden('This task is not yours to act on');
    if (e.code === 'sod_violation') throw conflict(`Separation-of-duties rule blocks this action`, e.detail);
    if (e.code === 'unknown_task') throw notFound('Task not found');
    throw conflict(e.message, { code: e.code });
  }
  throw e;
}

const submitSchema = z.object({
  type: z.enum(['invoice', 'vendor_change', 'payment_run', 'po']),
  totalMinorBase: z.string().regex(/^\d+$/),
  vendorId: z.string().uuid().nullish(),
  attributes: z.record(z.unknown()).optional(),
  lines: z.array(z.object({
    amountMinor: z.string().regex(/^\d+$/),
    currency: z.string().length(3),
    description: z.string().nullish(),
    dimensions: z.record(z.string().uuid()).optional(),
  })).min(1),
});

approvalsRouter.post('/organizations/:organizationId/approvals', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const input = submitSchema.parse(req.body);
  const { ensureEngineSetup } = await import('./wiring.js');
  await ensureEngineSetup(organizationId); // first touch self-initializes the org's default policy
  const requesterId = await personForUser(organizationId, req.auth!.userId);
  const result = await submitApprovable({
    organizationId,
    type: input.type,
    requesterId,
    vendorId: input.vendorId ?? null,
    totalMinorBase: BigInt(input.totalMinorBase),
    attributes: input.attributes,
    lines: input.lines.map((l) => ({
      amountMinor: BigInt(l.amountMinor), currency: l.currency,
      description: l.description ?? null, dimensions: l.dimensions,
    })),
  }).catch(mapEngineError);
  sendCreated(res, {
    approvableId: result.approvableId,
    state: result.macroState,
    steps: result.compile.steps.map((s) => ({
      index: s.index, mode: s.step, purpose: s.purpose,
      approvers: s.approvers.map((a) => a.personId),
    })),
  });
}));

approvalsRouter.get('/organizations/:organizationId/approvals/tasks', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const personId = await personForUser(organizationId, req.auth!.userId);
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT t.id AS task_id, t.state, t.step_index, t.sla_deadline,
           a.id AS approvable_id, a.type, a.total_minor_base::text AS total_minor_base, a.macro_state
    FROM approval.tasks t
    JOIN approval.approval_plans p ON p.id = t.plan_id AND p.superseded_by IS NULL
    JOIN approval.approvables a ON a.id = p.approvable_id
    WHERE t.person_id = ${personId}::uuid AND t.state IN ('open', 'info_requested')
      AND a.organization_id = ${organizationId}::uuid
    ORDER BY t.sla_deadline NULLS LAST`;
  sendList(res, rows);
}));

approvalsRouter.post('/organizations/:organizationId/approvals/tasks/:taskId/command', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  const { taskId } = z.object({ taskId: z.string().uuid() }).parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const idempotencyKey = req.get('idempotency-key') ?? z.object({ idempotencyKey: z.string().min(8) }).parse(req.body).idempotencyKey;
  const command = approverCommandSchema.parse(req.body.command);
  if (!idempotencyKey) throw badRequest('idempotency key required');
  const actorId = await personForUser(organizationId, req.auth!.userId);
  const result = await executeCommand({ taskId, actorId, command, idempotencyKey }).catch(mapEngineError);
  sendJson(res, result);
}));

// Structured view of the org's approval flows — powers the Approvals page.
approvalsRouter.get('/organizations/:organizationId/approvals/policy', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { ensureEngineSetup } = await import('./wiring.js');
  await ensureEngineSetup(organizationId);
  const sets = await prisma.$queryRaw<{ approvable_type: string; name: string; body: unknown }[]>`
    SELECT ps.approvable_type, p.name, p.body
    FROM approval.policy_sets ps
    JOIN approval.policies p ON p.id = ps.default_policy_id AND p.version = ps.default_policy_version
    WHERE ps.organization_id = ${organizationId}::uuid`;
  const flows = [];
  for (const s of sets) {
    flows.push({
      approvableType: s.approvable_type,
      name: s.name,
      items: await flowItems(organizationId, s.body as any[], 0),
    });
  }
  sendJson(res, { flows });
}));

type FlowPerson = { name: string; email: string };
type FlowItem =
  | { kind: 'step'; depth: number; purpose: string; mode: string; m: number | null; people: FlowPerson[] }
  | { kind: 'auto' | 'reject' | 'condition' | 'otherwise'; depth: number; text: string };

async function peopleForTarget(organizationId: string, target: any): Promise<FlowPerson[]> {
  if (target.kind !== 'holders' && target.kind !== 'seat') return [];
  const seatFilter = target.kind === 'seat' ? target.seatId : null;
  return prisma.$queryRaw<FlowPerson[]>`
    SELECT DISTINCT pe.name, pe.email FROM approval.seat_assignments sa
    JOIN approval.people pe ON pe.id = sa.person_id
    JOIN approval.seats st ON st.id = sa.seat_id
    JOIN approval.nodes n ON n.id = st.node_id
    JOIN approval.hierarchies h ON h.id = n.hierarchy_id AND h.organization_id = ${organizationId}::uuid
    WHERE (sa.eff_to IS NULL OR sa.eff_to > now())
      AND (${seatFilter}::uuid IS NULL OR sa.seat_id = ${seatFilter}::uuid)
    ORDER BY pe.name`;
}

async function flowItems(organizationId: string, nodes: any[], depth: number): Promise<FlowItem[]> {
  const out: FlowItem[] = [];
  for (const node of nodes ?? []) {
    if (node.type === 'step') {
      const target = node.targets[0];
      out.push({
        kind: 'step', depth,
        purpose: node.purpose ?? 'Approval',
        mode: node.step.mode, m: node.step.m ?? null,
        people: target.kind === 'walk' ? [] : await peopleForTarget(organizationId, target),
      });
    } else if (node.type === 'terminal') {
      out.push({ kind: node.outcome === 'auto_approve' ? 'auto' : 'reject', depth, text: node.reason });
    } else if (node.type === 'condition') {
      out.push({ kind: 'condition', depth, text: describePredicate(node.if) });
      out.push(...(await flowItems(organizationId, node.then, depth + 1)));
      if (node.else?.length) {
        out.push({ kind: 'otherwise', depth, text: 'Otherwise' });
        out.push(...(await flowItems(organizationId, node.else, depth + 1)));
      }
    }
  }
  return out;
}

// --- Prebuilt roles (fixed permission bundles: reviewer/approver/payer/viewer) --

approvalsRouter.get('/organizations/:organizationId/roles', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { getMembersAndRoles } = await import('./roles.js');
  sendJson(res, await getMembersAndRoles(organizationId));
}));

const roleKeyParam = z.object({ roleKey: z.enum(['reviewer', 'approver', 'payer', 'viewer']) });

approvalsRouter.post('/organizations/:organizationId/roles/:roleKey/holders', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  const { roleKey } = roleKeyParam.parse(req.params);
  await requireOrgAdmin(organizationId, req.auth!);
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
  const { assignRole } = await import('./roles.js');
  sendCreated(res, await assignRole(organizationId, roleKey, userId));
}));

approvalsRouter.delete('/organizations/:organizationId/roles/:roleKey/holders/:personId', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  const { roleKey } = roleKeyParam.parse(req.params);
  const { personId } = z.object({ personId: z.string().uuid() }).parse(req.params);
  await requireOrgAdmin(organizationId, req.auth!);
  const { unassignRole } = await import('./roles.js');
  sendJson(res, await unassignRole(organizationId, roleKey, personId));
}));

// --- Out of office: pick a fill-in approver for while you're away ---------------
// Self-service (Ramp/Vic.ai model): anyone with approval duties sets their own.

approvalsRouter.get('/organizations/:organizationId/approvals/out-of-office', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const personId = await personForUser(organizationId, req.auth!.userId);
  const { getOutOfOffice } = await import('./out-of-office.js');
  sendJson(res, { outOfOffice: await getOutOfOffice(organizationId, personId) });
}));

approvalsRouter.put('/organizations/:organizationId/approvals/out-of-office', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const body = z.object({
    substitutePersonId: z.string().uuid(),
    endsAt: z.string().datetime(),
  }).parse(req.body);
  const personId = await personForUser(organizationId, req.auth!.userId);
  const { setOutOfOffice } = await import('./out-of-office.js');
  sendJson(res, await setOutOfOffice(organizationId, personId, body.substitutePersonId, new Date(body.endsAt)));
}));

approvalsRouter.delete('/organizations/:organizationId/approvals/out-of-office', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const personId = await personForUser(organizationId, req.auth!.userId);
  const { clearOutOfOffice } = await import('./out-of-office.js');
  sendJson(res, await clearOutOfOffice(organizationId, personId));
}));

// The caller's own access: membership tier, prebuilt roles, and the resolved
// capability list — what the frontend gates nav and pages on.
approvalsRouter.get('/organizations/:organizationId/my-access', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { getOrgAccess } = await import('./permissions.js');
  const access = await getOrgAccess(organizationId, req.auth!.userId);
  sendJson(res, access ?? { membershipRole: 'member', roles: [], capabilities: [], isOwnerOrAdmin: false });
}));

// --- Approval flow builder ------------------------------------------------------

const flowNodeSchema: z.ZodType<unknown> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('step'), title: z.string().min(1).max(120), approvers: z.array(z.string().uuid()), quorum: z.union([z.literal('all'), z.literal('any'), z.number().int().min(1).max(20)]), purpose: z.string().max(200).nullable().optional() }),
  z.object({
    id: z.string(), type: z.literal('if'), amountGteUsd: z.number().min(0),
    split: z.union([
      z.object({ kind: z.literal('vendor'), vendorIds: z.array(z.string().uuid()).min(1).max(30), vendorNames: z.array(z.string()).max(30) }),
      z.object({ kind: z.literal('category'), categories: z.array(z.string().min(1)).min(1).max(30) }),
      z.object({ kind: z.literal('firstBill') }),
    ]).nullable().optional(),
    then: z.array(flowNodeSchema), otherwise: z.array(flowNodeSchema),
  }),
  z.object({ id: z.string(), type: z.literal('auto') }),
  z.object({ id: z.string(), type: z.literal('notify'), people: z.array(z.string().uuid()) }),
]));
const flowSchema = z.array(flowNodeSchema).max(40);

approvalsRouter.get('/organizations/:organizationId/approvals/flow', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { getFlow } = await import('./flow.js');
  sendJson(res, await getFlow(organizationId));
}));

approvalsRouter.post('/organizations/:organizationId/approvals/flow/simulate', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const body = z.object({
    flow: flowSchema,
    sample: z.object({
      amountUsd: z.number().min(0),
      requesterPersonId: z.string().uuid().nullable(),
      vendorId: z.string().uuid().nullable().optional(),
      category: z.string().nullable().optional(),
      firstBill: z.boolean().nullable().optional(),
    }),
  }).parse(req.body);
  const { simulateFlow } = await import('./flow.js');
  sendJson(res, await simulateFlow(organizationId, body.flow as never, body.sample));
}));

approvalsRouter.post('/organizations/:organizationId/approvals/flow/assist', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const body = z.object({ message: z.string().trim().min(1).max(1000), flow: flowSchema }).parse(req.body);
  const { assistFlow } = await import('./flow.js');
  sendJson(res, await assistFlow(organizationId, body.message, body.flow as never));
}));

// Streaming assist (SSE): narrate real steps, drop the flow onto the canvas
// mid-generation, then a final `done`. Client Stop aborts the request, which
// tears down the OpenAI call.
approvalsRouter.post('/organizations/:organizationId/approvals/flow/assist/stream', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const body = z.object({ message: z.string().trim().min(1).max(1000), flow: flowSchema }).parse(req.body);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx/cloudflared)
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('open', { ok: true });

  const ac = new AbortController();
  req.on('close', () => ac.abort()); // client hit Stop or navigated away

  const { assistFlow } = await import('./flow.js');
  try {
    const result = await assistFlow(organizationId, body.message, body.flow as never, {
      onStatus: (step, label) => send('status', { step, label }),
      onFlow: (flow) => send('flow', { flow }),
      signal: ac.signal,
    });
    if (!ac.signal.aborted) send('done', result);
  } catch (error) {
    if (!ac.signal.aborted) send('error', { message: 'The assistant hit a snag. Your flow is unchanged — try again.' });
  } finally {
    res.end();
  }
}));

// Save / clear the unpublished builder draft so edits survive navigation.
approvalsRouter.put('/organizations/:organizationId/approvals/flow/draft', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const body = z.object({ flow: flowSchema }).parse(req.body);
  const { saveFlowDraft } = await import('./flow.js');
  await saveFlowDraft(organizationId, body.flow as never);
  sendJson(res, { ok: true });
}));

approvalsRouter.delete('/organizations/:organizationId/approvals/flow/draft', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { clearFlowDraft } = await import('./flow.js');
  await clearFlowDraft(organizationId);
  sendJson(res, { ok: true });
}));

// Payment-release control point (the payment_run policy): who must sign to
// release money once a bill has passed approval. Read is open to members
// (view-only); setting it is owner-only.
approvalsRouter.get('/organizations/:organizationId/approvals/release', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { getReleaseConfig } = await import('./flow.js');
  sendJson(res, await getReleaseConfig(organizationId));
}));

approvalsRouter.post('/organizations/:organizationId/approvals/release/publish', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { isOwnerRole, getOrganizationMembership } = await import('../auth/organization-access.js');
  const m = await getOrganizationMembership(req.auth!.userId, organizationId);
  if (!isOwnerRole(m?.role)) throw forbidden('Only the primary admin can set who sends payments.');
  const body = z.object({
    approvers: z.array(z.string().uuid()).min(1),
    quorum: z.union([z.literal('all'), z.literal('any'), z.number().int().min(1).max(20)]),
  }).parse(req.body);
  const { publishReleaseConfig } = await import('./flow.js');
  sendJson(res, await publishReleaseConfig(organizationId, body));
}));

approvalsRouter.post('/organizations/:organizationId/approvals/flow/publish', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { isOwnerRole, getOrganizationMembership } = await import('../auth/organization-access.js');
  const membership = await getOrganizationMembership(req.auth!.userId, organizationId);
  if (!isOwnerRole(membership?.role)) throw forbidden('Only the primary admin can publish the approval flow.');
  const body = z.object({ flow: flowSchema.min(1) }).parse(req.body);
  const { publishFlow } = await import('./flow.js');
  sendJson(res, await publishFlow(organizationId, body.flow as never));
}));

// --- Review stage (control point #1): who must confirm a bill's details before
// it can enter approval. Same builder power as the approval flow. Read is open
// to members (view-only); publishing/drafting is owner-only. -------------------
approvalsRouter.get('/organizations/:organizationId/approvals/review', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { getReviewFlow } = await import('./flow.js');
  sendJson(res, await getReviewFlow(organizationId));
}));

approvalsRouter.post('/organizations/:organizationId/approvals/review/publish', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { isOwnerRole, getOrganizationMembership } = await import('../auth/organization-access.js');
  const m = await getOrganizationMembership(req.auth!.userId, organizationId);
  if (!isOwnerRole(m?.role)) throw forbidden('Only the primary admin can publish the review stage.');
  const body = z.object({ flow: flowSchema.min(1) }).parse(req.body);
  const { publishReviewFlow } = await import('./flow.js');
  sendJson(res, await publishReviewFlow(organizationId, body.flow as never));
}));

approvalsRouter.put('/organizations/:organizationId/approvals/review/draft', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const body = z.object({ flow: flowSchema }).parse(req.body);
  const { saveFlowDraft } = await import('./flow.js');
  await saveFlowDraft(organizationId, body.flow as never, 'review');
  sendJson(res, { ok: true });
}));

approvalsRouter.delete('/organizations/:organizationId/approvals/review/draft', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { clearFlowDraft } = await import('./flow.js');
  await clearFlowDraft(organizationId, 'review');
  sendJson(res, { ok: true });
}));

// --- Payment stage as a full flow (steps · quorums · splits) on the
// payment_run policy. Read member-open; publish/draft owner-only. -----------------
approvalsRouter.get('/organizations/:organizationId/approvals/payment-flow', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { getPaymentFlow } = await import('./flow.js');
  sendJson(res, await getPaymentFlow(organizationId));
}));

approvalsRouter.post('/organizations/:organizationId/approvals/payment-flow/publish', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { isOwnerRole, getOrganizationMembership } = await import('../auth/organization-access.js');
  const m = await getOrganizationMembership(req.auth!.userId, organizationId);
  if (!isOwnerRole(m?.role)) throw forbidden('Only the primary admin can publish the payment stage.');
  const body = z.object({ flow: flowSchema.min(1) }).parse(req.body);
  const { publishPaymentFlow } = await import('./flow.js');
  sendJson(res, await publishPaymentFlow(organizationId, body.flow as never));
}));

approvalsRouter.put('/organizations/:organizationId/approvals/payment-flow/draft', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const body = z.object({ flow: flowSchema }).parse(req.body);
  const { saveFlowDraft } = await import('./flow.js');
  await saveFlowDraft(organizationId, body.flow as never, 'payment_run');
  sendJson(res, { ok: true });
}));

approvalsRouter.delete('/organizations/:organizationId/approvals/payment-flow/draft', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { clearFlowDraft } = await import('./flow.js');
  await clearFlowDraft(organizationId, 'payment_run');
  sendJson(res, { ok: true });
}));

// --- Separation of duties: the org's own switches over how strictly Review /
// Approve / Release must be staffed by different people. Read open to members;
// changing is owner-only. -------------------------------------------------------
approvalsRouter.get('/organizations/:organizationId/approvals/separation', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { getSodSettings } = await import('./flow.js');
  sendJson(res, await getSodSettings(organizationId));
}));

approvalsRouter.post('/organizations/:organizationId/approvals/separation', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { isOwnerRole, getOrganizationMembership } = await import('../auth/organization-access.js');
  const m = await getOrganizationMembership(req.auth!.userId, organizationId);
  if (!isOwnerRole(m?.role)) throw forbidden('Only the primary admin can change separation of duties.');
  const body = z.object({
    reviewerCanApprove: z.boolean(),
    submitterCanApprove: z.boolean(),
    approverCanRelease: z.boolean(),
  }).parse(req.body);
  const { setSodSettings } = await import('./flow.js');
  await setSodSettings(organizationId, body);
  sendJson(res, { ok: true });
}));

// --- Whole-pipeline dry run for the Test rail: resolve a sample bill through
// Review → Approve → Release with the org's separation switches applied. --------
approvalsRouter.post('/organizations/:organizationId/approvals/pipeline/simulate', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const body = z.object({
    reviewFlow: flowSchema,
    approveFlow: flowSchema,
    releaseFlow: flowSchema,
    amountUsd: z.number().min(0),
    submitterPersonId: z.string().uuid().nullable(),
    vendorId: z.string().uuid().nullable().optional(),
    category: z.string().nullable().optional(),
    firstBill: z.boolean().nullable().optional(),
    separation: z.object({
      reviewerCanApprove: z.boolean(),
      submitterCanApprove: z.boolean(),
      approverCanRelease: z.boolean(),
    }).nullable().optional(),
  }).parse(req.body);
  const { simulatePipeline } = await import('./flow.js');
  sendJson(res, await simulatePipeline(organizationId, {
    reviewFlow: body.reviewFlow as never,
    approveFlow: body.approveFlow as never,
    releaseFlow: body.releaseFlow as never,
    amountUsd: body.amountUsd,
    submitterPersonId: body.submitterPersonId,
    vendorId: body.vendorId ?? null,
    category: body.category ?? null,
    firstBill: body.firstBill ?? null,
    flagsOverride: body.separation ?? null,
  }));
}));

approvalsRouter.get('/organizations/:organizationId/approvals/:approvableId', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  const { approvableId } = z.object({ approvableId: z.string().uuid() }).parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, type, macro_state, total_minor_base::text AS total_minor_base, vendor_id, attributes
    FROM approval.approvables WHERE id = ${approvableId}::uuid AND organization_id = ${organizationId}::uuid`;
  if (rows.length === 0) throw notFound('Approval not found');
  const plan = await getActivePlan(prisma, approvableId);
  const events = await listEvents(organizationId, approvableId);
  sendJson(res, {
    ...rows[0],
    plan: plan ? { id: plan.id, steps: plan.steps, sodOutcomes: plan.sod_outcomes } : null,
    events: events.map((e) => ({ seq: String(e.seq), at: e.at, actorId: e.actor_id, payload: e.payload })),
  });
}));

approvalsRouter.post('/organizations/:organizationId/approvals/:approvableId/release', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  const { approvableId } = z.object({ approvableId: z.string().uuid() }).parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const result = await spawnReleaseRun(approvableId).catch(mapEngineError);
  sendCreated(res, { releaseRunId: result.approvableId, state: result.macroState });
}));



async function requireOrgAdmin(organizationId: string, auth: NonNullable<import('express').Request['auth']>) {
  await assertOrganizationAccess(organizationId, auth);
  const { getOrganizationMembership, isAdminRole } = await import('../auth/organization-access.js');
  const m = await getOrganizationMembership(auth.userId, organizationId);
  if (!isAdminRole(m?.role)) throw forbidden('Only admins can manage roles.');
}

function describePredicate(p: any): string {
  switch (p?.op) {
    case 'amount_gte': return `the amount is $${(Number(p.value.minorUnits) / 100).toLocaleString()} or more`;
    case 'amount_lt': return `the amount is under $${(Number(p.value.minorUnits) / 100).toLocaleString()}`;
    case 'po_matched_within_tolerance': return 'the bill matches its purchase order';
    case 'vendor_is_first_invoice': return 'this is the first bill from the vendor';
    case 'and': return p.all.map(describePredicate).join(' and ');
    case 'or': return p.any.map(describePredicate).join(' or ');
    case 'not': return `not (${describePredicate(p.p)})`;
    default: return 'a condition applies';
  }
}

// --- Protections (SoD rules as product surface) --------------------------------

approvalsRouter.get('/organizations/:organizationId/protections', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { listProtections } = await import('./protections.js');
  const { ensureEngineSetup } = await import('./wiring.js');
  await ensureEngineSetup(organizationId);
  const people = await prisma.$queryRaw<{ id: string; name: string; email: string }[]>`
    SELECT id, name, email FROM approval.people
    WHERE organization_id = ${organizationId}::uuid AND status = 'active' ORDER BY name`;
  const me = await prisma.$queryRaw<{ has_password: boolean }[]>`
    SELECT password_hash IS NOT NULL AS has_password FROM users WHERE user_id = ${req.auth!.userId}::uuid`;
  sendJson(res, { protections: await listProtections(organizationId), people, requiresPassword: me[0]?.has_password ?? false });
}));

const relaxSchema = z.object({
  password: z.string().optional(),          // fresh re-auth: the identity ceremony
  sheetContent: z.unknown(),                // exactly what was rendered to the owner
  reviewAtHeadcount: z.number().int().min(2).max(50).optional(),
  scopedPersonIds: z.array(z.string().uuid()).max(50).nullish(), // null/absent = everyone
});

// --- Policies page (P1) — the single home: R-pack + gates + ceiling -----------
// GET aggregates everything the page renders; the gates are always-on, so
// their cards carry live counts rather than switches.
approvalsRouter.get('/organizations/:organizationId/policies', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  await assertOrganizationAccess(organizationId, req.auth!);
  const { listProtections } = await import('./protections.js');
  const { getBillCeilingMinor } = await import('./store.js');
  const [protections, ceilingMinor, payableCounts, duplicateOverrides] = await Promise.all([
    listProtections(organizationId),
    getBillCeilingMinor(prisma, organizationId),
    prisma.$queryRaw<{ status: string; count: bigint }[]>`
      SELECT metadata_json->'payableHold'->>'status' AS status, COUNT(*)::bigint AS count
      FROM counterparties
      WHERE organization_id = ${organizationId}::uuid AND metadata_json ? 'payableHold'
      GROUP BY 1`,
    prisma.paymentOrderEvent.count({
      where: {
        organizationId,
        eventType: 'policy_overridden',
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
    }),
  ]);
  const held = Number(payableCounts.find((r) => r.status === 'held')?.count ?? 0n);
  const blocked = Number(payableCounts.find((r) => r.status === 'blocked')?.count ?? 0n);
  sendJson(res, {
    protections,
    ceilingUsd: ceilingMinor === null ? null : Number(ceilingMinor) / 1_000_000,
    gates: {
      duplicate: { overridesLast30Days: duplicateOverrides },
      payable: { held, blocked },
      pinnedDestination: {},
    },
  });
}));

const ceilingSchema = z.object({ amountUsd: z.number().positive().max(1_000_000_000).nullable() });

approvalsRouter.put('/organizations/:organizationId/policies/ceiling', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  const access = await assertOrganizationAccess(organizationId, req.auth!);
  const { isOwnerRole } = await import('../auth/organization-access.js');
  if (!isOwnerRole(access.membership.role)) throw forbidden('Only the primary admin can change the bill ceiling.');
  const input = ceilingSchema.parse(req.body);
  const { setBillCeilingMinor } = await import('./store.js');
  const minor = input.amountUsd === null ? null : BigInt(Math.round(input.amountUsd * 1_000_000));
  await prisma.$transaction((tx) => setBillCeilingMinor(tx, organizationId, minor));
  sendJson(res, { ok: true, ceilingUsd: input.amountUsd });
}));

approvalsRouter.post('/organizations/:organizationId/protections/:code/relax', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  const { code } = z.object({ code: z.enum(['R1', 'R2', 'R5']) }).parse(req.params); // R7 not even routable
  const access = await assertOrganizationAccess(organizationId, req.auth!);
  const { isOwnerRole } = await import('../auth/organization-access.js');
  if (!isOwnerRole(access.membership.role)) throw forbidden('Only the primary admin can relax a protection');

  const input = relaxSchema.parse(req.body);
  // Fresh re-authentication — a real identity ceremony, not a checkbox.
  const user = await prisma.$queryRaw<{ password_hash: string | null }[]>`
    SELECT password_hash FROM users WHERE user_id = ${req.auth!.userId}::uuid`;
  if (user[0]?.password_hash) {
    const { verifyPassword } = await import('../auth/passwords.js');
    if (!input.password || !(await verifyPassword(input.password, user[0].password_hash))) {
      throw forbidden('Please confirm your password to relax a protection');
    }
  } // passwordless (Google-only) accounts: session suffices; the event records the method

  const { relaxProtection } = await import('./protections.js');
  const { ensurePersonForUser } = await import('./wiring.js');
  const personId = await prisma.$transaction((tx) => ensurePersonForUser(tx, organizationId, req.auth!.userId));
  const result = await relaxProtection({
    organizationId, code, acknowledgedByPersonId: personId,
    sheetContent: { ...(input.sheetContent as object ?? {}), reauthMethod: user[0]?.password_hash ? 'password' : 'session' },
    reviewAtHeadcount: input.reviewAtHeadcount,
    scopedPersonIds: input.scopedPersonIds ?? null,
  });
  sendJson(res, result);
}));

approvalsRouter.post('/organizations/:organizationId/protections/:code/retighten', asyncRoute(async (req, res) => {
  const { organizationId } = orgParams.parse(req.params);
  const { code } = z.object({ code: z.enum(['R1', 'R2', 'R5']) }).parse(req.params);
  const access = await assertOrganizationAccess(organizationId, req.auth!);
  const { isOwnerRole } = await import('../auth/organization-access.js');
  if (!isOwnerRole(access.membership.role)) throw forbidden('Only the primary admin can change protections');
  const { revokeRelaxation } = await import('./protections.js');
  const { ensurePersonForUser } = await import('./wiring.js');
  const personId = await prisma.$transaction((tx) => ensurePersonForUser(tx, organizationId, req.auth!.userId));
  sendJson(res, await revokeRelaxation({ organizationId, code, revokedByPersonId: personId }));
}));
