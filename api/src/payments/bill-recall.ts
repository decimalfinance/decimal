/**
 * The product's side of the recall ceremony.
 *
 * The engine speaks in approvables and people; the screens speak in payment
 * orders and users. This is the translation, and nothing more — the rules all
 * live in `approvals/recall.ts`, where they can be tested without a web server.
 */
import { prisma } from '../infra/prisma.js';
import { forbidden, notFound } from '../infra/api-errors.js';
import {
  requestRecall, decideRecall, withdrawRecall, canDecideRecall,
  openRecallRequest, recallHistory, pendingRecallRequests,
  type RecallRequestRow,
} from '../approvals/recall.js';

export interface BillRecallView {
  recallRequestId: string;
  reason: string;
  state: 'pending' | 'granted' | 'denied' | 'withdrawn';
  requestedBy: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** True when the person who asked also decided — visible, never disguised. */
  selfDecided: boolean;
}

function toView(row: RecallRequestRow): BillRecallView {
  return {
    recallRequestId: row.id,
    reason: row.reason,
    state: row.state,
    requestedBy: row.requested_by_name,
    requestedAt: row.created_at.toISOString(),
    decidedBy: row.decided_by_name,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    decisionNote: row.decision_note,
    selfDecided: Boolean(row.decided_by) && row.decided_by === row.requested_by,
  };
}

/** The live invoice approvable behind a payment order. */
async function approvableForOrder(organizationId: string, paymentOrderId: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM approval.approvables
    WHERE organization_id = ${organizationId}::uuid
      AND type = 'invoice'
      AND macro_state NOT IN ('rejected', 'cancelled')
      AND attributes->>'paymentOrderId' = ${paymentOrderId}
    ORDER BY id LIMIT 1`;
  if (rows.length === 0) throw notFound('This bill is not in approval.');
  return rows[0]!.id;
}

async function personFor(organizationId: string, userId: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM approval.people
    WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`;
  if (rows.length === 0) throw forbidden('You have no identity in this organization.');
  return rows[0]!.id;
}

export async function requestBillRecall(input: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  reason: string;
}): Promise<BillRecallView & { granted: boolean }> {
  const approvableId = await approvableForOrder(input.organizationId, input.paymentOrderId);
  const actorId = await personFor(input.organizationId, input.actorUserId);
  const { requestId } = await requestRecall({ approvableId, actorId, reason: input.reason });

  // An admin asking themselves is not a review.
  //
  // Recall is a request because it throws away approvals real people gave, and
  // somebody should own that. But only an admin can grant one — so when the
  // asker IS an admin, the ceremony asks them to rubber-stamp their own
  // decision. Zara raised a request and immediately granted it, which is not a
  // safeguard, it is a form to fill in. Worse, the record then shows two
  // decisions where one was made.
  //
  // The reason is still captured, the freeze still happens, the grant still
  // runs through decideRecall — nothing is skipped except the interval in which
  // the same person waits for themselves.
  if (await canDecideRecall(input.organizationId, actorId)) {
    await decideRecall({ requestId, actorId, grant: true, note: 'Recalled directly — the asker is an admin.' });
    const [decided] = await recallHistory(approvableId);
    return { ...toView(decided!), granted: true };
  }

  const open = await openRecallRequest(approvableId);
  return { ...toView(open!), granted: false };
}

export async function decideBillRecall(input: {
  organizationId: string;
  recallRequestId: string;
  actorUserId: string;
  grant: boolean;
  note?: string;
}): Promise<{ state: 'granted' | 'denied'; paymentOrderId: string | null }> {
  const actorId = await personFor(input.organizationId, input.actorUserId);
  const result = await decideRecall({
    requestId: input.recallRequestId, actorId, grant: input.grant, note: input.note,
  });
  return { state: result.state, paymentOrderId: await orderForRequest(input.recallRequestId) };
}

export async function withdrawBillRecall(input: {
  organizationId: string;
  recallRequestId: string;
  actorUserId: string;
}): Promise<{ paymentOrderId: string | null }> {
  const actorId = await personFor(input.organizationId, input.actorUserId);
  await withdrawRecall({ requestId: input.recallRequestId, actorId });
  return { paymentOrderId: await orderForRequest(input.recallRequestId) };
}

async function orderForRequest(recallRequestId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ payment_order_id: string | null }[]>`
    SELECT a.attributes->>'paymentOrderId' AS payment_order_id
    FROM approval.recall_requests r
    JOIN approval.approvables a ON a.id = r.approvable_id
    WHERE r.id = ${recallRequestId}::uuid`;
  return rows[0]?.payment_order_id ?? null;
}

/** For the bill screen: the open request, plus everything asked before it. */
export async function billRecallState(organizationId: string, paymentOrderId: string): Promise<{
  open: BillRecallView | null;
  history: BillRecallView[];
}> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM approval.approvables
    WHERE organization_id = ${organizationId}::uuid
      AND type = 'invoice'
      AND attributes->>'paymentOrderId' = ${paymentOrderId}
    ORDER BY id LIMIT 1`;
  if (rows.length === 0) return { open: null, history: [] };
  const approvableId = rows[0]!.id;
  const [open, history] = await Promise.all([
    openRecallRequest(approvableId),
    recallHistory(approvableId),
  ]);
  return {
    open: open ? toView(open) : null,
    history: history.filter((h) => h.state !== 'pending').map(toView),
  };
}

/** The admin's queue — what is frozen and waiting on a decision. */
export async function pendingBillRecalls(organizationId: string): Promise<Array<BillRecallView & {
  paymentOrderId: string | null;
  vendorName: string | null;
  amountMinor: string;
}>> {
  const rows = await pendingRecallRequests(organizationId);
  if (rows.length === 0) return [];
  const meta = await prisma.$queryRaw<{
    id: string; payment_order_id: string | null; total_minor_base: bigint; vendor_name: string | null;
  }[]>`
    SELECT r.id::text, a.attributes->>'paymentOrderId' AS payment_order_id,
           a.total_minor_base, c.display_name AS vendor_name
    FROM approval.recall_requests r
    JOIN approval.approvables a ON a.id = r.approvable_id
    LEFT JOIN counterparties c ON c.counterparty_id = a.vendor_id
    WHERE r.organization_id = ${organizationId}::uuid AND r.state = 'pending'`;
  const byId = new Map(meta.map((m) => [m.id, m]));
  return rows.map((r) => {
    const m = byId.get(r.id);
    return {
      ...toView(r),
      paymentOrderId: m?.payment_order_id ?? null,
      vendorName: m?.vendor_name ?? null,
      amountMinor: (m?.total_minor_base ?? 0n).toString(),
    };
  });
}
