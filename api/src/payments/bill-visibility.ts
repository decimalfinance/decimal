// Which bills a person is allowed to open.
//
// Until now there was one answer for everybody: every bill in the workspace.
// `bills.view` is a feature-surface capability — it says you get a Bills screen,
// not which bills belong on it — so an approver brought in to sign off on one
// invoice could read every invoice the company had, and the owner of the
// workspace could edit any of them mid-approval.
//
// The scoped answer is deliberately narrow, and it is about INVOLVEMENT rather
// than assignment. "Routed to me right now" would be too tight in a way that
// breaks real work: an approver who already signed must still be able to open
// the bill they signed, someone who asked a question about a bill needs to see
// the answer, and the person who submitted it needs to watch it move. All of
// those are the same bill, and none of them is an open task.
//
// Everyone else — reviewers, payers, accountants, auditors, admins — keeps the
// whole queue, because their jobs are defined by having it.
import { prisma } from '../infra/prisma.js';
import { notFound } from '../infra/api-errors.js';
import { getOrgAccess } from '../approvals/permissions.js';

/**
 * The bills this person is involved in. Returns null when they are entitled to
 * all of them, which callers read as "no filter" — distinct from an empty set,
 * which means "involved in nothing" and must show an empty list rather than
 * everything.
 */
export async function involvedBillIds(organizationId: string, userId: string): Promise<Set<string> | null> {
  const access = await getOrgAccess(organizationId, userId);
  if (!access) return new Set();
  if (access.billScope === 'all') return null;

  // Three ways to be involved, in one pass: on the chain (any task, in any
  // state, on any plan — a superseded plan still means you were part of this
  // bill's history), or the person who submitted or entered it.
  const routed = await prisma.$queryRaw<{ payment_order_id: string | null }[]>`
    SELECT DISTINCT a.attributes->>'paymentOrderId' AS payment_order_id
    FROM approval.approvables a
    JOIN approval.people me
      ON me.organization_id = a.organization_id AND me.user_id = ${userId}::uuid
    LEFT JOIN approval.approval_plans p ON p.approvable_id = a.id
    LEFT JOIN approval.tasks t ON t.plan_id = p.id AND t.person_id = me.id
    WHERE a.organization_id = ${organizationId}::uuid
      AND a.type = 'invoice'
      AND (t.id IS NOT NULL OR a.requester_id = me.id OR a.enterer_id = me.id)`;

  // …and the fourth: a question was put to you about it, or you put one to
  // someone else. Being asked about a bill you cannot open is not a question,
  // it is a riddle.
  const asked = await prisma.billQuestion.findMany({
    where: {
      organizationId,
      OR: [{ askedOfUserId: userId }, { askedByUserId: userId }],
    },
    select: { paymentOrderId: true },
    distinct: ['paymentOrderId'],
  });

  const ids = new Set<string>();
  for (const row of routed) if (row.payment_order_id) ids.add(row.payment_order_id);
  for (const row of asked) ids.add(row.paymentOrderId);
  return ids;
}

/**
 * Refuse a bill this person has no business opening — as a 404, not a 403.
 *
 * A 403 confirms the bill exists, which for an approver scoped away from the
 * rest of the queue leaks exactly what the scoping is there to withhold: how
 * many bills there are, and that this id is one of them. They cannot see it, so
 * as far as they are concerned it is not there.
 */
export async function assertBillVisible(organizationId: string, userId: string, paymentOrderId: string): Promise<void> {
  const visible = await involvedBillIds(organizationId, userId);
  if (visible === null || visible.has(paymentOrderId)) return;
  throw notFound('Bill not found');
}
