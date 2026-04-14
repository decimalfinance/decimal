import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import type { AuthenticatedSession, OrganizationMembership, Workspace } from './api';

type WorkspaceContext = {
  organization: OrganizationMembership;
  workspace: Workspace;
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

const icons = {
  command: (
    <Icon>
      <path
        d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 13a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1v-6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  requests: (
    <Icon>
      <path
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  runs: (
    <Icon>
      <path
        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  payments: (
    <Icon>
      <path
        d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  approvals: (
    <Icon>
      <path
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  execution: (
    <Icon>
      <path
        d="M13 10V3L4 14h7v7l9-11h-7z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  settlement: (
    <Icon>
      <path
        d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  exceptions: (
    <Icon>
      <path
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  proofs: (
    <Icon>
      <path
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  address: (
    <Icon>
      <path
        d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  policy: (
    <Icon>
      <path
        d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  ops: (
    <Icon>
      <path
        d="M4 19h16M6 15l2-3 3 3 4-8 3 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  ),
} as const;

function SidebarLink({
  to,
  end,
  icon,
  badgeCount,
  children,
}: {
  to: string;
  end?: boolean;
  icon: ReactNode;
  badgeCount?: number;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link-active' : ''}`}
    >
      <span className="sidebar-link-icon-wrap">{icon}</span>
      <span className="sidebar-link-label">{children}</span>
      {badgeCount && badgeCount > 0 ? (
        <span className="sidebar-link-badge" aria-label={`${badgeCount} pending`}>
          {badgeCount}
        </span>
      ) : null}
    </NavLink>
  );
}

function workspaceNavItems(workspaceId: string) {
  const base = `/workspaces/${workspaceId}`;
  return {
    operations: [
      { to: base, end: true as const, label: 'Command Center', icon: icons.command },
      { to: `${base}/payments`, end: false as const, label: 'Payments', icon: icons.payments },
      { to: `${base}/approvals`, end: false as const, label: 'Approvals', icon: icons.approvals },
      { to: `${base}/execution`, end: false as const, label: 'Execution', icon: icons.execution },
      { to: `${base}/settlement`, end: false as const, label: 'Settlement', icon: icons.settlement },
      { to: `${base}/exceptions`, end: false as const, label: 'Exceptions', icon: icons.exceptions },
      { to: `${base}/proofs`, end: false as const, label: 'Proofs', icon: icons.proofs },
    ],
    administration: [
      { to: `${base}/registry`, end: false as const, label: 'Address book', icon: icons.address },
      { to: `${base}/policy`, end: false as const, label: 'Policy', icon: icons.policy },
      { to: `${base}/ops`, end: false as const, label: 'Ops health', icon: icons.ops },
    ],
  };
}

function initialsFromEmail(email: string) {
  const local = email.split('@')[0] ?? '?';
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

export function AppSidebar({
  session,
  workspaceContexts,
  activeWorkspaceId,
  approvalPendingCount,
  onLogout,
}: {
  session: AuthenticatedSession;
  workspaceContexts: WorkspaceContext[];
  activeWorkspaceId?: string;
  approvalPendingCount?: number;
  onLogout: () => void;
}) {
  return (
    <aside className="sidebar" aria-label="Application">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden />
        <div className="sidebar-brand-text">
          <strong>Stablecoin Ops</strong>
          <span>Payment control</span>
        </div>
      </div>

      <nav className="sidebar-scroll" aria-label="Workspace navigation">
        {workspaceContexts.map(({ organization, workspace }) => {
          const nav = workspaceNavItems(workspace.workspaceId);
          return (
            <div className="sidebar-workspace" key={workspace.workspaceId}>
              <div className="sidebar-workspace-header">
                <p className="sidebar-section-label">Workspace</p>
                <div className="sidebar-workspace-title">
                  <span className="sidebar-workspace-name">{workspace.workspaceName}</span>
                  <span className="sidebar-workspace-org">{organization.organizationName}</span>
                </div>
              </div>

              <div className="sidebar-section">
                <p className="sidebar-section-label">Operations</p>
                <div className="sidebar-link-list" role="list">
                  {nav.operations.map((item) => (
                    <SidebarLink
                      key={item.to + String(item.end)}
                      to={item.to}
                      end={item.end}
                      icon={item.icon}
                      badgeCount={
                        item.label === 'Approvals' && workspace.workspaceId === activeWorkspaceId
                          ? approvalPendingCount
                          : undefined
                      }
                    >
                      {item.label}
                    </SidebarLink>
                  ))}
                </div>
              </div>

              <div className="sidebar-section">
                <p className="sidebar-section-label">Administration</p>
                <div className="sidebar-link-list" role="list">
                  {nav.administration.map((item) => (
                    <SidebarLink key={item.to} to={item.to} icon={item.icon}>
                      {item.label}
                    </SidebarLink>
                  ))}
                </div>
              </div>
            </div>
          );
        })}

        {!workspaceContexts.length ? (
          <div className="sidebar-empty-workspace">
            <p className="sidebar-section-label">Workspace</p>
            <NavLink className="sidebar-cta-link" to="/setup">
              Create workspace
            </NavLink>
          </div>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <span className="sidebar-user-avatar" aria-hidden>
            {initialsFromEmail(session.user.email)}
          </span>
          <div className="sidebar-user-meta">
            <span className="sidebar-user-email" title={session.user.email}>
              {session.user.email}
            </span>
            <button className="sidebar-sign-out" onClick={() => void onLogout()} type="button">
              Sign out
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
