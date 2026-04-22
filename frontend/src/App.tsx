import type { FormEvent, ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppSidebar } from './Sidebar';
import { api } from './api';
import { PaymentRunDetailPage as PaymentRunDetailPageV2 } from './pages/PaymentRunDetail';
import { CommandCenterPage as CommandCenterPageV2 } from './pages/CommandCenter';
import { PaymentsPage as PaymentsPageV2 } from './pages/Payments';
import { PaymentDetailPage as PaymentDetailPageV2 } from './pages/PaymentDetail';
import { CollectionsPage } from './pages/Collections';
import { CollectionDetailPage } from './pages/CollectionDetail';
import { CollectionRunDetailPage } from './pages/CollectionRunDetail';
import { CollectionSourcesPage } from './pages/CollectionSources';
import { WalletsPage } from './pages/Wallets';
import { CounterpartiesPage } from './pages/Counterparties';
import { DestinationsPage } from './pages/Destinations';
import { ProofsPage as ProofsPageV2 } from './pages/Proofs';
import { ExecutionPage as ExecutionPageV2 } from './pages/Execution';
import { SettlementPage as SettlementPageV2 } from './pages/Settlement';
import { ApprovalsPage as ApprovalsPageV2 } from './pages/Approvals';
import { LandingPage as LandingPageV2 } from './pages/Landing';
import { useToast } from './ui/Toast';
import type {
  ApprovalPolicy,
  AuthenticatedSession,
  Counterparty,
  Destination,
  ExceptionItem,
  PaymentExecutionPacket,
  PaymentOrder,
  PaymentOrderState,
  PaymentRequest,
  PaymentRun,
  PaymentRunExecutionPreparation,
  ReconciliationRow,
  ReconciliationTimelineItem,
  ObservedTransfer,
  TreasuryWallet,
  Workspace,
} from './api';
import {
  discoverSolanaWallets,
  formatRawUsdcCompact,
  formatRelativeTime,
  formatTimestamp,
  orbTransactionUrl,
  shortenAddress,
  signAndSubmitPreparedPayment,
  subscribeSolanaWallets,
  type BrowserWalletOption,
} from './domain';
import { parseCsvPreview } from './csv-parse';
import { ProofJsonView } from './proof-json-view';
import {
  approvalReasonLine,
  displayPaymentRequestState,
  displayPaymentStatus,
  displayReconciliationState,
  displayRunStatus,
  EXECUTION_BUCKETS,
  executionBucketTitle,
  type ExecutionBucket,
  humanizeExceptionReason,
  isPaymentOrderState,
  nextPaymentAction,
  paymentExecutionBucket,
  statusToneForPayment,
  toneForGenericState,
  trustDisplay,
} from './status-labels';
import {
  Collapsible,
  DataTableShell,
  Drawer,
  EmptyPanel,
  MetricTile,
  Modal,
  PanelHeader,
  Tabs,
} from './ui-primitives';

function queryKeys(workspaceId?: string, paymentOrderId?: string) {
  return {
    session: ['session'] as const,
    addresses: ['addresses', workspaceId] as const,
    counterparties: ['counterparties', workspaceId] as const,
    destinations: ['destinations', workspaceId] as const,
    paymentRequests: ['payment-requests', workspaceId] as const,
    paymentRuns: ['payment-runs', workspaceId] as const,
    paymentRun: ['payment-run', workspaceId, paymentOrderId] as const,
    paymentOrders: ['payment-orders', workspaceId] as const,
    paymentOrder: ['payment-order', workspaceId, paymentOrderId] as const,
    approvalPolicy: ['approval-policy', workspaceId] as const,
    exceptions: ['exceptions', workspaceId] as const,
  };
}

function toAuthenticatedSession(result: { user: AuthenticatedSession['user']; organizations: AuthenticatedSession['organizations'] }): AuthenticatedSession {
  return {
    authenticated: true,
    user: result.user,
    organizations: result.organizations,
  };
}

