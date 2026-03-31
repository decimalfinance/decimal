import type { FormEvent, ReactNode } from 'react';
import { startTransition, useEffect, useState } from 'react';
import { api } from './api';
import type {
  AuthenticatedSession,
  EventParticipant,
  OnboardingSnapshot,
  OperationalEvent,
  OrganizationDirectoryItem,
  OrganizationMembership,
  ReconciliationRow,
  Workspace,
} from './types';

type Route =
  | { name: 'login' }
  | { name: 'dashboard' }
  | { name: 'profile' }
  | { name: 'orgs' }
  | { name: 'workspaceHome'; workspaceId: string }
  | { name: 'workspaceSetup'; workspaceId: string }
  | { name: 'workspaceGraph'; workspaceId: string };

type AuthStatus = 'booting' | 'anonymous' | 'authenticated';
type OnboardingStepId = 'addresses' | 'labels' | 'objects' | 'addressLabels' | 'mappings';

const EVENT_TYPE_OPTIONS = ['', 'workspace_inflow', 'workspace_outflow', 'workspace_mixed', 'workspace_observed_write'];
const DIRECTION_OPTIONS = ['', 'inflow', 'outflow', 'mixed', 'neutral'];
const THEME_STORAGE_KEY = 'usdc_ops.theme';
type Theme = 'dark' | 'light';

