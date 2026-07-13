// Prebuilt roles as permission bundles (roles-research/SYNTHESIS-decimal-roles.md).
// A role is a job in the bill's journey; holding it grants the capabilities that
// job needs and nothing else. Access = union of held roles; owner/admin
// memberships bypass everything. A member with NO roles gets the viewer bundle
// (can see, can't act) so existing orgs keep working the day this ships.
import { prisma } from '../infra/prisma.js';

export type Capability =
  | 'bills.view' | 'bills.edit'
  | 'approvals.act'
  | 'payments.view' | 'payments.sign'
  | 'treasury.view' | 'treasury.manage'
  | 'vendors.view' | 'vendors.manage'
  | 'accounting.view' | 'accounting.manage'
  | 'members.view' | 'members.manage'
  | 'governance.view' | 'governance.edit';

export type RoleKey = 'reviewer' | 'approver' | 'payer' | 'viewer';
export const ROLE_KEYS: RoleKey[] = ['reviewer', 'approver', 'payer', 'viewer'];

const ALL_VIEW: Capability[] = [
  'bills.view', 'payments.view', 'treasury.view', 'vendors.view',
  'accounting.view', 'members.view', 'governance.view',
];

// What every active member can always do, roles or not: see the team and read
// how the pipeline is governed (the pipeline page is view-only for non-owners).
const BASE: Capability[] = ['members.view', 'governance.view'];

export const ROLE_BUNDLES: Record<RoleKey, Capability[]> = {
  reviewer: [...BASE, 'bills.view', 'bills.edit', 'vendors.view', 'accounting.view'],
  approver: [...BASE, 'bills.view', 'approvals.act', 'vendors.view'],
  payer: [...BASE, 'bills.view', 'payments.view', 'payments.sign', 'treasury.view', 'vendors.view'],
  viewer: [...ALL_VIEW],
};

// Shown on the Members page and used as the role's explanation everywhere.
export const ROLE_DEFINITIONS: Array<{ key: RoleKey; name: string; summary: string }> = [
  { key: 'reviewer', name: 'Reviewer', summary: "Enters and confirms a bill's details and coding. Cannot approve bills or see payments." },
  { key: 'approver', name: 'Approver', summary: 'Signs off on bills assigned to them. Cannot edit bills, send payments, or see bank details.' },
  { key: 'payer', name: 'Payer', summary: 'Sends approved payments and sees balances. Cannot create, edit, or approve bills.' },
  { key: 'viewer', name: 'Viewer', summary: 'Sees everything, changes nothing. For auditors and stakeholders.' },
];

export interface OrgAccess {
  membershipRole: string;          // owner | admin | member
  roles: RoleKey[];                // prebuilt roles held (empty = viewer default)
  capabilities: Capability[];
  isOwnerOrAdmin: boolean;
}

export function capabilitiesFor(membershipRole: string, roles: RoleKey[]): Capability[] {
  if (membershipRole === 'owner' || membershipRole === 'admin') {
    return [...ALL_VIEW, 'bills.edit', 'approvals.act', 'payments.sign', 'treasury.manage', 'vendors.manage', 'accounting.manage', 'members.manage', 'governance.edit'];
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
  };
}
