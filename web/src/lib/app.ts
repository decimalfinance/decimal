import type { OrganizationMembership } from '../types';
import { startTransition } from 'react';

export type Route =
  | { name: 'landingEditorial' }
  | { name: 'login' }
  | { name: 'dashboard' }
  | { name: 'profile' }
  | { name: 'orgs' }
  | { name: 'organizationHome'; organizationId: string }
  | { name: 'workspaceHome'; workspaceId: string }
  | { name: 'workspaceRegistry'; workspaceId: string }
  | { name: 'workspacePolicy'; workspaceId: string }
  | { name: 'workspaceRequests'; workspaceId: string };
export type Theme = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'usdc_ops.theme';

export function formatRawUsdc(amountRaw: string) {
  const negative = amountRaw.startsWith('-');
  const digits = negative ? amountRaw.slice(1) : amountRaw;
  const padded = digits.padStart(7, '0');
  const whole = padded.slice(0, -6) || '0';
  const fraction = padded.slice(-6);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortenAddress(value: string | null | undefined, prefix = 6, suffix = 6) {
  if (!value) {
    return 'Unknown';
  }

  if (value.length <= prefix + suffix + 1) {
    return value;
  }

  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

export function orbTransactionUrl(signature: string) {
  return `https://orbmarkets.io/tx/${signature}?tab=summary`;
}

export function parseRoute(pathname: string): Route {
  if (pathname === '/landing/editorial') return { name: 'landingEditorial' };
  if (pathname === '/landing/brand-film') return { name: 'landingEditorial' };
  if (pathname === '/login') return { name: 'login' };
  if (pathname === '/profile') return { name: 'profile' };
  if (pathname === '/orgs') return { name: 'orgs' };

  const organizationMatch = pathname.match(/^\/orgs\/([0-9a-f-]+)$/i);
  if (organizationMatch) {
    return { name: 'organizationHome', organizationId: organizationMatch[1] };
  }

  const workspaceMatch = pathname.match(/^\/workspaces\/([0-9a-f-]+)\/(home|setup|registry|policy|requests)$/i);
  if (workspaceMatch) {
    const [, workspaceId, page] = workspaceMatch;
    if (page === 'home') return { name: 'workspaceHome', workspaceId };
    if (page === 'policy') return { name: 'workspacePolicy', workspaceId };
    if (page === 'requests') return { name: 'workspaceRequests', workspaceId };
    return { name: 'workspaceRegistry', workspaceId };
  }

  return { name: 'dashboard' };
}

export function routeToPath(route: Route) {
  switch (route.name) {
    case 'landingEditorial':
      return '/landing/editorial';
    case 'login':
      return '/login';
    case 'dashboard':
      return '/';
    case 'profile':
      return '/profile';
    case 'orgs':
      return '/orgs';
    case 'organizationHome':
      return `/orgs/${route.organizationId}`;
    case 'workspaceHome':
      return `/workspaces/${route.workspaceId}/home`;
    case 'workspaceRegistry':
      return `/workspaces/${route.workspaceId}/registry`;
    case 'workspacePolicy':
      return `/workspaces/${route.workspaceId}/policy`;
    case 'workspaceRequests':
      return `/workspaces/${route.workspaceId}/requests`;
  }
}

export function navigate(route: Route, setRoute: (route: Route) => void, replace = false) {
  const nextPath = routeToPath(route);
  startTransition(() => {
    setRoute(route);
  });

  if (replace) {
    window.history.replaceState(null, '', nextPath);
  } else if (window.location.pathname !== nextPath) {
    window.history.pushState(null, '', nextPath);
  }
}

export function loadTheme(): Theme {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

export function findOrganization(session: { organizations: OrganizationMembership[] } | null, organizationId: string) {
  if (!session) {
    return null;
  }

  return session.organizations.find((organization) => organization.organizationId === organizationId) ?? null;
}

export function findWorkspace(session: { organizations: OrganizationMembership[] } | null, workspaceId: string) {
  if (!session) {
    return null;
  }

  for (const organization of session.organizations) {
    const workspace = organization.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
    if (workspace) {
      return workspace;
    }
  }

  return null;
}

export function findOrganizationForWorkspace(session: { organizations: OrganizationMembership[] } | null, workspaceId: string) {
  if (!session) {
    return null;
  }

  for (const organization of session.organizations) {
    if (organization.workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
      return organization;
    }
  }

  return null;
}

export function isAdminRole(role: string | null | undefined) {
  return role === 'owner' || role === 'admin';
}

export function countWorkspaces(organizations: OrganizationMembership[]) {
  return organizations.reduce((sum, organization) => sum + organization.workspaces.length, 0);
}
