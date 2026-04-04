import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { api } from './api';
import { GridBackdrop, CenteredState } from './components/ui';
import {
  findOrganizationForWorkspace,
  findOrganization,
  findWorkspace,
  isAdminRole,
  loadTheme,
  navigate,
  parseRoute,
  THEME_STORAGE_KEY,
  type Route,
  type Theme,
} from './lib/app';
import {
  DashboardPage,
  LoginScreen,
  OrganizationPage,
  OrganizationsPage,
  ProfilePage,
} from './screens/general-pages';
import {
  WorkspaceHomePage,
  WorkspaceSetupPage,
} from './screens/workspace-pages';
import type {
  AuthenticatedSession,
  ExceptionItem,
  ObservedTransfer,
  OrganizationDirectoryItem,
  ReconciliationRow,
  TransferRequest,
  WorkspaceAddress,
} from './types';

type AuthStatus = 'booting' | 'anonymous' | 'authenticated';
const WORKSPACE_REFRESH_INTERVAL_MS = 10_000;

export function App() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [authStatus, setAuthStatus] = useState<AuthStatus>('booting');
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [organizationDirectory, setOrganizationDirectory] = useState<OrganizationDirectoryItem[]>([]);
  const [addresses, setAddresses] = useState<WorkspaceAddress[]>([]);
  const [transferRequests, setTransferRequests] = useState<TransferRequest[]>([]);
  const [observedTransfers, setObservedTransfers] = useState<ObservedTransfer[]>([]);
  const [reconciliationRows, setReconciliationRows] = useState<ReconciliationRow[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [selectedObservedTransfer, setSelectedObservedTransfer] = useState<ObservedTransfer | null>(null);
  const [selectedReconciliation, setSelectedReconciliation] = useState<ReconciliationRow | null>(null);
  const [workspaceServedAt, setWorkspaceServedAt] = useState<string | null>(null);
  const [workspaceLoadedAt, setWorkspaceLoadedAt] = useState<string | null>(null);
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(false);
  const [isLoadingOrganizations, setIsLoadingOrganizations] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const currentWorkspaceId =
    route.name === 'workspaceHome' || route.name === 'workspaceSetup'
      ? route.workspaceId
      : null;

  const currentWorkspace = currentWorkspaceId ? findWorkspace(session, currentWorkspaceId) : null;
  const currentWorkspaceOrganization = currentWorkspace ? findOrganizationForWorkspace(session, currentWorkspace.workspaceId) : null;
  const currentOrganization =
    route.name === 'organizationHome'
      ? findOrganization(session, route.organizationId)
      : currentWorkspaceOrganization;
  const currentRole = currentWorkspaceOrganization?.role ?? currentOrganization?.role ?? null;
  const canManageCurrentOrg = isAdminRole(currentRole);

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
    if (authStatus !== 'authenticated' || !currentWorkspaceId) {
      resetWorkspaceState();
      return;
    }

    void loadWorkspace(currentWorkspaceId);
  }, [authStatus, currentWorkspaceId]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !currentWorkspaceId || route.name !== 'workspaceHome') {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadWorkspace(currentWorkspaceId);
    }, WORKSPACE_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [authStatus, currentWorkspaceId, route.name]);

  function resetWorkspaceState() {
    setAddresses([]);
    setTransferRequests([]);
    setObservedTransfers([]);
    setReconciliationRows([]);
    setExceptions([]);
    setSelectedObservedTransfer(null);
    setSelectedReconciliation(null);
    setWorkspaceServedAt(null);
    setWorkspaceLoadedAt(null);
  }

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

      const [
        nextAddresses,
        nextTransferRequests,
        nextTransfers,
        nextReconciliation,
        nextExceptions,
      ] = await Promise.all([
        api.listAddresses(workspaceId),
        api.listTransferRequests(workspaceId),
        api.listTransfers(workspaceId),
        api.listReconciliation(workspaceId),
        api.listExceptions(workspaceId),
      ]);

      setAddresses(nextAddresses.items);
      setTransferRequests(nextTransferRequests.items);
      setObservedTransfers(nextTransfers.items);
      setReconciliationRows(nextReconciliation.items);
      setExceptions(nextExceptions.items);
      setWorkspaceServedAt(nextReconciliation.servedAt);
      setWorkspaceLoadedAt(new Date().toISOString());

      if (
        selectedObservedTransfer &&
        !nextTransfers.items.some((transfer) => transfer.transferId === selectedObservedTransfer.transferId)
      ) {
        setSelectedObservedTransfer(null);
      }
      if (
        selectedReconciliation &&
        !nextReconciliation.items.some((row) => row.transferRequestId === selectedReconciliation.transferRequestId)
      ) {
        setSelectedReconciliation(null);
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
    resetWorkspaceState();
    setAuthStatus('anonymous');
    navigate({ name: 'login' }, setRoute);
  }

  async function handleCreateOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const organizationName = String(formData.get('organizationName') ?? '').trim();

    if (!organizationName) {
      return;
    }

    try {
      setErrorMessage(null);
      const organization = await api.createOrganization({
        organizationName,
      });

      await Promise.all([refreshSession(), refreshOrganizationDirectory()]);
      form.reset();
      navigate({ name: 'organizationHome', organizationId: organization.organizationId }, setRoute);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create organization');
    }
  }

  async function handleJoinOrganization(organizationId: string) {
    try {
      setErrorMessage(null);
      await api.joinOrganization(organizationId);
      await Promise.all([refreshSession(), refreshOrganizationDirectory()]);
      navigate({ name: 'organizationHome', organizationId }, setRoute);
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

    if (!workspaceName) {
      return;
    }

    try {
      setErrorMessage(null);
      const workspace = await api.createWorkspace(currentOrganization.organizationId, {
        workspaceName,
      });

      await refreshSession();
      form.reset();
      navigate({ name: 'workspaceHome', workspaceId: workspace.workspaceId }, setRoute);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create workspace');
    }
  }

  async function handleCreateDemoWorkspace() {
    if (!currentOrganization) {
      return;
    }

    try {
      setErrorMessage(null);
      const workspace = await api.createDemoWorkspace(currentOrganization.organizationId);
      await refreshSession();
      navigate({ name: 'workspaceHome', workspaceId: workspace.workspaceId }, setRoute);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create demo workspace');
    }
  }

  async function handleCreateAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentWorkspaceId) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const address = String(formData.get('address') ?? '').trim();
    const displayName = String(formData.get('displayName') ?? '').trim();
    const notes = String(formData.get('notes') ?? '').trim();
    if (!address) return;

    try {
      setErrorMessage(null);
      await api.createAddress(currentWorkspaceId, {
        address,
        displayName: displayName || undefined,
        notes: notes || undefined,
      });
      form.reset();
      await loadWorkspace(currentWorkspaceId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create address');
    }
  }

  async function handleCreateTransferRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentWorkspaceId) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const sourceWorkspaceAddressId = String(formData.get('sourceWorkspaceAddressId') ?? '').trim();
    const destinationWorkspaceAddressId = String(formData.get('destinationWorkspaceAddressId') ?? '').trim();
    const requestType = String(formData.get('requestType') ?? '').trim();
    const amountRaw = String(formData.get('amountRaw') ?? '').trim();
    const reason = String(formData.get('reason') ?? '').trim();
    const externalReference = String(formData.get('externalReference') ?? '').trim();
    const status = String(formData.get('status') ?? '').trim();
    if (!destinationWorkspaceAddressId || !requestType || !amountRaw) return;

    try {
      setErrorMessage(null);
      await api.createTransferRequest(currentWorkspaceId, {
        sourceWorkspaceAddressId: sourceWorkspaceAddressId || undefined,
        destinationWorkspaceAddressId,
        requestType,
        amountRaw,
        reason: reason || undefined,
        externalReference: externalReference || undefined,
        status: status || undefined,
      });
      form.reset();
      await loadWorkspace(currentWorkspaceId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create transfer request');
    }
  }

  function handleSelectObservedTransfer(transfer: ObservedTransfer) {
    setSelectedObservedTransfer(transfer);
  }

  function handleSelectReconciliation(row: ReconciliationRow) {
    setSelectedReconciliation(row);
  }

  async function handleRefreshWorkspace() {
    if (!currentWorkspaceId) {
      return;
    }

    await loadWorkspace(currentWorkspaceId);
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
        <LoginScreen errorMessage={errorMessage} onLogin={handleLogin} />
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
            <span className="status-chip">
              {currentWorkspace ? currentWorkspace.workspaceName : currentOrganization ? currentOrganization.organizationName : 'personal view'}
            </span>
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

            {session.organizations.length ? (
              <div className="rail-section">
                <div className="section-header">
                  <span>Organizations</span>
                </div>
                <div className="stack-list">
                  {session.organizations.map((organization) => (
                    <button
                      key={organization.organizationId}
                      className={
                        route.name === 'organizationHome' && route.organizationId === organization.organizationId
                          ? 'workspace-link is-active'
                          : 'workspace-link'
                      }
                      onClick={() => navigate({ name: 'organizationHome', organizationId: organization.organizationId }, setRoute)}
                      type="button"
                    >
                      <strong>{organization.organizationName}</strong>
                      <small>{organization.role}</small>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {currentOrganization ? (
              <div className="rail-section">
                <div className="section-header">
                  <span>Workspaces</span>
                  <small>{currentOrganization.role}</small>
                </div>
                <div className="stack-list">
                  {currentOrganization.workspaces.length ? (
                    currentOrganization.workspaces.map((workspace) => (
                      <button
                        key={workspace.workspaceId}
                        className={
                          currentWorkspaceId === workspace.workspaceId &&
                          (route.name === 'workspaceHome' || route.name === 'workspaceSetup')
                            ? 'workspace-link is-active'
                            : 'workspace-link'
                        }
                        onClick={() => navigate({ name: 'workspaceHome', workspaceId: workspace.workspaceId }, setRoute)}
                        type="button"
                      >
                        <strong>{workspace.workspaceName}</strong>
                        <small>{workspace.status}</small>
                      </button>
                    ))
                  ) : (
                    <div className="empty-box compact">No workspaces yet.</div>
                  )}
                </div>
              </div>
            ) : null}
          </aside>

          <main className="main-panel">
            {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

            {route.name === 'dashboard' ? (
              <DashboardPage
                onGoOrgs={() => navigate({ name: 'orgs' }, setRoute)}
                onOpenOrganization={(organizationId) => navigate({ name: 'organizationHome', organizationId }, setRoute)}
                onOpenWorkspace={(workspaceId) => navigate({ name: 'workspaceHome', workspaceId }, setRoute)}
                session={session}
              />
            ) : null}

            {route.name === 'orgs' ? (
              <OrganizationsPage
                directory={organizationDirectory}
                isLoading={isLoadingOrganizations}
                onCreateOrganization={handleCreateOrganization}
                onJoinOrganization={handleJoinOrganization}
                onOpenOrganization={(organizationId) => navigate({ name: 'organizationHome', organizationId }, setRoute)}
                session={session}
              />
            ) : null}

            {route.name === 'organizationHome' && currentOrganization ? (
              <OrganizationPage
                organization={currentOrganization}
                onCreateDemoWorkspace={handleCreateDemoWorkspace}
                onCreateWorkspace={handleCreateWorkspace}
                onOpenWorkspace={(workspaceId) => navigate({ name: 'workspaceHome', workspaceId }, setRoute)}
              />
            ) : null}

            {route.name === 'profile' ? <ProfilePage session={session} /> : null}

            {route.name === 'workspaceHome' && currentWorkspace ? (
              <WorkspaceHomePage
                addresses={addresses}
                currentWorkspace={currentWorkspace}
                currentRole={currentRole}
                exceptions={exceptions}
                isLoading={isLoadingWorkspace}
                observedTransfers={observedTransfers}
                onOpenSetup={() => navigate({ name: 'workspaceSetup', workspaceId: currentWorkspace.workspaceId }, setRoute)}
                onRefresh={handleRefreshWorkspace}
                onSelectObservedTransfer={handleSelectObservedTransfer}
                onSelectReconciliation={handleSelectReconciliation}
                reconciliationRows={reconciliationRows}
                selectedReconciliation={selectedReconciliation}
                selectedObservedTransfer={selectedObservedTransfer}
                workspaceLoadedAt={workspaceLoadedAt}
                workspaceServedAt={workspaceServedAt}
                transferRequests={transferRequests}
              />
            ) : null}

            {route.name === 'workspaceSetup' && currentWorkspace ? (
              <WorkspaceSetupPage
                addresses={addresses}
                canManage={canManageCurrentOrg}
                currentWorkspace={currentWorkspace}
                onCreateAddress={handleCreateAddress}
                onCreateTransferRequest={handleCreateTransferRequest}
                transferRequests={transferRequests}
              />
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}
