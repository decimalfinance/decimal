// The bridge that closes the payment loop (pipeline v2, target-architecture.md):
//   invoice approvable APPROVED  -> clear the order's review + spawn the release run
//   payment_run APPROVED         -> hand off to the existing execution path
//                                   (spending-limit lane or Squads proposal)
//   invoice REJECTED             -> send the bill BACK TO REVIEW with the reason
//                                   (flow-research: a terminal reject is the
//                                   industry's worst anti-pattern — the reviewer
//                                   fixes and re-confirms, which submits fresh)
// Registered once at app boot. Handlers are post-commit and best-effort by contract.
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';
import { registerApprovalHook } from '../approvals/hooks.js';
import { spawnReleaseRun } from '../approvals/lifecycle.js';
import { tryAdvancePaymentOrderWithAgent } from '../agents/payment-automation.js';
import { cancelPaymentOrder, clearPaymentOrderReview } from './orders.js';

// The most recent reject command's reason + who said it, for the send-back note.
async function latestRejection(approvableId: string): Promise<{ reason: string | null; byName: string | null }> {
  const rows = await prisma.$queryRaw<{ reason: string | null; name: string | null }[]>`
    SELECT e.payload->'command'->>'reason' AS reason, p.name
    FROM approval.approval_events e
    LEFT JOIN approval.people p ON p.id = e.actor_id
    WHERE e.approvable_id = ${approvableId}::uuid
      AND e.payload->>'kind' = 'command' AND e.payload->'command'->>'kind' = 'reject'
    ORDER BY e.seq DESC LIMIT 1`;
  return { reason: rows[0]?.reason ?? null, byName: rows[0]?.name ?? null };
}

function orderIdOf(attributes: Record<string, unknown>): string | null {
  const v = attributes?.paymentOrderId;
  return typeof v === 'string' ? v : null;
}

