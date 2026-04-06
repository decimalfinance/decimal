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
import { LandingEditorialPage } from './screens/landing-editorial';
import {
  WorkspaceHomePage,
  WorkspaceSetupPage,
} from './screens/workspace-pages';
import type {
  AuthenticatedSession,
  ObservedTransfer,
  ReconciliationDetail,
  ReconciliationRow,
  TransferRequest,
  WorkspaceAddress,
} from './types';

type AuthStatus = 'booting' | 'anonymous' | 'authenticated';
const WORKSPACE_REFRESH_INTERVAL_MS = 10_000;

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === 'dark') {
    return (
      <svg aria-hidden="true" className="theme-icon" viewBox="0 0 24 24">
        <path
          d="M12 4.5V2m0 20v-2.5M6.34 6.34 4.57 4.57m14.86 14.86-1.77-1.77M4.5 12H2m20 0h-2.5M6.34 17.66l-1.77 1.77m14.86-14.86-1.77 1.77M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className="theme-icon" viewBox="0 0 24 24">
      <path
        d="M21 12.8A9 9 0 1 1 11.2 3a7.2 7.2 0 0 0 9.8 9.8Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function resetViewport(sectionId?: string) {
  if (!sectionId) {
    if (window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }

  window.setTimeout(() => {
    window.location.hash = sectionId;
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 0);
}

export function App() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [authStatus, setAuthStatus] = useState<AuthStatus>('booting');
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [addresses, setAddresses] = useState<WorkspaceAddress[]>([]);
  const [transferRequests, setTransferRequests] = useState<TransferRequest[]>([]);
  const [observedTransfers, setObservedTransfers] = useState<ObservedTransfer[]>([]);
  const [reconciliationRows, setReconciliationRows] = useState<ReconciliationRow[]>([]);
  const [reconciliationFilter, setReconciliationFilter] = useState<
    ReconciliationRow['requestDisplayState'] | 'all'
  >('all');
  const [selectedObservedTransfer, setSelectedObservedTransfer] = useState<ObservedTransfer | null>(null);
  const [selectedReconciliationId, setSelectedReconciliationId] = useState<string | null>(null);
  const [selectedReconciliationDetail, setSelectedReconciliationDetail] = useState<ReconciliationDetail | null>(null);
  const [isLoadingReconciliationDetail, setIsLoadingReconciliationDetail] = useState(false);
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(false);
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
  const currentDashboardOrganizationId =
    currentWorkspaceOrganization?.organizationId ?? currentOrganization?.organizationId ?? null;
  const currentRole = currentWorkspaceOrganization?.role ?? currentOrganization?.role ?? null;
  const canManageCurrentOrg = isAdminRole(currentRole);
  const sidebarWorkspace = currentWorkspace ?? currentOrganization?.workspaces[0] ?? null;

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
    if (authStatus !== 'authenticated' || !currentWorkspaceId) {
      resetWorkspaceState();
      return;
    }

    void loadWorkspace(currentWorkspaceId);
  }, [authStatus, currentWorkspaceId, reconciliationFilter]);

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
    setSelectedObservedTransfer(null);
    setSelectedReconciliationId(null);
    setSelectedReconciliationDetail(null);
  }

  async function boot() {
    const currentRoute = parseRoute(window.location.pathname);
    if (!api.getSessionToken()) {
      setAuthStatus('anonymous');
      if (
        currentRoute.name !== 'landingEditorial' &&
        currentRoute.name !== 'login'
      ) {
        navigate({ name: 'landingEditorial' }, setRoute, true);
      }
      return;
    }

    try {
      const nextSession = await api.getSession();
      setSession(nextSession);
      setAuthStatus('authenticated');

      if (
        parseRoute(window.location.pathname).name === 'login' ||
        parseRoute(window.location.pathname).name === 'landingEditorial'
      ) {
        navigate({ name: 'dashboard' }, setRoute, true);
      }
    } catch {
      api.clearSessionToken();
      setSession(null);
      setAuthStatus('anonymous');
      if (
        currentRoute.name !== 'landingEditorial' &&
        currentRoute.name !== 'login'
      ) {
        navigate({ name: 'landingEditorial' }, setRoute, true);
      }
    }
  }

  async function refreshSession() {
    const nextSession = await api.getSession();
    setSession(nextSession);
    return nextSession;
  }

  async function loadReconciliationDetail(workspaceId: string, transferRequestId: string) {
    try {
      setIsLoadingReconciliationDetail(true);
      const detail = await api.getReconciliationDetail(workspaceId, transferRequestId);
      setSelectedReconciliationDetail(detail);
      setSelectedReconciliationId(transferRequestId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load request detail');
    } finally {
      setIsLoadingReconciliationDetail(false);
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
      ] = await Promise.all([
        api.listAddresses(workspaceId),
        api.listTransferRequests(workspaceId),
        api.listTransfers(workspaceId),
        api.listReconciliationQueue(
          workspaceId,
          reconciliationFilter === 'all' ? undefined : reconciliationFilter,
        ),
      ]);

      setAddresses(nextAddresses.items);
      setTransferRequests(nextTransferRequests.items);
      setObservedTransfers(nextTransfers.items);
      setReconciliationRows(nextReconciliation.items);

      if (
        selectedObservedTransfer &&
        !nextTransfers.items.some((transfer) => transfer.transferId === selectedObservedTransfer.transferId)
      ) {
        setSelectedObservedTransfer(null);
      }
      if (
        selectedReconciliationId &&
        !nextReconciliation.items.some((row) => row.transferRequestId === selectedReconciliationId)
      ) {
        setSelectedReconciliationId(null);
        setSelectedReconciliationDetail(null);
      }

      if (selectedReconciliationId) {
        await loadReconciliationDetail(workspaceId, selectedReconciliationId);
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
    resetWorkspaceState();
    setAuthStatus('anonymous');
    navigate({ name: 'landingEditorial' }, setRoute);
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

      await refreshSession();
      form.reset();
      navigate({ name: 'organizationHome', organizationId: organization.organizationId }, setRoute);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create organization');
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

  async function handleSelectReconciliation(row: ReconciliationRow) {
    if (!currentWorkspaceId) {
      return;
    }

    await loadReconciliationDetail(currentWorkspaceId, row.transferRequestId);
  }

  async function handleRefreshWorkspace() {
    if (!currentWorkspaceId) {
      return;
    }

    await loadWorkspace(currentWorkspaceId);
  }

  async function handleTransitionRequest(transferRequestId: string, toStatus: string) {
    if (!currentWorkspaceId || !selectedReconciliationDetail) {
      return;
    }

    try {
      setErrorMessage(null);
      await api.transitionTransferRequest(currentWorkspaceId, transferRequestId, {
        toStatus,
        linkedSignature: selectedReconciliationDetail.linkedSignature ?? undefined,
        linkedPaymentId: selectedReconciliationDetail.linkedPaymentId ?? undefined,
        linkedTransferIds: selectedReconciliationDetail.linkedTransferIds,
        payloadJson: {
          source: 'workspace_reconciliation_detail',
        },
      });
      await Promise.all([
        loadWorkspace(currentWorkspaceId),
        loadReconciliationDetail(currentWorkspaceId, transferRequestId),
      ]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to update request state');
    }
  }

  async function handleAddRequestNote(transferRequestId: string, body: string) {
    if (!currentWorkspaceId || !body.trim()) {
      return;
    }

    try {
      setErrorMessage(null);
      await api.addTransferRequestNote(currentWorkspaceId, transferRequestId, {
        body: body.trim(),
      });
      await Promise.all([
        loadWorkspace(currentWorkspaceId),
        loadReconciliationDetail(currentWorkspaceId, transferRequestId),
      ]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to add request note');
    }
  }

  async function handleAddExceptionNote(exceptionId: string, body: string) {
    if (!currentWorkspaceId || !selectedReconciliationId || !body.trim()) {
      return;
    }

    try {
      setErrorMessage(null);
      await api.addExceptionNote(currentWorkspaceId, exceptionId, {
        body: body.trim(),
      });
      await Promise.all([
        loadWorkspace(currentWorkspaceId),
        loadReconciliationDetail(currentWorkspaceId, selectedReconciliationId),
      ]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to add exception note');
    }
  }

  async function handleApplyExceptionAction(
    exceptionId: string,
    action: 'reviewed' | 'expected' | 'dismissed' | 'reopen',
    note?: string,
  ) {
    if (!currentWorkspaceId || !selectedReconciliationId) {
      return;
    }

    try {
      setErrorMessage(null);
      await api.applyExceptionAction(currentWorkspaceId, exceptionId, {
        action,
        note: note?.trim() ? note.trim() : undefined,
      });
      await Promise.all([
        loadWorkspace(currentWorkspaceId),
        loadReconciliationDetail(currentWorkspaceId, selectedReconciliationId),
      ]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to update exception');
    }
  }

  function handleOpenOrganization(organizationId: string) {
    navigate({ name: 'organizationHome', organizationId }, setRoute);
    resetViewport();
  }

  function handleOpenWorkspace(workspaceId: string) {
    navigate({ name: 'workspaceHome', workspaceId }, setRoute);
    resetViewport();
  }

  function handleOpenWorkspaceSetup(workspaceId: string, sectionId?: string) {
    navigate({ name: 'workspaceSetup', workspaceId }, setRoute);
    resetViewport(sectionId);
  }

  if (authStatus === 'booting') {
    return (
      <div className="app-root">
        <GridBackdrop />
        <CenteredState title="Booting control surface" body="Checking session, organizations, and workspace context." />
      </div>
    );
  }

  if (authStatus === 'anonymous' || !session) {
    return (
      <div className="app-root app-root-public">
        <GridBackdrop />
        {route.name === 'login' ? (
          <LoginScreen errorMessage={errorMessage} onLogin={handleLogin} />
        ) : (
          <LandingEditorialPage
            onLogin={() => navigate({ name: 'login' }, setRoute)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="app-root">
      <GridBackdrop />
      <div className="shell">
        <header className="topbar">
          <div className="topbar-brand">
            <strong>[project name]</strong>
            <span className="status-chip">
              {currentWorkspace ? currentWorkspace.workspaceName : currentOrganization ? currentOrganization.organizationName : 'personal view'}
            </span>
          </div>

          <nav className="topbar-nav" aria-label="Global navigation">
            <button
              className={route.name === 'dashboard' ? 'topbar-link is-active' : 'topbar-link'}
              onClick={() => navigate({ name: 'dashboard' }, setRoute)}
              type="button"
            >
              Dashboard
            </button>
            <button
              className={
                route.name === 'orgs' || route.name === 'organizationHome' || route.name === 'workspaceHome' || route.name === 'workspaceSetup'
                  ? 'topbar-link is-active'
                  : 'topbar-link'
              }
              onClick={() => navigate({ name: 'orgs' }, setRoute)}
              type="button"
            >
              Orgs
            </button>
            <button
              className={route.name === 'profile' ? 'topbar-link is-active' : 'topbar-link'}
              onClick={() => navigate({ name: 'profile' }, setRoute)}
              type="button"
            >
              Profile
            </button>
          </nav>

          <div className="topbar-meta">
            <button
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="ghost-button icon-button"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              type="button"
            >
              <ThemeIcon theme={theme} />
            </button>
            <span className="topbar-user">{session.user.displayName}</span>
            <button
              className="ghost-button danger-button"
              onClick={handleLogout}
              type="button"
            >
              Logout
            </button>
          </div>
        </header>

        <div className={currentOrganization ? 'shell-grid shell-grid-with-rail' : 'shell-grid shell-grid-full'}>
          {currentOrganization ? (
            <aside className="rail org-rail">
              <div className="rail-section">
                <div className="section-header">
                  <span>Org</span>
                  <small>{currentOrganization.role}</small>
                </div>
                <label className="field rail-field">
                  <span>Select org</span>
                  <select
                    aria-label="Select organization"
                    value={currentOrganization.organizationId}
                    onChange={(event) => handleOpenOrganization(event.target.value)}
                  >
                    {session.organizations.map((organization) => (
                      <option key={organization.organizationId} value={organization.organizationId}>
                        {organization.organizationName}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="stack-list">
                  <button
                    className={
                      route.name === 'organizationHome'
                        ? 'rail-link is-active'
                        : 'rail-link'
                    }
                    onClick={() => handleOpenOrganization(currentOrganization.organizationId)}
                    type="button"
                  >
                    Dashboard
                  </button>
                </div>
              </div>

              {sidebarWorkspace ? (
                <div className="rail-section">
                <div className="section-header">
                  <span>Current watch system</span>
                  <small>{sidebarWorkspace.workspaceName}</small>
                </div>
                <div className="stack-list">
                  <button
                    className={route.name === 'workspaceHome' ? 'rail-link is-active' : 'rail-link'}
                    onClick={() => handleOpenWorkspace(sidebarWorkspace.workspaceId)}
                    type="button"
                  >
                    Watch system
                  </button>
                  <button
                    className={route.name === 'workspaceSetup' ? 'rail-link is-active' : 'rail-link'}
                    onClick={() => handleOpenWorkspaceSetup(sidebarWorkspace.workspaceId)}
                    type="button"
                  >
                    Wallets + expected transfers
                  </button>
                </div>
              </div>
              ) : null}

              <div className="rail-section">
                <div className="section-header">
                  <span>Watch systems</span>
                  <small>{currentOrganization.workspaces.length}</small>
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
                        onClick={() => handleOpenWorkspace(workspace.workspaceId)}
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
            </aside>
          ) : null}

          <main className="main-panel">
            {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

            {route.name === 'dashboard' ? (
              <DashboardPage
                onGoOrgs={() => navigate({ name: 'orgs' }, setRoute)}
                onOpenOrganization={handleOpenOrganization}
                session={session}
              />
            ) : null}

            {route.name === 'orgs' ? (
              <OrganizationsPage
                onCreateOrganization={handleCreateOrganization}
                onOpenOrganization={handleOpenOrganization}
                session={session}
              />
            ) : null}

            {route.name === 'organizationHome' && currentOrganization ? (
              <OrganizationPage
                organization={currentOrganization}
                onCreateDemoWorkspace={handleCreateDemoWorkspace}
                onCreateWorkspace={handleCreateWorkspace}
                onOpenWorkspace={handleOpenWorkspace}
              />
            ) : null}

            {route.name === 'profile' ? <ProfilePage session={session} /> : null}

            {route.name === 'workspaceHome' && currentWorkspace ? (
              <WorkspaceHomePage
                addresses={addresses}
                currentWorkspace={currentWorkspace}
                currentRole={currentRole}
                isLoading={isLoadingWorkspace}
                observedTransfers={observedTransfers}
                onBackToDashboard={() => {
                  if (currentDashboardOrganizationId) handleOpenOrganization(currentDashboardOrganizationId);
                }}
                onOpenSetup={() => navigate({ name: 'workspaceSetup', workspaceId: currentWorkspace.workspaceId }, setRoute)}
                onAddExceptionNote={handleAddExceptionNote}
                onAddRequestNote={handleAddRequestNote}
                onApplyExceptionAction={handleApplyExceptionAction}
                onChangeReconciliationFilter={setReconciliationFilter}
                onRefresh={handleRefreshWorkspace}
                onSelectObservedTransfer={handleSelectObservedTransfer}
                onSelectReconciliation={(row) => void handleSelectReconciliation(row)}
                onTransitionRequest={handleTransitionRequest}
                reconciliationFilter={reconciliationFilter}
                reconciliationRows={reconciliationRows}
                selectedReconciliationDetail={selectedReconciliationDetail}
                selectedObservedTransfer={selectedObservedTransfer}
                transferRequests={transferRequests}
                isLoadingReconciliationDetail={isLoadingReconciliationDetail}
              />
            ) : null}

            {route.name === 'workspaceSetup' && currentWorkspace ? (
              <WorkspaceSetupPage
                addresses={addresses}
                canManage={canManageCurrentOrg}
                currentWorkspace={currentWorkspace}
                onBackToDashboard={() => {
                  if (currentDashboardOrganizationId) handleOpenOrganization(currentDashboardOrganizationId);
                }}
                onBackToWatchSystem={() => handleOpenWorkspace(currentWorkspace.workspaceId)}
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
