import type { FormEvent } from 'react';
import type {
  AuthenticatedSession,
  OrganizationDirectoryItem,
  OrganizationMembership,
  Workspace,
} from '../types';
import { countWorkspaces, isAdminRole } from '../lib/app';
import { Metric, InfoLine } from '../components/ui';

export function LoginScreen({
  errorMessage,
  onLogin,
}: {
  errorMessage: string | null;
  onLogin: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <>
      <div className="auth-shell">
        <section className="auth-hero">
          <p className="eyebrow">USDC//OPS</p>
          <h1>Operate stablecoin flows without guessing what happened.</h1>
          <p className="hero-copy">
            Save wallets, create planned transfers, and verify whether real USDC transfers settled the way you expected.
          </p>
          <div className="hero-notes">
            <span>solana</span>
            <span>dark mono</span>
            <span>org scoped</span>
          </div>
        </section>

        <section className="auth-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Sign in</p>
              <h2>Operator login</h2>
            </div>
          </div>

          <form className="form-stack" onSubmit={onLogin}>
            <label className="field">
              <span>Email</span>
              <input name="email" type="email" placeholder="ops@company.com" required />
            </label>
            <label className="field">
              <span>Display name</span>
              <input name="displayName" type="text" placeholder="Optional" />
            </label>
            <button className="primary-button" type="submit">
              Enter surface
            </button>
          </form>
        </section>
      </div>
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
    </>
  );
}

