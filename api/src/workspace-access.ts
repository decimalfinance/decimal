import { prisma } from './prisma.js';

const ADMIN_ROLES = new Set(['owner', 'admin']);

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

export async function assertOrganizationAccess(organizationId: string, userId: string) {
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

export async function assertOrganizationAdmin(organizationId: string, userId: string) {
  const result = await assertOrganizationAccess(organizationId, userId);

  if (!ADMIN_ROLES.has(result.membership.role)) {
    throw new Error('Admin access required');
  }

  return result;
}

export async function assertWorkspaceAccess(workspaceId: string, userId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { workspaceId },
  });

  if (!workspace) {
    throw new Error('Workspace not found');
  }

  const { membership } = await assertOrganizationAccess(workspace.organizationId, userId);

  return {
    workspace,
    membership,
  };
}

export async function assertWorkspaceAdmin(workspaceId: string, userId: string) {
  const result = await assertWorkspaceAccess(workspaceId, userId);

  if (!ADMIN_ROLES.has(result.membership.role)) {
    throw new Error('Admin access required');
  }

  return result;
}

export function isAdminRole(role: string | null | undefined) {
  return Boolean(role && ADMIN_ROLES.has(role));
}
