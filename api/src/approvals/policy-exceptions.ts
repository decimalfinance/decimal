// Bills that went through with a policy set aside, for Organisation's
// Exceptions. Two kinds:
//
//   self_approval  approved by whoever sent it for approval. That only happens
//                  while No self-approval is off for them, so the approval
//                  itself is the record, however it came to be off.
//   over_ceiling   allowed past the bill ceiling by the primary admin, then
//                  approved. Only while the grant still covers the bill: an
//                  edited amount voids it, and the bill is blocked again.
//
// Only bills approved now, in the plan that stands, approved in the last 90
// days: the newest 100. A bill that is both is a row of each kind.
import { prisma } from '../infra/prisma.js';
import { activeCeilingException } from '../payments/ceiling-exception.js';

export type PolicyException = {
  kind: 'self_approval' | 'over_ceiling';
  paymentOrderId: string;
  vendorName: string;
  invoiceNumber: string | null;
  /** Minor units (dollars x 10^6), as a decimal string. */
  amountRaw: string;
  approvedBy: { personId: string; name: string; avatarUrl: string | null };
  /** For over_ceiling: who allowed it past the ceiling. */
  allowedByName: string | null;
  approvedAt: string;
};

const LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Found = { paymentOrderId: string; personId: string; at: Date; kind: PolicyException['kind']; allowedByName: string | null };

export async function listPolicyExceptions(organizationId: string): Promise<PolicyException[]> {
  const selfApproved = await prisma.$queryRaw<{ payment_order_id: string | null; person_id: string; at: Date }[]>`
    SELECT DISTINCT ON (a.id) a.attributes->>'paymentOrderId' AS payment_order_id, e.actor_id::text AS person_id, e.at
    FROM approval.approval_events e
    JOIN approval.approvables a ON a.id = e.approvable_id
    JOIN approval.approval_plans p ON p.id = e.plan_id AND p.superseded_by IS NULL
    WHERE e.organization_id = ${organizationId}::uuid
      AND a.organization_id = ${organizationId}::uuid
      AND a.type = 'invoice' AND a.macro_state = 'approved'
      AND e.payload->>'kind' = 'command' AND e.payload->'command'->>'kind' = 'approve'
      AND e.actor_id = a.requester_id
      AND e.at > now() - interval '90 days'
    ORDER BY a.id, e.seq DESC`;

  const allowed = await prisma.$queryRaw<{ payment_order_id: string; amount_raw: bigint; metadata_json: unknown; person_id: string; at: Date }[]>`
    SELECT DISTINCT ON (po.payment_order_id) po.payment_order_id::text AS payment_order_id, po.amount_raw, po.metadata_json,
           last.actor_id::text AS person_id, last.at
    FROM payment_orders po
    JOIN approval.approvables a
      ON a.organization_id = po.organization_id AND a.type = 'invoice' AND a.macro_state = 'approved'
     AND a.attributes->>'paymentOrderId' = po.payment_order_id::text
    JOIN LATERAL (
      SELECT e.actor_id, e.at FROM approval.approval_events e
      JOIN approval.approval_plans p ON p.id = e.plan_id AND p.superseded_by IS NULL
      WHERE e.approvable_id = a.id
        AND e.payload->>'kind' = 'command' AND e.payload->'command'->>'kind' = 'approve'
      ORDER BY e.seq DESC LIMIT 1
    ) last ON true
    WHERE po.organization_id = ${organizationId}::uuid
      AND po.metadata_json ? 'ceilingException'
      AND last.actor_id IS NOT NULL
      AND last.at > now() - interval '90 days'
    ORDER BY po.payment_order_id, last.at DESC`;

  const found: Found[] = [
    ...selfApproved
      .filter((r) => r.payment_order_id && UUID.test(r.payment_order_id))
      .map((r) => ({ paymentOrderId: r.payment_order_id!, personId: r.person_id, at: r.at, kind: 'self_approval' as const, allowedByName: null })),
    ...allowed.flatMap((r) => {
      const grant = activeCeilingException(r.metadata_json, r.amount_raw);
      return grant ? [{ paymentOrderId: r.payment_order_id, personId: r.person_id, at: r.at, kind: 'over_ceiling' as const, allowedByName: grant.byName }] : [];
    }),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, LIMIT);
  if (found.length === 0) return [];

  const billIds = [...new Set(found.map((f) => f.paymentOrderId))];
  const personIds = [...new Set(found.map((f) => f.personId))];
  const [bills, people] = await Promise.all([
    prisma.paymentOrder.findMany({
      where: { organizationId, paymentOrderId: { in: billIds } },
      select: {
        paymentOrderId: true,
        invoiceNumber: true,
        amountRaw: true,
        counterparty: { select: { displayName: true } },
        counterpartyWallet: { select: { label: true } },
      },
    }),
    prisma.$queryRaw<{ id: string; name: string; avatar_url: string | null }[]>`
      SELECT p.id::text AS id, p.name, u.avatar_url
      FROM approval.people p LEFT JOIN users u ON u.user_id = p.user_id
      WHERE p.organization_id = ${organizationId}::uuid AND p.id = ANY(${personIds}::uuid[])`,
  ]);
  const billOf = new Map(bills.map((b) => [b.paymentOrderId, b]));
  const personOf = new Map(people.map((p) => [p.id, p]));

  return found.flatMap((f) => {
    const bill = billOf.get(f.paymentOrderId);
    const person = personOf.get(f.personId);
    if (!bill || !person) return [];
    return [{
      kind: f.kind,
      paymentOrderId: f.paymentOrderId,
      // The vendor as the bill names it everywhere else.
      vendorName: bill.counterparty?.displayName ?? bill.counterpartyWallet.label,
      invoiceNumber: bill.invoiceNumber,
      amountRaw: bill.amountRaw.toString(),
      approvedBy: { personId: person.id, name: person.name, avatarUrl: person.avatar_url },
      allowedByName: f.allowedByName,
      approvedAt: f.at.toISOString(),
    }];
  });
}