export function App() {
  const location = useLocation();
  const shouldCheckSession = location.pathname !== '/login' && api.hasSessionToken();
  const sessionQuery = useQuery({
    queryKey: queryKeys().session,
    queryFn: () => api.getSession(),
    enabled: shouldCheckSession,
    retry: false,
  });

  return (
    <Routes>
      <Route path="/" element={<LandingPageV2 />} />
      <Route path="/landing" element={<LandingPageV2 />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={<RequireSession sessionQuery={sessionQuery} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RequireSession({
  sessionQuery,
}: {
  sessionQuery: ReturnType<typeof useQuery<AuthenticatedSession>>;
}) {
  if (sessionQuery.isLoading) {
    return <ScreenState title="Loading workspace" description="Checking your session." />;
  }

  if (!sessionQuery.data) {
    return <Navigate to="/login" replace />;
  }

  return <AppShell session={sessionQuery.data} />;
}

function AppShell({ session }: { session: AuthenticatedSession }) {
  const workspaces = useMemo(() => getWorkspaces(session), [session]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const activeWorkspaceId = useMemo(() => {
    const match = location.pathname.match(/^\/workspaces\/([^/]+)/);
    return match?.[1];
  }, [location.pathname]);
  const sidebarOrdersQuery = useQuery({
    queryKey: queryKeys(activeWorkspaceId).paymentOrders,
    queryFn: () => api.listPaymentOrders(activeWorkspaceId!),
    enabled: Boolean(activeWorkspaceId),
    // Keeps sidebar badges (approvals / execution queue) fresh without hammering the API.
    refetchInterval: () =>
      typeof document !== 'undefined' && document.hidden ? false : 15_000,
  });
  const approvalPendingCount = useMemo(
    () => (sidebarOrdersQuery.data?.items ?? []).filter((order) => order.derivedState === 'pending_approval').length,
    [sidebarOrdersQuery.data?.items],
  );
  const executionQueueCount = useMemo(
    () => (sidebarOrdersQuery.data?.items ?? []).filter((order) => paymentExecutionBucket(order) !== null).length,
    [sidebarOrdersQuery.data?.items],
  );
  const paymentsIncompleteCount = useMemo(
    () =>
      (sidebarOrdersQuery.data?.items ?? []).filter(
        (order) => !['settled', 'closed', 'cancelled'].includes(order.derivedState),
      ).length,
    [sidebarOrdersQuery.data?.items],
  );
  const sidebarCollectionsQuery = useQuery({
    queryKey: ['sidebar-collections', activeWorkspaceId] as const,
    queryFn: () => api.listCollections(activeWorkspaceId!),
    enabled: Boolean(activeWorkspaceId),
    refetchInterval: () =>
      typeof document !== 'undefined' && document.hidden ? false : 15_000,
  });
  const collectionsOpenCount = useMemo(
    () =>
      (sidebarCollectionsQuery.data?.items ?? []).filter(
        (c) => !['collected', 'closed', 'cancelled'].includes(c.derivedState),
      ).length,
    [sidebarCollectionsQuery.data?.items],
  );
  const sidebarPayersQuery = useQuery({
    queryKey: ['sidebar-collection-sources', activeWorkspaceId] as const,
    queryFn: () => api.listCollectionSources(activeWorkspaceId!),
    enabled: Boolean(activeWorkspaceId),
    refetchInterval: () =>
      typeof document !== 'undefined' && document.hidden ? false : 30_000,
  });
  const payersUnreviewedCount = useMemo(
    () =>
      (sidebarPayersQuery.data?.items ?? []).filter((s) => s.trustState === 'unreviewed').length,
    [sidebarPayersQuery.data?.items],
  );

  async function logout() {
    await queryClient.cancelQueries();
    await api.logout().catch(() => undefined);
    api.clearSessionToken();
    queryClient.removeQueries({ queryKey: queryKeys().session });
    queryClient.clear();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <AppSidebar
        session={session}
        workspaceContexts={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        paymentsIncompleteCount={paymentsIncompleteCount}
        collectionsOpenCount={collectionsOpenCount}
        payersUnreviewedCount={payersUnreviewedCount}
        approvalPendingCount={approvalPendingCount}
        executionQueueCount={executionQueueCount}
        onWorkspaceSwitch={(workspaceId) => navigate(`/workspaces/${workspaceId}`)}
        onLogout={logout}
      />
      <main className="main-surface">
        <Routes>
          <Route path="/" element={<HomeRedirect session={session} />} />
          <Route path="/setup" element={<SetupPage session={session} />} />
          <Route path="/profile" element={<ProfilePage session={session} />} />
          <Route path="/workspaces/:workspaceId" element={<CommandCenterPageV2 session={session} />} />
          <Route path="/workspaces/:workspaceId/wallets" element={<WalletsPage session={session} />} />
          <Route path="/workspaces/:workspaceId/counterparties" element={<CounterpartiesPage session={session} />} />
          <Route path="/workspaces/:workspaceId/destinations" element={<DestinationsPage session={session} />} />
          <Route path="/workspaces/:workspaceId/registry" element={<AddressBookPage session={session} />} />
          <Route path="/workspaces/:workspaceId/requests" element={<PaymentRequestsPage session={session} />} />
          <Route path="/workspaces/:workspaceId/runs" element={<PaymentsPageV2 session={session} />} />
          <Route path="/workspaces/:workspaceId/runs/:paymentRunId" element={<PaymentRunDetailPageV2 />} />
          <Route path="/workspaces/:workspaceId/payments" element={<PaymentsPageV2 session={session} />} />
          <Route path="/workspaces/:workspaceId/payments/:paymentOrderId" element={<PaymentDetailPageV2 />} />
          <Route path="/workspaces/:workspaceId/collections" element={<CollectionsPage session={session} />} />
          <Route path="/workspaces/:workspaceId/collections/:collectionRequestId" element={<CollectionDetailPage />} />
          <Route path="/workspaces/:workspaceId/collection-runs/:collectionRunId" element={<CollectionRunDetailPage />} />
          <Route path="/workspaces/:workspaceId/payers" element={<CollectionSourcesPage session={session} />} />
          <Route path="/workspaces/:workspaceId/approvals" element={<ApprovalsPageV2 session={session} />} />
          <Route path="/workspaces/:workspaceId/execution" element={<ExecutionPageV2 session={session} />} />
          <Route path="/workspaces/:workspaceId/settlement" element={<SettlementPageV2 session={session} />} />
          <Route path="/workspaces/:workspaceId/proofs" element={<ProofsPageV2 session={session} />} />
          <Route path="/workspaces/:workspaceId/policy" element={<PolicyPage session={session} />} />
          <Route path="/workspaces/:workspaceId/exceptions" element={<ExceptionsPage session={session} />} />
          <Route path="/workspaces/:workspaceId/exceptions/:exceptionId" element={<ExceptionDetailPage session={session} />} />
        </Routes>
      </main>
    </div>
  );
}

function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const loginMutation = useMutation({
    mutationFn: (nextEmail: string) => {
      // Always start login from a clean auth state so stale tokens cannot win.
      void queryClient.cancelQueries({ queryKey: queryKeys().session });
      queryClient.removeQueries({ queryKey: queryKeys().session });
      api.clearSessionToken();
      return api.login({ email: nextEmail });
    },
    onSuccess: async (result, submittedEmail) => {
      const expectedEmail = submittedEmail.trim().toLowerCase();
      const actualEmail = result.user.email.trim().toLowerCase();
      if (expectedEmail && expectedEmail !== actualEmail) {
        api.clearSessionToken();
        queryClient.removeQueries({ queryKey: queryKeys().session });
        setError(`Sign-in mismatch: entered ${submittedEmail}, received session for ${result.user.email}. Please retry.`);
        return;
      }
      api.setSessionToken(result.sessionToken);
      queryClient.setQueryData(queryKeys().session, toAuthenticatedSession(result));
      const firstWorkspaceId = result.organizations[0]?.workspaces[0]?.workspaceId;
      navigate(firstWorkspaceId ? `/workspaces/${firstWorkspaceId}` : '/setup', { replace: true });
    },
    onError: (nextError) => {
      setError(nextError instanceof Error ? nextError.message : 'Unable to sign in.');
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError('Email is required.');
      return;
    }
    setError(null);
    loginMutation.mutate(normalizedEmail);
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Email
            <input
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ops@company.com"
              autoComplete="email"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="email"
            />
          </label>
          <button className="button button-primary" disabled={loginMutation.isPending} type="submit">
            {loginMutation.isPending ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
        {error ? <p className="form-error">{error}</p> : null}
      </section>
    </main>
  );
}

function HomeRedirect({ session }: { session: AuthenticatedSession }) {
  const [first] = getWorkspaces(session);
  if (!first) {
    return <Navigate to="/setup" replace />;
  }

  return <Navigate to={`/workspaces/${first.workspace.workspaceId}`} replace />;
}

function SetupPage({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();
  const createWorkspaceMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const organizationName = String(formData.get('organizationName') ?? '').trim();
      const existingOrganizationId = String(formData.get('existingOrganizationId') ?? '').trim();
      const workspaceName = String(formData.get('workspaceName') ?? '').trim();
      if (!workspaceName) {
        throw new Error('Workspace name is required.');
      }
      const organization = existingOrganizationId
        ? session.organizations.find((candidate) => candidate.organizationId === existingOrganizationId)
        : await api.createOrganization({ organizationName });
      if (!organization) {
        throw new Error('Pick an existing organization or give a new organization name.');
      }
      const workspace = await api.createWorkspace(organization.organizationId, { workspaceName });
      return workspace;
    },
    onSuccess: async (workspace) => {
      success('Workspace created.');
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      navigate(`/workspaces/${workspace.workspaceId}`, { replace: true });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to create workspace.'),
  });

  const hasOrganizations = session.organizations.length > 0;

  return (
    <PageFrame
      eyebrow="Setup"
      title={hasOrganizations ? 'New workspace' : 'Create your first workspace'}
      description={
        hasOrganizations
          ? 'Add another workspace under an organization you belong to, or start a new organization.'
          : 'An organization holds your workspaces. A workspace is where you track payments.'
      }
    >
      <section className="panel" style={{ maxWidth: 560 }}>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            createWorkspaceMutation.mutate(new FormData(event.currentTarget));
          }}
        >
          {hasOrganizations ? (
            <label className="field">
              Organization
              <select name="existingOrganizationId" defaultValue="">
                <option value="">Create a new organization</option>
                {session.organizations.map((organization) => (
                  <option key={organization.organizationId} value={organization.organizationId}>
                    {organization.organizationName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            New organization name
            <input
              name="organizationName"
              placeholder="Acme Treasury"
              autoComplete="organization"
            />
          </label>
          <label className="field">
            Workspace name
            <input
              name="workspaceName"
              placeholder="Main stablecoin desk"
              required
              autoComplete="off"
            />
          </label>
          <button
            className="button button-primary"
            disabled={createWorkspaceMutation.isPending}
            type="submit"
            aria-busy={createWorkspaceMutation.isPending}
          >
            {createWorkspaceMutation.isPending ? 'Creating…' : 'Create workspace'}
          </button>
        </form>
      </section>
    </PageFrame>
  );
}

function ProfilePage({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();
  const createWorkspaceMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const organizationId = getFormString(formData, 'organizationId');
      const workspaceName = getFormString(formData, 'workspaceName');
      if (!organizationId) throw new Error('Select an organization.');
      if (!workspaceName) throw new Error('Workspace name is required.');
      return api.createWorkspace(organizationId, { workspaceName });
    },
    onSuccess: async (workspace) => {
      success('Workspace created.');
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      navigate(`/workspaces/${workspace.workspaceId}`);
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to create workspace.'),
  });
  const createOrganizationMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const organizationName = getFormString(formData, 'organizationName');
      const firstWorkspaceName = getOptionalFormString(formData, 'firstWorkspaceName');
      if (!organizationName) throw new Error('Organization name is required.');
      const organization = await api.createOrganization({ organizationName });
      if (firstWorkspaceName) {
        const workspace = await api.createWorkspace(organization.organizationId, { workspaceName: firstWorkspaceName });
        return { organization, workspace };
      }
      return { organization, workspace: null };
    },
    onSuccess: async (result) => {
      success(result.workspace ? 'Organization and workspace created.' : 'Organization created.');
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      if (result.workspace) {
        navigate(`/workspaces/${result.workspace.workspaceId}`);
      }
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to create organization.'),
  });

  return (
    <PageFrame
      eyebrow="Account"
      title="Profile"
      description="Manage your identity, organizations, and workspaces."
    >
      <div className="metric-strip metric-strip-three">
        <Metric label="Organizations" value={String(session.organizations.length)} />
        <Metric label="Workspaces" value={String(getWorkspaces(session).length)} />
        <Metric label="User" value={session.user.email} />
      </div>
      <div className="split-panels">
        <section className="panel">
          <SectionHeader title="Create workspace in existing org" description="Add another workspace under an organization you already belong to." />
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              createWorkspaceMutation.mutate(new FormData(event.currentTarget));
            }}
          >
            <label className="field">
              Organization
              <select name="organizationId" defaultValue="">
                <option value="" disabled>Select organization</option>
                {session.organizations.map((org) => (
                  <option key={org.organizationId} value={org.organizationId}>{org.organizationName}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Workspace name
              <input name="workspaceName" placeholder="Treasury Ops APAC" />
            </label>
            <button className="button button-primary" disabled={createWorkspaceMutation.isPending} type="submit">
              {createWorkspaceMutation.isPending ? 'Creating…' : 'Create workspace'}
            </button>
          </form>
        </section>
        <section className="panel">
          <SectionHeader title="Create organization" description="Create a new organization and optionally seed its first workspace." />
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              createOrganizationMutation.mutate(new FormData(event.currentTarget));
            }}
          >
            <label className="field">
              Organization name
              <input name="organizationName" placeholder="Acme Treasury Group" />
            </label>
            <label className="field">
              First workspace (optional)
              <input name="firstWorkspaceName" placeholder="Main desk" />
            </label>
            <button className="button button-primary" disabled={createOrganizationMutation.isPending} type="submit">
              {createOrganizationMutation.isPending ? 'Creating…' : 'Create organization'}
            </button>
          </form>
        </section>
      </div>
      <section className="panel panel-spaced">
        <SectionHeader title="Your organizations" description="Organizations and workspaces you're a member of." />
        <SimpleList
          items={session.organizations.map((org) => ({
            id: org.organizationId,
            title: org.organizationName,
            meta: `${org.workspaces.length} workspace${org.workspaces.length === 1 ? '' : 's'}`,
          }))}
          empty="You don't belong to any organization yet."
        />
      </section>
    </PageFrame>
  );
}

function CommandCenterPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const workspace = findWorkspace(session, workspaceId);
  const paymentOrdersQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentOrders,
    queryFn: () => api.listPaymentOrders(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const paymentRunsQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentRuns,
    queryFn: () => api.listPaymentRuns(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const exceptionsQuery = useQuery({
    queryKey: queryKeys(workspaceId).exceptions,
    queryFn: () => api.listExceptions(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });

  if (!workspaceId || !workspace) {
    return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar or create one in setup." />;
  }

  const orders = paymentOrdersQuery.data?.items ?? [];
  const runs = paymentRunsQuery.data?.items ?? [];
  const exceptions = exceptionsQuery.data?.items ?? [];
  const needsApproval = orders.filter((order) => order.derivedState === 'pending_approval');
  const ready = orders.filter((order) => order.derivedState === 'ready_for_execution');
  const unsettled = orders.filter((order) => ['execution_recorded', 'approved', 'partially_settled'].includes(order.derivedState));
  const completed = orders.filter((order) => ['settled', 'closed'].includes(order.derivedState));
  const openExceptions = exceptions.filter((item) => item.status !== 'dismissed');
  const agingCritical = orders.filter((order) => {
    if (['settled', 'closed', 'cancelled'].includes(order.derivedState)) return false;
    return ageHours(order.createdAt) >= 24;
  }).length;
  const priorityRows = [...orders]
    .filter((order) => ['pending_approval', 'approved', 'ready_for_execution', 'execution_recorded', 'partially_settled', 'exception'].includes(order.derivedState))
    .sort((a, b) => commandPriorityScore(b) - commandPriorityScore(a))
    .slice(0, 10);

  return (
    <PageFrame
      eyebrow="Command Center"
      title={workspace.workspaceName}
      description="Daily payment work across intake, approval, execution, settlement, exceptions, and proof."
      action={
        <div className="action-cluster">
          <Link className="button button-secondary" to={`/workspaces/${workspaceId}/requests`}>New request</Link>
          <Link className="button button-primary" to={`/workspaces/${workspaceId}/runs`}>Import CSV batch</Link>
        </div>
      }
    >
      <div className="metric-strip metric-strip-four">
        <Metric label="Approval queue" value={String(needsApproval.length)} />
        <Metric label="Ready to execute" value={String(ready.length)} />
        <Metric label="Settlement watch" value={String(unsettled.length)} />
        <Metric label="Open exceptions" value={String(openExceptions.length)} />
      </div>
      <div className="split-panels">
        <section className="panel">
          <SectionHeader title="Today's focus" description="Priority-ranked work based on state risk, amount, and age." />
          <ActionPaymentTable
            workspaceId={workspaceId}
            paymentOrders={priorityRows}
            actionHeader="Do now"
            emptyTitle="No priority work"
            emptyDescription="High-priority items will appear here as workflow state changes."
            reasonHeader="Why now"
            renderReason={(order) => commandPriorityReason(order)}
            renderAction={(order) => (
              <Link className="button button-secondary button-small" to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}`}>
                {executionActionLabel(order)}
              </Link>
            )}
          />
        </section>
        <section className="panel">
          <SectionHeader title="Operational load" description="Current queue distribution across active workflows." />
          <InfoGrid
            items={[
              ['Approvals pending', String(needsApproval.length)],
              ['Execution ready', String(ready.length)],
              ['Settlement in-flight', String(unsettled.length)],
              ['Aging over 24h', String(agingCritical)],
              ['Proof-ready', String(completed.length)],
              ['Open exceptions', String(openExceptions.length)],
            ]}
          />
          <div className="action-cluster" style={{ marginTop: 12 }}>
            <Link className="button button-secondary" to={`/workspaces/${workspaceId}/approvals`}>Open approvals</Link>
            <Link className="button button-secondary" to={`/workspaces/${workspaceId}/execution`}>Open execution</Link>
            <Link className="button button-secondary" to={`/workspaces/${workspaceId}/exceptions`}>Open exceptions</Link>
          </div>
        </section>
      </div>
      <section className="panel panel-spaced">
        <SectionHeader title="Recent payment runs" description="Batch imports and execution packets." />
        <PaymentRunsTable workspaceId={workspaceId} runs={runs.slice(0, 8)} />
      </section>
    </PageFrame>
  );
}

function PaymentsPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [importStep, setImportStep] = useState<'edit' | 'preview'>('edit');
  const [csvText, setCsvText] = useState('');
  const [runName, setRunName] = useState('');
  const [sourceTreasuryWalletId, setSourceTreasuryWalletId] = useState('');
  const workspace = findWorkspace(session, workspaceId);
  const paymentOrdersQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentOrders,
    queryFn: () => api.listPaymentOrders(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const paymentRunsQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentRuns,
    queryFn: () => api.listPaymentRuns(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const addressesQuery = useQuery({
    queryKey: queryKeys(workspaceId).addresses,
    queryFn: () => api.listTreasuryWallets(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const destinationsQuery = useQuery({
    queryKey: queryKeys(workspaceId).destinations,
    queryFn: () => api.listDestinations(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const csvPreview = useMemo(() => parseCsvPreview(csvText, 15), [csvText]);
  const importMutation = useMutation({
    mutationFn: async () => {
      const csv = csvText.trim();
      if (!csv) throw new Error('CSV is required.');
      return api.importPaymentRunCsv(workspaceId!, {
        csv,
        runName: runName.trim() || undefined,
        sourceTreasuryWalletId: sourceTreasuryWalletId || undefined,
        submitOrderNow: true,
      });
    },
    onSuccess: async (result) => {
      setMessage(`Imported ${result.importResult.imported} row(s). Rows were submitted into approval.`);
      setImportStep('edit');
      setCsvText('');
      setRunName('');
      setImportOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentRuns }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentRequests }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentOrders }),
      ]);
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to import CSV.'),
  });
  const createRequestMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const destinationId = getFormString(formData, 'destinationId');
      const amount = getFormString(formData, 'amount');
      const reason = getFormString(formData, 'reason');
      if (!destinationId || !amount || !reason) {
        throw new Error('Destination, amount, and reason are required.');
      }
      return api.createPaymentRequest(workspaceId!, {
        destinationId,
        amountRaw: usdcToRaw(amount),
        reason,
        externalReference: getOptionalFormString(formData, 'externalReference') ?? undefined,
        dueAt: normalizeDateInput(getOptionalFormString(formData, 'dueAt')),
        createOrderNow: true,
        sourceTreasuryWalletId: getOptionalFormString(formData, 'sourceTreasuryWalletId') ?? undefined,
        submitOrderNow: true,
      });
    },
    onSuccess: async () => {
      setMessage('Payment request created.');
      setRequestModalOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentRequests }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentOrders }),
      ]);
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to create request.'),
  });

  if (!workspaceId || !workspace) {
    return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar." />;
  }

  const paymentOrders = paymentOrdersQuery.data?.items ?? [];
  const standaloneOrders = paymentOrders.filter((order) => !order.paymentRunId);
  const paymentRuns = paymentRunsQuery.data?.items ?? [];
  const addresses = addressesQuery.data?.items ?? [];
  const destinations = destinationsQuery.data?.items ?? [];
  const standaloneNeedsAction = standaloneOrders.filter(isActionableOrder).length;
  const runNeedsAction = paymentRuns.filter((run) => ['draft', 'pending_approval', 'ready_for_execution', 'execution_recorded', 'partially_settled', 'exception'].includes(run.derivedState)).length;
  const standaloneReadyToSign = standaloneOrders.filter((order) => order.derivedState === 'ready_for_execution').length;
  const runReadyToSign = paymentRuns.filter((run) => run.derivedState === 'ready_for_execution').length;
  const standaloneCompleted = standaloneOrders.filter((order) => order.derivedState === 'settled' || order.derivedState === 'closed').length;
  const runCompleted = paymentRuns.filter((run) => run.derivedState === 'settled' || run.derivedState === 'closed').length;
  const unifiedRows = [
    ...standaloneOrders.map((order) => ({
      kind: 'payment' as const,
      id: order.paymentOrderId,
      name: order.destination.label,
      amountLabel: `${formatRawUsdcCompact(order.amountRaw)} ${assetSymbol(order.asset)}`,
      sourceLabel: order.sourceTreasuryWallet?.displayName ?? shortenAddress(order.sourceTreasuryWallet?.address),
      refLabel: order.externalReference ?? order.invoiceNumber ?? order.memo ?? 'N/A',
      stateLabel: displayPaymentStatus(order.derivedState),
      tone: statusToneForPayment(order.derivedState),
      createdAt: order.createdAt,
      to: `/workspaces/${workspaceId}/payments/${order.paymentOrderId}`,
    })),
    ...paymentRuns.map((run) => ({
      kind: 'run' as const,
      id: run.paymentRunId,
      name: run.runName,
      amountLabel: `${formatRawUsdcCompact(run.totals.totalAmountRaw)} USDC`,
      sourceLabel: run.sourceTreasuryWallet ? (walletLabel(run.sourceTreasuryWallet) ?? 'N/A') : 'N/A',
      refLabel: `${run.totals.orderCount} rows`,
      stateLabel: displayRunStatus(run.derivedState),
      tone: statusToneForPayment(run.derivedState),
      createdAt: run.createdAt,
      to: `/workspaces/${workspaceId}/runs/${run.paymentRunId}`,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <PageFrame
      eyebrow="Payments"
      title="Payment control"
      description="Review payment intent, execution, settlement, exceptions, and proof from one queue."
      action={
        <div className="action-cluster">
          <button className="button button-secondary" type="button" onClick={() => setImportOpen(true)}>Import CSV batch</button>
          <button className="button button-primary" type="button" onClick={() => setRequestModalOpen(true)}>New payment request</button>
        </div>
      }
    >
      <div className="metric-strip">
        <Metric label="Needs action" value={String(standaloneNeedsAction + runNeedsAction)} />
        <Metric label="Ready to sign" value={String(standaloneReadyToSign + runReadyToSign)} />
        <Metric label="Completed" value={String(standaloneCompleted + runCompleted)} />
      </div>
      <section className="panel">
        <SectionHeader title={`Payments and batches [${unifiedRows.length}]`} description="Individual payments and batch runs in one operational ledger." />
        {paymentOrdersQuery.isLoading || paymentRunsQuery.isLoading ? (
          <EmptyState title="Loading payments" description="Fetching the payment queue." />
        ) : unifiedRows.length ? (
          <UnifiedPaymentsTable rows={unifiedRows} />
        ) : (
          <EmptyState title="No payments yet" description="Create a payment request or import a CSV batch to start the workflow." />
        )}
      </section>
      {message ? <div className="notice panel-spaced">{message}</div> : null}
      <Modal
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          setImportStep('edit');
        }}
        title="Import CSV batch"
        size="wide"
      >
        {message ? <div className="notice">{message}</div> : null}
        {importStep === 'edit' ? (
          <div className="split-panels split-panels-wide-left">
            <section>
              <SectionHeader title="Batch settings" description="Name the run and optionally preselect a source wallet." />
              <div className="form-stack">
                <label className="field">
                  Run name
                  <input value={runName} onChange={(e) => setRunName(e.target.value)} placeholder="April contractor payouts" />
                </label>
                <label className="field">
                  Source wallet
                  <select value={sourceTreasuryWalletId} onChange={(e) => setSourceTreasuryWalletId(e.target.value)}>
                    <option value="">Optional until execution</option>
                    {addresses.filter((address) => address.isActive).map((address) => (
                      <option key={address.treasuryWalletId} value={address.treasuryWalletId}>{walletLabel(address)}</option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
            <section>
              <SectionHeader title="CSV input" description="Paste rows to preview before creating the run." />
              <div className="form-stack">
                <label className="field">
                  CSV
                  <textarea
                    value={csvText}
                    onChange={(e) => setCsvText(e.target.value)}
                    rows={16}
                    placeholder={[
                      'counterparty,destination,amount,reference,due_date',
                      'Acme Corp,8cZ65A8ERdVsXq3YnEdMNimwG7DhGe1tPszysJwh43Zx,0.01,INV-1001,2026-04-15',
                    ].join('\n')}
                  />
                </label>
                <button
                  className="button button-primary"
                  disabled={!csvText.trim()}
                  type="button"
                  onClick={() => {
                    setMessage(null);
                    const p = parseCsvPreview(csvText);
                    if (p.parseError) {
                      setMessage(p.parseError);
                      return;
                    }
                    if (!p.headers.length) {
                      setMessage('Add a header row and at least one data row.');
                      return;
                    }
                    setImportStep('preview');
                  }}
                >
                  Review import
                </button>
              </div>
            </section>
          </div>
        ) : (
          <div className="form-stack">
            <p className="section-copy">
              {csvPreview.rowCount} data row(s). Showing first {csvPreview.rows.length} row(s). Run name: {runName.trim() || 'N/A'}.
            </p>
            {csvPreview.parseError ? <div className="notice">{csvPreview.parseError}</div> : null}
            <div style={{ overflowX: 'auto' }}>
              <table className="csv-preview-table">
                <thead>
                  <tr>
                    {csvPreview.headers.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvPreview.rows.map((row, ri) => (
                    <tr key={ri}>
                      {csvPreview.headers.map((_, ci) => (
                        <td key={ci}>{row[ci] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="action-cluster">
              <button className="button button-secondary" type="button" onClick={() => setImportStep('edit')}>
                Edit CSV
              </button>
              <button className="button button-primary" disabled={importMutation.isPending} type="button" onClick={() => importMutation.mutate()}>
                {importMutation.isPending ? 'Importing...' : 'Confirm import'}
              </button>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={requestModalOpen} onClose={() => setRequestModalOpen(false)} title="New payment request">
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            createRequestMutation.mutate(new FormData(event.currentTarget));
          }}
        >
          <label className="field">
            Destination
            <select name="destinationId" required defaultValue="">
              <option value="" disabled>Select destination</option>
              {destinations.filter((destination) => destination.isActive).map((destination) => (
                <option key={destination.destinationId} value={destination.destinationId}>{destination.label} / {destination.trustState}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Source wallet
            <select name="sourceTreasuryWalletId" defaultValue="">
              <option value="">Optional until execution</option>
              {addresses.filter((address) => address.isActive).map((address) => (
                <option key={address.treasuryWalletId} value={address.treasuryWalletId}>{walletLabel(address)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Amount
            <input name="amount" placeholder="0.01" required />
          </label>
          <label className="field">
            Reason
            <input name="reason" placeholder="Pay Acme Corp for INV-1001" required />
          </label>
          <label className="field">
            Reference
            <input name="externalReference" placeholder="INV-1001" />
          </label>
          <label className="field">
            Due date
            <input name="dueAt" type="date" />
          </label>
          <button className="button button-primary" disabled={createRequestMutation.isPending || !destinations.length} type="submit">
            {createRequestMutation.isPending ? 'Creating...' : 'Create request'}
          </button>
        </form>
      </Modal>
    </PageFrame>
  );
}

function PaymentRequestsPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const workspace = findWorkspace(session, workspaceId);
  const requestsQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentRequests,
    queryFn: () => api.listPaymentRequests(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const ordersQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentOrders,
    queryFn: () => api.listPaymentOrders(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const destinationsQuery = useQuery({
    queryKey: queryKeys(workspaceId).destinations,
    queryFn: () => api.listDestinations(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const addressesQuery = useQuery({
    queryKey: queryKeys(workspaceId).addresses,
    queryFn: () => api.listTreasuryWallets(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const createRequestMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const destinationId = getFormString(formData, 'destinationId');
      const amount = getFormString(formData, 'amount');
      const reason = getFormString(formData, 'reason');
      if (!destinationId || !amount || !reason) {
        throw new Error('Destination, amount, and reason are required.');
      }
      return api.createPaymentRequest(workspaceId!, {
        destinationId,
        amountRaw: usdcToRaw(amount),
        reason,
        externalReference: getOptionalFormString(formData, 'externalReference') ?? undefined,
        dueAt: normalizeDateInput(getOptionalFormString(formData, 'dueAt')),
        createOrderNow: true,
        sourceTreasuryWalletId: getOptionalFormString(formData, 'sourceTreasuryWalletId') ?? undefined,
        submitOrderNow: formData.get('submitOrderNow') === 'on',
      });
    },
    onSuccess: async () => {
      setMessage('Payment request created.');
      setRequestModalOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentRequests }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentOrders }),
      ]);
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to create request.'),
  });

  if (!workspaceId || !workspace) {
    return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar." />;
  }

  const requests = requestsQuery.data?.items ?? [];
  const ordersByRequest = new Map((ordersQuery.data?.items ?? []).map((order) => [order.paymentRequestId, order]));
  const destinations = destinationsQuery.data?.items ?? [];
  const addresses = addressesQuery.data?.items ?? [];

  return (
    <PageFrame
      eyebrow="Intake"
      title="Payment requests"
      description="Create the human-facing input object, then let the order workflow handle approval, execution, settlement, and proof."
      action={(
        <div className="action-cluster">
          <button className="button button-primary" type="button" onClick={() => setRequestModalOpen(true)}>+ New payment request</button>
          <Link className="button button-secondary" to={`/workspaces/${workspaceId}/runs`}>Import CSV batch</Link>
        </div>
      )}
    >
      <section className="panel">
        <SectionHeader title={`Requests [${requests.length}]`} description="Manual requests and imported rows become controlled payment orders." />
        <PaymentRequestsTable workspaceId={workspaceId} requests={requests} ordersByRequest={ordersByRequest} />
      </section>
      {message ? <div className="notice panel-spaced">{message}</div> : null}
      <Modal open={requestModalOpen} onClose={() => setRequestModalOpen(false)} title="New payment request">
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            createRequestMutation.mutate(new FormData(event.currentTarget));
          }}
        >
          <label className="field">
            Destination
            <select name="destinationId" required defaultValue="">
              <option value="" disabled>Select destination</option>
              {destinations.filter((destination) => destination.isActive).map((destination) => (
                <option key={destination.destinationId} value={destination.destinationId}>{destination.label} / {destination.trustState}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Source wallet
            <select name="sourceTreasuryWalletId" defaultValue="">
              <option value="">Optional until execution</option>
              {addresses.filter((address) => address.isActive).map((address) => (
                <option key={address.treasuryWalletId} value={address.treasuryWalletId}>{walletLabel(address)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Amount
            <input name="amount" placeholder="0.01" required />
          </label>
          <label className="field">
            Reason
            <input name="reason" placeholder="Pay Acme Corp for INV-1001" required />
          </label>
          <label className="field">
            Reference
            <input name="externalReference" placeholder="INV-1001" />
          </label>
          <label className="field">
            Due date
            <input name="dueAt" type="date" />
          </label>
          <label className="field checkbox-field">
            <input name="submitOrderNow" type="checkbox" />
            Submit into approval now
          </label>
          <button className="button button-primary" disabled={createRequestMutation.isPending || !destinations.length} type="submit">
            {createRequestMutation.isPending ? 'Creating...' : 'Create request'}
          </button>
        </form>
      </Modal>
    </PageFrame>
  );
}

function PaymentRunsPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importStep, setImportStep] = useState<'edit' | 'preview'>('edit');
  const [csvText, setCsvText] = useState('');
  const [runName, setRunName] = useState('');
  const [sourceTreasuryWalletId, setSourceTreasuryWalletId] = useState('');
  const workspace = findWorkspace(session, workspaceId);
  const runsQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentRuns,
    queryFn: () => api.listPaymentRuns(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const addressesQuery = useQuery({
    queryKey: queryKeys(workspaceId).addresses,
    queryFn: () => api.listTreasuryWallets(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const csvPreview = useMemo(() => parseCsvPreview(csvText, 15), [csvText]);
  const duplicateRunName = useMemo(() => {
    const normalized = runName.trim().toLowerCase();
    if (!normalized) return null;
    return (runsQuery.data?.items ?? []).find((run) => run.runName.trim().toLowerCase() === normalized) ?? null;
  }, [runName, runsQuery.data?.items]);
  const importMutation = useMutation({
    mutationFn: async () => {
      const csv = csvText.trim();
      if (!csv) throw new Error('CSV is required.');
      if (duplicateRunName) throw new Error(`Run name "${runName.trim()}" already exists. Choose a unique run name.`);
      return api.importPaymentRunCsv(workspaceId!, {
        csv,
        runName: runName.trim() || undefined,
        sourceTreasuryWalletId: sourceTreasuryWalletId || undefined,
        submitOrderNow: true,
      });
    },
    onSuccess: async (result) => {
      setMessage(`Imported ${result.importResult.imported} row(s). Rows were submitted into approval.`);
      setImportStep('edit');
      setCsvText('');
      setRunName('');
      setImportOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentRuns }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentRequests }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentOrders }),
      ]);
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to import CSV.'),
  });

  if (!workspaceId || !workspace) {
    return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar." />;
  }

  const runs = runsQuery.data?.items ?? [];
  const addresses = addressesQuery.data?.items ?? [];

  return (
    <PageFrame
      eyebrow="Batch Intake"
      title="Payment runs"
      description="Import CSV payout sheets, review the batch, prepare one transaction, and export run-level proof."
      action={
        <button className="button button-primary" type="button" onClick={() => setImportOpen(true)}>
          + Import CSV batch
        </button>
      }
    >
      <Modal
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          setImportStep('edit');
        }}
        title="Import CSV batch"
        size="wide"
      >
        {message ? <div className="notice">{message}</div> : null}
        {importStep === 'edit' ? (
          <div className="split-panels split-panels-wide-left">
            <section>
              <SectionHeader title="Batch settings" description="Name the run and optionally preselect a source wallet." />
              <div className="form-stack">
                <label className="field">
                  Run name
                  <input value={runName} onChange={(e) => setRunName(e.target.value)} placeholder="April contractor payouts" />
                </label>
                <label className="field">
                  Source wallet
                  <select value={sourceTreasuryWalletId} onChange={(e) => setSourceTreasuryWalletId(e.target.value)}>
                    <option value="">Optional until execution</option>
                    {addresses.filter((address) => address.isActive).map((address) => (
                      <option key={address.treasuryWalletId} value={address.treasuryWalletId}>{walletLabel(address)}</option>
                    ))}
                  </select>
                </label>
                {duplicateRunName ? (
                  <p className="section-copy form-error">Run name already exists. Use a unique name to avoid operator confusion.</p>
                ) : null}
              </div>
            </section>
            <section>
              <SectionHeader title="CSV input" description="Paste rows to preview before creating the run." />
              <div className="form-stack">
                <label className="field">
                  CSV
                  <textarea
                    value={csvText}
                    onChange={(e) => setCsvText(e.target.value)}
                    rows={16}
                    placeholder={[
                      'counterparty,destination,amount,reference,due_date',
                      'Acme Corp,8cZ65A8ERdVsXq3YnEdMNimwG7DhGe1tPszysJwh43Zx,0.01,INV-1001,2026-04-15',
                    ].join('\n')}
                  />
                </label>
                <button
                  className="button button-primary"
                  disabled={!csvText.trim()}
                  type="button"
                  onClick={() => {
                    setMessage(null);
                    const p = parseCsvPreview(csvText);
                    if (p.parseError) {
                      setMessage(p.parseError);
                      return;
                    }
                    if (!p.headers.length) {
                      setMessage('Add a header row and at least one data row.');
                      return;
                    }
                    setImportStep('preview');
                  }}
                >
                  Review import
                </button>
              </div>
            </section>
          </div>
        ) : (
          <div className="form-stack">
            <p className="section-copy">
              {csvPreview.rowCount} data row(s). Showing first {csvPreview.rows.length} row(s). Run name: {runName.trim() || 'N/A'}.
            </p>
            {csvPreview.parseError ? <div className="notice">{csvPreview.parseError}</div> : null}
            <div style={{ overflowX: 'auto' }}>
              <table className="csv-preview-table">
                <thead>
                  <tr>
                    {csvPreview.headers.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvPreview.rows.map((row, ri) => (
                    <tr key={ri}>
                      {csvPreview.headers.map((_, ci) => (
                        <td key={ci}>{row[ci] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="action-cluster">
              <button className="button button-secondary" type="button" onClick={() => setImportStep('edit')}>
                Edit CSV
              </button>
              <button className="button button-primary" disabled={importMutation.isPending || Boolean(duplicateRunName)} type="button" onClick={() => importMutation.mutate()}>
                {importMutation.isPending ? 'Importing...' : 'Confirm import'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <section className="panel">
        <SectionHeader title={`Payment runs [${runs.length}]`} description="Each run is a durable page with its own execution and proof packet." />
        <PaymentRunsTable workspaceId={workspaceId} runs={runs} />
      </section>
      {message ? <div className="notice panel-spaced">{message}</div> : null}
    </PageFrame>
  );
}

function PaymentRunDetailPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId, paymentRunId } = useParams<{ workspaceId: string; paymentRunId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [prepared, setPrepared] = useState<PaymentRunExecutionPreparation | null>(null);
  const [manualSignature, setManualSignature] = useState('');
  const [executionModalOpen, setExecutionModalOpen] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [selectedSourceAddressId, setSelectedSourceAddressId] = useState('');
  const [selectedWalletId, setSelectedWalletId] = useState<string | undefined>();
  const [wallets, setWallets] = useState<BrowserWalletOption[]>(() => discoverSolanaWallets());
  const [message, setMessage] = useState<string | null>(null);
  const [expandedRunLifecycleStages, setExpandedRunLifecycleStages] = useState<Record<'imported' | 'reviewed' | 'approved' | 'submitted' | 'settled' | 'proven', boolean>>({
    imported: false,
    reviewed: false,
    approved: false,
    submitted: false,
    settled: false,
    proven: false,
  });
  useEffect(() => subscribeSolanaWallets(setWallets), []);
  useEffect(() => {
    setPrepared(null);
  }, [selectedSourceAddressId]);
  const workspace = findWorkspace(session, workspaceId);
  const addressesQuery = useQuery({
    queryKey: queryKeys(workspaceId).addresses,
    queryFn: () => api.listTreasuryWallets(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 15_000,
  });
  const runQuery = useQuery({
    queryKey: queryKeys(workspaceId, paymentRunId).paymentRun,
    queryFn: () => api.getPaymentRunDetail(workspaceId!, paymentRunId!),
    enabled: Boolean(workspaceId && paymentRunId),
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      const state = query.state.data?.derivedState;
      if (state === 'settled' || state === 'closed') return false;
      return 8_000;
    },
  });
  const sourceAddresses = addressesQuery.data?.items ?? [];
  const effectiveSourceAddressId =
    selectedSourceAddressId
    || runQuery.data?.sourceTreasuryWalletId
    || sourceAddresses[0]?.treasuryWalletId
    || '';
  const prepareMutation = useMutation({
    mutationFn: (sourceTreasuryWalletId: string) => api.preparePaymentRunExecution(workspaceId!, paymentRunId!, {
      sourceTreasuryWalletId,
    }),
    onSuccess: async (result) => {
      setPrepared(result);
      setMessage('Batch execution packet prepared.');
      await queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId, paymentRunId).paymentRun });
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to prepare run.'),
  });
  const attachMutation = useMutation({
    mutationFn: (signature: string) => api.attachPaymentRunSignature(workspaceId!, paymentRunId!, {
      submittedSignature: signature,
      submittedAt: new Date().toISOString(),
    }),
    onSuccess: async () => {
      setManualSignature('');
      setMessage('Batch signature attached.');
      await queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId, paymentRunId).paymentRun });
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to attach signature.'),
  });
  const signMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveSourceAddressId) throw new Error('Choose a source wallet before executing this run.');
      const sourceAddressRow = sourceAddresses.find((row) => row.treasuryWalletId === effectiveSourceAddressId);
      if (!sourceAddressRow?.address) {
        throw new Error('Source wallet is still loading or unavailable. Wait a moment and try again.');
      }
      let preparation = prepared;
      const sourceMismatch =
        !preparation
        || preparation.paymentRun.sourceTreasuryWalletId !== effectiveSourceAddressId
        || preparation.executionPacket.signerWallet !== sourceAddressRow.address;
      if (sourceMismatch) {
        preparation = await api.preparePaymentRunExecution(workspaceId!, paymentRunId!, {
          sourceTreasuryWalletId: effectiveSourceAddressId,
        });
        setPrepared(preparation);
      }
      if (!preparation) {
        throw new Error('Batch execution preparation is missing. Try Prepare packet only, then execute again.');
      }
      const signature = await signAndSubmitPreparedPayment(preparation.executionPacket, selectedWalletId);
      await api.attachPaymentRunSignature(workspaceId!, paymentRunId!, {
        submittedSignature: signature,
        submittedAt: new Date().toISOString(),
      });
      return signature;
    },
    onSuccess: async (signature) => {
      setMessage(`Executed ${shortenAddress(signature, 8, 8)}.`);
      setManualSignature('');
      setExecutionModalOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId, paymentRunId).paymentRun }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentOrders }),
      ]);
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to sign and submit batch.'),
  });
  const proofMutation = useMutation({
    mutationFn: () => api.getPaymentRunProof(workspaceId!, paymentRunId!),
    onSuccess: (proof) => downloadJson(`payment-run-proof-${paymentRunId}.json`, proof),
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to export run proof.'),
  });
  const orderProofMutation = useMutation({
    mutationFn: (orderId: string) => api.getPaymentOrderProof(workspaceId!, orderId),
    onSuccess: (proof, orderId) => downloadJson(`payment-proof-${orderId}.json`, proof),
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to export payment proof.'),
  });
  const deleteRunMutation = useMutation({
    mutationFn: () => api.deletePaymentRun(workspaceId!, paymentRunId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentRuns });
      navigate(`/workspaces/${workspaceId}/runs`);
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to delete payment run.'),
  });
  const approvePendingMutation = useMutation({
    mutationFn: async () => {
      const orders = runQuery.data?.paymentOrders ?? [];
      const drafts = orders.filter((order) => order.derivedState === 'draft');
      const draftResults = await Promise.allSettled(
        drafts.map((order) => api.submitPaymentOrder(workspaceId!, order.paymentOrderId)),
      );
      const routedDrafts = draftResults.filter((result) => result.status === 'fulfilled').length;
      const draftFailures = drafts.length - routedDrafts;
      const refreshedRun = await api.getPaymentRunDetail(workspaceId!, paymentRunId!);
      const pending = (refreshedRun.paymentOrders ?? []).filter(
        (order) => order.derivedState === 'pending_approval' && Boolean(order.transferRequestId),
      );
      if (!pending.length) return { routedDrafts, approved: 0, failed: draftFailures };
      const results = await Promise.allSettled(
        pending.map((order) =>
          api.createApprovalDecision(workspaceId!, order.transferRequestId!, { action: 'approve' }),
        ),
      );
      const approved = results.filter((result) => result.status === 'fulfilled').length;
      return { routedDrafts, approved, failed: draftFailures + (pending.length - approved) };
    },
    onSuccess: async ({ routedDrafts, approved, failed }) => {
      setMessage(
        failed
          ? `Advanced ${routedDrafts + approved} payment(s). ${failed} failed.`
          : `Advanced ${routedDrafts + approved} payment(s) through approvals.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId, paymentRunId).paymentRun }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentOrders }),
      ]);
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to approve pending payments.'),
  });

  if (!workspaceId || !paymentRunId || !workspace) {
    return <ScreenState title="Run unavailable" description="Choose a payment run from the runs page." />;
  }
  if (runQuery.isLoading) {
    return <ScreenState title="Loading run" description="Fetching the payment run." />;
  }
  const run = runQuery.data;
  if (!run) {
    return <ScreenState title="Run not found" description="The payment run could not be loaded." />;
  }
  const runOrders = run.paymentOrders ?? [];
  const draftCount = runOrders.filter((order) => order.derivedState === 'draft').length;
  const pendingApprovalCount = runOrders.filter((order) => order.derivedState === 'pending_approval').length;
  const approvalsQueueCount = draftCount + pendingApprovalCount;
  const executableOrders = runOrders.filter((order) => {
    if (['cancelled', 'closed', 'settled', 'partially_settled', 'exception'].includes(order.derivedState)) return false;
    const latestExecution = order.reconciliationDetail?.latestExecution;
    if (!latestExecution) return ['approved', 'ready_for_execution', 'execution_recorded'].includes(order.derivedState);
    if (latestExecution.submittedSignature) return false;
    if (['submitted_onchain', 'observed', 'settled'].includes(latestExecution.state)) return false;
    return ['approved', 'ready_for_execution', 'execution_recorded'].includes(order.derivedState);
  });
  const selectedWallet = wallets.find((wallet) => wallet.id === selectedWalletId);
  const selectedSourceAddress = sourceAddresses.find((address) => address.treasuryWalletId === effectiveSourceAddressId) ?? null;
  const canExecuteBatch = executableOrders.length > 0;
  const totalExecutableAmountRaw = executableOrders.reduce((sum, order) => sum + BigInt(order.amountRaw || '0'), 0n);
  const allocationPreview = executableOrders
    .map((order) => {
      const amountRaw = Number(order.amountRaw || 0);
      const ratio = totalExecutableAmountRaw > 0n ? amountRaw / Number(totalExecutableAmountRaw) : 0;
      return {
        paymentOrderId: order.paymentOrderId,
        label: order.destination.label,
        detail: order.externalReference ?? order.invoiceNumber ?? shortenAddress(order.destination.walletAddress),
        amountLabel: `${formatRawUsdcCompact(order.amountRaw)} ${assetSymbol(order.asset)}`,
        ratio,
      };
    })
    .sort((a, b) => b.ratio - a.ratio);
  const runWorkflowSteps = buildRunWorkflow(run);
  const runStageByLabel = new Map(runWorkflowSteps.map((step) => [step.label.toLowerCase(), step]));
  const approvalEvents = runOrders
    .flatMap((order) => (order.reconciliationDetail?.approvalDecisions ?? []).map((decision) => ({
      order,
      decision,
    })))
    .sort((a, b) => new Date(b.decision.createdAt).getTime() - new Date(a.decision.createdAt).getTime());
  const resolvedApprovalEvents = approvalEvents.filter(({ decision }) => ['approve', 'reject', 'escalate'].includes(decision.action));
  const submissionEvents = runOrders
    .flatMap((order) => {
      const latestExecution = order.reconciliationDetail?.latestExecution;
      if (!latestExecution?.submittedSignature) return [];
      return [{
        order,
        signature: latestExecution.submittedSignature,
        submittedAt: latestExecution.submittedAt ?? latestExecution.createdAt ?? order.updatedAt,
      }];
    })
    .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
  const settlementEvents = runOrders
    .flatMap((order) => {
      const match = order.reconciliationDetail?.match;
      if (!match?.matchedAt) return [];
      return [{
        order,
        matchStatus: match.matchStatus,
        matchedAt: match.matchedAt,
      }];
    })
    .sort((a, b) => new Date(b.matchedAt).getTime() - new Date(a.matchedAt).getTime());

  return (
    <PageFrame
      eyebrow="Payment Run"
      title={run.runName}
      description={`${run.totals.orderCount} payment(s) / ${formatRawUsdcCompact(run.totals.totalAmountRaw)} USDC / ${displayRunStatus(run.derivedState)}`}
      action={
        <div className="action-cluster">
          {approvalsQueueCount > 0 ? (
            <button
              className="button button-secondary"
              onClick={() => approvePendingMutation.mutate()}
              disabled={approvePendingMutation.isPending}
              type="button"
            >
              {approvePendingMutation.isPending ? 'Advancing...' : `Advance approvals (${approvalsQueueCount})`}
            </button>
          ) : null}
          <button
            className="button button-secondary"
            onClick={() => setExecutionModalOpen(true)}
            type="button"
            title="Opens the execution panel. The API is called from there when you choose a wallet and confirm—prepare, then sign in the browser."
          >
            Open execution
          </button>
          <button className="button button-primary" onClick={() => proofMutation.mutate()} type="button">Export run proof</button>
          <button
            className="button button-secondary"
            disabled={deleteRunMutation.isPending}
            onClick={() => setDeleteModalOpen(true)}
            type="button"
          >
            {deleteRunMutation.isPending ? 'Deleting...' : 'Delete run'}
          </button>
        </div>
      }
    >
      <RunProgressTracker steps={runWorkflowSteps} />
      {message ? <div className="notice">{message}</div> : null}
      <section className="panel" id="run-payments">
        <SectionHeader title="Run payments" description="Rows reconcile independently even when execution is prepared as one batch packet." />
        <RunPaymentsTable
          workspaceId={workspaceId}
          paymentOrders={runOrders}
          onExportProof={(order) => orderProofMutation.mutate(order.paymentOrderId)}
          exportPending={orderProofMutation.isPending}
        />
      </section>
      <section className="panel panel-spaced">
        <SectionHeader title="Lifecycle details" description="Stage-by-stage summary for this batch run." />
        <div className="vertical-timeline">
          {runWorkflowSteps.map((step) => {
            const stageKey = step.label.startsWith('Import')
              ? 'imported'
              : step.label.startsWith('Review')
                ? 'reviewed'
                : step.label.startsWith('Approve')
                  ? 'approved'
                  : step.label.startsWith('Execute')
                    ? 'submitted'
                    : step.label.startsWith('Settle')
                      ? 'settled'
                      : 'proven';
            return (
            <article className={`vertical-timeline-item vertical-timeline-item-${step.state}`} key={step.label}>
              <span className="vertical-timeline-marker" />
              <div className="vertical-timeline-content">
                <div className="vertical-timeline-title-row">
                  <strong>{step.label}</strong>
                  <button
                    className="timeline-inline-toggle"
                    onClick={() => {
                      setExpandedRunLifecycleStages((s) => ({ ...s, [stageKey]: !s[stageKey] }));
                    }}
                    type="button"
                    aria-label={expandedRunLifecycleStages[stageKey] ? `Collapse ${step.label} details` : `Expand ${step.label} details`}
                  >
                    {expandedRunLifecycleStages[stageKey] ? '▾' : '▸'}
                  </button>
                </div>
                <p>{step.subtext}</p>
                {step.label === 'Imported' && expandedRunLifecycleStages.imported ? (
                  <CompactStageEvents
                    items={[
                      {
                        title: 'Run created',
                        body: `Imported ${run.totals.orderCount} row(s) into ${run.runName}.`,
                        time: run.createdAt,
                      },
                    ]}
                  />
                ) : null}
                {step.label === 'Reviewed' && expandedRunLifecycleStages.reviewed ? (
                  <CompactStageEvents
                    items={[
                      {
                        title: 'Review snapshot',
                        body: `${run.totals.orderCount} total rows / ${run.totals.pendingApprovalCount} awaiting approval.`,
                        time: run.updatedAt,
                      },
                    ]}
                  />
                ) : null}
                {(step.label === 'Approved' || step.label === 'Approve') && expandedRunLifecycleStages.approved ? (
                  resolvedApprovalEvents.length ? (
                    <CompactStageEvents
                      items={resolvedApprovalEvents.map(({ order, decision }) => ({
                        title: `${decision.action.replaceAll('_', ' ')} · ${order.destination.label}`,
                        body: `${decision.actorUser?.email ?? decision.actorType} · ${order.externalReference ?? order.invoiceNumber ?? 'No reference'}`,
                        time: decision.createdAt,
                      }))}
                    />
                  ) : (
                    <p>No resolved approval decisions yet.</p>
                  )
                ) : null}
                {(step.label === 'Execute' || step.label === 'Executed') && expandedRunLifecycleStages.submitted ? (
                  submissionEvents.length ? (
                    <CompactStageEvents
                      items={submissionEvents.map((event) => ({
                        title: `${event.order.destination.label}`,
                        body: `Signature ${shortenAddress(event.signature, 10, 8)}`,
                        time: event.submittedAt,
                      }))}
                    />
                  ) : (
                    <p>No signatures executed yet.</p>
                  )
                ) : null}
                {(step.label === 'Settle' || step.label === 'Settled') && expandedRunLifecycleStages.settled ? (
                  settlementEvents.length ? (
                    <CompactStageEvents
                      items={settlementEvents.map((event) => ({
                        title: `${event.order.destination.label}`,
                        body: event.matchStatus.replaceAll('_', ' '),
                        time: event.matchedAt,
                      }))}
                    />
                  ) : (
                    <p>No settlement matches yet.</p>
                  )
                ) : null}
                {(step.label === 'Prove' || step.label === 'Proven') && expandedRunLifecycleStages.proven ? (
                  <CompactStageEvents
                    items={[
                      {
                        title: runStageByLabel.get('proven')?.state === 'complete' ? 'Proof ready' : 'Proof pending',
                        body: runStageByLabel.get('proven')?.state === 'complete'
                          ? 'Run proof packet can be exported.'
                          : 'Proof becomes ready after settlement completes.',
                        time: run.updatedAt,
                      },
                    ]}
                  />
                ) : null}
              </div>
            </article>
            );
          })}
        </div>
      </section>
      <Modal
        open={executionModalOpen}
        onClose={() => setExecutionModalOpen(false)}
        size="wide"
        title="Execute payments"
      >
        {!sourceAddresses.length ? (
          <EmptyState title="No source wallets available" description="Add a wallet in Address book before preparing this batch." />
        ) : (
          <div className="form-stack">
            <p className="section-copy">
              Prepare and sign happen here: the backend builds the transaction packet, then your browser wallet submits the signed transaction.
            </p>
            <label className="field">
              Source wallet
              <select
                value={effectiveSourceAddressId}
                onChange={(event) => setSelectedSourceAddressId(event.target.value)}
              >
                {sourceAddresses.map((address: TreasuryWallet) => (
                  <option key={address.treasuryWalletId} value={address.treasuryWalletId}>
                    {walletLabel(address)}
                  </option>
                ))}
              </select>
            </label>
            <section className="panel">
              <SectionHeader title="Browser wallet" description="Select the signer wallet in a dedicated picker." />
              <div className="action-cluster">
                <span className="section-copy">
                  {selectedWallet
                    ? `Selected: ${selectedWallet.name}`
                    : 'Selected: Auto-detect wallet'}
                </span>
                <button className="button button-secondary" onClick={() => setWalletModalOpen(true)} type="button">
                  Choose wallet
                </button>
              </div>
            </section>
            <section className="allocation-panel">
              <SectionHeader title="Transfer preview" description="Who gets paid in this batch and how the total is distributed." />
              <div className="allocation-summary">
                <span><strong>{executableOrders.length}</strong> payments</span>
                <span><strong>{formatRawUsdcCompact(totalExecutableAmountRaw.toString())} USDC</strong> total</span>
                <span><strong>{selectedSourceAddress ? walletLabel(selectedSourceAddress) : 'No source selected'}</strong></span>
              </div>
              {!canExecuteBatch ? <div className="notice">No executable payments in this run. Cancelled or closed rows are excluded.</div> : null}
              <div className="allocation-list">
                {allocationPreview.map((item) => (
                  <div className="allocation-row" key={item.paymentOrderId}>
                    <div className="allocation-copy">
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </div>
                    <div className="allocation-bar-track">
                      <span className="allocation-bar-fill" style={{ width: `${Math.max(item.ratio * 100, 4)}%` }} />
                    </div>
                    <div className="allocation-amount">{item.amountLabel}</div>
                  </div>
                ))}
              </div>
            </section>
            {prepared ? (
              <div className="packet-box">
                <InfoGrid
                  items={[
                    ['Signer', safeShortAddress(prepared.executionPacket.signerWallet)],
                    ['Transfers', String(prepared.executionPacket.transfers?.length ?? 0)],
                    ['Amount', `${formatRawUsdcCompact(prepared.executionPacket.amountRaw)} ${prepared.executionPacket.token?.symbol ?? 'USDC'}`],
                    ['Instructions', String(prepared.executionPacket.instructions.length)],
                  ]}
                />
              </div>
            ) : (
              <p className="section-copy">Execute non-cancelled payments in this run using the selected source wallet.</p>
            )}
            <div className="action-cluster">
              <button
                className="button button-secondary"
                disabled={prepareMutation.isPending || !effectiveSourceAddressId || !canExecuteBatch}
                onClick={() => prepareMutation.mutate(effectiveSourceAddressId)}
                type="button"
              >
                {prepareMutation.isPending ? 'Preparing...' : 'Prepare packet only'}
              </button>
              <button
                className="button button-primary"
                disabled={!effectiveSourceAddressId || signMutation.isPending || !canExecuteBatch}
                onClick={() => signMutation.mutate()}
                type="button"
              >
                {signMutation.isPending ? 'Executing...' : 'Execute payments'}
              </button>
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={walletModalOpen}
        onClose={() => setWalletModalOpen(false)}
        title="Choose browser wallet"
      >
        <div className="form-stack">
          <WalletPicker
            wallets={wallets}
            selectedWalletId={selectedWalletId}
            onSelect={(walletId) => {
              setSelectedWalletId(walletId);
              setWalletModalOpen(false);
            }}
          />
        </div>
      </Modal>
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete payment run"
        footer={(
          <>
            <button className="button button-secondary" onClick={() => setDeleteModalOpen(false)} type="button">Cancel</button>
            <button
              className="button button-primary"
              disabled={deleteRunMutation.isPending}
              onClick={() => {
                deleteRunMutation.mutate();
                setDeleteModalOpen(false);
              }}
              type="button"
            >
              {deleteRunMutation.isPending ? 'Deleting...' : 'Delete run'}
            </button>
          </>
        )}
      >
        <p className="section-copy">
          Delete run <strong>{run.runName}</strong>? This action is permanent and will remove run grouping from linked records.
        </p>
      </Modal>
    </PageFrame>
  );
}

function ApprovalsPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const workspace = findWorkspace(session, workspaceId);
  const runIdFilter = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('runId');
  }, [location.search]);

  const ordersQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentOrders,
    queryFn: () => api.listPaymentOrders(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const runQuery = useQuery({
    queryKey: ['payment-run', workspaceId, runIdFilter] as const,
    queryFn: () => api.getPaymentRunDetail(workspaceId!, runIdFilter!),
    enabled: Boolean(workspaceId && runIdFilter),
  });
  const approvalMutation = useMutation({
    mutationFn: ({ order, action }: { order: PaymentOrder; action: 'approve' | 'reject' }) => {
      if (!order.transferRequestId) throw new Error('This payment has no linked approval request yet.');
      return api.createApprovalDecision(workspaceId!, order.transferRequestId, { action });
    },
    onSuccess: async () => {
      setMessage('Approval decision recorded.');
      await queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentOrders });
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to record approval decision.'),
  });

  if (!workspaceId || !workspace) return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar." />;
  const allOrders = ordersQuery.data?.items ?? [];
  const scopedOrders = runIdFilter
    ? allOrders.filter((o) => o.paymentRunId === runIdFilter)
    : allOrders;
  const pending = scopedOrders.filter((order) => order.derivedState === 'pending_approval');
  const history = scopedOrders.filter((order) => {
    const decisions = order.reconciliationDetail?.approvalDecisions ?? [];
    return decisions.some((decision) => ['approve', 'reject', 'escalate'].includes(decision.action));
  });
  const latestDecisions = history
    .map((order) => {
      const decisions = (order.reconciliationDetail?.approvalDecisions ?? [])
        .filter((decision) => ['approve', 'reject', 'escalate'].includes(decision.action))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return decisions[0] ?? null;
    })
    .filter((decision): decision is NonNullable<typeof decision> => Boolean(decision));
  const approvedCount = latestDecisions.filter((decision) => decision.action === 'approve').length;
  const rejectedCount = latestDecisions.filter((decision) => decision.action === 'reject').length;
  const escalatedCount = latestDecisions.filter((decision) => decision.action === 'escalate').length;

  const batchRun = runQuery.data;
  const batchBanner = runIdFilter ? (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '14px 16px',
        borderRadius: 12,
        border: '1px solid var(--ax-border)',
        background: 'var(--ax-surface-2)',
        marginBottom: 16,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ax-text-muted)' }}>
          Reviewing batch
        </span>
        <strong style={{ color: 'var(--ax-text)' }}>
          {batchRun?.runName ?? 'Loading batch…'}
        </strong>
        <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
          {batchRun
            ? `${pending.length} of ${batchRun.totals.orderCount} awaiting individual review`
            : ''}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Link
          to={`/workspaces/${workspaceId}/runs/${runIdFilter}`}
          className="rd-btn rd-btn-secondary"
          style={{ textDecoration: 'none' }}
        >
          ← Back to run
        </Link>
        <Link
          to={`/workspaces/${workspaceId}/approvals`}
          className="rd-btn rd-btn-ghost"
          style={{ textDecoration: 'none' }}
        >
          Clear filter
        </Link>
      </div>
    </div>
  ) : null;

  return (
    <PageFrame eyebrow="Approvals" title={`Approval queue [${pending.length}]`} description="Live approval queue and full decision history for audit visibility.">
      {batchBanner}
      {message ? <div className="notice">{message}</div> : null}
      <div className="metric-strip metric-strip-four">
        <Metric label="Pending" value={String(pending.length)} />
        <Metric label="Approved" value={String(approvedCount)} />
        <Metric label="Rejected" value={String(rejectedCount)} />
        <Metric label="Escalated" value={String(escalatedCount)} />
      </div>
      <section className="panel">
        <SectionHeader title={`Pending approvals [${pending.length}]`} description="Payments blocked by policy or destination trust until a human decision is recorded." />
        <ApprovalsTable
          workspaceId={workspaceId}
          paymentOrders={pending}
          onApprove={(order) => approvalMutation.mutate({ order, action: 'approve' })}
          onReject={(order) => approvalMutation.mutate({ order, action: 'reject' })}
        />
      </section>
      <section className="panel panel-spaced">
        <SectionHeader title={`Approval history [${history.length}]`} description="Resolved approval decisions only." />
        <ApprovalHistoryTable workspaceId={workspaceId} paymentOrders={history} />
      </section>
    </PageFrame>
  );
}

