import type { FormEvent } from 'react';
import type {
  AuthenticatedSession,
  OrganizationMembership,
  Workspace,
} from '../types';
import { countWorkspaces, isAdminRole } from '../lib/app';
import { Metric, InfoLine } from '../components/ui';

export function LandingPage({
  onEnter,
  onOpenLogin,
}: {
  onEnter: () => void;
  onOpenLogin: () => void;
}) {
  return (
    <div className="landing-shell">
      <section className="landing-hero">
        <header className="landing-nav">
          <div className="landing-brand">
            <span className="eyebrow">[project name]</span>
            <strong>Settlement visibility for stablecoin operations.</strong>
          </div>
          <button className="ghost-button" onClick={onOpenLogin} type="button">
            Operator login
          </button>
        </header>

        <div className="landing-hero-grid">
          <div className="landing-copy">
            <p className="eyebrow">Stablecoin ops control surface</p>
            <h1>See the transfer. See the route. See whether it actually settled.</h1>
            <p className="hero-copy">
              Built for finance and operations teams moving USDC on Solana. Save the wallets you care about, define expected transfers, and reconcile real transaction paths against what your team intended.
            </p>
            <div className="landing-actions">
              <button className="primary-button" onClick={onEnter} type="button">
                Enter control surface
              </button>
              <button className="ghost-button" onClick={onOpenLogin} type="button">
                Open operator login
              </button>
            </div>
            <div className="landing-proof">
              <span>Wallet registry</span>
              <span>Observed transfer reconstruction</span>
              <span>Reconciliation for operators</span>
            </div>
          </div>

          <div className="landing-visual" aria-hidden="true">
            <div className="landing-console">
              <div className="landing-console-topbar">
                <span className="eyebrow">Live settlement</span>
                <span className="landing-console-badge">Matched</span>
              </div>
              <div className="landing-console-hero">
                <div>
                  <span className="eyebrow">Expected transfer</span>
                  <strong>Treasury A {'->'} Ops wallet B</strong>
                </div>
                <span className="landing-console-amount">0.010000 USDC</span>
              </div>
              <div className="landing-console-grid">
                <div className="landing-console-section">
                  <span className="eyebrow">Observed route</span>
                  <div className="landing-console-route">
                    <div className="landing-console-node">
                      <strong>Source wallet</strong>
                      <small>Treasury signer</small>
                    </div>
                    <div className="landing-console-connector" />
                    <div className="landing-console-node landing-console-node-mid">
                      <strong>Transaction path</strong>
                      <small>Instruction-aware USDC legs</small>
                    </div>
                    <div className="landing-console-connector" />
                    <div className="landing-console-node">
                      <strong>Receiving wallet</strong>
                      <small>Derived USDC account</small>
                    </div>
                  </div>
                </div>
                <div className="landing-console-section">
                  <span className="eyebrow">Operator view</span>
                  <div className="landing-console-list">
                    <div className="landing-console-row">
                      <span>Observed transfer</span>
                      <strong>Exact destination confirmed</strong>
                    </div>
                    <div className="landing-console-row">
                      <span>Route count</span>
                      <strong>01 route / 01 payment</strong>
                    </div>
                    <div className="landing-console-row">
                      <span>Latency</span>
                      <strong>Chain to match in milliseconds</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section landing-section-inline">
        <div>
          <p className="eyebrow">Why it exists</p>
          <h2>Most tooling stops at balances. Operations teams need settlement truth.</h2>
        </div>
        <div className="landing-support-stack">
          <p className="landing-section-copy">
            This product is for teams who need to know what actually happened in a transaction, not just whether a wallet balance changed. It reconstructs observed USDC movement and compares that chain reality with the transfer your team planned.
          </p>
          <div className="landing-support-list">
            <div className="landing-support-row">
              <span>Observed transfers</span>
              <strong>One readable row for every USDC leg the indexer reconstructs.</strong>
            </div>
            <div className="landing-support-row">
              <span>Expected transfers</span>
              <strong>Define intent before money moves so operations has something concrete to reconcile against.</strong>
            </div>
            <div className="landing-support-row">
              <span>Operator exceptions</span>
              <strong>Surface partial, routed, or unresolved movement instead of leaving the team to inspect explorers by hand.</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section landing-workflow">
        <div className="landing-section-head">
          <p className="eyebrow">Workflow</p>
          <h2>One product surface from wallet setup to reconciliation.</h2>
        </div>
        <div className="landing-workflow-rail">
          <div className="landing-step">
            <span>01</span>
            <div>
              <strong>Save the wallets</strong>
              <p>Register the treasury, operational, or counterparty wallets that matter to your team.</p>
            </div>
          </div>
          <div className="landing-step">
            <span>02</span>
            <div>
              <strong>Create planned transfers</strong>
              <p>Define the movement you expect to see before the transaction lands on-chain.</p>
            </div>
          </div>
          <div className="landing-step">
            <span>03</span>
            <div>
              <strong>Reconstruct observed movement</strong>
              <p>Every relevant USDC leg is indexed and turned into an operator-readable transfer record.</p>
            </div>
          </div>
          <div className="landing-step">
            <span>04</span>
            <div>
              <strong>Confirm or escalate</strong>
              <p>Reconciliation and exceptions tell your team whether a payment is complete, partial, routed, or unresolved.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section landing-cta">
        <div className="landing-cta-copy">
          <p className="eyebrow">Start</p>
          <h2>Open the control surface and run a real USDC settlement test.</h2>
          <p className="landing-section-copy">
            Start with two wallets, create one planned transfer, and verify the full route from observed chain movement to settlement status.
          </p>
        </div>
        <div className="landing-actions landing-actions-end">
          <button className="primary-button" onClick={onEnter} type="button">
            Enter control surface
          </button>
          <button className="ghost-button" onClick={onOpenLogin} type="button">
            Operator login
          </button>
        </div>
      </section>
    </div>
  );
}

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
  session,
}: {
  onGoOrgs: () => void;
  onOpenOrganization: (organizationId: string) => void;
  session: AuthenticatedSession;
}) {
  const workspaces = session.organizations.flatMap((organization) =>
    organization.workspaces.map((workspace) => ({
      organizationId: organization.organizationId,
      organizationName: organization.organizationName,
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName,
      status: workspace.status,
    })),
  );

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>Welcome back, {session.user.displayName}.</h1>
        </div>
        <div className="hero-metrics">
          <Metric label="Orgs" value={String(session.organizations.length).padStart(2, '0')} />
          <Metric label="Workspaces" value={String(countWorkspaces(session.organizations)).padStart(2, '0')} />
        </div>
      </section>

      <section className="ops-home-grid">
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

        <div className="content-panel content-panel-soft">
          <div className="panel-header panel-header-stack">
            <div>
              <p className="eyebrow">Operator path</p>
              <h2>Start from a live system</h2>
              <p className="compact-copy">
                Open a workspace when you want to watch requests, approvals, execution, and actual settlement in one place.
              </p>
            </div>
            <button className="ghost-button compact-button" onClick={onGoOrgs} type="button">
              manage orgs
            </button>
          </div>

          <div className="stack-list">
            {workspaces.length ? (
              workspaces.slice(0, 4).map((workspace) => (
                <button
                  className="workspace-row"
                  key={workspace.workspaceId}
                  onClick={() => onOpenOrganization(workspace.organizationId)}
                  type="button"
                >
                  <div>
                    <strong>{workspace.workspaceName}</strong>
                    <small>{workspace.organizationName} // {workspace.status}</small>
                  </div>
                  <span>open org</span>
                </button>
              ))
            ) : (
              <div className="empty-box compact">
                No workspaces yet. Create an organization and spin up a desk when you are ready to monitor a real flow.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export function OrganizationsPage({
  onCreateOrganization,
  onOpenOrganization,
  session,
}: {
  onCreateOrganization: (event: FormEvent<HTMLFormElement>) => Promise<void>;
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