export function registerPaymentApprovalBridge(): void {
  registerApprovalHook(async (approvable, transition) => {
    if (approvable.type === 'invoice') {
      const paymentOrderId = orderIdOf(approvable.attributes);
      if (!paymentOrderId) return;

      if (transition === 'approved' || transition === 'auto_approved') {
        const order = await prisma.paymentOrder.findFirst({
          where: { organizationId: approvable.organization_id, paymentOrderId },
          select: { state: true },
        });
        if (order?.state === 'needs_review') {
          await clearPaymentOrderReview({
            organizationId: approvable.organization_id,
            paymentOrderId,
            actorUserId: null,
            actorType: 'system',
            reviewNote: 'Cleared by approval engine: bill approved',
          });
        }
        // Approved ≠ paid: the release ceremony is its own consent (H rows).
        const existing = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM approval.approvables
          WHERE type = 'payment_run' AND attributes->>'sourceApprovableId' = ${approvable.id}
            AND macro_state IN ('pending_approval', 'approved', 'auto_approved')
          LIMIT 1`;
        if (existing.length > 0) return;
        const release = await spawnReleaseRun(approvable.id);
        logger.info('approval_bridge.release_spawned', {
          sourceApprovableId: approvable.id, releaseRunId: release.approvableId, paymentOrderId,
        });
      } else if (transition === 'rejected') {
        // Send back for changes: the bill returns to the Review stage carrying
        // the approver's reason. Re-confirming submits a FRESH approval run
        // (fresh consents). Only possible while no money has moved; otherwise
        // fall back to cancelling.
        const order = await prisma.paymentOrder.findFirst({
          where: { organizationId: approvable.organization_id, paymentOrderId },
          select: { state: true, metadataJson: true, transferRequests: { select: { transferRequestId: true }, take: 1 } },
        });
        if (order && order.state === 'draft' && order.transferRequests.length === 0) {
          const { reason, byName } = await latestRejection(approvable.id);
          const metadata = order.metadataJson && typeof order.metadataJson === 'object' && !Array.isArray(order.metadataJson)
            ? (order.metadataJson as Record<string, unknown>) : {};
          const sentBackAt = new Date().toISOString();
          await prisma.$transaction([
            prisma.paymentOrder.update({
              where: { paymentOrderId },
              data: {
                state: 'needs_review',
                metadataJson: { ...metadata, sentBack: { reason, byName, at: sentBackAt, approvableId: approvable.id } },
              },
            }),
            prisma.paymentOrderEvent.create({
              data: {
                organizationId: approvable.organization_id,
                paymentOrderId,
                eventType: 'payment_order_sent_back',
                actorType: 'system',
                beforeState: 'draft',
                afterState: 'needs_review',
                payloadJson: { reason, byName, approvableId: approvable.id },
              },
            }),
          ]);
          logger.info('approval_bridge.sent_back_to_review', {
            sourceApprovableId: approvable.id, paymentOrderId, byName,
          });
        } else {
          await cancelPaymentOrder({
            organizationId: approvable.organization_id,
            paymentOrderId,
            actorUserId: null,
            actorType: 'system',
          });
        }
      } else if (transition === 'cancelled') {
        // Recall: the submitter pulled the bill out of approval — it goes back
        // to their review queue (only while nothing has moved money yet).
        const order = await prisma.paymentOrder.findFirst({
          where: { organizationId: approvable.organization_id, paymentOrderId },
          select: { state: true, transferRequests: { select: { transferRequestId: true }, take: 1 } },
        });
        if (order && order.state === 'draft' && order.transferRequests.length === 0) {
          await prisma.$transaction([
            prisma.paymentOrder.update({
              where: { paymentOrderId },
              data: { state: 'needs_review' },
            }),
            prisma.paymentOrderEvent.create({
              data: {
                organizationId: approvable.organization_id,
                paymentOrderId,
                eventType: 'payment_order_review_reopened',
                actorType: 'system',
                beforeState: 'draft',
                afterState: 'needs_review',
                payloadJson: { reason: 'recalled_from_approval', approvableId: approvable.id },
              },
            }),
          ]);
          logger.info('approval_bridge.recalled_to_review', {
            sourceApprovableId: approvable.id, paymentOrderId,
          });
        }
      }
      return;
    }

    if (approvable.type === 'payment_run' && (transition === 'approved' || transition === 'auto_approved')) {
      const sourceId = approvable.attributes?.sourceApprovableId;
      if (typeof sourceId !== 'string') return;
      const source = await prisma.$queryRaw<{ attributes: Record<string, unknown> }[]>`
        SELECT attributes FROM approval.approvables WHERE id = ${sourceId}::uuid`;
      const paymentOrderId = source[0] ? orderIdOf(source[0].attributes) : null;
      if (!paymentOrderId) return;
      // Duplicate gate, second pass (policy P0): a twin bill may have been
      // confirmed or PAID while this one sat in approval. Settlement is
      // irreversible — hold the release and record why; after an admin clears
      // the flag, a payer retries via the advance endpoint.
      const { findDuplicateBills, readDuplicateOverride, describeDuplicate } = await import('./duplicate-check.js');
      const releaseOrder = await prisma.paymentOrder.findFirst({
        where: { organizationId: approvable.organization_id, paymentOrderId },
        select: { counterpartyId: true, counterpartyWalletId: true, invoiceNumber: true, externalReference: true, amountRaw: true, createdAt: true, state: true, metadataJson: true },
      });
      if (releaseOrder && !readDuplicateOverride(releaseOrder.metadataJson)) {
        const dupes = await findDuplicateBills(approvable.organization_id, {
          excludePaymentOrderId: paymentOrderId,
          counterpartyId: releaseOrder.counterpartyId,
          counterpartyWalletId: releaseOrder.counterpartyWalletId,
          invoiceNumber: releaseOrder.invoiceNumber,
          externalReference: releaseOrder.externalReference,
          amountRaw: releaseOrder.amountRaw,
          createdAt: releaseOrder.createdAt,
        });
        if (dupes.length > 0) {
          await prisma.paymentOrderEvent.create({
            data: {
              organizationId: approvable.organization_id,
              paymentOrderId,
              eventType: 'payment_release_held_duplicate',
              actorType: 'system',
              beforeState: releaseOrder.state,
              afterState: releaseOrder.state,
              payloadJson: { matches: dupes.map((d) => ({ paymentOrderId: d.paymentOrderId, matchKind: d.matchKind })), message: describeDuplicate(dupes[0]!) },
            },
          });
          logger.warn('approval_bridge.release_held_duplicate', {
            releaseRunId: approvable.id, paymentOrderId, matches: dupes.length,
          });
          return;
        }
      }
      const result = await tryAdvancePaymentOrderWithAgent({
        organizationId: approvable.organization_id,
        paymentOrderId,
        actorUserId: null,
      });
      logger.info('approval_bridge.release_executed', {
        releaseRunId: approvable.id, paymentOrderId, status: result?.status ?? null,
      });
    }
  });
}
