// The quick pass: the drafts the companion rates ready, in the order to work
// them — soonest due first, then oldest.
//
// One by one, never all at once (Zaid, 2026-09-24): the person looks at each
// bill and sends it with one key, and the server re-checks it at the click
// (confirm-as-read). Only for someone whose job is sending bills on.
import { getOrgAccess } from '../approvals/permissions.js';
import { getBillsWorkbench } from '../payments/bills.js';

export async function getReadyBills(organizationId: string, viewerUserId: string) {
  const access = await getOrgAccess(organizationId, viewerUserId);
  const canEdit = (access?.isPrimaryOrAdmin ?? false) || (access?.capabilities.includes('bills.edit') ?? false);
  if (!canEdit) return { bills: [] };
  const board = await getBillsWorkbench(organizationId, viewerUserId);
  const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : Number.POSITIVE_INFINITY);
  const ready = board.bills
    .filter((b) => b.state === 'draft' && b.companion?.ready)
    .sort((a, b) => time(a.dueAt) - time(b.dueAt) || time(a.createdAt) - time(b.createdAt));
  return {
    bills: ready.map((b) => ({
      billId: b.paymentOrderId,
      vendorName: b.vendorName,
      invoiceNumber: b.invoiceNumber,
      amountUsd: b.amountUsd,
      dueAt: b.dueAt ? new Date(b.dueAt).toISOString() : null,
    })),
  };
}
