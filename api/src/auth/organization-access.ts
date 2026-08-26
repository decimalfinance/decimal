import type { AuthContext } from './sessions.js';
import { prisma } from '../infra/prisma.js';

const ADMIN_ROLES = new Set(['primary_admin', 'admin']);

type AccessActor = string | AuthContext;

export async function getOrganizationMembership(userId: string, organizationId: string) {
  const membership = await prisma.organizationMembership.findUnique({
    where: {
      organizationId_userId: {
        organizationId,
        userId,
      },
    },
  });

  if (!membership || membership.status !== 'active') {
    throw new Error('Organization not found');
  }

  return membership;
}

export async function assertOrganizationAccess(organizationId: string, actor: AccessActor) {
  const userId = getUserId(actor);
  const [organization, membership] = await Promise.all([
    prisma.organization.findUnique({
      where: { organizationId },
    }),
    getOrganizationMembership(userId, organizationId),
  ]);

  if (!organization) {
    throw new Error('Organization not found');
  }

  return {
    organization,
    membership,
  };
}

export async function assertOrganizationAdmin(organizationId: string, actor: AccessActor) {
  const result = await assertOrganizationAccess(organizationId, actor);

  if (!canMutateWithRole(result.membership.role, actor)) {
    throw new Error('Admin access required');
  }

  return result;
}

/** The primary admin is distinct from an admin for governance acts (protection relaxation, vault keys). */
export function isPrimaryAdminRole(role: string | null | undefined) {
  return role === 'primary_admin';
}

export function isAdminRole(role: string | null | undefined) {
  return Boolean(role && ADMIN_ROLES.has(role));
}

function getUserId(actor: AccessActor) {
  return typeof actor === 'string' ? actor : actor.userId;
}

function canMutateWithRole(role: string | null | undefined, _actor: AccessActor) {
  if (!role) {
    return false;
  }

  return ADMIN_ROLES.has(role);
}