export function DashboardPage({
  onGoOrgs,
  onOpenOrganization,
  onOpenWorkspace,
  session,
}: {
  onGoOrgs: () => void;
  onOpenOrganization: (organizationId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  session: AuthenticatedSession;
}) {
  const recentWorkspaces = session.organizations.flatMap((organization) =>
    organization.workspaces.map((workspace) => ({
      organizationId: organization.organizationId,
      organizationName: organization.organizationName,
      role: organization.role,
      workspace,
    })),
  );

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>Welcome back, {session.user.displayName}.</h1>
          <p className="section-copy">
            This is your personal operator view. Start from an organization, then open one workspace when you are ready to manage wallets and planned transfers.
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="Orgs" value={String(session.organizations.length).padStart(2, '0')} />
          <Metric label="Workspaces" value={String(countWorkspaces(session.organizations)).padStart(2, '0')} />
        </div>
      </section>

      <section className="content-grid">
        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Organizations</p>
              <h2>Your access</h2>
            </div>
          </div>

          <div className="stack-list">
            {session.organizations.length ? (
              session.organizations.map((organization) => (
                <button
                  key={organization.organizationId}
                  className="workspace-row"
                  onClick={() => onOpenOrganization(organization.organizationId)}
                  type="button"
                >
                  <div>
                    <strong>{organization.organizationName}</strong>
                    <small>{organization.role} // {organization.workspaces.length} workspaces</small>
                  </div>
                  <span>open</span>
                </button>
              ))
            ) : (
              <div className="empty-box compact">
                You are not part of any organization yet.
                <button className="primary-button" onClick={onGoOrgs} type="button">
                  Open orgs
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Recent workspaces</p>
              <h2>Jump back in</h2>
            </div>
          </div>

          <div className="stack-list">
            {recentWorkspaces.length ? (
              recentWorkspaces.slice(0, 6).map(({ organizationName, role, workspace }) => (
                <button
                  key={workspace.workspaceId}
                  className="workspace-row"
                  onClick={() => onOpenWorkspace(workspace.workspaceId)}
                  type="button"
                >
                  <div>
                    <strong>{workspace.workspaceName}</strong>
                    <small>{organizationName} // {role}</small>
                  </div>
                  <span>{workspace.status}</span>
                </button>
              ))
            ) : (
              <div className="empty-box compact">No workspaces yet. Open an organization to create the first one.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export function OrganizationsPage({
  directory,
  isLoading,
  onCreateOrganization,
  onJoinOrganization,
  onOpenOrganization,
  session,
}: {
  directory: OrganizationDirectoryItem[];
  isLoading: boolean;
  onCreateOrganization: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onJoinOrganization: (organizationId: string) => Promise<void>;
  onOpenOrganization: (organizationId: string) => void;
  session: AuthenticatedSession;
}) {
  return (
    <div className="page-stack">
      <section className="section-headline">
        <div>
          <p className="eyebrow">Organizations</p>
          <h1>Manage where this account can operate.</h1>
          <p className="section-copy">
            Membership controls which workspaces you can see. Admin role controls which ones you can configure.
          </p>
        </div>
      </section>

      <section className="ops-home-grid">
        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Your orgs</p>
              <h2>Memberships</h2>
            </div>
          </div>

          <div className="stack-list">
            {session.organizations.length ? (
              session.organizations.map((organization) => (
                <button
                  key={organization.organizationId}
                  className="workspace-row"
                  onClick={() => onOpenOrganization(organization.organizationId)}
                  type="button"
                >
                  <div>
                    <strong>{organization.organizationName}</strong>
                    <small>{organization.role} // {organization.workspaces.length} workspaces</small>
                  </div>
                  <span>open</span>
                </button>
              ))
            ) : (
              <div className="empty-box compact">You are not in any organizations yet.</div>
            )}
          </div>
        </div>

        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Create org</p>
              <h2>New organization</h2>
            </div>
          </div>

          <form className="form-stack" onSubmit={onCreateOrganization}>
            <label className="field">
              <span>Organization name</span>
              <input name="organizationName" placeholder="Acme Treasury" required />
            </label>
            <button className="primary-button" type="submit">
              Create organization
            </button>
          </form>
        </div>
      </section>

      <section className="content-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Directory</p>
            <h2>Available organizations</h2>
          </div>
          <span className="status-chip">{isLoading ? 'syncing' : 'ready'}</span>
        </div>

        <div className="stack-list">
          {directory.map((organization) => (
            <div key={organization.organizationId} className="workspace-row static-row">
              <div>
                <strong>{organization.organizationName}</strong>
                <small>
                  {organization.workspaceCount} workspaces
                </small>
              </div>
              {organization.isMember ? (
                <button className="ghost-button" onClick={() => onOpenOrganization(organization.organizationId)} type="button">
                  open
                </button>
              ) : (
                <button className="ghost-button" onClick={() => onJoinOrganization(organization.organizationId)} type="button">
                  join
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function OrganizationPage({
  organization,
  onCreateDemoWorkspace,
  onCreateWorkspace,
  onOpenWorkspace,
}: {
  organization: OrganizationMembership;
  onCreateDemoWorkspace: () => Promise<void>;
  onCreateWorkspace: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onOpenWorkspace: (workspaceId: string) => void;
}) {
  const canManage = isAdminRole(organization.role);

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Organization</p>
          <h1>{organization.organizationName}</h1>
          <p className="section-copy">
            Workspaces live here. Create and manage them at the organization layer, then open one when you want to track wallets and planned transfers.
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="Role" value={organization.role.toUpperCase()} />
          <Metric label="Workspaces" value={String(organization.workspaces.length).padStart(2, '0')} />
        </div>
      </section>

      <section className="content-grid">
        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Workspaces</p>
              <h2>Organization systems</h2>
            </div>
          </div>

          <div className="stack-list">
            {organization.workspaces.length ? (
              organization.workspaces.map((workspace) => (
                <button
                  key={workspace.workspaceId}
                  className="workspace-row"
                  onClick={() => onOpenWorkspace(workspace.workspaceId)}
                  type="button"
                >
                  <div>
                    <strong>{workspace.workspaceName}</strong>
                    <small>{workspace.status}</small>
                  </div>
                  <span>open</span>
                </button>
              ))
            ) : (
              <div className="empty-box compact">No workspaces yet. Create one when you are ready to monitor a real flow.</div>
            )}
          </div>
        </div>

        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">New workspace</p>
              <h2>Create a workspace</h2>
            </div>
          </div>

          {canManage ? (
            <div className="form-stack">
              <form className="form-stack" onSubmit={onCreateWorkspace}>
                <label className="field">
                  <span>Workspace name</span>
                  <input name="workspaceName" placeholder="Payout Desk" required />
                </label>
                <button className="primary-button" type="submit">
                  Create workspace
                </button>
              </form>
              <button className="ghost-button" onClick={() => void onCreateDemoWorkspace()} type="button">
                Create demo workspace
              </button>
            </div>
          ) : (
            <div className="empty-box compact">Only organization admins can create new workspaces.</div>
          )}
        </div>
      </section>
    </div>
  );
}

export function ProfilePage({ session }: { session: AuthenticatedSession }) {
  return (
    <div className="page-stack">
      <section className="section-headline">
        <div>
          <p className="eyebrow">Profile</p>
          <h1>Identity and current operator context.</h1>
          <p className="section-copy">This account signs in at the user level, then gains workspace access through org membership.</p>
        </div>
      </section>

      <section className="content-grid">
        <div className="content-panel">
          <div className="info-grid">
            <InfoLine label="Display name" value={session.user.displayName} />
            <InfoLine label="Email" value={session.user.email} />
            <InfoLine label="Organizations" value={String(session.organizations.length)} />
          </div>
        </div>

        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Memberships</p>
              <h2>Current access</h2>
            </div>
          </div>
          <div className="stack-list">
            {session.organizations.map((organization) => (
              <div key={organization.organizationId} className="workspace-row static-row">
                <div>
                  <strong>{organization.organizationName}</strong>
                  <small>{organization.role} // {organization.workspaces.length} workspaces</small>
                </div>
                <span>{organization.status}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