function ApprovalsTable({
  workspaceId,
  paymentOrders,
  onApprove,
  onReject,
}: {
  workspaceId: string;
  paymentOrders: PaymentOrder[];
  onApprove: (order: PaymentOrder) => void;
  onReject: (order: PaymentOrder) => void;
}) {
  if (!paymentOrders.length) {
    return <EmptyState title="No approvals waiting" description="Payments requiring approval will appear here." />;
  }
  return (
    <div className="data-table">
      <div className="data-table-row data-table-head data-table-row-approvals data-table-sticky-head">
        <span>Recipient</span>
        <span>Amount</span>
        <span>Reason</span>
        <span>Age</span>
        <span>Decision</span>
      </div>
      {paymentOrders.map((order) => (
        <div className="data-table-row data-table-row-approvals" key={order.paymentOrderId}>
          <span>
            <Link to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}#approval`}>
              <strong>{order.destination.label}</strong>
            </Link>
            <small>{shortenAddress(order.paymentOrderId, 8, 6)}</small>
          </span>
          <span>{formatRawUsdcCompact(order.amountRaw)} {assetSymbol(order.asset)}</span>
          <span>
            <small>{approvalReasonLine(order)}</small>
          </span>
          <span>{formatRelativeTime(order.createdAt)}</span>
          <span className="table-actions">
            <button
              className="rd-btn rd-btn-primary"
              style={{ minHeight: 32, padding: '6px 12px', fontSize: 12 }}
              onClick={() => onApprove(order)}
              type="button"
            >
              Approve
            </button>
            <button
              className="rd-btn rd-btn-danger"
              style={{ minHeight: 32, padding: '6px 12px', fontSize: 12 }}
              onClick={() => onReject(order)}
              type="button"
            >
              Reject
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

function ApprovalHistoryTable({
  workspaceId,
  paymentOrders,
}: {
  workspaceId: string;
  paymentOrders: PaymentOrder[];
}) {
  if (!paymentOrders.length) {
    return <EmptyState title="No approval history yet" description="Decisions will appear here once approvals are routed or recorded." />;
  }
  return (
    <div className="data-table">
      <div className="data-table-row data-table-head data-table-row-approval-history data-table-sticky-head">
        <span>Recipient</span>
        <span>Amount</span>
        <span>Approval decision</span>
        <span>Actor</span>
        <span>Time</span>
        <span>Payment status</span>
      </div>
      {paymentOrders.map((order) => {
        const decisions = (order.reconciliationDetail?.approvalDecisions ?? [])
          .filter((decision) => ['approve', 'reject', 'escalate'].includes(decision.action));
        const latest = decisions.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        if (!latest) return null;
        const decisionLabel = latest.action === 'approve'
          ? 'Approved'
          : latest.action === 'reject'
            ? 'Rejected'
            : 'Escalated';
        const decisionTone = latest.action === 'approve'
          ? 'success'
          : latest.action === 'reject'
            ? 'danger'
            : 'warning';
        return (
          <div className="data-table-row data-table-row-approval-history" key={order.paymentOrderId}>
            <span>
              <Link to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}#approval`}>
                <strong>{order.destination.label}</strong>
              </Link>
              <small>{shortenAddress(order.paymentOrderId, 8, 6)}</small>
            </span>
            <span>{formatRawUsdcCompact(order.amountRaw)} {assetSymbol(order.asset)}</span>
            <span><StatusBadge tone={decisionTone}>{decisionLabel}</StatusBadge></span>
            <span>{latest?.actorUser?.email ?? latest?.actorType ?? 'System'}</span>
            <span>{latest ? formatDateCompact(latest.createdAt) : 'N/A'}</span>
            <span><StatusBadge tone={statusToneForPayment(order.derivedState)}>{displayPaymentStatus(order.derivedState)}</StatusBadge></span>
          </div>
        );
      })}
    </div>
  );
}

function ExecutionPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const workspace = findWorkspace(session, workspaceId);
  const ordersQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentOrders,
    queryFn: () => api.listPaymentOrders(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const inQueue = useMemo(
    () => (ordersQuery.data?.items ?? []).filter((order) => paymentExecutionBucket(order) !== null),
    [ordersQuery.data?.items],
  );
  const grouped = useMemo(() => {
    const m = new Map<ExecutionBucket, PaymentOrder[]>();
    for (const b of EXECUTION_BUCKETS) m.set(b, []);
    for (const order of inQueue) {
      const b = paymentExecutionBucket(order);
      if (b) m.get(b)!.push(order);
    }
    return m;
  }, [inQueue]);
  const allOrders = ordersQuery.data?.items ?? [];
  const readyToSignCount = inQueue.filter((order) => order.derivedState === 'ready_for_execution').length;
  const executedCount = allOrders.filter((order) => hasExecutionRecorded(order)).length;
  const reviewCount = inQueue.filter((order) => order.derivedState === 'exception' || order.derivedState === 'partially_settled').length;
  const executedHistory = useMemo(
    () =>
      allOrders
        .filter((order) => Boolean(order.reconciliationDetail?.latestExecution?.submittedSignature))
        .sort((a, b) => {
          const aTime = new Date(a.reconciliationDetail?.latestExecution?.submittedAt ?? a.updatedAt).getTime();
          const bTime = new Date(b.reconciliationDetail?.latestExecution?.submittedAt ?? b.updatedAt).getTime();
          return bTime - aTime;
        })
        .slice(0, 12),
    [allOrders],
  );

  if (!workspaceId || !workspace) return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar." />;

  return (
    <PageFrame
      eyebrow="Execution"
      title={`Execution queue [${inQueue.length}]`}
      description="Operational queue by immediate next action so treasury can push payments through signing and settlement quickly."
    >
      <div className="metric-strip metric-strip-four">
        <Metric label="In queue" value={String(inQueue.length)} />
        <Metric label="Ready to sign" value={String(readyToSignCount)} />
        <Metric label="Executed" value={String(executedCount)} />
        <Metric label="Needs review" value={String(reviewCount)} />
      </div>
      {inQueue.length === 0 ? (
        <EmptyState title="Nothing waiting for execution" description="Approved, executed, or review-needed payments will appear in the groups below." />
      ) : (
        EXECUTION_BUCKETS.map((bucket) => {
          const rows = grouped.get(bucket) ?? [];
          if (!rows.length) return null;
          return (
            <section className="panel panel-spaced" key={bucket}>
              <SectionHeader title={executionBucketTitle(bucket)} description={`${rows.length} payment(s)`} />
              <ActionPaymentTable
                workspaceId={workspaceId}
                paymentOrders={rows}
                actionHeader="Open"
                emptyTitle="No payments"
                emptyDescription="This group is empty."
                reasonHeader="Why now"
                renderReason={(order) => executionReasonLine(order)}
                renderAction={(order) => (
                  <Link className="button button-secondary button-small" to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}#execution`}>
                    {executionActionLabel(order)}
                  </Link>
                )}
              />
            </section>
          );
        })
      )}
      <section className="panel panel-spaced">
        <SectionHeader title={`Recent executed [${executedHistory.length}]`} description="Most recent payments that already have execution signatures." />
        <ActionPaymentTable
          workspaceId={workspaceId}
          paymentOrders={executedHistory}
          actionHeader="Open"
          emptyTitle="No executed payments yet"
          emptyDescription="Executed payments with signatures will appear here."
          reasonHeader="Execution signature"
          renderReason={(order) =>
            order.reconciliationDetail?.latestExecution?.submittedSignature
              ? <AddressLink value={order.reconciliationDetail.latestExecution.submittedSignature} kind="transaction" />
              : 'N/A'
          }
          renderAction={(order) => (
            <Link className="button button-secondary button-small" to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}#execution`}>
              Open payment
            </Link>
          )}
        />
      </section>
    </PageFrame>
  );
}

function SettlementPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const workspace = findWorkspace(session, workspaceId);
  const [settlementTab, setSettlementTab] = useState<'reconciliation' | 'raw'>('reconciliation');
  const reconciliationQuery = useQuery({
    queryKey: ['settlement-reconciliation', workspaceId],
    queryFn: () => api.listReconciliation(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const transfersQuery = useQuery({
    queryKey: ['observed-transfers', workspaceId],
    queryFn: () => api.listTransfers(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const exceptionsQuery = useQuery({
    queryKey: queryKeys(workspaceId).exceptions,
    queryFn: () => api.listExceptions(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  if (!workspaceId || !workspace) return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar." />;
  const reconciliationRows = reconciliationQuery.data?.items ?? [];
  const observedTransfers = transfersQuery.data?.items ?? [];
  const openExceptions = (exceptionsQuery.data?.items ?? []).filter((item) => item.status !== 'dismissed');
  const matchedCount = reconciliationRows.filter((row) => row.requestDisplayState === 'matched').length;
  const reconciliationExceptionCount = reconciliationRows.filter((row) => row.requestDisplayState === 'exception').length;
  const rejectedCount = reconciliationRows.filter(
    (row) => row.approvalState === 'rejected' || row.executionState === 'rejected',
  ).length;
  const pendingCount = reconciliationRows.filter(
    (row) => row.requestDisplayState === 'pending' && row.approvalState !== 'rejected' && row.executionState !== 'rejected',
  ).length;
  return (
    <PageFrame eyebrow="Settlement" title="Settlement and reconciliation" description="Payment-centric chain truth first; use the debug tab for raw observed USDC movement.">
      <div className="metric-strip metric-strip-five">
        <Metric label="Rows tracked" value={String(reconciliationRows.length)} />
        <Metric label="Matched" value={String(matchedCount)} />
        <Metric label="Pending" value={String(pendingCount)} />
        <Metric label="Rejected" value={String(rejectedCount)} />
        <Metric label="Open exceptions" value={String(openExceptions.length)} />
      </div>
      <Tabs
        active={settlementTab}
        onChange={(id) => setSettlementTab(id as 'reconciliation' | 'raw')}
        tabs={[
          { id: 'reconciliation', label: `Reconciliation (${reconciliationRows.length})` },
          { id: 'raw', label: `Observed movement (${observedTransfers.length})` },
        ]}
      />
      {settlementTab === 'reconciliation' ? (
        <section className="panel">
          <SectionHeader title="Payment reconciliation" description={`What the matcher attached to each transfer request. Reconciliation exceptions: ${reconciliationExceptionCount}.`} />
          <SettlementReconciliationTable workspaceId={workspaceId} rows={reconciliationRows} />
        </section>
      ) : (
        <section className="panel">
          <SectionHeader title="Observed USDC movement" description="Raw chain events for debugging settlement and matcher behavior." />
          <ObservedTransfersTable rows={observedTransfers} />
        </section>
      )}
    </PageFrame>
  );
}

function SettlementReconciliationTable({
  workspaceId,
  rows,
}: {
  workspaceId: string;
  rows: ReconciliationRow[];
}) {
  if (!rows.length) return <EmptyState title="No reconciliation rows yet" description="Rows will appear after payment requests are submitted." />;
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-settlement-recon data-table-sticky-head">
        <span>Payment</span><span>Amount</span><span>Display state</span><span>Match status</span><span>Signature</span><span>Updated</span>
      </div>
      {rows.map((row) => (
        <div className="data-table-row data-table-row-settlement-recon" key={row.transferRequestId}>
          <span>
            {row.paymentOrderId ? (
              <Link to={`/workspaces/${workspaceId}/payments/${row.paymentOrderId}`}>
                <strong>{row.destination?.label ?? row.destination?.walletAddress ?? 'Destination'}</strong>
              </Link>
            ) : (
              <strong>{row.destination?.label ?? row.destination?.walletAddress ?? 'Destination'}</strong>
            )}
            <small>{shortenAddress(row.transferRequestId, 8, 6)}</small>
          </span>
          <span>{formatRawUsdcCompact(row.amountRaw)} {assetSymbol(row.asset)}</span>
          <span><StatusBadge tone={toneForGenericState(settlementDisplayState(row))}>{settlementDisplayState(row)}</StatusBadge></span>
          <span>{settlementMatchLabel(row)}</span>
          <span>{row.match?.signature ? <AddressLink value={row.match.signature} kind="transaction" /> : 'N/A'}</span>
          <span className="cell-due-compact">{formatDateCompact(row.match?.updatedAt ?? row.requestedAt)}</span>
        </div>
      ))}
    </DataTableShell>
  );
}

function ObservedTransfersTable({ rows }: { rows: ObservedTransfer[] }) {
  if (!rows.length) return <EmptyState title="No observed transfers yet" description="Chain-observed USDC movement will appear here." />;
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-observed-transfers data-table-sticky-head">
        <span>Source</span><span>Destination</span><span>Amount</span><span>Signature</span><span>Slot</span><span>Observed</span><span>Lag</span>
      </div>
      {rows.map((row) => (
        <div className="data-table-row data-table-row-observed-transfers" key={row.transferId}>
          <span>
            {row.sourceWallet ? <AddressLink value={row.sourceWallet} /> : <strong>unknown</strong>}
          </span>
          <span>{row.destinationWallet ? <AddressLink value={row.destinationWallet} /> : 'unknown'}</span>
          <span>{formatRawUsdcCompact(row.amountRaw)} {assetSymbol(row.asset)}</span>
          <span><AddressLink value={row.signature} kind="transaction" /></span>
          <span>{row.slot.toLocaleString()}</span>
          <span className="cell-due-compact">{formatDateCompact(row.eventTime)}</span>
          <span>{row.chainToWriteMs.toLocaleString()} ms</span>
        </div>
      ))}
    </DataTableShell>
  );
}

function ProofsPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; data: Record<string, unknown> } | null>(null);
  const [proofTab, setProofTab] = useState<'needs_review' | 'ready' | 'exported'>('needs_review');
  const workspace = findWorkspace(session, workspaceId);
  const ordersQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentOrders,
    queryFn: () => api.listPaymentOrders(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const runsQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentRuns,
    queryFn: () => api.listPaymentRuns(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const proofMutation = useMutation({
    mutationFn: ({ kind, id }: { kind: 'order' | 'run'; id: string }) => (
      kind === 'order' ? api.getPaymentOrderProof(workspaceId!, id) : api.getPaymentRunProof(workspaceId!, id)
    ),
    onSuccess: (proof, variables) => downloadJson(`${variables.kind}-proof-${variables.id}.json`, proof),
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to export proof.'),
  });
  const proofPreviewMutation = useMutation({
    mutationFn: async ({ kind, id, title }: { kind: 'order' | 'run'; id: string; title: string }) => {
      const packet =
        kind === 'order' ? await api.getPaymentOrderProof(workspaceId!, id) : await api.getPaymentRunProof(workspaceId!, id);
      return { title, data: JSON.parse(JSON.stringify(packet)) as Record<string, unknown> };
    },
    onSuccess: (result) => setPreview(result),
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to load proof preview.'),
  });

  if (!workspaceId || !workspace) return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar." />;
  const allOrders = ordersQuery.data?.items ?? [];
  const proofNeedsReview = allOrders.filter((order) => ['partially_settled', 'exception', 'execution_recorded'].includes(order.derivedState));
  const proofReadyOrders = allOrders.filter((order) => ['settled', 'closed'].includes(order.derivedState));
  const exportedLikeOrders = allOrders.filter((order) => order.derivedState === 'closed');
  const runs = runsQuery.data?.items ?? [];
  const runNeedsReview = runs.filter((run) => ['exception', 'partially_settled'].includes(run.derivedState));
  const runReady = runs.filter((run) => ['settled', 'closed'].includes(run.derivedState));
  const runExported = runs.filter((run) => run.derivedState === 'closed');
  return (
    <PageFrame eyebrow="Proofs" title="Proof packets" description="Preview structured proof in the app, or export JSON for finance review and audit handoff.">
      {message ? <div className="notice">{message}</div> : null}
      <Modal open={Boolean(preview)} title={preview?.title ?? 'Proof'} onClose={() => setPreview(null)}>
        {preview ? <ProofJsonView data={preview.data} /> : null}
      </Modal>
      <div className="metric-strip metric-strip-four">
        <Metric label="Needs review" value={String(proofNeedsReview.length + runNeedsReview.length)} />
        <Metric label="Ready to export" value={String(proofReadyOrders.length + runReady.length)} />
        <Metric label="Exported / closed" value={String(exportedLikeOrders.length + runExported.length)} />
        <Metric label="Total proof records" value={String(allOrders.length + runs.length)} />
      </div>
      <Tabs
        active={proofTab}
        onChange={(id) => setProofTab(id as 'needs_review' | 'ready' | 'exported')}
        tabs={[
          { id: 'needs_review', label: `Needs review (${proofNeedsReview.length + runNeedsReview.length})` },
          { id: 'ready', label: `Ready to export (${proofReadyOrders.length + runReady.length})` },
          { id: 'exported', label: `Exported (${exportedLikeOrders.length + runExported.length})` },
        ]}
      />
      <section className="panel">
        {proofTab === 'needs_review' ? (
          <>
            <SectionHeader title={`Payments needing review [${proofNeedsReview.length}]`} description="Resolve settlement or exception context before final proof export." />
            <ActionPaymentTable
              workspaceId={workspaceId}
              paymentOrders={proofNeedsReview}
              actionHeader="Action"
              emptyTitle="No payments need proof review"
              emptyDescription="Items with exception or partial settlement will appear here."
              reasonHeader="Readiness"
              renderReason={(order) => proofReadinessLine(order)}
              renderAction={(order) => (
                <Link className="button button-secondary button-small" to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}`}>
                  Open payment
                </Link>
              )}
            />
            <section className="panel panel-spaced">
              <SectionHeader title={`Runs needing review [${runNeedsReview.length}]`} />
              <PaymentRunProofTable
                workspaceId={workspaceId}
                runs={runNeedsReview}
                onExport={(run) => proofMutation.mutate({ kind: 'run', id: run.paymentRunId })}
                onPreview={(run) =>
                  proofPreviewMutation.mutate({ kind: 'run', id: run.paymentRunId, title: `Run proof · ${run.runName}` })
                }
                previewPending={proofPreviewMutation.isPending}
              />
            </section>
          </>
        ) : null}
        {proofTab === 'ready' ? (
          <>
            <SectionHeader title={`Payment proofs ready [${proofReadyOrders.length}]`} description="Preview or export completed proofs for audit handoff." />
            <ActionPaymentTable
              workspaceId={workspaceId}
              paymentOrders={proofReadyOrders}
              actionHeader="Proof"
              emptyTitle="No proof-ready payments"
              emptyDescription="Settled or closed payments will appear here."
              reasonHeader="Readiness"
              renderReason={(order) => proofReadinessLine(order)}
              renderAction={(order) => (
                <span className="table-actions">
                  <button
                    className="button button-secondary button-small"
                    disabled={proofPreviewMutation.isPending}
                    onClick={() =>
                      proofPreviewMutation.mutate({
                        kind: 'order',
                        id: order.paymentOrderId,
                        title: `Payment proof · ${order.destination.label}`,
                      })
                    }
                    type="button"
                  >
                    Preview
                  </button>
                  <button className="button button-secondary button-small" onClick={() => proofMutation.mutate({ kind: 'order', id: order.paymentOrderId })} type="button">
                    Export
                  </button>
                </span>
              )}
            />
            <section className="panel panel-spaced">
              <SectionHeader title={`Run proofs ready [${runReady.length}]`} />
              <PaymentRunProofTable
                workspaceId={workspaceId}
                runs={runReady}
                onExport={(run) => proofMutation.mutate({ kind: 'run', id: run.paymentRunId })}
                onPreview={(run) =>
                  proofPreviewMutation.mutate({ kind: 'run', id: run.paymentRunId, title: `Run proof · ${run.runName}` })
                }
                previewPending={proofPreviewMutation.isPending}
              />
            </section>
          </>
        ) : null}
        {proofTab === 'exported' ? (
          <>
            <SectionHeader title={`Exported payment proofs [${exportedLikeOrders.length}]`} description="Records in closed state for completed evidence trails." />
            <ActionPaymentTable
              workspaceId={workspaceId}
              paymentOrders={exportedLikeOrders}
              actionHeader="Open"
              emptyTitle="No exported payment proofs"
              emptyDescription="Closed payment records appear here."
              reasonHeader="Readiness"
              renderReason={(order) => proofReadinessLine(order)}
              renderAction={(order) => (
                <Link className="button button-secondary button-small" to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}`}>
                  Open payment
                </Link>
              )}
            />
            <section className="panel panel-spaced">
              <SectionHeader title={`Exported run proofs [${runExported.length}]`} />
              <PaymentRunProofTable
                workspaceId={workspaceId}
                runs={runExported}
                onExport={(run) => proofMutation.mutate({ kind: 'run', id: run.paymentRunId })}
                onPreview={(run) =>
                  proofPreviewMutation.mutate({ kind: 'run', id: run.paymentRunId, title: `Run proof · ${run.runName}` })
                }
                previewPending={proofPreviewMutation.isPending}
              />
            </section>
          </>
        ) : null}
      </section>
    </PageFrame>
  );
}

function AddressBookPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const workspace = findWorkspace(session, workspaceId);
  const walletsQuery = useQuery({
    queryKey: queryKeys(workspaceId).addresses,
    queryFn: () => api.listTreasuryWallets(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const counterpartiesQuery = useQuery({
    queryKey: queryKeys(workspaceId).counterparties,
    queryFn: () => api.listCounterparties(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const destinationsQuery = useQuery({
    queryKey: queryKeys(workspaceId).destinations,
    queryFn: () => api.listDestinations(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  async function invalidateRegistry() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).addresses }),
      queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).counterparties }),
      queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).destinations }),
    ]);
  }

  const createTreasuryWalletMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      return api.createTreasuryWallet(workspaceId!, {
        displayName: getOptionalFormString(formData, 'displayName') ?? undefined,
        address: getFormString(formData, 'address'),
        notes: getOptionalFormString(formData, 'notes') ?? undefined,
      });
    },
    onSuccess: async () => {
      success('Wallet saved.');
      await invalidateRegistry();
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to save wallet.'),
  });
  const createCounterpartyMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      return api.createCounterparty(workspaceId!, {
        displayName: getFormString(formData, 'displayName'),
        category: getOptionalFormString(formData, 'category') ?? undefined,
      });
    },
    onSuccess: async () => {
      success('Counterparty saved.');
      await invalidateRegistry();
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to save counterparty.'),
  });
  const createDestinationMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      return api.createDestination(workspaceId!, {
        walletAddress: getFormString(formData, 'walletAddress'),
        counterpartyId: getOptionalFormString(formData, 'counterpartyId') ?? undefined,
        label: getFormString(formData, 'label'),
        trustState: getFormString(formData, 'trustState') as Destination['trustState'],
        notes: getOptionalFormString(formData, 'notes') ?? undefined,
      });
    },
    onSuccess: async () => {
      success('Destination saved.');
      await invalidateRegistry();
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to save destination.'),
  });

  const [registryDrawer, setRegistryDrawer] = useState<{ title: string; body: ReactNode } | null>(null);
  const [addWalletOpen, setAddWalletOpen] = useState(false);
  const [addDestinationOpen, setAddDestinationOpen] = useState(false);
  const [addCounterpartyOpen, setAddCounterpartyOpen] = useState(false);

  if (!workspaceId || !workspace) {
    return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar." />;
  }

  const wallets = walletsQuery.data?.items ?? [];
  const counterparties = counterpartiesQuery.data?.items ?? [];
  const destinations = destinationsQuery.data?.items ?? [];

  return (
    <PageFrame
      eyebrow="Address book"
      title="Wallets and destinations"
      description="Your treasury wallets on the left. Counterparty destinations you pay on the right. Two independent lists — no cross-link."
    >
      <Drawer open={Boolean(registryDrawer)} title={registryDrawer?.title ?? ''} onClose={() => setRegistryDrawer(null)}>
        {registryDrawer?.body}
      </Drawer>
      <Modal open={addWalletOpen} title="Add wallet" onClose={() => setAddWalletOpen(false)}>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            createTreasuryWalletMutation.mutate(new FormData(event.currentTarget), {
              onSuccess: () => setAddWalletOpen(false),
            });
          }}
        >
          <label className="field">Name<input name="displayName" placeholder="Ops vault" autoComplete="off" /></label>
          <label className="field">Solana address<input name="address" required placeholder="Wallet address" autoComplete="off" /></label>
          <label className="field">Notes<input name="notes" placeholder="Optional context" autoComplete="off" /></label>
          <button className="button button-primary" disabled={createTreasuryWalletMutation.isPending} type="submit">
            {createTreasuryWalletMutation.isPending ? 'Saving…' : 'Save wallet'}
          </button>
        </form>
      </Modal>
      <Modal open={addDestinationOpen} title="Add destination" onClose={() => setAddDestinationOpen(false)}>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            createDestinationMutation.mutate(new FormData(event.currentTarget), {
              onSuccess: () => setAddDestinationOpen(false),
            });
          }}
        >
          <label className="field">Label<input name="label" required placeholder="Acme payout wallet" autoComplete="off" /></label>
          <label className="field">Solana address<input name="walletAddress" required placeholder="Counterparty wallet address" autoComplete="off" /></label>
          <label className="field">
            Counterparty (optional)
            <select name="counterpartyId" defaultValue="">
              <option value="">Unassigned</option>
              {counterparties.map((counterparty) => <option key={counterparty.counterpartyId} value={counterparty.counterpartyId}>{counterparty.displayName}</option>)}
            </select>
          </label>
          <label className="field">
            Trust state
            <select name="trustState" defaultValue="unreviewed">
              <option value="unreviewed">Unreviewed</option>
              <option value="trusted">Trusted</option>
              <option value="restricted">Restricted</option>
              <option value="blocked">Blocked</option>
            </select>
          </label>
          <label className="field">Notes<input name="notes" placeholder="Optional context" autoComplete="off" /></label>
          <button className="button button-primary" disabled={createDestinationMutation.isPending} type="submit">
            {createDestinationMutation.isPending ? 'Saving…' : 'Save destination'}
          </button>
        </form>
      </Modal>
      <Modal open={addCounterpartyOpen} title="Add counterparty" onClose={() => setAddCounterpartyOpen(false)}>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            createCounterpartyMutation.mutate(new FormData(event.currentTarget), {
              onSuccess: () => setAddCounterpartyOpen(false),
            });
          }}
        >
          <label className="field">Name<input name="displayName" required placeholder="Acme Corp" autoComplete="organization" /></label>
          <label className="field">Category<input name="category" placeholder="vendor, contractor, internal" autoComplete="off" /></label>
          <button className="button button-primary" disabled={createCounterpartyMutation.isPending} type="submit">
            {createCounterpartyMutation.isPending ? 'Saving…' : 'Save counterparty'}
          </button>
        </form>
      </Modal>

      <div className="split-panels">
        <section className="panel">
          <SectionHeader
            title={`Your wallets [${wallets.length}]`}
            description="Treasury wallets you own and sign with. Monitored on-chain."
          />
          <div className="action-cluster" style={{ marginBottom: 14 }}>
            <button className="button button-primary" type="button" onClick={() => setAddWalletOpen(true)}>+ Add wallet</button>
          </div>
          {wallets.length ? (
            <WalletsTable
              addresses={wallets}
              destinations={destinations}
              onSelect={(wallet) =>
                setRegistryDrawer({
                  title: walletLabel(wallet) ?? shortenAddress(wallet.address),
                  body: (
                    <InfoGrid
                      items={[
                        ['Name', walletLabel(wallet) ?? 'N/A'],
                        ['Address', <AddressLink key="a" value={wallet.address} />],
                        ['USDC ATA', wallet.usdcAtaAddress ? <AddressLink key="ata" value={wallet.usdcAtaAddress} /> : 'N/A'],
                        ['Asset scope', wallet.assetScope],
                        ['Status', wallet.isActive ? 'Active' : 'Inactive'],
                        ['Notes', wallet.notes ?? 'N/A'],
                      ]}
                    />
                  ),
                })
              }
            />
          ) : (
            <div className="empty-state">
              <strong>No wallets yet</strong>
              <p>Add a treasury wallet to start receiving or sending payments.</p>
            </div>
          )}
        </section>

        <section className="panel">
          <SectionHeader
            title={`Destinations [${destinations.length}]`}
            description="Counterparty payout endpoints. Not monitored directly; matched via signatures when you pay them."
          />
          <div className="action-cluster" style={{ marginBottom: 14 }}>
            <button className="button button-primary" type="button" onClick={() => setAddDestinationOpen(true)}>+ Add destination</button>
          </div>
          {destinations.length ? (
            <DestinationsTable
              destinations={destinations}
              onSelect={(destination) =>
                setRegistryDrawer({
                  title: destination.label,
                  body: (
                    <InfoGrid
                      items={[
                        ['Label', destination.label],
                        ['Wallet', <AddressLink key="w" value={destination.walletAddress} />],
                        ['Trust', trustDisplay(destination.trustState)],
                        ['Scope', destination.isInternal ? 'Internal' : 'External'],
                        ['Counterparty', destination.counterparty?.displayName ?? 'N/A'],
                        ['Status', destination.isActive ? 'Active' : 'Inactive'],
                        ['Notes', destination.notes ?? 'N/A'],
                      ]}
                    />
                  ),
                })
              }
            />
          ) : (
            <div className="empty-state">
              <strong>No destinations yet</strong>
              <p>Add a counterparty's Solana address as a payout destination.</p>
            </div>
          )}
        </section>
      </div>

      <section className="panel panel-spaced">
        <SectionHeader
          title={`Counterparties [${counterparties.length}]`}
          description="Business entities behind your destinations. Optional — you can pay destinations without assigning a counterparty."
        />
        <div className="action-cluster" style={{ marginBottom: 14 }}>
          <button className="button button-primary" type="button" onClick={() => setAddCounterpartyOpen(true)}>+ Add counterparty</button>
        </div>
        {counterparties.length ? (
          <CounterpartiesTable counterparties={counterparties} destinations={destinations} />
        ) : (
          <div className="empty-state">
            <strong>No counterparties yet</strong>
            <p>Tag a destination with a counterparty to track who you're paying.</p>
          </div>
        )}
      </section>
    </PageFrame>
  );
}

function PolicyPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const workspace = findWorkspace(session, workspaceId);
  const policyQuery = useQuery({
    queryKey: queryKeys(workspaceId).approvalPolicy,
    queryFn: () => api.getApprovalPolicy(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const ordersQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentOrders,
    queryFn: () => api.listPaymentOrders(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const destinationsQuery = useQuery({
    queryKey: queryKeys(workspaceId).destinations,
    queryFn: () => api.listDestinations(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 10_000,
  });
  const updateMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      return api.updateApprovalPolicy(workspaceId!, {
        policyName: getOptionalFormString(formData, 'policyName') ?? undefined,
        isActive: formData.get('isActive') === 'on',
        ruleJson: {
          requireTrustedDestination: formData.get('requireTrustedDestination') === 'on',
          requireApprovalForExternal: formData.get('requireApprovalForExternal') === 'on',
          requireApprovalForInternal: formData.get('requireApprovalForInternal') === 'on',
          externalApprovalThresholdRaw: usdcToRaw(getFormString(formData, 'externalThreshold')),
          internalApprovalThresholdRaw: usdcToRaw(getFormString(formData, 'internalThreshold')),
        },
      });
    },
    onSuccess: async () => {
      setMessage('Approval policy updated.');
      setEditOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).approvalPolicy });
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to update policy.'),
  });

  if (!workspaceId || !workspace) return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar." />;
  const policy = policyQuery.data;
  if (!policy) return <ScreenState title="Loading policy" description="Fetching approval rules." />;
  const orders = ordersQuery.data?.items ?? [];
  const destinations = destinationsQuery.data?.items ?? [];
  const pendingApprovals = orders.filter((order) => order.derivedState === 'pending_approval').length;
  const trustedDestinationCount = destinations.filter((destination) => destination.trustState === 'trusted').length;
  const externalApprovalLoad = orders.filter((order) => order.destination && !order.destination.isInternal && order.derivedState === 'pending_approval').length;
  const thresholdTriggered = orders.filter((order) => {
    const raw = BigInt(order.amountRaw);
    return raw >= BigInt(policy.ruleJson.externalApprovalThresholdRaw) || raw >= BigInt(policy.ruleJson.internalApprovalThresholdRaw);
  }).length;

  return (
    <PageFrame
      eyebrow="Policy"
      title="Approval policy"
      description="Configure approval routing, trust gates, and thresholds that shape payment flow."
      action={
        <button className="button button-primary" type="button" onClick={() => setEditOpen(true)}>
          Edit policy
        </button>
      }
    >
      {message ? <div className="notice">{message}</div> : null}
      <div className="metric-strip metric-strip-four">
        <Metric label="Pending approvals" value={String(pendingApprovals)} />
        <Metric label="Threshold-triggered" value={String(thresholdTriggered)} />
        <Metric label="Trusted destinations" value={`${trustedDestinationCount}/${destinations.length}`} />
        <Metric label="External approval load" value={String(externalApprovalLoad)} />
      </div>
      <section className="panel">
        <SectionHeader title="Active strategy" description="Policy posture and live impact on current payment flow." />
        <div className="policy-summary-grid">
          <dl className="policy-summary-card">
            <dt>Policy name</dt>
            <dd>{policy.policyName}</dd>
          </dl>
          <dl className="policy-summary-card">
            <dt>Status</dt>
            <dd>{policy.isActive ? 'Active' : 'Inactive'}</dd>
          </dl>
          <dl className="policy-summary-card">
            <dt>Trusted destination</dt>
            <dd>{yesNo(policy.ruleJson.requireTrustedDestination)}</dd>
          </dl>
          <dl className="policy-summary-card">
            <dt>External approval</dt>
            <dd>{yesNo(policy.ruleJson.requireApprovalForExternal)}</dd>
          </dl>
          <dl className="policy-summary-card">
            <dt>Internal approval</dt>
            <dd>{yesNo(policy.ruleJson.requireApprovalForInternal)}</dd>
          </dl>
          <dl className="policy-summary-card">
            <dt>External threshold</dt>
            <dd>{formatRawUsdcCompact(policy.ruleJson.externalApprovalThresholdRaw)} USDC</dd>
          </dl>
          <dl className="policy-summary-card">
            <dt>Internal threshold</dt>
            <dd>{formatRawUsdcCompact(policy.ruleJson.internalApprovalThresholdRaw)} USDC</dd>
          </dl>
          <dl className="policy-summary-card">
            <dt>Updated</dt>
            <dd>{formatDateCompact(policy.updatedAt)}</dd>
          </dl>
        </div>
      </section>
      <Modal open={editOpen} title="Edit approval policy" onClose={() => setEditOpen(false)}>
        <form
          key={policy.updatedAt}
          onSubmit={(event) => {
            event.preventDefault();
            updateMutation.mutate(new FormData(event.currentTarget));
          }}
        >
          <div className="rd-form-section">
            <div className="rd-form-section-head">
              <h3>Policy</h3>
              <p>Name and toggle this policy on or off for new payment checks.</p>
            </div>
            <label className="field">
              Policy name
              <input name="policyName" defaultValue={policy.policyName} autoComplete="off" />
            </label>
            <label className="field checkbox-field">
              <input name="isActive" defaultChecked={policy.isActive} type="checkbox" />
              Active policy for new payment checks
            </label>
          </div>

          <div className="rd-form-section">
            <div className="rd-form-section-head">
              <h3>Rules</h3>
              <p>What routes a payment through human review.</p>
            </div>
            <label className="field checkbox-field">
              <input name="requireTrustedDestination" defaultChecked={policy.ruleJson.requireTrustedDestination} type="checkbox" />
              Require trusted destination before execution
            </label>
            <label className="field checkbox-field">
              <input name="requireApprovalForExternal" defaultChecked={policy.ruleJson.requireApprovalForExternal} type="checkbox" />
              Require approval for external payments
            </label>
            <label className="field checkbox-field">
              <input name="requireApprovalForInternal" defaultChecked={policy.ruleJson.requireApprovalForInternal} type="checkbox" />
              Require approval for internal payments
            </label>
          </div>

          <div className="rd-form-section">
            <div className="rd-form-section-head">
              <h3>Thresholds</h3>
              <p>Payments at or above these amounts always require approval.</p>
            </div>
            <div className="form-grid">
              <label className="field">
                External (USDC)
                <input name="externalThreshold" defaultValue={formatRawUsdcCompact(policy.ruleJson.externalApprovalThresholdRaw)} inputMode="decimal" autoComplete="off" />
              </label>
              <label className="field">
                Internal (USDC)
                <input name="internalThreshold" defaultValue={formatRawUsdcCompact(policy.ruleJson.internalApprovalThresholdRaw)} inputMode="decimal" autoComplete="off" />
              </label>
            </div>
          </div>
          <div className="notice">
            Saving applies immediately. Review approval queue impact after changes.
          </div>
          <div className="action-cluster">
            <button className="button button-secondary" type="button" onClick={() => setEditOpen(false)}>
              Cancel
            </button>
            <button className="button button-primary" disabled={updateMutation.isPending} type="submit">
              {updateMutation.isPending ? 'Saving...' : 'Save policy'}
            </button>
          </div>
        </form>
      </Modal>
    </PageFrame>
  );
}

function ExceptionsPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | string>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | string>('all');
  const [ownerFilter, setOwnerFilter] = useState<'all' | 'assigned' | 'unassigned'>('all');
  const [resolveModal, setResolveModal] = useState<{ exceptionId: string; title: string } | null>(null);
  const [resolveAction, setResolveAction] = useState<'reviewed' | 'expected' | 'dismissed'>('reviewed');
  const [resolveNote, setResolveNote] = useState('');
  const workspace = findWorkspace(session, workspaceId);
  const exceptionsQuery = useQuery({
    queryKey: queryKeys(workspaceId).exceptions,
    queryFn: () => api.listExceptions(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
  });
  const ordersForExceptionsQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentOrders,
    queryFn: () => api.listPaymentOrders(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const payByTransfer = useMemo(() => {
    const m = new Map<string, PaymentOrder>();
    for (const order of ordersForExceptionsQuery.data?.items ?? []) {
      if (order.transferRequestId) m.set(order.transferRequestId, order);
    }
    return m;
  }, [ordersForExceptionsQuery.data?.items]);
  const actionMutation = useMutation({
    mutationFn: ({ exceptionId, action, note }: { exceptionId: string; action: 'reviewed' | 'expected' | 'dismissed' | 'reopen'; note?: string }) => (
      api.applyExceptionAction(workspaceId!, exceptionId, { action, note })
    ),
    onSuccess: async () => {
      setMessage('Exception updated.');
      await queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).exceptions });
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to update exception.'),
  });

  if (!workspaceId || !workspace) return <ScreenState title="Workspace unavailable" description="Choose a workspace from the sidebar." />;
  const exceptions = exceptionsQuery.data?.items ?? [];
  const statuses = Array.from(new Set(exceptions.map((exception) => exception.status))).sort();
  const severities = Array.from(new Set(exceptions.map((exception) => exception.severity))).sort();
  const filteredExceptions = exceptions.filter((exception) => {
    const statusMatch = statusFilter === 'all' || exception.status === statusFilter;
    const severityMatch = severityFilter === 'all' || exception.severity === severityFilter;
    const ownerMatch = ownerFilter === 'all'
      || (ownerFilter === 'assigned' ? Boolean(exception.assignedToUserId) : !exception.assignedToUserId);
    return statusMatch && severityMatch && ownerMatch;
  });
  const openCount = exceptions.filter((exception) => exception.status === 'open').length;
  const dismissedCount = exceptions.filter((exception) => exception.status === 'dismissed').length;
  const highSeverityCount = exceptions.filter((exception) => exception.severity.toLowerCase().includes('critical')).length;
  const unassignedCount = exceptions.filter((exception) => !exception.assignedToUserId).length;
  const agingCount = exceptions.filter((exception) => ageHours(exception.createdAt) >= 24 && exception.status !== 'dismissed').length;

  return (
    <PageFrame eyebrow="Exceptions" title={`Exceptions [${exceptions.length}]`} description="Resolve operational problems created by settlement mismatch, partials, or unknown activity.">
      {message ? <div className="notice">{message}</div> : null}
      <div className="metric-strip metric-strip-five">
        <Metric label="Open" value={String(openCount)} />
        <Metric label="High severity" value={String(highSeverityCount)} />
        <Metric label="Unassigned" value={String(unassignedCount)} />
        <Metric label="Aging >24h" value={String(agingCount)} />
        <Metric label="Dismissed" value={String(dismissedCount)} />
      </div>
      <section className="panel panel-spaced">
        <SectionHeader title="Triage filters" description="Narrow the exception queue by status, severity, and assignment." />
        <div className="exceptions-filter-bar">
          <label className="field">
            Status
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">All statuses</option>
              {statuses.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Severity
            <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}>
              <option value="all">All severities</option>
              {severities.map((severity) => (
                <option key={severity} value={severity}>{severity}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Owner
            <select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value as 'all' | 'assigned' | 'unassigned')}>
              <option value="all">All</option>
              <option value="assigned">Assigned</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
        </div>
      </section>
      <ExceptionsTable
        workspaceId={workspaceId}
        exceptions={filteredExceptions}
        paymentByTransferId={payByTransfer}
        onAction={(exceptionId, action) => actionMutation.mutate({ exceptionId, action })}
        onResolve={(exception) => {
          setResolveAction('reviewed');
          setResolveNote('');
          setResolveModal({ exceptionId: exception.exceptionId, title: humanizeExceptionReason(exception.reasonCode) });
        }}
      />
      <Modal
        open={Boolean(resolveModal)}
        onClose={() => setResolveModal(null)}
        title={resolveModal?.title ?? 'Resolve exception'}
      >
        <div className="form-stack">
          <label className="field">
            Resolution
            <select value={resolveAction} onChange={(event) => setResolveAction(event.target.value as 'reviewed' | 'expected' | 'dismissed')}>
              <option value="reviewed">Mark reviewed</option>
              <option value="expected">Dismiss as expected</option>
              <option value="dismissed">Dismiss</option>
            </select>
          </label>
          <label className="field">
            Resolution note
            <textarea
              rows={3}
              value={resolveNote}
              onChange={(event) => setResolveNote(event.target.value)}
              placeholder="Required audit note for this resolution."
            />
          </label>
          <div className="action-cluster">
            <button className="button button-secondary" type="button" onClick={() => setResolveModal(null)}>
              Cancel
            </button>
            <button
              className="button button-primary"
              type="button"
              disabled={!resolveNote.trim() || actionMutation.isPending || !resolveModal}
              onClick={() => {
                if (!resolveModal) return;
                actionMutation.mutate({
                  exceptionId: resolveModal.exceptionId,
                  action: resolveAction,
                  note: resolveNote.trim(),
                }, {
                  onSuccess: () => setResolveModal(null),
                });
              }}
            >
              {actionMutation.isPending ? 'Saving...' : 'Save resolution'}
            </button>
          </div>
        </div>
      </Modal>
    </PageFrame>
  );
}

function ExceptionDetailPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId, exceptionId } = useParams<{ workspaceId: string; exceptionId: string }>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);
  const [noteBody, setNoteBody] = useState('');
  const workspace = findWorkspace(session, workspaceId);

  const exceptionQuery = useQuery({
    queryKey: ['workspace-exception', workspaceId, exceptionId] as const,
    queryFn: () => api.getWorkspaceException(workspaceId!, exceptionId!),
    enabled: Boolean(workspaceId && exceptionId),
    refetchInterval: 5_000,
  });
  const ordersQuery = useQuery({
    queryKey: queryKeys(workspaceId).paymentOrders,
    queryFn: () => api.listPaymentOrders(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const linkedOrder = useMemo(() => {
    const tid = exceptionQuery.data?.transferRequestId;
    if (!tid) return null;
    return (ordersQuery.data?.items ?? []).find((o) => o.transferRequestId === tid) ?? null;
  }, [exceptionQuery.data?.transferRequestId, ordersQuery.data?.items]);

  const actionMutation = useMutation({
    mutationFn: ({ action, note }: { action: 'reviewed' | 'expected' | 'dismissed' | 'reopen'; note?: string }) =>
      api.applyExceptionAction(workspaceId!, exceptionId!, { action, note }),
    onSuccess: async () => {
      setMessage('Exception updated.');
      await queryClient.invalidateQueries({ queryKey: ['workspace-exception', workspaceId, exceptionId] as const });
      await queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).exceptions });
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to update exception.'),
  });

  const noteMutation = useMutation({
    mutationFn: (body: string) => api.addExceptionNote(workspaceId!, exceptionId!, { body }),
    onSuccess: async () => {
      setNoteBody('');
      setMessage('Note added.');
      await queryClient.invalidateQueries({ queryKey: ['workspace-exception', workspaceId, exceptionId] as const });
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to add note.'),
  });

  const proofMutation = useMutation({
    mutationFn: () => {
      if (!linkedOrder) throw new Error('Link a payment before exporting proof.');
      return api.getPaymentOrderProof(workspaceId!, linkedOrder.paymentOrderId);
    },
    onSuccess: (proof) => downloadJson(`payment-proof-${linkedOrder?.paymentOrderId}.json`, proof),
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to export proof.'),
  });

  if (!workspaceId || !exceptionId || !workspace) {
    return <ScreenState title="Exception unavailable" description="Choose a workspace from the sidebar." />;
  }
  if (exceptionQuery.isLoading) {
    return <ScreenState title="Loading exception" description="Fetching exception details." />;
  }
  const ex = exceptionQuery.data;
  if (!ex) {
    return <ScreenState title="Exception not found" description="This exception may have been resolved or removed." />;
  }

  const actions = ex.availableActions ?? ['reviewed', 'dismissed', 'expected', 'reopen'];

  return (
    <PageFrame
      eyebrow="Exception"
      title={humanizeExceptionReason(ex.reasonCode)}
      description={ex.explanation}
      action={
        <div className="action-cluster">
          <button className="button button-secondary" type="button" onClick={() => navigate(`/workspaces/${workspaceId}/exceptions`)}>
            Back to list
          </button>
          {linkedOrder ? (
            <Link className="button button-secondary" to={`/workspaces/${workspaceId}/payments/${linkedOrder.paymentOrderId}`}>
              Open payment
            </Link>
          ) : null}
          {linkedOrder ? (
            <button className="button button-primary" type="button" onClick={() => proofMutation.mutate()}>
              Export payment proof
            </button>
          ) : null}
        </div>
      }
    >
      {message ? <div className="notice">{message}</div> : null}
      <div className="split-panels">
        <section className="panel">
          <SectionHeader title="Details" />
          <InfoGrid
            items={[
              ['Severity', <StatusBadge key="s" tone={toneForGenericState(ex.severity)}>{ex.severity}</StatusBadge>],
              ['Status', ex.status],
              ['Type', ex.exceptionType],
              ['Owner', ex.assignedToUser?.email ?? 'Unassigned'],
              ['Observed time', ex.observedEventTime ? formatDateCompact(ex.observedEventTime) : 'N/A'],
              ['Signature', ex.signature ? <AddressLink key="sig" value={ex.signature} kind="transaction" /> : 'N/A'],
              ['Transfer request', ex.transferRequestId ? shortenAddress(ex.transferRequestId, 8, 6) : 'N/A'],
              [
                'Amount',
                linkedOrder ? `${formatRawUsdcCompact(linkedOrder.amountRaw)} ${assetSymbol(linkedOrder.asset)}` : 'N/A',
              ],
            ]}
          />
        </section>
        <section className="panel">
          <SectionHeader title="Resolve" description="Record review outcomes or add operator notes." />
          <div className="table-actions" style={{ marginBottom: 14 }}>
            {actions.includes('reviewed') ? (
              <button className="button button-secondary button-small" type="button" onClick={() => actionMutation.mutate({ action: 'reviewed' })}>
                Mark reviewed
              </button>
            ) : null}
            {actions.includes('expected') ? (
              <button className="button button-secondary button-small" type="button" onClick={() => actionMutation.mutate({ action: 'expected' })}>
                Dismiss as expected
              </button>
            ) : null}
            {actions.includes('dismissed') ? (
              <button className="button button-secondary button-small" type="button" onClick={() => actionMutation.mutate({ action: 'dismissed' })}>
                Dismiss
              </button>
            ) : null}
            {actions.includes('reopen') ? (
              <button className="button button-secondary button-small" type="button" onClick={() => actionMutation.mutate({ action: 'reopen' })}>
                Reopen
              </button>
            ) : null}
          </div>
          <label className="field">
            Add note
            <textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="Context for the next reviewer" rows={3} />
          </label>
          <button
            className="button button-primary"
            type="button"
            disabled={!noteBody.trim() || noteMutation.isPending}
            onClick={() => noteMutation.mutate(noteBody.trim())}
          >
            Save note
          </button>
        </section>
      </div>
      <section className="panel panel-spaced">
        <SectionHeader title="Notes" />
        {ex.notes?.length ? (
          <TimelineList
            items={ex.notes.map((n) => ({
              title: n.authorUser?.email ?? 'Operator',
              body: n.body,
              time: n.createdAt,
            }))}
          />
        ) : (
          <p className="section-copy">No notes recorded.</p>
        )}
      </section>
    </PageFrame>
  );
}

function PaymentDetailPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId, paymentOrderId } = useParams<{ workspaceId: string; paymentOrderId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [preparedPacket, setPreparedPacket] = useState<PaymentExecutionPacket | null>(null);
  const [manualSignature, setManualSignature] = useState('');
  const [expandedTimelineStages, setExpandedTimelineStages] = useState<{ approval: boolean; settlement: boolean }>({
    approval: false,
    settlement: false,
  });
  const [selectedSourceAddressId, setSelectedSourceAddressId] = useState('');
  const [selectedWalletId, setSelectedWalletId] = useState<string | undefined>();
  const [wallets, setWallets] = useState<BrowserWalletOption[]>(() => discoverSolanaWallets());
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [executionModalOpen, setExecutionModalOpen] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  useEffect(() => subscribeSolanaWallets(setWallets), []);
  useEffect(() => {
    setPreparedPacket(null);
  }, [selectedSourceAddressId]);

  const workspace = findWorkspace(session, workspaceId);
  const paymentOrderQuery = useQuery({
    queryKey: queryKeys(workspaceId, paymentOrderId).paymentOrder,
    queryFn: () => api.getPaymentOrderDetail(workspaceId!, paymentOrderId!),
    enabled: Boolean(workspaceId && paymentOrderId),
    refetchInterval: 4_000,
  });
  const addressesQuery = useQuery({
    queryKey: queryKeys(workspaceId).addresses,
    queryFn: () => api.listTreasuryWallets(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const prepareMutation = useMutation({
    mutationFn: (sourceTreasuryWalletId: string) => api.preparePaymentOrderExecution(workspaceId!, paymentOrderId!, {
      sourceTreasuryWalletId,
    }),
    onSuccess: async (result) => {
      setPreparedPacket(result.executionPacket);
      setActionMessage('Payment packet prepared.');
      await queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId, paymentOrderId).paymentOrder });
    },
    onError: (error) => setActionMessage(error instanceof Error ? error.message : 'Failed to prepare payment.'),
  });

  const attachSignatureMutation = useMutation({
    mutationFn: (submittedSignature: string) => api.attachPaymentOrderSignature(workspaceId!, paymentOrderId!, {
      submittedSignature,
      submittedAt: new Date().toISOString(),
    }),
    onSuccess: async () => {
      setActionMessage('Execution signature attached.');
      setManualSignature('');
      await queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId, paymentOrderId).paymentOrder });
    },
    onError: (error) => setActionMessage(error instanceof Error ? error.message : 'Failed to attach signature.'),
  });
  const submitMutation = useMutation({
    mutationFn: () => api.submitPaymentOrder(workspaceId!, paymentOrderId!),
    onSuccess: async () => {
      setActionMessage('Payment submitted for approval.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId, paymentOrderId).paymentOrder }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentOrders }),
      ]);
    },
    onError: (error) => setActionMessage(error instanceof Error ? error.message : 'Failed to submit payment.'),
  });
  const approveMutation = useMutation({
    mutationFn: () => {
      const transferRequestId = paymentOrderQuery.data?.transferRequestId;
      if (!transferRequestId) throw new Error('Approval request is not available yet for this payment.');
      return api.createApprovalDecision(workspaceId!, transferRequestId, { action: 'approve' });
    },
    onSuccess: async () => {
      setActionMessage('Payment approved and moved to execution.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId, paymentOrderId).paymentOrder }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentOrders }),
      ]);
    },
    onError: (error) => setActionMessage(error instanceof Error ? error.message : 'Failed to approve payment.'),
  });

  const signMutation = useMutation({
    mutationFn: async () => {
      const sourceTreasuryWalletId = selectedSourceAddressId
        || paymentOrderQuery.data?.sourceTreasuryWalletId
        || addressesQuery.data?.items?.[0]?.treasuryWalletId
        || '';
      if (!sourceTreasuryWalletId) throw new Error('Select a source wallet before execution.');
      const sourceAddressRow = addressesQuery.data?.items?.find(
        (row) => row.treasuryWalletId === sourceTreasuryWalletId,
      );
      if (!sourceAddressRow?.address) {
        throw new Error('Source wallet is still loading or unavailable. Wait a moment and try again.');
      }

      let packet = preparedPacket ?? getPreparedPacket(paymentOrderQuery.data);
      if (!packet || packet.signerWallet !== sourceAddressRow.address) {
        const prepared = await api.preparePaymentOrderExecution(workspaceId!, paymentOrderId!, {
          sourceTreasuryWalletId,
        });
        packet = prepared.executionPacket;
        setPreparedPacket(packet);
      }
      const signature = await signAndSubmitPreparedPayment(packet, selectedWalletId);
      await api.attachPaymentOrderSignature(workspaceId!, paymentOrderId!, {
        submittedSignature: signature,
        submittedAt: new Date().toISOString(),
      });
      return signature;
    },
    onSuccess: async (signature) => {
      setActionMessage(`Executed ${shortenAddress(signature, 8, 8)}.`);
      setExecutionModalOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId, paymentOrderId).paymentOrder });
    },
    onError: (error) => setActionMessage(error instanceof Error ? error.message : 'Failed to sign and submit payment.'),
  });

  const proofMutation = useMutation({
    mutationFn: () => api.getPaymentOrderProof(workspaceId!, paymentOrderId!),
    onSuccess: (proof) => {
      downloadJson(`payment-proof-${paymentOrderId}.json`, proof);
    },
    onError: (error) => setActionMessage(error instanceof Error ? error.message : 'Failed to export proof.'),
  });
  const deletePaymentMutation = useMutation({
    mutationFn: () => api.cancelPaymentOrder(workspaceId!, paymentOrderId!),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentOrders }),
        queryClient.invalidateQueries({ queryKey: queryKeys(workspaceId).paymentRuns }),
      ]);
      navigate(`/workspaces/${workspaceId}/payments`);
    },
    onError: (error) => setActionMessage(error instanceof Error ? error.message : 'Failed to delete payment.'),
  });

  useLayoutEffect(() => {
    const id = location.hash.replace(/^#/, '');
    if (!id) return;
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [location.hash, paymentOrderId, paymentOrderQuery.data?.paymentOrderId]);
  if (!workspaceId || !paymentOrderId || !workspace) {
    return <ScreenState title="Payment unavailable" description="Choose a payment from the queue." />;
  }

  if (paymentOrderQuery.isLoading) {
    return <ScreenState title="Loading payment" description="Fetching the payment record." />;
  }

  const order = paymentOrderQuery.data;
  if (!order) {
    return <ScreenState title="Payment not found" description="The payment may have been deleted or moved." />;
  }
  if (!order.destination) {
    return <ScreenState title="Payment unavailable" description="Destination details are missing for this payment record." />;
  }

  const summary = summarizePayment(order);
  const packet = preparedPacket ?? getPreparedPacket(order);
  const latestExecution = order.reconciliationDetail?.latestExecution ?? null;
  const match = order.reconciliationDetail?.match ?? null;
  const approvalDecisions = (Array.isArray(order.reconciliationDetail?.approvalDecisions)
    ? order.reconciliationDetail.approvalDecisions.filter(Boolean)
    : []);
  const exceptions = (Array.isArray(order.reconciliationDetail?.exceptions)
    ? order.reconciliationDetail.exceptions.filter(Boolean)
    : []);
  const proofReady = order.derivedState === 'settled' || order.derivedState === 'closed';
  const selectedWallet = wallets.find((wallet) => wallet.id === selectedWalletId);
  const sourceAddresses = addressesQuery.data?.items ?? [];
  const effectiveSourceAddressId = selectedSourceAddressId || order.sourceTreasuryWalletId || sourceAddresses[0]?.treasuryWalletId || '';
  const selectedSourceAddress = sourceAddresses.find((address) => address.treasuryWalletId === effectiveSourceAddressId) ?? null;
  const heroTime = latestExecution?.submittedAt ?? order.createdAt;
  const heroTimeLabel = latestExecution?.submittedSignature ? 'Executed' : 'Requested';
  const latestDecision = approvalDecisions.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
  const stageAction = (() => {
    if (order.derivedState === 'draft') {
      return (
        <button className="button button-secondary" disabled={submitMutation.isPending} onClick={() => submitMutation.mutate()} type="button">
          {submitMutation.isPending ? 'Submitting...' : 'Submit for approval'}
        </button>
      );
    }
    if (order.derivedState === 'pending_approval') {
      return (
        <button className="button button-secondary" disabled={approveMutation.isPending || !order.transferRequestId} onClick={() => approveMutation.mutate()} type="button">
          {approveMutation.isPending ? 'Approving...' : 'Approve payment'}
        </button>
      );
    }
    const hasChainSignature = Boolean(order.reconciliationDetail?.latestExecution?.submittedSignature?.trim());
    const canExecuteFromUi =
      order.derivedState === 'approved'
      || order.derivedState === 'ready_for_execution'
      || (order.derivedState === 'execution_recorded' && !hasChainSignature);
    if (canExecuteFromUi) {
      return (
        <button className="button button-secondary" onClick={() => setExecutionModalOpen(true)} type="button">
          Execute payment
        </button>
      );
    }
    return null;
  })();

  try {
    return (
      <PageFrame
      eyebrow="Payment"
      title={summary.title}
      description={summary.description}
      action={
        <div className="action-cluster">
          {stageAction}
          <button className="button button-secondary" onClick={() => proofMutation.mutate()} type="button">
            Export proof
          </button>
          <button
            className="button button-secondary"
            disabled={deletePaymentMutation.isPending}
            onClick={() => setDeleteModalOpen(true)}
            type="button"
          >
            {deletePaymentMutation.isPending ? 'Deleting...' : 'Delete payment'}
          </button>
        </div>
      }
    >
      <RunProgressTracker steps={buildWorkflow(order)} />
      <section className="panel panel-spaced">
        <SectionHeader title="Payment snapshot" />
        <InfoGrid
          items={[
            ['Amount', `${formatRawUsdcCompact(order.amountRaw)} ${assetSymbol(order.asset)}`],
            ['From', order.sourceTreasuryWallet?.address ? <AddressLink key="from" value={order.sourceTreasuryWallet.address} /> : 'Source not set'],
            ['To', order.destination?.walletAddress ? <AddressLink key="to" value={order.destination.walletAddress} /> : 'Destination unavailable'],
            ['Signature', latestExecution?.submittedSignature ? shortenAddress(latestExecution.submittedSignature) : 'Not executed'],
            ['Time label', heroTimeLabel],
            ['Time', formatRelativeTime(heroTime)],
          ]}
        />
      </section>
      {actionMessage ? <div className="notice">{actionMessage}</div> : null}
      <section className="panel panel-spaced">
        <SectionHeader title="Lifecycle details" description="One-line stage summaries with optional deep detail." />
        <div className="vertical-timeline">
          {(() => {
            const stageState = paymentTimelineStates(order.derivedState);
            return (
              <>
          <article className={`vertical-timeline-item vertical-timeline-item-${stageState.request}`}>
            <span className="vertical-timeline-marker" />
            <div className="vertical-timeline-content">
              <strong>Request</strong>
              <p>Created by {order.createdByUser?.email ?? 'System'} at {formatDateCompact(order.createdAt)}.</p>
            </div>
          </article>
          <article className={`vertical-timeline-item vertical-timeline-item-${stageState.approval}`}>
            <span className="vertical-timeline-marker" />
            <div className="vertical-timeline-content">
              <div className="vertical-timeline-title-row">
                <strong>Approval</strong>
                {approvalDecisions.length ? (
                  <button
                    className="timeline-inline-toggle"
                    onClick={() => setExpandedTimelineStages((s) => ({ ...s, approval: !s.approval }))}
                    type="button"
                    aria-label={expandedTimelineStages.approval ? 'Collapse approval details' : 'Expand approval details'}
                  >
                    {expandedTimelineStages.approval ? '▾' : '▸'}
                  </button>
                ) : null}
              </div>
              <p>{latestDecision ? `${latestDecision.action.replaceAll('_', ' ')} by ${latestDecision.actorUser?.email ?? latestDecision.actorType}` : 'No approval decision recorded yet.'}</p>
              {approvalDecisions.length && expandedTimelineStages.approval ? (
                <CompactStageEvents
                  items={approvalDecisions.map((decision) => ({
                    title: decision.action.replaceAll('_', ' '),
                    body: decision.comment ?? decision.payloadJson?.message?.toString() ?? 'Policy decision recorded.',
                    time: decision.createdAt,
                  }))}
                />
              ) : null}
            </div>
          </article>
          <article className={`vertical-timeline-item vertical-timeline-item-${stageState.execution}`} id="stage-execution">
            <span className="vertical-timeline-marker" />
            <div className="vertical-timeline-content">
              <strong>Execution</strong>
              <p>{latestExecution?.submittedSignature ? `Executed on-chain with ${shortenAddress(latestExecution.submittedSignature)}.` : 'Not executed on-chain yet.'}</p>
            </div>
          </article>
          <article className={`vertical-timeline-item vertical-timeline-item-${stageState.settlement}`}>
            <span className="vertical-timeline-marker" />
            <div className="vertical-timeline-content">
              <div className="vertical-timeline-title-row">
                <strong>Settlement</strong>
                {exceptions.length ? (
                  <button
                    className="timeline-inline-toggle"
                    onClick={() => setExpandedTimelineStages((s) => ({ ...s, settlement: !s.settlement }))}
                    type="button"
                    aria-label={expandedTimelineStages.settlement ? 'Collapse settlement details' : 'Expand settlement details'}
                  >
                    {expandedTimelineStages.settlement ? '▾' : '▸'}
                  </button>
                ) : null}
              </div>
              <p>{match ? `${match.matchStatus.replaceAll('_', ' ')} at ${formatDateCompact(match.matchedAt ?? order.updatedAt)}.` : 'Waiting for chain match and reconciliation.'}</p>
              {match?.explanation ? <p>{match.explanation}</p> : null}
              {exceptions.length && expandedTimelineStages.settlement ? (
                <CompactStageEvents
                  items={exceptions.map((exception) => ({
                    title: `${exception.severity} / ${exception.status}`,
                    body: exception.explanation,
                    time: exception.createdAt,
                  }))}
                />
              ) : null}
            </div>
          </article>
          <article className={`vertical-timeline-item vertical-timeline-item-${stageState.proof}`}>
            <span className="vertical-timeline-marker" />
            <div className="vertical-timeline-content">
              <strong>Proof</strong>
              <p>{proofReady ? 'Proof is ready for export.' : 'Proof becomes complete after settlement.'}</p>
            </div>
          </article>
              </>
            );
          })()}
        </div>
      </section>
      <Modal
        open={executionModalOpen}
        onClose={() => setExecutionModalOpen(false)}
        title="Execute payment"
      >
        <div className="form-stack">
          <label className="field">
            Source wallet
            <select
              value={effectiveSourceAddressId}
              onChange={(event) => setSelectedSourceAddressId(event.target.value)}
            >
              <option value="">Select source wallet</option>
              {sourceAddresses.filter((address) => address.isActive).map((address) => (
                <option key={address.treasuryWalletId} value={address.treasuryWalletId}>
                  {walletLabel(address)}
                </option>
              ))}
            </select>
          </label>
          <section className="allocation-panel">
            <SectionHeader title="Transfer preview" description="Review this payment before preparing and signing." />
            <div className="allocation-summary">
              <span><strong>{formatRawUsdcCompact(order.amountRaw)} {assetSymbol(order.asset)}</strong></span>
              <span><strong>{order.destination.label}</strong></span>
              <span><strong>{selectedSourceAddress ? walletLabel(selectedSourceAddress) : 'No source wallet set'}</strong></span>
            </div>
          </section>
          <section className="panel">
            <SectionHeader title="Browser wallet" description="Select the signer wallet in a dedicated picker." />
            <div className="action-cluster">
              <span className="section-copy">
                {selectedWallet
                  ? `Selected: ${selectedWallet.name}`
                  : 'Selected: Auto-detect wallet'}
              </span>
              <button className="button button-secondary" onClick={() => setWalletModalOpen(true)} type="button">
                Choose wallet
              </button>
            </div>
          </section>
          {packet ? (
            <div className="packet-box">
              <InfoGrid
                items={[
                  ['Signer', safeShortAddress(packet.signerWallet)],
                  ['Amount', `${formatRawUsdcCompact(packet.amountRaw)} ${packet.token?.symbol ?? 'USDC'}`],
                  ['Instructions', String(packet.instructions.length)],
                ]}
              />
            </div>
          ) : (
            <p className="section-copy">Prepare this payment packet and submit with your selected wallet.</p>
          )}
          <div className="action-cluster">
            <button
              className="button button-secondary"
              disabled={prepareMutation.isPending || !effectiveSourceAddressId}
              onClick={() => prepareMutation.mutate(effectiveSourceAddressId)}
              type="button"
            >
              {prepareMutation.isPending ? 'Preparing...' : 'Prepare packet only'}
            </button>
            <button
              className="button button-primary"
              disabled={signMutation.isPending || !effectiveSourceAddressId}
              onClick={() => signMutation.mutate()}
              type="button"
            >
              {signMutation.isPending ? 'Executing...' : 'Execute payment'}
            </button>
          </div>
          {!effectiveSourceAddressId ? <div className="notice">Select a source wallet before execution.</div> : null}
        </div>
      </Modal>
      <Modal
        open={walletModalOpen}
        onClose={() => setWalletModalOpen(false)}
        title="Choose browser wallet"
      >
        <div className="form-stack">
          <WalletPicker
            wallets={wallets}
            selectedWalletId={selectedWalletId}
            onSelect={(walletId) => {
              setSelectedWalletId(walletId);
              setWalletModalOpen(false);
            }}
          />
        </div>
      </Modal>
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete payment"
        footer={(
          <>
            <button className="button button-secondary" onClick={() => setDeleteModalOpen(false)} type="button">Cancel</button>
            <button
              className="button button-primary"
              disabled={deletePaymentMutation.isPending}
              onClick={() => {
                deletePaymentMutation.mutate();
                setDeleteModalOpen(false);
              }}
              type="button"
            >
              {deletePaymentMutation.isPending ? 'Deleting...' : 'Delete payment'}
            </button>
          </>
        )}
      >
        <p className="section-copy">
          Delete payment <strong>{summary.title}</strong>? This action cancels the payment and removes it from active workflows.
        </p>
      </Modal>
      </PageFrame>
    );
  } catch (error) {
    console.error('Payment detail render failed', error, order);
    return <ScreenState title="Payment unavailable" description="This payment record has malformed data. Please retry or refresh." />;
  }
}

function PaymentTable({
  workspaceId,
  paymentOrders,
}: {
  workspaceId: string;
  paymentOrders: PaymentOrder[];
}) {
  if (!paymentOrders.length) {
    return <EmptyState title="No payments here" description="There are no payments for this view yet." />;
  }

  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-payments-ext data-table-sticky-head">
        <span>Recipient</span>
        <span>Amount</span>
        <span>Source</span>
        <span>Destination</span>
        <span>Reference</span>
        <span>Due</span>
        <span>Next action</span>
        <span>Status</span>
      </div>
      {paymentOrders.map((order) => (
        <Link className="data-table-row data-table-link data-table-row-payments-ext" key={order.paymentOrderId} to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}`}>
          <span>
            <strong>{order.destination.label}</strong>
            <small>{shortenAddress(order.paymentOrderId, 8, 6)}</small>
          </span>
          <span>{formatRawUsdcCompact(order.amountRaw)} {assetSymbol(order.asset)}</span>
          <span>
            {order.sourceTreasuryWallet?.displayName
              ?? (order.sourceTreasuryWallet?.address ? <AddressLink value={order.sourceTreasuryWallet.address} /> : 'N/A')}
          </span>
          <span>{order.destination.label}</span>
          <span>{order.externalReference ?? order.invoiceNumber ?? order.memo ?? 'N/A'}</span>
          <span className="cell-due-compact">{order.dueAt ? formatDateCompact(order.dueAt) : 'N/A'}</span>
          <span>{nextPaymentAction(order)}</span>
          <span><StatusBadge tone={statusToneForPayment(order.derivedState)}>{displayPaymentStatus(order.derivedState)}</StatusBadge></span>
        </Link>
      ))}
    </DataTableShell>
  );
}

function UnifiedPaymentsTable({
  rows,
}: {
  rows: Array<{
    kind: 'payment' | 'run';
    id: string;
    name: string;
    amountLabel: string;
    sourceLabel: string;
    refLabel: string;
    stateLabel: string;
    tone: 'success' | 'warning' | 'danger' | 'neutral';
    createdAt: string;
    to: string;
  }>;
}) {
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-unified-ext data-table-sticky-head">
        <span>Type</span>
        <span>Name</span>
        <span>Amount</span>
        <span>Source</span>
        <span>Reference / rows</span>
        <span>Status</span>
        <span>Created</span>
      </div>
      {rows.map((row) => (
        <Link className="data-table-row data-table-link data-table-row-unified-ext" key={`${row.kind}-${row.id}`} to={row.to}>
          <span><StatusBadge tone="neutral">{row.kind === 'run' ? 'batch' : 'individual'}</StatusBadge></span>
          <span><strong>{row.name}</strong></span>
          <span>{row.amountLabel}</span>
          <span>{row.sourceLabel}</span>
          <span>{row.refLabel}</span>
          <span><StatusBadge tone={row.tone}>{row.stateLabel}</StatusBadge></span>
          <span className="cell-due-compact">{formatDateCompact(row.createdAt)}</span>
        </Link>
      ))}
    </DataTableShell>
  );
}

function RunPaymentsTable({
  workspaceId,
  paymentOrders,
  onExportProof,
  exportPending,
}: {
  workspaceId: string;
  paymentOrders: PaymentOrder[];
  onExportProof: (order: PaymentOrder) => void;
  exportPending?: boolean;
}) {
  if (!paymentOrders.length) {
    return <EmptyState title="No payments here" description="There are no payments for this run yet." />;
  }
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-run-payments-ext data-table-sticky-head">
        <span>Recipient</span>
        <span>Amount</span>
        <span>Source</span>
        <span>Destination</span>
        <span>Reference</span>
        <span>Due</span>
        <span>Status</span>
        <span>Export proof</span>
      </div>
      {paymentOrders.map((order) => (
        <div className="data-table-row data-table-row-run-payments-ext" key={order.paymentOrderId}>
          <span>
            <Link to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}`}>
              <strong>{order.destination.label}</strong>
            </Link>
            <small>{shortenAddress(order.paymentOrderId, 8, 6)}</small>
          </span>
          <span>{formatRawUsdcCompact(order.amountRaw)} {assetSymbol(order.asset)}</span>
          <span>
            {order.sourceTreasuryWallet?.displayName
              ?? (order.sourceTreasuryWallet?.address ? <AddressLink value={order.sourceTreasuryWallet.address} /> : 'N/A')}
          </span>
          <span>{order.destination.label}</span>
          <span>{order.externalReference ?? order.invoiceNumber ?? order.memo ?? 'N/A'}</span>
          <span className="cell-due-compact">{order.dueAt ? formatDateCompact(order.dueAt) : 'N/A'}</span>
          <span><StatusBadge tone={statusToneForPayment(order.derivedState)}>{displayPaymentStatus(order.derivedState)}</StatusBadge></span>
          <span>
            <button className="button button-secondary button-small" disabled={exportPending} onClick={() => onExportProof(order)} type="button">
              Export
            </button>
          </span>
        </div>
      ))}
    </DataTableShell>
  );
}

