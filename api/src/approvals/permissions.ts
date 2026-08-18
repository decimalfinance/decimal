// Prebuilt roles as permission bundles (roles-research/SYNTHESIS-decimal-roles.md).
// A role is a job in the bill's journey; holding it grants the capabilities that
// job needs and nothing else. Access = union of held roles; owner/admin
// memberships bypass everything. A member with NO roles gets the viewer bundle
// (can see, can't act) so existing orgs keep working the day this ships.
//
// Bill Clerk was called Reviewer until 2026-08-17. The job never changed — it
// enters and codes bills — but "reviewer" named a stage we established does not
// exist, and every AP product already has a word for this person: Bill.com's
// Clerk, QuickBooks' Bill Clerk, Tipalti's AP Clerk.
import { prisma } from '../infra/prisma.js';

export type Capability =
  | 'bills.view' | 'bills.create' | 'bills.edit'
  | 'approvals.act'
  | 'payments.view' | 'payments.sign'
  | 'treasury.view' | 'treasury.manage'
  | 'vendors.view' | 'vendors.manage'
  | 'accounting.view' | 'accounting.manage'
  | 'members.view' | 'members.manage'
  | 'governance.view' | 'governance.edit';

export type RoleKey = 'bill_clerk' | 'approver' | 'payer' | 'viewer';
export const ROLE_KEYS: RoleKey[] = ['bill_clerk', 'approver', 'payer', 'viewer'];

const ALL_VIEW: Capability[] = [
  'bills.view', 'payments.view', 'treasury.view', 'vendors.view',
  'accounting.view', 'members.view', 'governance.view',
];

// What every active member can always do, roles or not: see the team and read
// how the pipeline is governed (the pipeline page is view-only for non-owners).
const BASE: Capability[] = ['members.view', 'governance.view'];

// `bills.create` is deliberately wider than `bills.edit`.
//
// Getting an invoice INTO the system is not a privileged act — it creates a
// draft that does nothing until somebody works it. The person holding the
// invoice is frequently not the clerk: the ops lead who ordered the thing, the
// engineer whose tool renewed. Stampli models exactly this with a Requester
// who submits and an AP Processor who processes. Refusing them would only push
// the invoice into somebody's inbox and out of the product.
//
// PREPARING the bill — changing figures, coding lines, sending it for approval
// — stays `bills.edit`, and stays the Bill Clerk's. That is where the control
// belongs and it has not moved.
//
// The Viewer is the one exception. It is an auditor's seat: read everything,
// change nothing, and creating a record is a change.
export const ROLE_BUNDLES: Record<RoleKey, Capability[]> = {
  bill_clerk: [...BASE, 'bills.view', 'bills.create', 'bills.edit', 'vendors.view', 'accounting.view'],
  approver: [...BASE, 'bills.view', 'bills.create', 'approvals.act', 'vendors.view'],
  payer: [...BASE, 'bills.view', 'bills.create', 'payments.view', 'payments.sign', 'treasury.view', 'vendors.view'],
  viewer: [...ALL_VIEW],
};

// Shown on the Members page and used as the role's explanation everywhere.
export const ROLE_DEFINITIONS: Array<{ key: RoleKey; name: string; summary: string }> = [
  { key: 'bill_clerk', name: 'Bill Clerk', summary: "Enters and confirms a bill's details and coding. Cannot approve bills or see payments." },
  { key: 'approver', name: 'Approver', summary: 'Signs off on bills assigned to them. Cannot edit bills, send payments, or see bank details.' },
  { key: 'payer', name: 'Payer', summary: 'Sends approved payments and sees balances. Cannot create, edit, or approve bills.' },
  { key: 'viewer', name: 'Viewer', summary: 'Sees everything, changes nothing — cannot even bring a bill in. For auditors and stakeholders.' },
];

/**
 * Which BILLS a person may see, as opposed to which SCREENS. The roles round
 * mapped the feature surface and deferred this one; access-research found it is
 * the axis that actually matters — seven of ten AP products scope the approver
 * to the bills routed to them, and Xero, the documented outlier that shows
 * everyone everything, is what we were.
 *
 * One axis, deliberately. Department, entity and project scoping are all
 * enterprise-tier in the products that have them at all, and we would be
 * building them for nobody.
 */
export type BillScope = 'all' | 'involved';

export interface OrgAccess {
  membershipRole: string;          // owner | admin | member
  roles: RoleKey[];                // prebuilt roles held (empty = viewer default)
  capabilities: Capability[];
  isOwnerOrAdmin: boolean;
  billScope: BillScope;
}

/**
 * Everyone in the organization sees every bill. What differs is what they can
 * DO to one.
 *
 * This was briefly the other way round — an Approver was scoped to bills routed
 * to them, following the seven-of-ten pattern in the scoping research. It was
 * changed deliberately, and the argument that won is about the job rather than
 * the data: the people who approve and pay are the ones carrying the decision,
 * and a bill should not land in front of them out of nowhere. Seeing it being
 * prepared — what the machine read, what a person corrected, who corrected it —
 * is the context that makes an approval mean something rather than a rubber
 * stamp on a number.
 *
 * The cost is accepted knowingly: an approver can read bills they will never be
 * asked about. That is a confidentiality trade, not a control one — authority
 * still comes from the role bundle and, per bill, from the engine's task
 * assignment and its separation-of-duties rules. Nobody can act on a bill just
 * because they can see it.
 *
 * The `involved` machinery in bill-visibility.ts is kept, unused, because the
 * deferred work it exists for is narrowing by DEPARTMENT or ENTITY — the axes
 * the research found in the enterprise tier. If that arrives, this function is
 * where it switches back on.
 */
export function billScopeFor(_membershipRole: string, _roles: RoleKey[]): BillScope {
  return 'all';
}

export function capabilitiesFor(membershipRole: string, roles: RoleKey[]): Capability[] {
  if (membershipRole === 'owner' || membershipRole === 'admin') {
    return [...ALL_VIEW, 'bills.create', 'bills.edit', 'approvals.act', 'payments.sign', 'treasury.manage', 'vendors.manage', 'accounting.manage', 'members.manage', 'governance.edit'];
  }
  const effective = roles.length > 0 ? roles : (['viewer'] as RoleKey[]);
  const caps = new Set<Capability>();
  for (const r of effective) for (const c of ROLE_BUNDLES[r]) caps.add(c);
  return [...caps];
}

/** Load a user's org access (membership + prebuilt roles) in one query each. */
export async function getOrgAccess(organizationId: string, userId: string): Promise<OrgAccess | null> {
  const rows = await prisma.$queryRaw<{ membership_role: string; role: string | null }[]>`
    SELECT om.role AS membership_role, pr.role
    FROM organization_memberships om
    LEFT JOIN approval.people p ON p.organization_id = om.organization_id AND p.user_id = om.user_id
    LEFT JOIN approval.person_roles pr ON pr.organization_id = om.organization_id AND pr.person_id = p.id
    WHERE om.organization_id = ${organizationId}::uuid AND om.user_id = ${userId}::uuid AND om.status = 'active'`;
  if (rows.length === 0) return null;
  const membershipRole = rows[0]!.membership_role;
  const roles = rows.map((r) => r.role).filter((r): r is RoleKey => r !== null && (ROLE_KEYS as string[]).includes(r));
  return {
    membershipRole,
    roles,
    capabilities: capabilitiesFor(membershipRole, roles),
    isOwnerOrAdmin: membershipRole === 'owner' || membershipRole === 'admin',
    billScope: billScopeFor(membershipRole, roles),
  };
}
