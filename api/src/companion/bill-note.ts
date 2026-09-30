// The companion's note on one bill, for the bill's own screen.
//
// Everything here already exists elsewhere — the steps it took reading the
// document, its ready-or-not verdict, what the viewer's Inbox wants of them on
// this bill, the vendor's category habit. This gathers them for one bill so
// the screen can say, in one place: what I did, what I need from you, and
// where the bill stands. Read-only, and only for a bill the viewer can see.
import { prisma } from '../infra/prisma.js';
import { notFound } from '../infra/api-errors.js';
import { involvedBillIds } from '../payments/bill-visibility.js';
import { getBillsWorkbench } from '../payments/bills.js';
import { getInbox } from './inbox.js';
import { latestBillChat } from './chat.js';

export async function getBillNote(organizationId: string, viewerUserId: string, paymentOrderId: string) {
  const visible = await involvedBillIds(organizationId, viewerUserId);
  if (visible !== null && !visible.has(paymentOrderId)) throw notFound('No such bill.');
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    select: { invoiceDocumentId: true, counterpartyId: true },
  });
  if (!order) throw notFound('No such bill.');

  const [board, inbox, rule, steps, chatId] = await Promise.all([
    getBillsWorkbench(organizationId, viewerUserId),
    // Read-only: opening a bill must not tidy the person's inbox.
    getInbox(organizationId, viewerUserId, { settle: false }),
    order.counterpartyId
      ? prisma.vendorCodingRule.findFirst({ where: { organizationId, counterpartyId: order.counterpartyId } })
      : null,
    // The document's steps, and this bill's: a document can hold several
    // bills, and steps before the bill existed belong to all of them.
    order.invoiceDocumentId
      ? prisma.companionStep.findMany({
        where: { organizationId, invoiceDocumentId: order.invoiceDocumentId, OR: [{ paymentOrderId }, { paymentOrderId: null }] },
        orderBy: { startedAt: 'asc' },
        select: { stepId: true, status: true, text: true, detail: true },
      })
      : [],
    latestBillChat(organizationId, viewerUserId, paymentOrderId),
  ]);
  const row = board.bills.find((b) => b.paymentOrderId === paymentOrderId);
  // The verdict already says whether the bill needs a check or a sign-off;
  // repeating the inbox's "review" line under it would say it twice.
  const waiting = (inbox.items.find((i) => i.billId === paymentOrderId)?.lines ?? [])
    .filter((l) => l.kind !== 'review' && l.kind !== 'sign_off');

  return {
    /** Draft only: ready to send as read, or the one reason it needs a person. */
    verdict: row?.companion ?? null,
    standing: row?.subStatus.text ?? null,
    waiting: waiting.map((l) => ({ kind: l.kind, text: l.text, from: l.from ?? null })),
    did: steps.map((s) => ({ id: s.stepId, status: s.status, text: s.text, detail: s.detail })),
    // A vendor default a person set: the last resort for a line. Where each
    // line's category came from is on the draft's own lines (categoryFrom).
    vendorDefault: rule ? { category: rule.accountName ?? rule.accountId } : null,
    chatId,
  };
}
