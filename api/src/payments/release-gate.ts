// Release gate (policy P0 — fail closed on irreversible money).
// A bill that went through the approval engine may only be RELEASED once its
// invoice approvable is approved. The workbench bucket fix alone isn't enough
// (BUG-approval-not-enforced-failopen §3): the proposal/release ceremony has
// to refuse too, or an API caller can pay a pending bill directly.
// Orders with no engine approvable (direct API/CSV/agent-created drafts) pass:
// those paths carry their own controls (spending limits, multisig quorum).
import { prisma } from '../infra/prisma.js';
import { badRequest } from '../infra/api-errors.js';
import { getBillCeilingMinor } from '../approvals/store.js';

/**
 * Vendor payable status, re-checked at the last server choke point before
 * money moves. Standalone (no approval-engine involvement required): a held
 * or blocked vendor binds direct/API/agent orders exactly the same.
 */
export async function assertVendorPayableForRelease(organizationId: string, paymentOrderId: string) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    select: { counterparty: { select: { displayName: true, metadataJson: true } } },
  });
  if (!order?.counterparty) return;
  const { readPayableHold, describePayableHold } = await import('./vendor-payable.js');
  const hold = readPayableHold(order.counterparty.metadataJson);
  if (hold) {
    throw badRequest(describePayableHold(order.counterparty.displayName, hold), { paymentOrderId, rule: 'vendor_payable' });
  }
}

export async function assertBillApprovedForRelease(organizationId: string, paymentOrderId: string) {
  // Vendor payable first: it applies to EVERY order, including direct/agent
  // ones with no engine approvable (which return early below).
  await assertVendorPayableForRelease(organizationId, paymentOrderId);

  // A bill can have several approvables across its life (a sent-back bill is
  // re-confirmed as a fresh one, the old one cancelled). The gate passes when
  // ANY of them is approved; cancelled husks alone don't block, and a live
  // pending/rejected one with no approval does.
  const rows = await prisma.$queryRaw<{ macro_state: string; attributes: Record<string, unknown> }[]>`
    SELECT macro_state, attributes FROM approval.approvables
    WHERE organization_id = ${organizationId}::uuid
      AND type = 'invoice'
      AND attributes->>'paymentOrderId' = ${paymentOrderId}`;
  if (rows.length === 0) return; // no engine involvement (direct/agent order)
  const approvedRow = rows.find((r) => r.macro_state === 'approved' || r.macro_state === 'auto_approved');
  if (!approvedRow) {
    const live = rows.map((r) => r.macro_state).find((s) => s !== 'cancelled') ?? rows[0]!.macro_state;
    throw badRequest(
      `This bill hasn't finished approval (${live.replace(/_/g, ' ')}) — approval always comes before payment.`,
      { paymentOrderId, approvalState: live },
    );
  }

  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    select: { amountRaw: true, counterpartyWalletId: true, counterpartyWallet: { select: { walletAddress: true } } },
  });
  if (!order) return;

  // Org ceiling, re-checked at release: a ceiling lowered after approval
  // still binds — the ceiling is the org's standing rule, not a snapshot.
  const ceilingMinor = await getBillCeilingMinor(prisma, organizationId);
  if (ceilingMinor !== null && order.amountRaw > ceilingMinor) {
    throw badRequest(
      "This bill is over the organization's bill ceiling — the primary admin can raise it on the Policies page.",
      { paymentOrderId, rule: 'bill_ceiling', ceilingMinor: ceilingMinor.toString() },
    );
  }

  // Pinned payout destination (policy P0): the approvers authorized paying a
  // SPECIFIC destination. If the order's rail changed after approval — even
  // legitimately — the release refuses until the bill is re-approved. Older
  // approvables without a pin (pre-feature) pass unchecked.
  const pin = readPin(approvedRow.attributes);
  if (!pin) return;
  if (order.counterpartyWalletId !== pin.counterpartyWalletId || order.counterpartyWallet.walletAddress !== pin.walletAddress) {
    throw badRequest(
      'The payout destination changed after this bill was approved — the approvers authorized a different address. Send the bill back through approval before paying it.',
      { paymentOrderId, rule: 'pinned_destination', approvedWalletAddress: pin.walletAddress, currentWalletAddress: order.counterpartyWallet.walletAddress },
    );
  }
}

function readPin(attributes: unknown): { counterpartyWalletId: string; walletAddress: string } | null {
  if (!attributes || typeof attributes !== 'object') return null;
  const pin = (attributes as Record<string, unknown>).approvedDestination;
  if (!pin || typeof pin !== 'object') return null;
  const r = pin as Record<string, unknown>;
  if (typeof r.counterpartyWalletId !== 'string' || typeof r.walletAddress !== 'string') return null;
  return { counterpartyWalletId: r.counterpartyWalletId, walletAddress: r.walletAddress };
}