export function App() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [authStatus, setAuthStatus] = useState<AuthStatus>('booting');
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [organizationDirectory, setOrganizationDirectory] = useState<OrganizationDirectoryItem[]>([]);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [events, setEvents] = useState<OperationalEvent[]>([]);
  const [reconciliationRows, setReconciliationRows] = useState<ReconciliationRow[]>([]);
  const [participants, setParticipants] = useState<EventParticipant[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<OperationalEvent | null>(null);
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [directionFilter, setDirectionFilter] = useState('');
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(false);
  const [isLoadingOrganizations, setIsLoadingOrganizations] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const currentWorkspaceId =
    route.name === 'workspaceHome' || route.name === 'workspaceSetup' || route.name === 'workspaceGraph'
      ? route.workspaceId
      : null;

  const currentOrganization = getActiveOrganization(session, activeOrganizationId);
  const currentWorkspace = currentWorkspaceId ? findWorkspace(session, currentWorkspaceId) : null;
  const currentWorkspaceOrganization = currentWorkspace ? findOrganizationForWorkspace(session, currentWorkspace.workspaceId) : null;
  const currentRole = currentWorkspaceOrganization?.role ?? currentOrganization?.role ?? null;
  const canManageCurrentOrg = isAdminRole(currentRole);
  const onboarding = snapshot ? getOnboardingState(snapshot) : null;

  useEffect(() => {
    const onPopstate = () => {
      setRoute(parseRoute(window.location.pathname));
    };

    window.addEventListener('popstate', onPopstate);
    void boot();

    return () => {
      window.removeEventListener('popstate', onPopstate);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (authStatus !== 'authenticated') {
      return;
    }

    void refreshOrganizationDirectory();
  }, [authStatus]);

  useEffect(() => {
    if (!session) {
      setActiveOrganizationId(null);
      return;
    }

    if (activeOrganizationId && session.organizations.some((organization) => organization.organizationId === activeOrganizationId)) {
      return;
    }

    setActiveOrganizationId(session.organizations[0]?.organizationId ?? null);
  }, [activeOrganizationId, session]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !currentWorkspaceId) {
      setSnapshot(null);
      setEvents([]);
      setReconciliationRows([]);
      setParticipants([]);
      setSelectedEvent(null);
      return;
    }

    void loadWorkspace(currentWorkspaceId);
  }, [authStatus, currentWorkspaceId, eventTypeFilter, directionFilter]);

  async function boot() {
    if (!api.getSessionToken()) {
      setAuthStatus('anonymous');
      navigate({ name: 'login' }, setRoute, true);
      return;
    }

    try {
      const nextSession = await api.getSession();
      setSession(nextSession);
      setAuthStatus('authenticated');

      if (parseRoute(window.location.pathname).name === 'login') {
        navigate({ name: 'dashboard' }, setRoute, true);
      }
    } catch {
      api.clearSessionToken();
      setSession(null);
      setAuthStatus('anonymous');
      navigate({ name: 'login' }, setRoute, true);
    }
  }

  async function refreshSession() {
    const nextSession = await api.getSession();
    setSession(nextSession);
    return nextSession;
  }

  async function refreshOrganizationDirectory() {
    try {
      setIsLoadingOrganizations(true);
      const response = await api.listOrganizations();
      setOrganizationDirectory(response.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load organizations');
    } finally {
      setIsLoadingOrganizations(false);
    }
  }

  async function loadWorkspace(workspaceId: string) {
    try {
      setErrorMessage(null);
      setIsLoadingWorkspace(true);

      const [nextSnapshot, nextEvents, nextReconciliation] = await Promise.all([
        api.getOnboardingSnapshot(workspaceId),
        api.listEvents(workspaceId, {
          eventType: eventTypeFilter || undefined,
          direction: directionFilter || undefined,
        }),
        api.listReconciliation(workspaceId),
      ]);

      setSnapshot(nextSnapshot);
      setEvents(nextEvents.items);
      setReconciliationRows(nextReconciliation.items);

      if (selectedEvent && !nextEvents.items.some((event) => event.workspace_event_id === selectedEvent.workspace_event_id)) {
        setSelectedEvent(null);
        setParticipants([]);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load workspace');
    } finally {
      setIsLoadingWorkspace(false);
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const email = String(formData.get('email') ?? '').trim();
    const displayName = String(formData.get('displayName') ?? '').trim();

    if (!email) {
      return;
    }

    try {
      setErrorMessage(null);
      const response = await api.login({
        email,
        displayName: displayName || undefined,
      });

      api.setSessionToken(response.sessionToken);
      setSession({
        authenticated: true,
        user: response.user,
        organizations: response.organizations,
      });
      setAuthStatus('authenticated');
      form.reset();
      await refreshOrganizationDirectory();
      navigate({ name: 'dashboard' }, setRoute);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to login');
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // ignore
    }

    api.clearSessionToken();
    setSession(null);
    setOrganizationDirectory([]);
    setSnapshot(null);
    setEvents([]);
    setReconciliationRows([]);
    setParticipants([]);
    setSelectedEvent(null);
    setActiveOrganizationId(null);
    setAuthStatus('anonymous');
    navigate({ name: 'login' }, setRoute);
  }

  async function handleCreateOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const organizationName = String(formData.get('organizationName') ?? '').trim();
    const organizationSlug = String(formData.get('organizationSlug') ?? '').trim();

    if (!organizationName || !organizationSlug) {
      return;
    }

    try {
      setErrorMessage(null);
      const organization = await api.createOrganization({
        organizationName,
        organizationSlug,
      });

      await Promise.all([refreshSession(), refreshOrganizationDirectory()]);
      setActiveOrganizationId(organization.organizationId);
      form.reset();
      navigate({ name: 'orgs' }, setRoute);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create organization');
    }
  }

  async function handleJoinOrganization(organizationId: string) {
    try {
      setErrorMessage(null);
      await api.joinOrganization(organizationId);
      await Promise.all([refreshSession(), refreshOrganizationDirectory()]);
      setActiveOrganizationId(organizationId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to join organization');
    }
  }

  async function handleCreateWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentOrganization) {
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData(form);
    const workspaceName = String(formData.get('workspaceName') ?? '').trim();
    const workspaceSlug = String(formData.get('workspaceSlug') ?? '').trim();

    if (!workspaceName || !workspaceSlug) {
      return;
    }

    try {
      setErrorMessage(null);
      const workspace = await api.createWorkspace(currentOrganization.organizationId, {
        workspaceName,
        workspaceSlug,
      });

      await refreshSession();
      form.reset();
      navigate({ name: 'workspaceHome', workspaceId: workspace.workspaceId }, setRoute);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create watch system');
    }
  }

  async function handleCreateAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentWorkspaceId) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const address = String(formData.get('address') ?? '').trim();
    const addressKind = String(formData.get('addressKind') ?? '').trim();
    const notes = String(formData.get('notes') ?? '').trim();
    if (!address || !addressKind) return;

    try {
      setErrorMessage(null);
      await api.createAddress(currentWorkspaceId, { address, addressKind, notes: notes || undefined });
      form.reset();
      await loadWorkspace(currentWorkspaceId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create address');
    }
  }

  async function handleCreateLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentWorkspaceId) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const labelName = String(formData.get('labelName') ?? '').trim();
    const labelType = String(formData.get('labelType') ?? '').trim();
    if (!labelName || !labelType) return;

    try {
      setErrorMessage(null);
      await api.createLabel(currentWorkspaceId, { labelName, labelType });
      form.reset();
      await loadWorkspace(currentWorkspaceId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create label');
    }
  }

  async function handleAttachLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentWorkspaceId) return;
    const formData = new FormData(event.currentTarget);
    const workspaceAddressId = String(formData.get('workspaceAddressId') ?? '');
    const labelId = String(formData.get('labelId') ?? '');
    if (!workspaceAddressId || !labelId) return;

    try {
      setErrorMessage(null);
      await api.attachLabel(currentWorkspaceId, { workspaceAddressId, labelId });
      event.currentTarget.reset();
      await loadWorkspace(currentWorkspaceId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to attach label');
    }
  }

  async function handleCreateObject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentWorkspaceId) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const objectType = String(formData.get('objectType') ?? '').trim();
    const objectKey = String(formData.get('objectKey') ?? '').trim();
    const displayName = String(formData.get('displayName') ?? '').trim();
    if (!objectType || !objectKey || !displayName) return;

    try {
      setErrorMessage(null);
      await api.createObject(currentWorkspaceId, { objectType, objectKey, displayName });
      form.reset();
      await loadWorkspace(currentWorkspaceId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create object');
    }
  }

  async function handleCreateMapping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentWorkspaceId) return;
    const formData = new FormData(event.currentTarget);
    const workspaceAddressId = String(formData.get('workspaceAddressId') ?? '');
    const workspaceObjectId = String(formData.get('workspaceObjectId') ?? '');
    const mappingRole = String(formData.get('mappingRole') ?? '').trim();
    if (!workspaceAddressId || !workspaceObjectId || !mappingRole) return;

    try {
      setErrorMessage(null);
      await api.createObjectMapping(currentWorkspaceId, { workspaceAddressId, workspaceObjectId, mappingRole });
      event.currentTarget.reset();
      await loadWorkspace(currentWorkspaceId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create mapping');
    }
  }

  async function handleSelectEvent(eventItem: OperationalEvent) {
    if (!currentWorkspaceId) return;

    try {
      setSelectedEvent(eventItem);
      const response = await api.listParticipants(currentWorkspaceId, eventItem.workspace_event_id);
      setParticipants(response.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load participants');
    }
  }

  if (authStatus === 'booting') {
    return (
      <div className="app-root">
        <GridBackdrop />
        <CenteredState title="Booting control surface" body="Checking session, organizations, and workspace context." />
      </div>
    );
  }

  if (authStatus === 'anonymous' || !session || route.name === 'login') {
    return (
      <div className="app-root">
        <GridBackdrop />
        <div className="auth-shell">
          <section className="auth-hero">
            <p className="eyebrow">USDC//OPS</p>
            <h1>Operate stablecoin flows without guessing what happened.</h1>
            <p className="hero-copy">
              Monitor watched systems, keep entity mappings clean, and move from raw writes to operational context.
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

            <form className="form-stack" onSubmit={handleLogin}>
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
      </div>
    );
  }

  return (
    <div className="app-root">
      <GridBackdrop />
      <div className="shell">
        <header className="topbar">
          <div className="topbar-brand">
            <div>
              <p className="eyebrow">USDC//OPS</p>
              <strong>Stablecoin control surface</strong>
            </div>
            <span className="status-chip">{currentOrganization ? currentOrganization.organizationSlug : 'personal view'}</span>
          </div>

          <div className="topbar-meta">
            <button
              className="ghost-button"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              type="button"
            >
              {theme === 'dark' ? 'light mode' : 'dark mode'}
            </button>
            <span>{session.user.displayName}</span>
            <button className="ghost-button" onClick={handleLogout} type="button">
              logout
            </button>
          </div>
        </header>

        <div className="shell-grid">
          <aside className="rail">
            <div className="rail-section">
              <button
                className={route.name === 'dashboard' ? 'rail-link is-active' : 'rail-link'}
                onClick={() => navigate({ name: 'dashboard' }, setRoute)}
                type="button"
              >
                Dashboard
              </button>
              <button
                className={route.name === 'orgs' ? 'rail-link is-active' : 'rail-link'}
                onClick={() => navigate({ name: 'orgs' }, setRoute)}
                type="button"
              >
                Orgs
              </button>
              <button
                className={route.name === 'profile' ? 'rail-link is-active' : 'rail-link'}
                onClick={() => navigate({ name: 'profile' }, setRoute)}
                type="button"
              >
                Profile
              </button>
            </div>

            <div className="rail-section">
              <div className="section-header">
                <span>Active org</span>
              </div>
              <select
                value={activeOrganizationId ?? ''}
                onChange={(event) => setActiveOrganizationId(event.target.value || null)}
              >
                <option value="">No org selected</option>
                {session.organizations.map((organization) => (
                  <option key={organization.organizationId} value={organization.organizationId}>
                    {organization.organizationName}
                  </option>
                ))}
              </select>
            </div>

            {currentOrganization ? (
              <div className="rail-section">
                <div className="section-header">
                  <span>Watch systems</span>
                  <small>{currentOrganization.role}</small>
                </div>
                <div className="stack-list">
                  {currentOrganization.workspaces.length ? (
                    currentOrganization.workspaces.map((workspace) => (
                      <button
                        key={workspace.workspaceId}
                        className={
                          currentWorkspaceId === workspace.workspaceId &&
                          (route.name === 'workspaceHome' || route.name === 'workspaceSetup' || route.name === 'workspaceGraph')
                            ? 'workspace-link is-active'
                            : 'workspace-link'
                        }
                        onClick={() => navigate({ name: 'workspaceHome', workspaceId: workspace.workspaceId }, setRoute)}
                        type="button"
                      >
                        <strong>{workspace.workspaceName}</strong>
                        <small>{workspace.workspaceSlug}</small>
                      </button>
                    ))
                  ) : (
                    <div className="empty-box compact">No watch systems yet.</div>
                  )}
                </div>
              </div>
            ) : null}
          </aside>

          <main className="main-panel">
            {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

            {route.name === 'dashboard' ? (
              <DashboardPage
                currentOrganization={currentOrganization}
                onCreateWorkspace={handleCreateWorkspace}
                onGoOrgs={() => navigate({ name: 'orgs' }, setRoute)}
                onOpenWorkspace={(workspaceId) => navigate({ name: 'workspaceHome', workspaceId }, setRoute)}
                session={session}
              />
            ) : null}

            {route.name === 'orgs' ? (
              <OrganizationsPage
                currentOrganizationId={activeOrganizationId}
                directory={organizationDirectory}
                isLoading={isLoadingOrganizations}
                onCreateOrganization={handleCreateOrganization}
                onJoinOrganization={handleJoinOrganization}
                onSelectOrganization={setActiveOrganizationId}
                session={session}
              />
            ) : null}

            {route.name === 'profile' ? <ProfilePage session={session} /> : null}

            {route.name === 'workspaceHome' && currentWorkspace ? (
              <WorkspaceHomePage
                currentWorkspace={currentWorkspace}
                currentRole={currentRole}
                events={events}
                isLoading={isLoadingWorkspace}
                onboarding={onboarding}
                onOpenGraph={() => navigate({ name: 'workspaceGraph', workspaceId: currentWorkspace.workspaceId }, setRoute)}
                onOpenSetup={() => navigate({ name: 'workspaceSetup', workspaceId: currentWorkspace.workspaceId }, setRoute)}
                onSelectEvent={handleSelectEvent}
                participants={participants}
                reconciliationRows={reconciliationRows}
                selectedEvent={selectedEvent}
                setDirectionFilter={setDirectionFilter}
                setEventTypeFilter={setEventTypeFilter}
              />
            ) : null}

            {route.name === 'workspaceSetup' && currentWorkspace ? (
              <WorkspaceSetupPage
                canManage={canManageCurrentOrg}
                currentWorkspace={currentWorkspace}
                onAttachLabel={handleAttachLabel}
                onCreateAddress={handleCreateAddress}
                onCreateLabel={handleCreateLabel}
                onCreateMapping={handleCreateMapping}
                onCreateObject={handleCreateObject}
                onOpenGraph={() => navigate({ name: 'workspaceGraph', workspaceId: currentWorkspace.workspaceId }, setRoute)}
                snapshot={snapshot}
              />
            ) : null}

            {route.name === 'workspaceGraph' && currentWorkspace ? (
              <WorkspaceGraphPage
                currentWorkspace={currentWorkspace}
                onOpenHome={() => navigate({ name: 'workspaceHome', workspaceId: currentWorkspace.workspaceId }, setRoute)}
                onOpenSetup={() => navigate({ name: 'workspaceSetup', workspaceId: currentWorkspace.workspaceId }, setRoute)}
                snapshot={snapshot}
              />
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}

function DashboardPage({
  currentOrganization,
  onCreateWorkspace,
  onGoOrgs,
  onOpenWorkspace,
  session,
}: {
  currentOrganization: OrganizationMembership | null;
  onCreateWorkspace: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onGoOrgs: () => void;
  onOpenWorkspace: (workspaceId: string) => void;
  session: AuthenticatedSession;
}) {
  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>Welcome back, {session.user.displayName}.</h1>
          <p className="section-copy">
            This is the operator view. Choose an organization, inspect watch systems, and only enter setup when you are ready to map ownership.
          </p>
        </div>
        <div className="hero-metrics">
          <Metric label="Orgs" value={String(session.organizations.length).padStart(2, '0')} />
          <Metric label="Systems" value={String(countWorkspaces(session.organizations)).padStart(2, '0')} />
        </div>
      </section>

      {!currentOrganization ? (
        <section className="content-grid content-grid-single">
          <div className="empty-box large">
            <p className="eyebrow">No active organization</p>
            <h2>Create or join an org first.</h2>
            <p>
              The dashboard stays calm until you attach yourself to an organization. Once you do, watch systems and setup become available.
            </p>
            <button className="primary-button" onClick={onGoOrgs} type="button">
              Open orgs
            </button>
          </div>
        </section>
      ) : (
        <section className="content-grid">
          <div className="content-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Active org</p>
                <h2>{currentOrganization.organizationName}</h2>
              </div>
              <span className="status-chip">{currentOrganization.role}</span>
            </div>

            <div className="stack-list">
              {currentOrganization.workspaces.length ? (
                currentOrganization.workspaces.map((workspace) => (
                  <button
                    key={workspace.workspaceId}
                    className="workspace-row"
                    onClick={() => onOpenWorkspace(workspace.workspaceId)}
                    type="button"
                  >
                    <div>
                      <strong>{workspace.workspaceName}</strong>
                      <small>{workspace.workspaceSlug}</small>
                    </div>
                    <span>{workspace.status}</span>
                  </button>
                ))
              ) : (
                <div className="empty-box compact">No watch systems in this org yet.</div>
              )}
            </div>
          </div>

          <div className="content-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Create watch system</p>
                <h2>New workspace</h2>
              </div>
            </div>

            {isAdminRole(currentOrganization.role) ? (
              <form className="form-stack" onSubmit={onCreateWorkspace}>
                <label className="field">
                  <span>Workspace name</span>
                  <input name="workspaceName" placeholder="Primary Watch" required />
                </label>
                <label className="field">
                  <span>Workspace slug</span>
                  <input name="workspaceSlug" placeholder="primary-watch" required />
                </label>
                <button className="primary-button" type="submit">
                  Create system
                </button>
              </form>
            ) : (
              <div className="empty-box compact">Only org admins can create new watch systems.</div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function OrganizationsPage({
  currentOrganizationId,
  directory,
  isLoading,
  onCreateOrganization,
  onJoinOrganization,
  onSelectOrganization,
  session,
}: {
  currentOrganizationId: string | null;
  directory: OrganizationDirectoryItem[];
  isLoading: boolean;
  onCreateOrganization: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onJoinOrganization: (organizationId: string) => Promise<void>;
  onSelectOrganization: (organizationId: string) => void;
  session: AuthenticatedSession;
}) {
  return (
    <div className="page-stack">
      <section className="section-headline">
        <div>
          <p className="eyebrow">Organizations</p>
          <h1>Manage where this account can operate.</h1>
          <p className="section-copy">
            Membership controls which watch systems you can see. Admin role controls which ones you can configure.
          </p>
        </div>
      </section>

      <section className="content-grid">
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
                  className={currentOrganizationId === organization.organizationId ? 'workspace-row is-active' : 'workspace-row'}
                  onClick={() => onSelectOrganization(organization.organizationId)}
                  type="button"
                >
                  <div>
                    <strong>{organization.organizationName}</strong>
                    <small>{organization.organizationSlug}</small>
                  </div>
                  <span>{organization.role}</span>
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
            <label className="field">
              <span>Organization slug</span>
              <input name="organizationSlug" placeholder="acme-treasury" required />
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
                  {organization.organizationSlug} // {organization.workspaceCount} systems
                </small>
              </div>
              {organization.isMember ? (
                <span>{organization.membershipRole}</span>
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

function ProfilePage({ session }: { session: AuthenticatedSession }) {
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
                  <small>{organization.organizationSlug}</small>
                </div>
                <span>{organization.role}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function WorkspaceHomePage({
  currentWorkspace,
  currentRole,
  events,
  isLoading,
  onboarding,
  onOpenGraph,
  onOpenSetup,
  onSelectEvent,
  participants,
  reconciliationRows,
  selectedEvent,
  setDirectionFilter,
  setEventTypeFilter,
}: {
  currentWorkspace: Workspace;
  currentRole: string | null;
  events: OperationalEvent[];
  isLoading: boolean;
  onboarding: OnboardingState | null;
  onOpenGraph: () => void;
  onOpenSetup: () => void;
  onSelectEvent: (eventItem: OperationalEvent) => Promise<void>;
  participants: EventParticipant[];
  reconciliationRows: ReconciliationRow[];
  selectedEvent: OperationalEvent | null;
  setDirectionFilter: (value: string) => void;
  setEventTypeFilter: (value: string) => void;
}) {
  return (
    <div className="page-stack">
      <section className="section-headline">
        <div>
          <p className="eyebrow">Workspace home</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">{currentWorkspace.workspaceSlug} // live operations view</p>
        </div>
        <div className="headline-actions">
          <button className="ghost-button" onClick={onOpenGraph} type="button">
            graph
          </button>
          <button className="primary-button" onClick={onOpenSetup} type="button">
            setup
          </button>
        </div>
      </section>

      {onboarding && !onboarding.complete ? (
        <div className="notice-banner">
          <div>
            <strong>Setup is incomplete.</strong>
            <p>
              {onboarding.completedCount}/5 required mapping stages are done. Events still stream, but operational meaning is limited until the graph is defined.
            </p>
          </div>
          <button className="ghost-button" onClick={onOpenSetup} type="button">
            complete setup
          </button>
        </div>
      ) : null}

      <section className="content-grid">
        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Event feed</p>
              <h2>Operational events</h2>
            </div>
            <span className="status-chip">{isLoading ? 'syncing' : currentRole ?? 'member'}</span>
          </div>

          <div className="filter-row">
            <label className="field">
              <span>Type</span>
              <select defaultValue="" onChange={(event) => setEventTypeFilter(event.target.value)}>
                {EVENT_TYPE_OPTIONS.map((option) => (
                  <option key={option || 'all'} value={option}>
                    {option || 'all'}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Direction</span>
              <select defaultValue="" onChange={(event) => setDirectionFilter(event.target.value)}>
                {DIRECTION_OPTIONS.map((option) => (
                  <option key={option || 'all'} value={option}>
                    {option || 'all'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="stack-list">
            {events.length ? (
              events.map((eventItem) => (
                <button
                  key={eventItem.workspace_event_id}
                  className={selectedEvent?.workspace_event_id === eventItem.workspace_event_id ? 'feed-row is-active' : 'feed-row'}
                  onClick={() => onSelectEvent(eventItem)}
                  type="button"
                >
                  <div>
                    <strong>{eventItem.summary_text}</strong>
                    <small>
                      {eventItem.event_type} // {eventItem.signature.slice(0, 10)}...
                    </small>
                  </div>
                  <span>{eventItem.amount_decimal}</span>
                </button>
              ))
            ) : (
              <div className="empty-box compact">No events yet for this workspace.</div>
            )}
          </div>
        </div>

        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Inspector</p>
              <h2>Participants</h2>
            </div>
          </div>

          {selectedEvent ? (
            <div className="stack-list">
              <InfoLine label="Summary" value={selectedEvent.summary_text} />
              <InfoLine label="Direction" value={selectedEvent.direction} />
              <InfoLine label="Amount" value={selectedEvent.amount_decimal} />
              <InfoLine label="Signature" value={selectedEvent.signature} />
              {participants.map((participant) => (
                <div key={participant.participant_id} className="participant-row">
                  <strong>{participant.role}</strong>
                  <small>{participant.address}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-box compact">Select an event to inspect touched addresses and objects.</div>
          )}
        </div>
      </section>

      <section className="content-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Reconciliation</p>
            <h2>Latest export rows</h2>
          </div>
        </div>
        <div className="table-list">
          {reconciliationRows.length ? (
            reconciliationRows.map((row) => (
              <div key={row.reconciliation_row_id} className="table-row">
                <div>
                  <strong>{row.event_type}</strong>
                  <small>{row.signature.slice(0, 12)}...</small>
                </div>
                <span>{row.amount_decimal}</span>
              </div>
            ))
          ) : (
            <div className="empty-box compact">No reconciliation rows yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function WorkspaceSetupPage({
  canManage,
  currentWorkspace,
  onAttachLabel,
  onCreateAddress,
  onCreateLabel,
  onCreateMapping,
  onCreateObject,
  onOpenGraph,
  snapshot,
}: {
  canManage: boolean;
  currentWorkspace: Workspace;
  onAttachLabel: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateAddress: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateLabel: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateMapping: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateObject: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onOpenGraph: () => void;
  snapshot: OnboardingSnapshot | null;
}) {
  const onboarding = snapshot ? getOnboardingState(snapshot) : null;

  return (
    <div className="page-stack">
      <section className="section-headline">
        <div>
          <p className="eyebrow">Workspace setup</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">Define the addresses and business meaning this workspace actually cares about.</p>
        </div>
        <div className="headline-actions">
          <button className="ghost-button" onClick={onOpenGraph} type="button">
            open graph
          </button>
        </div>
      </section>

      {!canManage ? (
        <div className="notice-banner">
          <div>
            <strong>Read only.</strong>
            <p>Only org admins can change setup. You can inspect the graph here, but mutations are disabled for this account.</p>
          </div>
        </div>
      ) : null}

      <section className="content-grid">
        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Progress</p>
              <h2>Mapping status</h2>
            </div>
            <span className="status-chip">{onboarding ? `${onboarding.completedCount}/5` : '--'}</span>
          </div>
          <div className="stack-list">
            {onboarding?.steps.map((step) => (
              <div key={step.id} className={step.complete ? 'status-row is-complete' : 'status-row'}>
                <div>
                  <strong>{step.title}</strong>
                  <small>{step.hint}</small>
                </div>
                <span>{String(step.count).padStart(2, '0')}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Current graph</p>
              <h2>What exists now</h2>
            </div>
          </div>
          <div className="info-grid">
            <InfoLine label="Addresses" value={String(snapshot?.addresses.length ?? 0)} />
            <InfoLine label="Labels" value={String(snapshot?.labels.length ?? 0)} />
            <InfoLine label="Objects" value={String(snapshot?.objects.length ?? 0)} />
            <InfoLine label="Mappings" value={String(snapshot?.addressObjectMappings.length ?? 0)} />
          </div>
        </div>
      </section>

      <section className="content-grid content-grid-triple">
        <SetupForm
          title="Known addresses"
          subtitle="Add wallets or token accounts this workspace cares about."
          disabled={!canManage}
        >
          <form className="form-stack" onSubmit={onCreateAddress}>
            <label className="field">
              <span>Address</span>
              <input name="address" placeholder="Solana address" required />
            </label>
            <label className="field">
              <span>Kind</span>
              <input name="addressKind" placeholder="treasury_wallet" required />
            </label>
            <label className="field">
              <span>Notes</span>
              <input name="notes" placeholder="Optional" />
            </label>
            <button className="primary-button" disabled={!canManage} type="submit">
              Add address
            </button>
          </form>
        </SetupForm>

        <SetupForm title="Labels" subtitle="Attach semantic tags to addresses." disabled={!canManage}>
          <form className="form-stack" onSubmit={onCreateLabel}>
            <label className="field">
              <span>Label name</span>
              <input name="labelName" placeholder="treasury" required />
            </label>
            <label className="field">
              <span>Label type</span>
              <input name="labelType" placeholder="internal" required />
            </label>
            <button className="primary-button" disabled={!canManage} type="submit">
              Add label
            </button>
          </form>
        </SetupForm>

        <SetupForm title="Internal objects" subtitle="Create business objects like customer, merchant, treasury." disabled={!canManage}>
          <form className="form-stack" onSubmit={onCreateObject}>
            <label className="field">
              <span>Object type</span>
              <input name="objectType" placeholder="merchant" required />
            </label>
            <label className="field">
              <span>Object key</span>
              <input name="objectKey" placeholder="merchant-001" required />
            </label>
            <label className="field">
              <span>Display name</span>
              <input name="displayName" placeholder="Merchant 001" required />
            </label>
            <button className="primary-button" disabled={!canManage} type="submit">
              Add object
            </button>
          </form>
        </SetupForm>
      </section>

      <section className="content-grid">
        <SetupForm title="Address labels" subtitle="Apply meaning to a watched address." disabled={!canManage}>
          <form className="form-stack" onSubmit={onAttachLabel}>
            <label className="field">
              <span>Address</span>
              <select name="workspaceAddressId" defaultValue="" required>
                <option value="" disabled>
                  Select address
                </option>
                {snapshot?.addresses.map((address) => (
                  <option key={address.workspaceAddressId} value={address.workspaceAddressId}>
                    {address.address}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Label</span>
              <select name="labelId" defaultValue="" required>
                <option value="" disabled>
                  Select label
                </option>
                {snapshot?.labels.map((label) => (
                  <option key={label.labelId} value={label.labelId}>
                    {label.labelName}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={!canManage} type="submit">
              Attach label
            </button>
          </form>
        </SetupForm>

        <SetupForm title="Object mappings" subtitle="Bind watched addresses to business objects." disabled={!canManage}>
          <form className="form-stack" onSubmit={onCreateMapping}>
            <label className="field">
              <span>Address</span>
              <select name="workspaceAddressId" defaultValue="" required>
                <option value="" disabled>
                  Select address
                </option>
                {snapshot?.addresses.map((address) => (
                  <option key={address.workspaceAddressId} value={address.workspaceAddressId}>
                    {address.address}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Object</span>
              <select name="workspaceObjectId" defaultValue="" required>
                <option value="" disabled>
                  Select object
                </option>
                {snapshot?.objects.map((object) => (
                  <option key={object.workspaceObjectId} value={object.workspaceObjectId}>
                    {object.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Role</span>
              <input name="mappingRole" placeholder="owner" required />
            </label>
            <button className="primary-button" disabled={!canManage} type="submit">
              Attach mapping
            </button>
          </form>
        </SetupForm>
      </section>
    </div>
  );
}

function WorkspaceGraphPage({
  currentWorkspace,
  onOpenHome,
  onOpenSetup,
  snapshot,
}: {
  currentWorkspace: Workspace;
  onOpenHome: () => void;
  onOpenSetup: () => void;
  snapshot: OnboardingSnapshot | null;
}) {
  return (
    <div className="page-stack">
      <section className="section-headline">
        <div>
          <p className="eyebrow">Workspace graph</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">Read the entity model this workspace uses to interpret watched USDC flow.</p>
        </div>
        <div className="headline-actions">
          <button className="ghost-button" onClick={onOpenHome} type="button">
            home
          </button>
          <button className="primary-button" onClick={onOpenSetup} type="button">
            setup
          </button>
        </div>
      </section>

      <section className="content-grid">
        <GraphColumn
          title="Addresses"
          items={snapshot?.addresses.map((address) => ({
            key: address.workspaceAddressId,
            title: address.address,
            meta: address.addressKind,
          })) ?? []}
        />
        <GraphColumn
          title="Labels"
          items={snapshot?.labels.map((label) => ({
            key: label.labelId,
            title: label.labelName,
            meta: label.labelType,
          })) ?? []}
        />
      </section>

      <section className="content-grid">
        <GraphColumn
          title="Objects"
          items={snapshot?.objects.map((object) => ({
            key: object.workspaceObjectId,
            title: object.displayName,
            meta: `${object.objectType} // ${object.objectKey}`,
          })) ?? []}
        />
        <GraphColumn
          title="Mappings"
          items={snapshot?.addressObjectMappings.map((mapping) => ({
            key: mapping.mappingId ?? `${mapping.workspaceAddressId}:${mapping.workspaceObjectId}`,
            title: `${mapping.workspaceAddress.address} -> ${mapping.workspaceObject.displayName}`,
            meta: mapping.mappingRole,
          })) ?? []}
        />
      </section>
    </div>
  );
}

function GraphColumn({
  title,
  items,
}: {
  title: string;
  items: Array<{ key: string; title: string; meta: string }>;
}) {
  return (
    <div className="content-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Graph</p>
          <h2>{title}</h2>
        </div>
      </div>

      <div className="stack-list">
        {items.length ? (
          items.map((item) => (
            <div key={item.key} className="workspace-row static-row">
              <div>
                <strong>{item.title}</strong>
                <small>{item.meta}</small>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-box compact">Nothing here yet.</div>
        )}
      </div>
    </div>
  );
}

function SetupForm({
  children,
  disabled,
  subtitle,
  title,
}: {
  children: ReactNode;
  disabled: boolean;
  subtitle: string;
  title: string;
}) {
  return (
    <div className="content-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Setup</p>
          <h2>{title}</h2>
          <p className="section-copy compact-copy">{subtitle}</p>
        </div>
        <span className="status-chip">{disabled ? 'locked' : 'write'}</span>
      </div>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function GridBackdrop() {
  return <div className="grid-backdrop" aria-hidden="true" />;
}

function CenteredState({ body, title }: { body: string; title: string }) {
  return (
    <div className="centered-state">
      <p className="eyebrow">USDC//OPS</p>
      <h1>{title}</h1>
      <p>{body}</p>
    </div>
  );
}

function parseRoute(pathname: string): Route {
  if (pathname === '/login') return { name: 'login' };
  if (pathname === '/profile') return { name: 'profile' };
  if (pathname === '/orgs') return { name: 'orgs' };

  const workspaceMatch = pathname.match(/^\/workspaces\/([0-9a-f-]+)\/(home|setup|graph)$/i);
  if (workspaceMatch) {
    const [, workspaceId, page] = workspaceMatch;
    if (page === 'home') return { name: 'workspaceHome', workspaceId };
    if (page === 'setup') return { name: 'workspaceSetup', workspaceId };
    return { name: 'workspaceGraph', workspaceId };
  }

  return { name: 'dashboard' };
}

function navigate(route: Route, setRoute: (route: Route) => void, replace = false) {
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

function routeToPath(route: Route) {
  switch (route.name) {
    case 'login':
      return '/login';
    case 'dashboard':
      return '/';
    case 'profile':
      return '/profile';
    case 'orgs':
      return '/orgs';
    case 'workspaceHome':
      return `/workspaces/${route.workspaceId}/home`;
    case 'workspaceSetup':
      return `/workspaces/${route.workspaceId}/setup`;
    case 'workspaceGraph':
      return `/workspaces/${route.workspaceId}/graph`;
  }
}

function loadTheme(): Theme {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

function getActiveOrganization(session: AuthenticatedSession | null, organizationId: string | null) {
  if (!session || !organizationId) {
    return session?.organizations[0] ?? null;
  }

  return session.organizations.find((organization) => organization.organizationId === organizationId) ?? session.organizations[0] ?? null;
}

function findWorkspace(session: AuthenticatedSession | null, workspaceId: string) {
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

function findOrganizationForWorkspace(session: AuthenticatedSession | null, workspaceId: string) {
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

function isAdminRole(role: string | null | undefined) {
  return role === 'owner' || role === 'admin';
}

function countWorkspaces(organizations: OrganizationMembership[]) {
  return organizations.reduce((sum, organization) => sum + organization.workspaces.length, 0);
}

type OnboardingState = {
  complete: boolean;
  completedCount: number;
  steps: Array<{ id: OnboardingStepId; title: string; hint: string; count: number; complete: boolean }>;
};

function getOnboardingState(snapshot: OnboardingSnapshot): OnboardingState {
  const steps = [
    {
      id: 'addresses' as const,
      title: 'Known addresses',
      hint: 'watch universe',
      count: snapshot.addresses.length,
      complete: snapshot.addresses.length > 0,
    },
    {
      id: 'labels' as const,
      title: 'Labels',
      hint: 'semantic tags',
      count: snapshot.labels.length,
      complete: snapshot.labels.length > 0,
    },
    {
      id: 'objects' as const,
      title: 'Internal objects',
      hint: 'business entities',
      count: snapshot.objects.length,
      complete: snapshot.objects.length > 0,
    },
    {
      id: 'addressLabels' as const,
      title: 'Address labels',
      hint: 'attach meaning',
      count: snapshot.addressLabels.length,
      complete: snapshot.addressLabels.length > 0,
    },
    {
      id: 'mappings' as const,
      title: 'Object mappings',
      hint: 'bind addresses to objects',
      count: snapshot.addressObjectMappings.length,
      complete: snapshot.addressObjectMappings.length > 0,
    },
  ];

  const completedCount = steps.filter((step) => step.complete).length;

  return {
    complete: completedCount === steps.length,
    completedCount,
    steps,
  };
}