function ActionPaymentTable({
  workspaceId,
  paymentOrders,
  actionHeader,
  emptyTitle,
  emptyDescription,
  reasonHeader,
  renderReason,
  renderAction,
}: {
  workspaceId: string;
  paymentOrders: PaymentOrder[];
  actionHeader: string;
  emptyTitle: string;
  emptyDescription: string;
  reasonHeader?: string;
  renderReason?: (order: PaymentOrder) => ReactNode;
  renderAction: (order: PaymentOrder) => ReactNode;
}) {
  if (!paymentOrders.length) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <DataTableShell>
      <div className={`data-table-row data-table-head ${reasonHeader ? 'data-table-row-actions-reason' : 'data-table-row-actions'}`}>
        <span>Recipient</span><span>Amount</span><span>Destination</span><span>Reference</span>{reasonHeader ? <span>{reasonHeader}</span> : null}<span>Status</span><span>{actionHeader}</span>
      </div>
      {paymentOrders.map((order) => (
        <div className={`data-table-row ${reasonHeader ? 'data-table-row-actions-reason' : 'data-table-row-actions'}`} key={order.paymentOrderId}>
          <Link to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}`}>
            <strong>{order.destination.label}</strong>
            <small>{shortenAddress(order.paymentOrderId, 8, 6)}</small>
          </Link>
          <span>{formatRawUsdcCompact(order.amountRaw)} {assetSymbol(order.asset)}</span>
          <span>{order.destination.label}</span>
          <span>{order.externalReference ?? order.invoiceNumber ?? order.memo ?? 'N/A'}</span>
          {reasonHeader ? <span><small>{renderReason?.(order) ?? '—'}</small></span> : null}
          <span><StatusBadge tone={statusToneForPayment(order.derivedState)}>{displayPaymentStatus(order.derivedState)}</StatusBadge></span>
          <span>{renderAction(order)}</span>
        </div>
      ))}
    </DataTableShell>
  );
}

function PaymentRequestsTable({
  workspaceId,
  requests,
  ordersByRequest,
}: {
  workspaceId: string;
  requests: PaymentRequest[];
  ordersByRequest: Map<string | null, PaymentOrder>;
}) {
  if (!requests.length) {
    return <EmptyState title="No payment requests yet" description="Create a manual request or import a CSV batch." />;
  }
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-requests">
        <span>Recipient</span><span>Destination</span><span>Amount</span><span>Reference</span><span>State</span><span>Progress</span><span>Created</span>
      </div>
      {requests.map((request) => {
        const order = ordersByRequest.get(request.paymentRequestId);
        const content = (
          <>
            <span><strong>{request.reason}</strong><small>{shortenAddress(request.paymentRequestId, 8, 6)}</small></span>
            <span>{request.destination.label}</span>
            <span>{formatRawUsdcCompact(request.amountRaw)} {assetSymbol(request.asset)}</span>
            <span>{request.externalReference ?? 'N/A'}</span>
            <span>
              <StatusBadge
                tone={order?.derivedState ? statusToneForPayment(order.derivedState) : toneForGenericState(request.state)}
              >
                {order?.derivedState ? displayPaymentStatus(order.derivedState) : displayPaymentRequestState(request.state)}
              </StatusBadge>
            </span>
            <span>
              <InlineProgressTracker state={order?.derivedState ?? request.state} />
            </span>
            <span className="cell-due-compact">{formatDateCompact(request.createdAt)}</span>
          </>
        );
        if (order) {
          return (
            <Link className="data-table-row data-table-link data-table-row-requests" key={request.paymentRequestId} to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}`}>
              {content}
            </Link>
          );
        }
        return <div className="data-table-row data-table-row-requests" key={request.paymentRequestId}>{content}</div>;
      })}
    </DataTableShell>
  );
}

function PaymentRunsTable({ workspaceId, runs }: { workspaceId: string; runs: PaymentRun[] }) {
  if (!runs.length) {
    return <EmptyState title="No payment runs yet" description="Import a CSV batch to create a run." />;
  }
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-runs-ext data-table-sticky-head">
        <span>Run</span>
        <span>Items</span>
        <span>Total</span>
        <span>Settled</span>
        <span>Exc</span>
        <span>In approval</span>
        <span>Stage</span>
        <span>Created</span>
      </div>
      {runs.map((run) => (
        <Link className="data-table-row data-table-link data-table-row-runs-ext" key={run.paymentRunId} to={`/workspaces/${workspaceId}/runs/${run.paymentRunId}`}>
          <span>
            <strong className="run-table-name">{run.runName}</strong>
          </span>
          <span>{run.totals.orderCount}</span>
          <span>{formatRawUsdcCompact(run.totals.totalAmountRaw)} USDC</span>
          <span>
            {run.totals.settledCount}/{run.totals.orderCount}
          </span>
          <span>{run.totals.exceptionCount}</span>
          <span>{run.totals.pendingApprovalCount}</span>
          <span><StatusBadge tone={statusToneForPayment(run.derivedState)}>{displayRunStatus(run.derivedState)}</StatusBadge></span>
          <span className="cell-due-compact">{formatDateCompact(run.createdAt)}</span>
        </Link>
      ))}
    </DataTableShell>
  );
}

function PaymentRunProofTable({
  workspaceId,
  runs,
  onExport,
  onPreview,
  previewPending,
}: {
  workspaceId: string;
  runs: PaymentRun[];
  onExport: (run: PaymentRun) => void;
  onPreview?: (run: PaymentRun) => void;
  previewPending?: boolean;
}) {
  if (!runs.length) return <EmptyState title="No payment runs yet" description="Import a CSV batch to create run-level proof." />;
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-runs">
        <span>Run</span><span>Items</span><span>Total</span><span>Ready</span><span>State</span><span>Proof</span>
      </div>
      {runs.map((run) => (
        <div className="data-table-row data-table-row-runs" key={run.paymentRunId}>
          <Link to={`/workspaces/${workspaceId}/runs/${run.paymentRunId}`}><strong>{run.runName}</strong><small>{shortenAddress(run.paymentRunId, 8, 6)}</small></Link>
          <span>{run.totals.orderCount}</span>
          <span>{formatRawUsdcCompact(run.totals.totalAmountRaw)} USDC</span>
          <span>{run.totals.readyCount}/{run.totals.orderCount}</span>
          <span><StatusBadge tone={statusToneForPayment(run.derivedState)}>{displayRunStatus(run.derivedState)}</StatusBadge></span>
          <span className="table-actions">
            {onPreview ? (
              <button className="button button-secondary button-small" disabled={previewPending} onClick={() => onPreview(run)} type="button">
                Preview
              </button>
            ) : null}
            <button className="button button-secondary button-small" onClick={() => onExport(run)} type="button">Export</button>
          </span>
        </div>
      ))}
    </DataTableShell>
  );
}

function DestinationsTable({
  destinations,
  onSelect,
}: {
  destinations: Destination[];
  onSelect?: (destination: Destination) => void;
}) {
  if (!destinations.length) return <EmptyState title="No destinations yet" description="Create wallets first, then turn them into destinations." />;
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-destinations">
        <span>Destination</span><span>Wallet</span><span>Owner</span><span>Trust</span><span>Scope</span><span>Status</span>
      </div>
      {destinations.map((destination) => (
        <div
          className={`data-table-row data-table-row-destinations${onSelect ? ' data-table-row-clickable' : ''}`}
          key={destination.destinationId}
          onClick={() => onSelect?.(destination)}
          onKeyDown={(event) => {
            if (onSelect && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              onSelect(destination);
            }
          }}
          role={onSelect ? 'button' : undefined}
          tabIndex={onSelect ? 0 : undefined}
        >
          <span><strong>{destination.label}</strong><small>{destination.destinationType}</small></span>
          <span><AddressLink value={destination.walletAddress} /></span>
          <span>{destination.counterparty?.displayName ?? 'Unassigned'}</span>
          <span><StatusBadge tone={toneForGenericState(destination.trustState)}>{trustDisplay(destination.trustState)}</StatusBadge></span>
          <span>{destination.isInternal ? 'internal' : 'external'}</span>
          <span>{destination.isActive ? 'active' : 'inactive'}</span>
        </div>
      ))}
    </DataTableShell>
  );
}

function WalletsTable({
  addresses,
  destinations,
  onSelect,
}: {
  addresses: TreasuryWallet[];
  destinations: Destination[];
  onSelect?: (address: TreasuryWallet) => void;
}) {
  if (!addresses.length) return <EmptyState title="No wallets saved" description="Save a wallet to watch, source, or destination-match USDC payments." />;
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-wallets"><span>Name</span><span>Address</span><span>Destination</span><span>Status</span></div>
      {addresses.map((address) => {
        const destination = destinations.find((item) => item.walletAddress === address.address);
        return (
          <div
            className={`data-table-row data-table-row-wallets${onSelect ? ' data-table-row-clickable' : ''}`}
            key={address.treasuryWalletId}
            onClick={() => onSelect?.(address)}
            onKeyDown={(event) => {
              if (onSelect && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onSelect(address);
              }
            }}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
          >
            <span><strong>{walletLabel(address)}</strong></span>
            <span onClick={(e) => e.stopPropagation()}><AddressLink value={address.address} /></span>
            <span>{destination?.label ?? 'Unlinked'}</span>
            <span>{address.isActive ? 'active' : 'inactive'}</span>
          </div>
        );
      })}
    </DataTableShell>
  );
}

function CounterpartiesTable({ counterparties, destinations }: { counterparties: Counterparty[]; destinations: Destination[] }) {
  if (!counterparties.length) return <EmptyState title="No counterparties yet" description="Counterparties are optional business owners behind destinations." />;
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-counterparties"><span>Name</span><span>Destinations</span><span>Category</span><span>Status</span></div>
      {counterparties.map((counterparty) => (
        <div className="data-table-row data-table-row-counterparties" key={counterparty.counterpartyId}>
          <span><strong>{counterparty.displayName}</strong></span>
          <span>{destinations.filter((destination) => destination.counterpartyId === counterparty.counterpartyId).length}</span>
          <span>{counterparty.category}</span>
          <span>{counterparty.status}</span>
        </div>
      ))}
    </DataTableShell>
  );
}

function ExceptionsTable({
  workspaceId,
  exceptions,
  paymentByTransferId,
  onAction,
  onResolve,
}: {
  workspaceId: string;
  exceptions: ExceptionItem[];
  paymentByTransferId: Map<string, PaymentOrder>;
  onAction: (exceptionId: string, action: 'reviewed' | 'expected' | 'dismissed' | 'reopen') => void;
  onResolve: (exception: ExceptionItem) => void;
}) {
  if (!exceptions.length) return <EmptyState title="No exceptions" description="Partial settlements, unmatched events, and review-needed payments will appear here." />;
  return (
    <DataTableShell>
      <div className="data-table-row data-table-head data-table-row-exceptions-v2 data-table-sticky-head">
        <span>Severity</span>
        <span>Context</span>
        <span>Exposure</span>
        <span>Age</span>
        <span>Owner</span>
        <span>Status</span>
        <span>Actions</span>
      </div>
      {exceptions.map((exception) => {
        const linked = exception.transferRequestId ? paymentByTransferId.get(exception.transferRequestId) : undefined;
        const recipientLabel = linked?.destination.label ?? 'N/A';
        return (
          <div className="data-table-row data-table-row-exceptions-v2" key={exception.exceptionId}>
            <span>
              <StatusBadge tone={toneForGenericState(exception.severity)}>{exception.severity}</StatusBadge>
            </span>
            <span>
              <Link to={`/workspaces/${workspaceId}/exceptions/${exception.exceptionId}`}>
                <strong>{recipientLabel}</strong>
              </Link>
              <small>{humanizeExceptionReason(exception.reasonCode)}</small>
            </span>
            <span>
              <strong>{linked ? `${formatRawUsdcCompact(linked.amountRaw)} ${assetSymbol(linked.asset)}` : 'N/A'}</strong>
              <small>{exception.exceptionType.replaceAll('_', ' ')}</small>
            </span>
            <span>{formatRelativeTime(exception.createdAt)}</span>
            <span>{exception.assignedToUser?.email ?? 'Unassigned'}</span>
            <span><StatusBadge tone={toneForGenericState(exception.status)}>{exception.status}</StatusBadge></span>
            <span className="table-actions">
              <Link className="button button-secondary button-small" to={`/workspaces/${workspaceId}/exceptions/${exception.exceptionId}`}>
                Open
              </Link>
              <button className="button button-primary button-small" onClick={() => onResolve(exception)} type="button">
                Resolve
              </button>
              <button className="button button-secondary button-small" onClick={() => onAction(exception.exceptionId, 'dismissed')} type="button">
                Dismiss
              </button>
            </span>
          </div>
        );
      })}
    </DataTableShell>
  );
}

function PaymentHero({ order }: { order: PaymentOrder }) {
  const latestSignature = order.reconciliationDetail?.latestExecution?.submittedSignature
    ?? order.reconciliationDetail?.match?.signature
    ?? null;
  const heroTime = order.reconciliationDetail?.latestExecution?.submittedAt ?? order.createdAt;
  const heroTimeLabel = latestSignature ? 'Executed' : 'Requested';

  return (
    <section className="payment-hero">
      <div className="payment-hero-amount">
        <span>Amount</span>
        <strong>{formatRawUsdcCompact(order.amountRaw)} {assetSymbol(order.asset)}</strong>
      </div>
      <div className="payment-hero-grid">
        <HeroCell label="Signature">
          {latestSignature ? <AddressLink value={latestSignature} kind="transaction" /> : <span>Not executed</span>}
        </HeroCell>
        <HeroCell label="From">
          {order.sourceTreasuryWallet?.address ? <AddressLink value={order.sourceTreasuryWallet.address} /> : <span>Source not set</span>}
        </HeroCell>
        <HeroCell label="To">
          {order.destination?.walletAddress ? <AddressLink value={order.destination.walletAddress} /> : <span>Destination unavailable</span>}
        </HeroCell>
        <HeroCell label="Time">
          <span>{heroTimeLabel}</span>
          <time title={formatTimestamp(heroTime)}>{formatRelativeTime(heroTime)}</time>
        </HeroCell>
      </div>
    </section>
  );
}

function ExecutionPanel({
  latestSignature,
  packet,
  wallets,
  selectedWalletId,
  isPreparing,
  isSigning,
  manualSignature,
  onManualSignatureChange,
  onPrepare,
  onSign,
  onSelectWallet,
  onAttachSignature,
}: {
  latestSignature: string | null;
  packet: PaymentExecutionPacket | null;
  wallets: BrowserWalletOption[];
  selectedWalletId: string | undefined;
  isPreparing: boolean;
  isSigning: boolean;
  manualSignature: string;
  onManualSignatureChange: (value: string) => void;
  onPrepare: () => void;
  onSign: () => void;
  onSelectWallet: (value: string | undefined) => void;
  onAttachSignature: () => void;
}) {
  const needsPrepare = !packet;
  return (
    <div className="execution-stack">
      {latestSignature ? (
        <div className="notice notice-success">
          Executed signature <AddressLink value={latestSignature} kind="transaction" />
        </div>
      ) : null}
      {packet ? (
        <div className="packet-box">
          <InfoGrid
            items={[
              [
                'From',
                packet.source?.walletAddress ? (
                  <>
                    <AddressLink key="packet-from-wallet" value={packet.source.walletAddress} />{' '}
                    // {safeShortAddress(packet.source?.tokenAccountAddress)}
                  </>
                ) : 'N/A',
              ],
              [
                'To',
                packet.destination?.walletAddress ? (
                  <>
                    {packet.destination.label} // <AddressLink key="packet-to-wallet" value={packet.destination.walletAddress} />
                  </>
                ) : `${packet.transfers?.length ?? 0} transfers`,
              ],
              ['Amount', `${formatRawUsdcCompact(packet.amountRaw)} ${packet.token?.symbol ?? 'USDC'}`],
              ['Instructions', `${packet.instructions.length} Solana instruction(s)`],
              ['Required signer', safeShortAddress(packet.signerWallet)],
            ]}
          />
        </div>
      ) : (
        <p className="section-copy">Prepare the exact non-custodial transaction packet before signing.</p>
      )}
      <div className="action-cluster">
        <button className={`button ${needsPrepare ? 'button-primary' : 'button-secondary'}`} disabled={isPreparing} onClick={onPrepare} type="button">
          {isPreparing ? 'Preparing...' : 'Prepare payment packet'}
        </button>
      </div>
      <label className="field">
        Browser wallet
        <WalletPicker wallets={wallets} selectedWalletId={selectedWalletId} onSelect={onSelectWallet} />
      </label>
      <button className="button button-primary" disabled={!packet || isSigning} onClick={onSign} type="button">
        {isSigning ? 'Signing...' : 'Sign and submit with source wallet'}
      </button>
      <div className="manual-signature">
        <label className="field">
          Manual executed signature
          <input value={manualSignature} onChange={(event) => onManualSignatureChange(event.target.value)} placeholder="Paste transaction signature" />
        </label>
        <button className="button button-secondary" onClick={onAttachSignature} type="button">
          Attach evidence
        </button>
      </div>
    </div>
  );
}

function RunExecutionPanel({
  run,
  packet,
  wallets,
  selectedWalletId,
  isPreparing,
  isSigning,
  manualSignature,
  onManualSignatureChange,
  onPrepare,
  onSign,
  onSelectWallet,
  onAttachSignature,
}: {
  run: PaymentRun;
  packet: PaymentExecutionPacket | null;
  wallets: BrowserWalletOption[];
  selectedWalletId: string | undefined;
  isPreparing: boolean;
  isSigning: boolean;
  manualSignature: string;
  onManualSignatureChange: (value: string) => void;
  onPrepare: () => void;
  onSign: () => void;
  onSelectWallet: (value: string | undefined) => void;
  onAttachSignature: () => void;
}) {
  return (
    <div className="execution-stack">
      <InfoGrid items={[
        ['Source', run.sourceTreasuryWallet ? walletLabel(run.sourceTreasuryWallet) : 'Not set'],
        ['Ready', `${run.totals.readyCount}/${run.totals.orderCount}`],
        ['Exceptions', String(run.totals.exceptionCount)],
        ['Prepared instructions', packet ? String(packet.instructions.length) : 'Not prepared'],
      ]} />
      {packet ? (
        <div className="packet-box">
          <InfoGrid
            items={[
              ['Signer', safeShortAddress(packet.signerWallet)],
              ['Transfers', String(packet.transfers?.length ?? 0)],
              ['Amount', `${formatRawUsdcCompact(packet.amountRaw)} ${packet.token?.symbol ?? 'USDC'}`],
              ['Instructions', String(packet.instructions.length)],
            ]}
          />
        </div>
      ) : null}
      <div className="action-cluster">
        <button className="button button-secondary" disabled={isPreparing} onClick={onPrepare} type="button">
          {isPreparing ? 'Preparing...' : 'Prepare batch packet'}
        </button>
      </div>
      <label className="field">
        Browser wallet
        <select value={selectedWalletId ?? ''} onChange={(event) => onSelectWallet(event.target.value || undefined)}>
          <option value="">Auto-detect wallet</option>
          {wallets.map((wallet) => (
            <option key={wallet.id} value={wallet.id} disabled={!wallet.ready}>
              {wallet.name}{wallet.address ? ` // ${shortenAddress(wallet.address)}` : ''}{wallet.ready ? '' : ' (unavailable)'}
            </option>
          ))}
        </select>
      </label>
      <button className="button button-primary" disabled={!packet || isSigning} onClick={onSign} type="button">
        {isSigning ? 'Signing...' : 'Sign and submit run'}
      </button>
      <div className="manual-signature">
        <label className="field">
          Manual executed signature
          <input value={manualSignature} onChange={(event) => onManualSignatureChange(event.target.value)} placeholder="Paste transaction signature" />
        </label>
        <button className="button button-secondary" onClick={onAttachSignature} type="button">
          Attach evidence
        </button>
      </div>
    </div>
  );
}

