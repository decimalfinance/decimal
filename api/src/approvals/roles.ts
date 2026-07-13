// Prebuilt roles (supersedes free-form role seats). The role set is fixed —
// Reviewer / Approver / Payer / Viewer — and each carries a permission bundle
// (permissions.ts). This module handles listing and assignment; enforcement
// lives in the access middleware. Legacy seat-roles were migrated by
// postgres/init/007-prebuilt-roles.sql.
import { prisma } from '../infra/prisma.js';
import { ROLE_DEFINITIONS, ROLE_KEYS, type RoleKey } from './permissions.js';

export function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as string[]).includes(value);
}

export async function getMembersAndRoles(organizationId: string) {
  const { ensureEngineSetup, ensurePersonForUser } = await import('./wiring.js');
  await ensureEngineSetup(organizationId);
  // Sync current members → people so everyone is assignable.
  const memberIds = await prisma.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM organization_memberships
    WHERE organization_id = ${organizationId}::uuid AND status = 'active'`;
  await prisma.$transaction(async (tx) => {
    for (const m of memberIds) await ensurePersonForUser(tx, organizationId, m.user_id);
  });

  const [members, assignments] = await Promise.all([
    prisma.$queryRaw<{ user_id: string; name: string; email: string; access: string; person_id: string | null }[]>`
      SELECT om.user_id, u.display_name AS name, u.email, om.role AS access, p.id AS person_id
      FROM organization_memberships om
      JOIN users u ON u.user_id = om.user_id
      LEFT JOIN approval.people p ON p.organization_id = om.organization_id AND p.user_id = om.user_id
      WHERE om.organization_id = ${organizationId}::uuid AND om.status = 'active'
      ORDER BY (om.role = 'owner') DESC, u.display_name`,
    prisma.$queryRaw<{ person_id: string; role: string; name: string; user_id: string | null }[]>`
      SELECT pr.person_id, pr.role, p.name, p.user_id
      FROM approval.person_roles pr
      JOIN approval.people p ON p.id = pr.person_id
      LEFT JOIN organization_memberships om
        ON om.organization_id = pr.organization_id AND om.user_id = p.user_id AND om.status = 'active'
      WHERE pr.organization_id = ${organizationId}::uuid
        AND (om.role IS NULL OR om.role NOT IN ('owner', 'admin'))
      ORDER BY p.name`,
  ]);

  const holdersByRole = new Map<string, { personId: string; name: string; userId: string | null }[]>();
  const rolesByPerson = new Map<string, RoleKey[]>();
  for (const a of assignments) {
    if (!isRoleKey(a.role)) continue;
    const list = holdersByRole.get(a.role) ?? [];
    list.push({ personId: a.person_id, name: a.name, userId: a.user_id });
    holdersByRole.set(a.role, list);
    const pr = rolesByPerson.get(a.person_id) ?? [];
    pr.push(a.role);
    rolesByPerson.set(a.person_id, pr);
  }

  return {
    members: members.map((m) => ({
      userId: m.user_id,
      personId: m.person_id,
      name: m.name,
      email: m.email,
      access: m.access,
      roles: m.person_id ? (rolesByPerson.get(m.person_id) ?? []) : [],
    })),
    roles: ROLE_DEFINITIONS.map((d) => ({
      key: d.key,
      name: d.name,
      summary: d.summary,
      holders: holdersByRole.get(d.key) ?? [],
    })),
  };
}

export async function assignRole(organizationId: string, roleKey: RoleKey, userId: string) {
  // Admins already hold every capability — a role on top would grant nothing
  // and mislead the roster (Ramp's rule: admin/owner take no add-on roles).
  const tier = await prisma.$queryRaw<{ role: string }[]>`
    SELECT role FROM organization_memberships
    WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid AND status = 'active'`;
  if (tier[0] && (tier[0].role === 'owner' || tier[0].role === 'admin')) {
    throw new Error('Admins already have full access — roles are for members.');
  }
  const { ensurePersonForUser } = await import('./wiring.js');
  const personId = await prisma.$transaction((tx) => ensurePersonForUser(tx, organizationId, userId));
  await prisma.$executeRaw`
    INSERT INTO approval.person_roles (organization_id, person_id, role)
    VALUES (${organizationId}::uuid, ${personId}::uuid, ${roleKey})
    ON CONFLICT DO NOTHING`;
  return { ok: true, personId };
}

export async function unassignRole(organizationId: string, roleKey: RoleKey, personId: string) {
  await prisma.$executeRaw`
    DELETE FROM approval.person_roles
    WHERE organization_id = ${organizationId}::uuid AND person_id = ${personId}::uuid AND role = ${roleKey}`;
  return { ok: true };
}