function WalletPicker({
  wallets,
  selectedWalletId,
  onSelect,
}: {
  wallets: BrowserWalletOption[];
  selectedWalletId?: string;
  onSelect: (walletId?: string) => void;
}) {
  return (
    <div className="wallet-picker">
      <button
        className={`wallet-picker-row${!selectedWalletId ? ' wallet-picker-row-active' : ''}`}
        onClick={() => onSelect(undefined)}
        type="button"
      >
        <span className="wallet-picker-main">
          <span className="wallet-picker-icon" aria-hidden>◇</span>
          <span className="wallet-picker-copy">
            <strong>Auto-detect wallet</strong>
            <small>Use first available browser wallet</small>
          </span>
        </span>
        <span className="wallet-picker-badge">AUTO</span>
      </button>
      {wallets.map((wallet) => (
        <button
          key={wallet.id}
          className={`wallet-picker-row${selectedWalletId === wallet.id ? ' wallet-picker-row-active' : ''}`}
          disabled={!wallet.ready}
          onClick={() => onSelect(wallet.id)}
          type="button"
        >
          <span className="wallet-picker-main">
            {wallet.icon ? (
              <img className="wallet-picker-image" src={wallet.icon} alt="" />
            ) : (
              <span className="wallet-picker-icon" aria-hidden>◆</span>
            )}
            <span className="wallet-picker-copy">
              <strong>{wallet.name}</strong>
              <small>{wallet.address ? shortenAddress(wallet.address) : 'No account exposed yet'}</small>
            </span>
          </span>
          <span className={`wallet-picker-badge ${wallet.ready ? 'wallet-picker-badge-ready' : 'wallet-picker-badge-disabled'}`}>
            {wallet.ready ? 'INSTALLED' : 'UNAVAILABLE'}
          </span>
        </button>
      ))}
    </div>
  );
}

function PageFrame({
  eyebrow,
  title,
  description,
  action,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {action ? <div className="page-actions">{action}</div> : null}
      </header>
      {children}
    </div>
  );
}

function WorkflowRail({
  steps,
}: {
  steps: Array<{ label: string; subtext: string; state: 'pending' | 'current' | 'complete' | 'blocked' }>;
}) {
  return (
    <section className="workflow-rail" aria-label="Payment workflow">
      {steps.map((step) => (
        <div className={`workflow-step workflow-step-${step.state}`} key={step.label}>
          <span>{step.label}</span>
          <strong>{step.subtext}</strong>
        </div>
      ))}
    </section>
  );
}

function RunProgressTracker({
  steps,
}: {
  steps: Array<{ label: string; subtext: string; state: 'pending' | 'current' | 'complete' | 'blocked' }>;
}) {
  return (
    <section className="run-progress" aria-label="Payment run progress">
      {steps.map((step, index) => (
        <div className="run-progress-step-wrap" key={step.label}>
          <div className={`run-progress-step run-progress-step-${step.state}`}>
            <div className="run-progress-row">
              <span className={`run-progress-dot run-progress-dot-${step.state}`} aria-hidden />
              {index < steps.length - 1 ? <span className={`run-progress-line run-progress-line-${step.state}`} aria-hidden /> : null}
            </div>
            <div className="run-progress-copy">
              <strong>{step.label}</strong>
              <small>{step.subtext}</small>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

function InlineProgressTracker({ state }: { state: string }) {
  const stages = ['draft', 'pending_approval', 'ready_for_execution', 'execution_recorded', 'settled'];
  const currentIndex = Math.max(
    stages.indexOf(state === 'approved' ? 'ready_for_execution' : (state === 'closed' ? 'settled' : state)),
    0,
  );
  return (
    <span className="inline-progress" aria-label={`Progress: ${state}`}>
      {stages.map((_, idx) => (
        <span
          key={idx}
          className={`inline-progress-dot${
            idx < currentIndex ? ' inline-progress-dot-complete' : idx === currentIndex ? ' inline-progress-dot-current' : ''
          }`}
        />
      ))}
    </span>
  );
}

function InfoSection({
  title,
  state,
  toneKey,
  sectionId,
  children,
}: {
  title: string;
  state?: string;
  toneKey?: string;
  sectionId?: string;
  children: ReactNode;
}) {
  const badgeTone = (() => {
    const key = toneKey ?? state ?? '';
    if (key && isPaymentOrderState(key)) return statusToneForPayment(key);
    return toneForGenericState(key);
  })();

  return (
    <section className="info-section" id={sectionId}>
      <header>
        <h2>{title}</h2>
        {state ? <StatusBadge tone={badgeTone}>{state}</StatusBadge> : null}
      </header>
      <div className="info-section-body">{children}</div>
    </section>
  );
}

function InfoGrid({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="info-grid">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TimelineList({ items }: { items: Array<{ title: string; body: React.ReactNode; time: string }> }) {
  if (!items.length) {
    return <p className="section-copy">No events recorded.</p>;
  }

  return (
    <div className="timeline-list">
      {items.map((item, index) => (
        <article key={`${item.title}-${item.time}-${index}`}>
          <div>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
          </div>
          <time title={formatTimestamp(item.time)}>{formatRelativeTime(item.time)}</time>
        </article>
      ))}
    </div>
  );
}

function CompactStageEvents({ items }: { items: Array<{ title: string; body: React.ReactNode; time: string }> }) {
  return (
    <div className="compact-stage-events">
      {items.map((item, index) => (
        <div key={`${item.title}-${item.time}-${index}`} className="compact-stage-event">
          <strong>{item.title}</strong>
          <time title={formatTimestamp(item.time)}>{formatRelativeTime(item.time)}</time>
          <p>{item.body}</p>
        </div>
      ))}
    </div>
  );
}

function SidePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="side-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return <PanelHeader title={title} description={description} />;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <MetricTile label={label} value={value} />;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <EmptyPanel title={title} description={description} />;
}

function SimpleList({
  items,
  empty,
}: {
  items: Array<{ id: string; title: string; meta: string }>;
  empty: string;
}) {
  if (!items.length) {
    return <EmptyState title={empty} description="Use the available actions on this page to create the first record." />;
  }
  return (
    <div className="simple-list">
      {items.map((item) => (
        <article key={item.id}>
          <strong>{item.title}</strong>
          <span>{item.meta}</span>
        </article>
      ))}
    </div>
  );
}

function ScreenState({ title, description }: { title: string; description: string }) {
  return (
    <main className="screen-state">
      <EmptyState title={title} description={description} />
    </main>
  );
}

function HeroCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hero-cell">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function AddressLink({ value, kind = 'account' }: { value: string; kind?: 'account' | 'transaction' }) {
  const href = kind === 'transaction' ? orbTransactionUrl(value) : orbAccountUrl(value);
  return (
    <span className="address-link">
      <a href={href} rel="noreferrer" target="_blank" title={value}>
        {shortenAddress(value, 6, 6)}
      </a>
      <a href={href} rel="noreferrer" target="_blank" aria-label="Open in explorer">↗</a>
    </span>
  );
}

function orbAccountUrl(address: string) {
  return `https://orbmarkets.io/address/${address}?tab=summary`;
}

function StatusBadge({ tone, state, children }: { tone?: 'success' | 'warning' | 'danger' | 'neutral'; state?: string; children: ReactNode }) {
  const resolved =
    tone ?? (state && isPaymentOrderState(state) ? statusToneForPayment(state) : toneForGenericState(state ?? ''));
  return <span className={`status-badge status-${resolved}`}>{children}</span>;
}

function getWorkspaces(session: AuthenticatedSession) {
  return session.organizations.flatMap((organization) => (
    organization.workspaces.map((workspace) => ({ organization, workspace }))
  ));
}

function findWorkspace(session: AuthenticatedSession, workspaceId?: string): Workspace | null {
  if (!workspaceId) return null;
  for (const organization of session.organizations) {
    const workspace = organization.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
    if (workspace) return workspace;
  }
  return null;
}

function isActionableOrder(order: PaymentOrder) {
  return ['pending_approval', 'approved', 'ready_for_execution', 'exception', 'partially_settled'].includes(order.derivedState);
}

function summarizePayment(order: PaymentOrder) {
  const title = order.counterparty?.displayName ?? order.destination.label;
  const reference = order.externalReference ?? order.invoiceNumber ?? order.memo ?? 'No reference';
  return {
    title,
    description: `${formatRawUsdcCompact(order.amountRaw)} ${assetSymbol(order.asset)} / ${reference}`,
  };
}

function buildWorkflow(order: PaymentOrder) {
  if (order.derivedState === 'cancelled') {
    return [
      { label: 'Imported', subtext: '1 row', state: 'complete' as const },
      { label: 'Reviewed', subtext: 'Not started', state: 'pending' as const },
      { label: 'Approval', subtext: 'Rejected', state: 'blocked' as const },
      { label: 'Execute', subtext: 'Not started', state: 'pending' as const },
      { label: 'Settle', subtext: 'Waiting', state: 'pending' as const },
      { label: 'Prove', subtext: 'Pending', state: 'pending' as const },
    ];
  }

  const currentIndexMap: Record<PaymentOrderState, number> = {
    draft: 1,
    pending_approval: 2,
    approved: 3,
    ready_for_execution: 3,
    execution_recorded: 4,
    settled: 5,
    partially_settled: 4,
    exception: 4,
    cancelled: 4,
    closed: 5,
  };
  const currentIndex = currentIndexMap[order.derivedState] ?? 1;
  const blocked = order.derivedState === 'exception' || order.derivedState === 'partially_settled';
  const reviewState = stepState(1, currentIndex, blocked);
  const approveState = stepState(2, currentIndex, blocked);
  const submitState = stepState(3, currentIndex, blocked);
  const settleState = blocked ? ('blocked' as const) : stepState(4, currentIndex, false);
  const proveState = order.derivedState === 'settled' || order.derivedState === 'closed' ? ('complete' as const) : blocked ? ('blocked' as const) : ('pending' as const);
  const tenseLabel = (complete: boolean, past: string, present: string) => (complete ? past : present);
  return [
    { label: 'Imported', subtext: '1 row', state: 'complete' as const },
    { label: tenseLabel(reviewState === 'complete', 'Reviewed', 'Review'), subtext: reviewState === 'complete' ? 'Reviewed' : 'Review pending', state: reviewState },
    { label: tenseLabel(approveState === 'complete', 'Approved', 'Approve'), subtext: getApprovalLabel(order), state: approveState },
    { label: tenseLabel(submitState === 'complete', 'Executed', 'Execute'), subtext: getExecutionLabel(order), state: submitState },
    { label: tenseLabel(settleState === 'complete', 'Settled', 'Settle'), subtext: getSettlementLabel(order), state: settleState },
    { label: tenseLabel(proveState === 'complete', 'Proven', 'Prove'), subtext: proveState === 'complete' ? 'Ready' : 'Pending', state: proveState },
  ];
}

function buildRunWorkflow(run: PaymentRun) {
  const state = run.derivedState;
  const blocked = state === 'exception' || state === 'partially_settled';
  const settled = state === 'settled' || state === 'closed';
  const pendingApproval = run.totals.pendingApprovalCount;
  const draftCount = Math.max(run.totals.actionableCount - pendingApproval - run.totals.approvedCount, 0);
  const approvedDone = run.totals.approvedCount > 0 || settled || state === 'execution_recorded' || state === 'exception' || state === 'partially_settled';
  const submittedDone = ['execution_recorded', 'partially_settled', 'settled', 'closed', 'exception'].includes(state);
  const reviewedCurrent = !approvedDone && draftCount > 0;
  const approvedCurrent = !approvedDone && pendingApproval > 0;
  const submittedCurrent = approvedDone && !submittedDone && !blocked;
  const settledCurrent = !blocked && !settled && submittedDone;
  const reviewedState = reviewedCurrent ? ('current' as const) : ('complete' as const);
  const approvedState = approvedDone ? ('complete' as const) : approvedCurrent ? ('current' as const) : ('pending' as const);
  const submittedState = blocked ? ('blocked' as const) : submittedDone ? ('complete' as const) : submittedCurrent ? ('current' as const) : ('pending' as const);
  const settledState = blocked ? ('blocked' as const) : settled ? ('complete' as const) : settledCurrent ? ('current' as const) : ('pending' as const);
  const provenState = settled ? ('complete' as const) : ('pending' as const);
  const tenseLabel = (complete: boolean, past: string, present: string) => (complete ? past : present);
  const approvedRows = run.totals.approvedCount;
  const rejectedRows = run.totals.cancelledCount;
  const approvalSummary = rejectedRows > 0
    ? `${approvedRows} approved / ${rejectedRows} rejected`
    : approvedDone
      ? 'Ready rows exist'
      : 'Waiting';
  return [
    { label: 'Imported', subtext: `${run.totals.orderCount} rows`, state: 'complete' as const },
    {
      label: tenseLabel(reviewedState === 'complete', 'Reviewed', 'Review'),
      subtext: draftCount > 0 ? `${draftCount} awaiting review` : 'Reviewed',
      state: reviewedState,
    },
    {
      label: tenseLabel(approvedState === 'complete', 'Approved', 'Approve'),
      subtext: pendingApproval > 0 ? `${pendingApproval} need approval` : approvalSummary,
      state: approvedState,
    },
    {
      label: tenseLabel(submittedState === 'complete', 'Executed', 'Execute'),
      subtext: blocked ? 'Needs review' : submittedDone ? 'On chain' : approvedDone ? 'Ready to sign and execute' : 'Pending',
      state: submittedState,
    },
    {
      label: tenseLabel(settledState === 'complete', 'Settled', 'Settle'),
      subtext: `${run.totals.settledCount}/${Math.max(run.totals.actionableCount, 1)} matched`,
      state: settledState,
    },
    { label: tenseLabel(provenState === 'complete', 'Proven', 'Prove'), subtext: settled ? 'Proof ready' : 'Pending', state: provenState },
  ];
}

function stepState(stepIndex: number, currentIndex: number, blocked: boolean) {
  if (blocked && stepIndex >= currentIndex) return 'blocked' as const;
  if (stepIndex < currentIndex) return 'complete' as const;
  if (stepIndex === currentIndex) return 'current' as const;
  return 'pending' as const;
}

function paymentTimelineStates(state: PaymentOrderState): Record<'request' | 'approval' | 'execution' | 'settlement' | 'proof', 'complete' | 'current' | 'pending' | 'blocked'> {
  if (state === 'cancelled') {
    return {
      request: 'complete',
      approval: 'blocked',
      execution: 'pending',
      settlement: 'pending',
      proof: 'pending',
    };
  }
  const blocked = state === 'exception' || state === 'partially_settled';
  const indexMap: Record<string, number> = {
    draft: 0,
    pending_approval: 1,
    approved: 2,
    ready_for_execution: 2,
    execution_recorded: 3,
    settled: 4,
    closed: 4,
  };
  const current = Math.max(indexMap[state] ?? 0, 0);
  const resolve = (idx: number) => stepState(idx, current, blocked);
  return {
    request: resolve(0),
    approval: resolve(1),
    execution: resolve(2),
    settlement: resolve(3),
    proof: state === 'settled' || state === 'closed' ? 'complete' : blocked ? 'blocked' : 'pending',
  };
}

function getApprovalLabel(order: PaymentOrder) {
  if (order.derivedState === 'pending_approval') return 'Needs approval';
  if (order.derivedState === 'draft') return 'Draft';
  if (order.derivedState === 'cancelled') return 'Rejected';
  return 'Approved';
}

function getApprovalSummary(order: PaymentOrder) {
  const evaluation = order.reconciliationDetail?.approvalEvaluation;
  if (!evaluation) {
    return order.derivedState === 'draft'
      ? 'This payment has not entered approval yet.'
      : 'Approval context is not available yet.';
  }
  if (!evaluation.requiresApproval) {
    return `Auto-cleared by ${evaluation.policyName}.`;
  }
  return evaluation.reasons.map((reason) => reason.message).join(' ') || 'Approval is required by policy.';
}

function getExecutionLabel(order: PaymentOrder) {
  if (order.derivedState === 'ready_for_execution') return 'Ready to sign';
  if (order.derivedState === 'execution_recorded') return 'Executed';
  if (order.derivedState === 'settled' || order.derivedState === 'closed') return 'Completed';
  if (order.derivedState === 'exception' || order.derivedState === 'partially_settled') return 'Needs review';
  return 'Not started';
}

function executionActionLabel(order: PaymentOrder) {
  if (order.derivedState === 'ready_for_execution') return 'Open signer';
  if (order.derivedState === 'execution_recorded') return 'Track settlement';
  if (order.derivedState === 'exception' || order.derivedState === 'partially_settled') return 'Resolve issue';
  return 'Open payment';
}

function executionReasonLine(order: PaymentOrder) {
  if (!order.sourceTreasuryWalletId && order.derivedState === 'ready_for_execution') {
    return 'Source wallet missing before signing.';
  }
  if (order.derivedState === 'ready_for_execution') return 'Approved and waiting for signature.';
  if (order.derivedState === 'execution_recorded') return 'Signed and waiting for chain match.';
  if (order.derivedState === 'exception') return 'Exception needs operator review.';
  if (order.derivedState === 'partially_settled') return 'Partial match detected, verify settlement.';
  return 'Waiting for execution step.';
}

function getSettlementLabel(order: PaymentOrder) {
  if (order.derivedState === 'settled' || order.derivedState === 'closed') return 'Matched';
  if (order.derivedState === 'partially_settled') return 'Partial';
  if (order.derivedState === 'exception') return 'Needs review';
  return 'Waiting';
}

function settlementDisplayState(row: ReconciliationRow) {
  if (row.approvalState === 'rejected' || row.executionState === 'rejected') return 'Rejected';
  return displayReconciliationState(row.requestDisplayState);
}

function settlementMatchLabel(row: ReconciliationRow) {
  if (row.approvalState === 'rejected' || row.executionState === 'rejected') return 'Not applicable';
  return row.match ? row.match.matchStatus.replaceAll('_', ' ') : 'Not matched';
}

function hasExecutionRecorded(order: PaymentOrder): boolean {
  if (order.reconciliationDetail?.latestExecution?.submittedSignature) return true;
  if (order.reconciliationDetail?.latestExecution?.submittedAt) return true;
  return (
    order.derivedState === 'execution_recorded'
    || order.derivedState === 'partially_settled'
    || order.derivedState === 'settled'
    || order.derivedState === 'closed'
  );
}

function ageHours(timestamp: string): number {
  const parsed = new Date(timestamp).getTime();
  if (Number.isNaN(parsed)) return 0;
  return (Date.now() - parsed) / 3_600_000;
}

function commandPriorityScore(order: PaymentOrder): number {
  const stateWeight: Record<PaymentOrder['derivedState'], number> = {
    draft: 5,
    pending_approval: 40,
    approved: 22,
    ready_for_execution: 34,
    execution_recorded: 24,
    partially_settled: 32,
    settled: 1,
    exception: 38,
    closed: 1,
    cancelled: 1,
  };
  const amountScore = Number.parseFloat(order.amountRaw) / 1_000_000;
  const ageScore = Math.min(48, ageHours(order.createdAt));
  return (stateWeight[order.derivedState] ?? 1) + amountScore + ageScore;
}

function commandPriorityReason(order: PaymentOrder): string {
  const aging = ageHours(order.createdAt);
  if (order.derivedState === 'pending_approval') return `Approval blocked for ${Math.floor(aging)}h.`;
  if (order.derivedState === 'ready_for_execution') return `Approved and waiting execution for ${Math.floor(aging)}h.`;
  if (order.derivedState === 'execution_recorded') return `Executed and waiting settlement for ${Math.floor(aging)}h.`;
  if (order.derivedState === 'partially_settled') return 'Partial settlement requires reconciliation.';
  if (order.derivedState === 'exception') return 'Exception state requires operator review.';
  return `In workflow for ${Math.floor(aging)}h.`;
}

function proofReadinessLine(order: PaymentOrder): string {
  const hasDecision = Boolean(order.reconciliationDetail?.approvalDecisions?.length);
  const hasExecution = hasExecutionRecorded(order);
  const hasMatch = Boolean(order.reconciliationDetail?.match?.signature);
  const hasException = Boolean(order.reconciliationDetail?.exceptions?.length);
  return [
    hasDecision ? 'approval ok' : 'approval pending',
    hasExecution ? 'execution present' : 'execution missing',
    hasMatch ? 'settlement matched' : 'match pending',
    hasException ? 'has exceptions' : 'no exceptions',
  ].join(' · ');
}

function getFormString(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

function getOptionalFormString(formData: FormData, key: string) {
  const value = getFormString(formData, key);
  return value || null;
}

function normalizeDateInput(value: string | null) {
  if (!value) return undefined;
  return value.includes('T') ? new Date(value).toISOString() : new Date(`${value}T00:00:00`).toISOString();
}

function usdcToRaw(value: string) {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed) && trimmed.length > 6) return trimmed;
  const [wholePart, decimalPart = ''] = trimmed.split('.');
  if (!/^\d+$/.test(wholePart || '0') || !/^\d*$/.test(decimalPart)) {
    throw new Error('Amount must be a valid USDC number.');
  }
  const decimals = decimalPart.padEnd(6, '0').slice(0, 6);
  return `${wholePart || '0'}${decimals}`.replace(/^0+(?=\d)/, '') || '0';
}

function yesNo(value: boolean) {
  return value ? 'yes' : 'no';
}

function assetSymbol(asset: string | null | undefined) {
  return (asset ?? '').toUpperCase();
}

function formatDateCompact(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function walletLabel(address: Pick<TreasuryWallet, 'displayName' | 'address'> | null | undefined) {
  if (!address) return null;
  return address.displayName ?? shortenAddress(address.address);
}

function safeShortAddress(value: string | null | undefined) {
  return value ? shortenAddress(value) : 'N/A';
}

function getPreparedPacket(order: PaymentOrder | undefined): PaymentExecutionPacket | null {
  const records = order?.reconciliationDetail?.executionRecords ?? [];
  for (const record of records) {
    const meta = record.metadataJson as { executionPacket?: unknown; preparedExecution?: unknown } | undefined;
    const packet = meta?.executionPacket ?? meta?.preparedExecution;
    if (isPaymentExecutionPacket(packet)) return packet;
  }
  return null;
}

function isPaymentExecutionPacket(value: unknown): value is PaymentExecutionPacket {
  return Boolean(value && typeof value === 'object' && 'kind' in value && 'instructions' in value);
}

function timelineLabel(item: ReconciliationTimelineItem) {
  switch (item.timelineType) {
    case 'request_event':
      return {
        type: item.eventType.replaceAll('_', ' '),
        description: item.afterState ? `${item.beforeState ?? 'created'} -> ${item.afterState}` : 'Request event recorded.',
        createdAt: item.createdAt,
      };
    case 'request_note':
      return { type: 'note', description: item.body, createdAt: item.createdAt };
    case 'approval_decision':
      return { type: item.action.replaceAll('_', ' '), description: item.comment ?? 'Approval decision recorded.', createdAt: item.createdAt };
    case 'execution_record':
      return { type: 'execution', description: `${item.executionSource} / ${item.state}`, createdAt: item.createdAt };
    case 'observed_execution':
      return { type: 'observed execution', description: `${item.status} at slot ${item.slot}`, createdAt: item.createdAt };
    case 'match_result':
      return { type: item.matchStatus.replaceAll('_', ' '), description: item.explanation, createdAt: item.createdAt };
    case 'exception':
      return { type: item.reasonCode.replaceAll('_', ' '), description: item.explanation, createdAt: item.createdAt };
  }

  const fallback = item as unknown as { timelineType?: string; createdAt: string };
  return {
    type: String(fallback.timelineType ?? 'timeline_event').replaceAll('_', ' '),
    description: 'Timeline event recorded.',
    createdAt: fallback.createdAt,
  };
}

function downloadJson(fileName: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}
