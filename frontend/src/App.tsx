import type { FormEvent, ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppSidebar } from './Sidebar';
import { api, ApiError } from './api';
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
import { LandingPage as LandingPageV2 } from './pages/Landing';
import { MembersPage } from './pages/Members';
import { TreasuryWalletDetailPage } from './pages/TreasuryWalletDetail';
import { OrganizationProposalsPage } from './pages/OrganizationProposals';
import { OrganizationProposalDetailPage } from './pages/OrganizationProposalDetail';
import { InviteAcceptPage } from './pages/InviteAccept';
import { AuthDivider, OAuthButton } from './ui/AuthButtons';
import { useToast } from './ui/Toast';
import type {
  AuthenticatedSession,
  Counterparty,
  Destination,
  PaymentOrder,
  PaymentOrderState,
  PaymentRequest,
  PaymentRun,
  TreasuryWallet,
  Organization,
  UserWallet,
} from './api';
import {
  discoverSolanaWallets,
  formatRawUsdcCompact,
  formatRelativeTime,
  formatTimestamp,
  orbAccountUrl,
  orbTransactionUrl,
  shortenAddress,
  signAndSubmitPreparedPayment,
  subscribeSolanaWallets,
  type BrowserWalletOption,
} from './domain';
import { setRuntimeSolanaConfig } from './solana-network';
import { parseCsvPreview } from './csv-parse';
import { ProofJsonView } from './proof-json-view';
import {
  displayPaymentRequestState,
  displayPaymentStatus,
  displayReconciliationState,
  displayRunStatus,
  EXECUTION_BUCKETS,
  executionBucketTitle,
  type ExecutionBucket,
  humanizeExceptionReason,
  isPaymentOrderState,
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
  Modal,
  PanelHeader,
  Tabs,
} from './ui-primitives';

function queryKeys(organizationId?: string, paymentOrderId?: string) {
  return {
    session: ['session'] as const,
    addresses: ['addresses', organizationId] as const,
    counterparties: ['counterparties', organizationId] as const,
    destinations: ['destinations', organizationId] as const,
    paymentRequests: ['payment-requests', organizationId] as const,
    paymentRuns: ['payment-runs', organizationId] as const,
    paymentRun: ['payment-run', organizationId, paymentOrderId] as const,
    paymentOrders: ['payment-orders', organizationId] as const,
    paymentOrder: ['payment-order', organizationId, paymentOrderId] as const,
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
  const capabilitiesQuery = useQuery({
    queryKey: ['capabilities'] as const,
    queryFn: () => api.getCapabilities(),
    retry: false,
    staleTime: 60_000,
  });
  const shouldCheckSession =
    location.pathname !== '/login' &&
    location.pathname !== '/register' &&
    api.hasSessionToken();
  const sessionQuery = useQuery({
    queryKey: queryKeys().session,
    queryFn: () => api.getSession(),
    enabled: shouldCheckSession,
    retry: false,
  });

  useEffect(() => {
    const solana = capabilitiesQuery.data?.solana;
    if (solana) {
      setRuntimeSolanaConfig(solana);
    }
  }, [capabilitiesQuery.data?.solana]);

  return (
    <Routes>
      <Route path="/" element={<LandingPageV2 />} />
      <Route path="/landing" element={<LandingPageV2 />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
      <Route path="/invites/:inviteToken" element={<InviteAcceptPage />} />
      <Route path="/verify-email" element={<RequireSession sessionQuery={sessionQuery} />} />
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
    return <ScreenState title="Loading organization" description="Checking your session." />;
  }

  if (!sessionQuery.data) {
    return <Navigate to="/login" replace />;
  }

  if (!sessionQuery.data.user.emailVerifiedAt) {
    return <VerifyEmailPage session={sessionQuery.data} />;
  }

  return <AppShell session={sessionQuery.data} />;
}

function AppShell({ session }: { session: AuthenticatedSession }) {
  const organizations = useMemo(() => getOrganizations(session), [session]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const activeOrganizationId = useMemo(() => {
    const match = location.pathname.match(/^\/organizations\/([^/]+)/);
    return match?.[1];
  }, [location.pathname]);
  const organizationSummaryQuery = useQuery({
    queryKey: ['organization-summary', activeOrganizationId] as const,
    queryFn: () => api.getOrganizationSummary(activeOrganizationId!),
    enabled: Boolean(activeOrganizationId),
    refetchInterval: () =>
      typeof document !== 'undefined' && document.hidden ? false : 15_000,
  });
  const paymentsIncompleteCount = organizationSummaryQuery.data?.paymentsIncompleteCount ?? 0;
  const collectionsOpenCount = organizationSummaryQuery.data?.collectionsOpenCount ?? 0;
  const destinationsUnreviewedCount = organizationSummaryQuery.data?.destinationsUnreviewedCount ?? 0;
  const payersUnreviewedCount = organizationSummaryQuery.data?.payersUnreviewedCount ?? 0;

  async function logout() {
    await queryClient.cancelQueries();
    await api.logout().catch(() => undefined);
    api.clearSessionToken();
    queryClient.removeQueries({ queryKey: queryKeys().session });
    queryClient.clear();
    navigate('/', { replace: true });
  }

  return (
    <div className="app-shell">
      <AppSidebar
        session={session}
        organizationContexts={organizations}
        activeOrganizationId={activeOrganizationId}
        paymentsIncompleteCount={paymentsIncompleteCount}
        collectionsOpenCount={collectionsOpenCount}
        destinationsUnreviewedCount={destinationsUnreviewedCount}
        payersUnreviewedCount={payersUnreviewedCount}
        onOrganizationSwitch={(organizationId) => navigate(`/organizations/${organizationId}`)}
        onLogout={logout}
      />
      <main className="main-surface">
        <Routes>
          <Route path="/" element={<HomeRedirect session={session} />} />
          <Route path="/setup" element={<SetupPage session={session} />} />
          <Route path="/profile" element={<ProfilePage session={session} />} />
          <Route path="/organizations/:organizationId" element={<CommandCenterPageV2 session={session} />} />
          <Route path="/organizations/:organizationId/wallets" element={<WalletsPage session={session} />} />
          <Route path="/organizations/:organizationId/wallets/:treasuryWalletId" element={<TreasuryWalletDetailPage session={session} />} />
          <Route path="/organizations/:organizationId/proposals" element={<OrganizationProposalsPage session={session} />} />
          <Route path="/organizations/:organizationId/proposals/:decimalProposalId" element={<OrganizationProposalDetailPage session={session} />} />
          <Route path="/organizations/:organizationId/members" element={<MembersPage session={session} />} />
          <Route path="/organizations/:organizationId/counterparties" element={<CounterpartiesPage session={session} />} />
          <Route path="/organizations/:organizationId/destinations" element={<DestinationsPage session={session} />} />
          <Route path="/organizations/:organizationId/registry" element={<AddressBookPage session={session} />} />
          <Route path="/organizations/:organizationId/requests" element={<PaymentRequestsPage session={session} />} />
          <Route path="/organizations/:organizationId/runs" element={<PaymentsPageV2 session={session} />} />
          <Route path="/organizations/:organizationId/runs/:paymentRunId" element={<PaymentRunDetailPageV2 />} />
          <Route path="/organizations/:organizationId/payments" element={<PaymentsPageV2 session={session} />} />
          <Route path="/organizations/:organizationId/payments/:paymentOrderId" element={<PaymentDetailPageV2 />} />
          <Route path="/organizations/:organizationId/collections" element={<CollectionsPage session={session} />} />
          <Route path="/organizations/:organizationId/collections/:collectionRequestId" element={<CollectionDetailPage />} />
          <Route path="/organizations/:organizationId/collection-runs/:collectionRunId" element={<CollectionRunDetailPage />} />
          <Route path="/organizations/:organizationId/payers" element={<CollectionSourcesPage session={session} />} />
        </Routes>
      </main>
    </div>
  );
}

function readSafeReturnTo(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get('returnTo');
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

function authErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_credentials') return 'Invalid email or password.';
    if (err.code === 'conflict') return 'An account with this email already exists.';
    if (err.code === 'validation_error') return err.message || 'Please check the form and try again.';
    return err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

function AuthTabs({ active }: { active: 'login' | 'register' }) {
  return (
    <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
      <Link
        to="/login"
        role="tab"
        aria-selected={active === 'login'}
        data-active={active === 'login'}
        className="auth-tab"
        replace
      >
        Sign in
      </Link>
      <Link
        to="/register"
        role="tab"
        aria-selected={active === 'register'}
        data-active={active === 'register'}
        className="auth-tab"
        replace
      >
        Create account
      </Link>
    </div>
  );
}

function OAuthCallbackPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = fragment.get('session_token');
    const returnTo = fragment.get('return_to') || '/setup';
    const oauthError = fragment.get('error');
    window.history.replaceState(null, document.title, '/oauth/callback');

    if (oauthError) {
      setError(`Google sign-in failed: ${oauthError}`);
      return;
    }
    if (!token) {
      setError('Google sign-in did not return a session.');
      return;
    }

    api.setSessionToken(token);
    void queryClient
      .fetchQuery({ queryKey: queryKeys().session, queryFn: () => api.getSession() })
      .then((session) => {
        const firstOrganizationId = session.organizations[0]?.organizationId;
        const safeReturnTo = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/setup';
        navigate(firstOrganizationId && safeReturnTo === '/setup' ? `/organizations/${firstOrganizationId}` : safeReturnTo, {
          replace: true,
        });
      })
      .catch((err) => {
        api.clearSessionToken();
        setError(err instanceof Error ? err.message : 'Unable to finish Google sign-in.');
      });
  }, [navigate, queryClient]);

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="panel-kicker">Google OAuth</div>
        <h1 className="auth-title">{error ? 'Sign-in failed' : 'Finishing sign-in'}</h1>
        <p className="muted-copy">
          {error ?? 'Creating your Decimal session and loading your organizations.'}
        </p>
        {error ? (
          <Link className="button button-primary" to="/login" replace>
            Back to sign in
          </Link>
        ) : null}
      </section>
    </main>
  );
}

function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = readSafeReturnTo(location.search);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const loginMutation = useMutation({
    mutationFn: (input: { email: string; password: string }) => {
      // Always start login from a clean auth state so stale tokens cannot win.
      void queryClient.cancelQueries({ queryKey: queryKeys().session });
      queryClient.removeQueries({ queryKey: queryKeys().session });
      api.clearSessionToken();
      return api.login(input);
    },
    onSuccess: async (result) => {
      api.setSessionToken(result.sessionToken);
      queryClient.setQueryData(queryKeys().session, toAuthenticatedSession(result));
      if (!result.user.emailVerifiedAt) {
        navigate(returnTo ? `/verify-email?returnTo=${encodeURIComponent(returnTo)}` : '/verify-email', { replace: true });
        return;
      }
      if (returnTo) {
        navigate(returnTo, { replace: true });
        return;
      }
      const firstOrganizationId = result.organizations[0]?.organizationId;
      navigate(firstOrganizationId ? `/organizations/${firstOrganizationId}` : '/setup', { replace: true });
    },
    onError: (nextError) => {
      setError(authErrorMessage(nextError, 'Unable to sign in.'));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError('Email is required.');
      return;
    }
    if (!password) {
      setError('Password is required.');
      return;
    }
    setError(null);
    loginMutation.mutate({ email: normalizedEmail, password });
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <AuthTabs active="login" />
        <OAuthButton mode="login" returnTo={returnTo} />
        <AuthDivider />
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
              required
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
              required
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

function RegisterPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = readSafeReturnTo(location.search);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const registerMutation = useMutation({
    mutationFn: (input: { email: string; password: string; displayName?: string }) => {
      void queryClient.cancelQueries({ queryKey: queryKeys().session });
      queryClient.removeQueries({ queryKey: queryKeys().session });
      api.clearSessionToken();
      return api.register(input);
    },
    onSuccess: (result) => {
      api.setSessionToken(result.sessionToken);
      queryClient.setQueryData(queryKeys().session, toAuthenticatedSession(result));
      navigate(returnTo ? `/verify-email?returnTo=${encodeURIComponent(returnTo)}` : '/verify-email', { replace: true });
    },
    onError: (nextError) => {
      setError(authErrorMessage(nextError, 'Unable to create account.'));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    const trimmedDisplayName = displayName.trim();
    if (!normalizedEmail) {
      setError('Email is required.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password.length > 128) {
      setError('Password must be 128 characters or fewer.');
      return;
    }
    setError(null);
    registerMutation.mutate({
      email: normalizedEmail,
      password,
      displayName: trimmedDisplayName ? trimmedDisplayName : undefined,
    });
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <AuthTabs active="register" />
        <OAuthButton mode="register" returnTo={returnTo} />
        <AuthDivider />
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
              required
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
          </label>
          <label>
            Name <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>(optional)</span>
            <input
              name="displayName"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Ops"
              autoComplete="name"
            />
          </label>
          <button
            className="button button-primary"
            disabled={registerMutation.isPending}
            type="submit"
          >
            {registerMutation.isPending ? 'Creating account...' : 'Create account'}
          </button>
        </form>
        {error ? <p className="form-error">{error}</p> : null}
      </section>
    </main>
  );
}

function VerifyEmailPage({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = readSafeReturnTo(location.search);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const verifyMutation = useMutation({
    mutationFn: () => api.verifyEmail({ code: code.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      if (returnTo) {
        navigate(returnTo, { replace: true });
        return;
      }
      navigate(session.organizations[0] ? `/organizations/${session.organizations[0].organizationId}/wallets` : '/setup', { replace: true });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Unable to verify email.'),
  });
  const resendMutation = useMutation({
    mutationFn: () => api.resendVerification(),
    onSuccess: (result) => {
      setDevCode(result.devEmailVerificationCode ?? null);
      if (result.emailDelivered) {
        setStatusMessage(`Code sent to ${session.user.email}. Check your inbox.`);
      } else if (result.devEmailVerificationCode) {
        setStatusMessage(null);
      } else {
        setStatusMessage('Could not send the email. Try again in a moment.');
      }
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Unable to send verification code.'),
  });

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="panel-kicker">Verify email</div>
        <h1 className="auth-title">Confirm your account</h1>
        <p className="muted-copy">Enter the verification code for {session.user.email}.</p>
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            verifyMutation.mutate();
          }}
        >
          <label>
            Verification code
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </label>
          <button className="button button-primary" disabled={verifyMutation.isPending} type="submit">
            {verifyMutation.isPending ? 'Verifying...' : 'Verify email'}
          </button>
        </form>
        <button className="button button-secondary" disabled={resendMutation.isPending} onClick={() => resendMutation.mutate()} type="button">
          {resendMutation.isPending ? 'Sending...' : 'Resend code'}
        </button>
        {statusMessage ? <p className="muted-copy">{statusMessage}</p> : null}
        {devCode ? <p className="muted-copy">Dev code (no email provider configured): <strong>{devCode}</strong></p> : null}
        {error ? <p className="form-error">{error}</p> : null}
      </section>
    </main>
  );
}

function HomeRedirect({ session }: { session: AuthenticatedSession }) {
  const [first] = getOrganizations(session);
  if (!first) {
    const firstOrganization = session.organizations[0];
    return <Navigate to={firstOrganization ? `/organizations/${firstOrganization.organizationId}/wallets` : '/setup'} replace />;
  }

  return <Navigate to={`/organizations/${first.organization.organizationId}`} replace />;
}

function SetupPage({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();
  const createOrganizationMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const organizationName = String(formData.get('organizationName') ?? '').trim();
      if (!organizationName) {
        throw new Error('Organization name is required.');
      }
      return api.createOrganization({ organizationName });
    },
    onSuccess: async (organization) => {
      success('Organization created.');
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      navigate(`/organizations/${organization.organizationId}/wallets`, { replace: true });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to create organization.'),
  });
  return (
    <PageFrame
      eyebrow="Setup"
      title="Create your organization"
      description="An organization is the team container for members, wallets, and future treasury controls. Joining an existing team requires an invite link from an admin."
    >
      <div className="split-panels">
      <section className="panel">
        <SectionHeader title="Create organization" description="Start a new team space." />
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            createOrganizationMutation.mutate(new FormData(event.currentTarget));
          }}
        >
          <label className="field">
            Organization name
            <input
              name="organizationName"
              placeholder="Decimal Labs"
              autoComplete="organization"
            />
          </label>
          <button
            className="button button-primary"
            disabled={createOrganizationMutation.isPending}
            type="submit"
            aria-busy={createOrganizationMutation.isPending}
          >
            {createOrganizationMutation.isPending ? 'Creating...' : 'Create organization'}
          </button>
        </form>
      </section>
      <section className="panel">
        <SectionHeader
          title="Have an invite?"
          description="Open the invite link your admin shared with you while signed in with the email it was sent to."
        />
        <p className="form-help">
          Organizations are joined through invite links only. Ask your admin to send one if you need access.
        </p>
      </section>
      </div>
    </PageFrame>
  );
}

function ProfilePage({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();
  const [createPersonalWalletOpen, setCreatePersonalWalletOpen] = useState(false);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [transferWallet, setTransferWallet] = useState<UserWallet | null>(null);
  const [airdropWallet, setAirdropWallet] = useState<UserWallet | null>(null);
  const [deleteWallet, setDeleteWallet] = useState<UserWallet | null>(null);

  const personalWalletBalancesQuery = useQuery({
    queryKey: ['personal-wallet-balances'] as const,
    queryFn: () => api.listPersonalWalletBalances(),
    refetchInterval: 15_000,
  });
  const balancesByWalletId = useMemo(() => {
    const map = new Map<string, { solLamports: string; usdcRaw: string | null; rpcError: string | null }>();
    for (const b of personalWalletBalancesQuery.data?.items ?? []) {
      map.set(b.userWalletId, {
        solLamports: b.solLamports,
        usdcRaw: b.usdcRaw,
        rpcError: b.rpcError,
      });
    }
    return map;
  }, [personalWalletBalancesQuery.data]);

  const personalWalletsQuery = useQuery({
    queryKey: ['personal-wallets'] as const,
    queryFn: () => api.listPersonalWallets(),
  });

  const createOrganizationMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const organizationName = getFormString(formData, 'organizationName');
      if (!organizationName) throw new Error('Organization name is required.');
      return api.createOrganization({ organizationName });
    },
    onSuccess: async (organization) => {
      success('Organization created.');
      setCreateOrgOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      navigate(`/organizations/${organization.organizationId}`);
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to create organization.'),
  });

  const createPersonalWalletMutation = useMutation({
    mutationFn: (formData: FormData) => {
      const label = getOptionalFormString(formData, 'label');
      return api.createPersonalWalletManaged({
        provider: 'privy',
        label: label || undefined,
      });
    },
    onSuccess: async () => {
      success('Personal wallet created.');
      setCreatePersonalWalletOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['personal-wallets'] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to create personal wallet.'),
  });

  const airdropMutation = useMutation({
    mutationFn: (input: { userWalletId: string; amountSol: number }) =>
      api.airdropSolToPersonalWallet(input.userWalletId, { amountSol: input.amountSol }),
    onSuccess: async (result) => {
      success(`Airdropped ${result.amountSol} devnet SOL.`);
      setAirdropWallet(null);
      await queryClient.invalidateQueries({ queryKey: ['personal-wallet-balances'] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Airdrop failed.'),
  });

  const deleteWalletMutation = useMutation({
    mutationFn: (input: { userWalletId: string }) =>
      api.deletePersonalWallet(input.userWalletId),
    onSuccess: async () => {
      success('Personal wallet deleted.');
      setDeleteWallet(null);
      await queryClient.invalidateQueries({ queryKey: ['personal-wallets'] });
      await queryClient.invalidateQueries({ queryKey: ['personal-wallet-balances'] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not delete wallet.'),
  });

  const transferOutMutation = useMutation({
    mutationFn: (input: { userWalletId: string; recipient: string; amountRaw: string; asset: 'sol' | 'usdc' }) =>
      api.transferOutPersonalWallet(input.userWalletId, {
        recipient: input.recipient,
        amountRaw: input.amountRaw,
        asset: input.asset,
      }),
    onSuccess: (result) => {
      success(
        `Transfer submitted (signature ${result.signature.slice(0, 8)}…${result.signature.slice(-6)}).`,
      );
      setTransferWallet(null);
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Transfer failed.'),
  });

  const personalWallets = personalWalletsQuery.data?.items ?? [];
  const organizations = session.organizations;
  const isLoadingWallets = personalWalletsQuery.isLoading && personalWallets.length === 0;

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Account · {session.user.email}</p>
          <h1>Profile</h1>
          <p>Manage your identity, personal signing wallets, and organizations.</p>
        </div>
      </header>

      <div className="rd-metrics">
        <div className="rd-metric">
          <span className="rd-metric-label">Personal wallets</span>
          <span className="rd-metric-value">{personalWallets.length}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Organizations</span>
          <span className="rd-metric-value">{organizations.length}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Display name</span>
          <span className="rd-metric-value" style={{ fontSize: 18 }}>
            {session.user.displayName || session.user.email.split('@')[0]}
          </span>
        </div>
      </div>

      <section className="rd-section" style={{ marginTop: 8 }}>
        <div className="rd-section-head">
          <div>
            <p className="eyebrow">Identity</p>
            <h2>Personal wallets</h2>
            <p style={{ margin: 0, color: 'var(--ax-text-muted)' }}>
              These wallets belong to you, not to any organization. Authorize one to act for a treasury account from the Treasury accounts page.
            </p>
          </div>
          <div>
            <button
              type="button"
              className="button button-primary"
              onClick={() => setCreatePersonalWalletOpen(true)}
            >
              + Create personal wallet
            </button>
          </div>
        </div>

        <div className="rd-table-shell" style={{ marginTop: 12 }}>
          {isLoadingWallets ? (
            <div style={{ padding: 16 }}>
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
            </div>
          ) : personalWallets.length === 0 ? (
            <div className="rd-empty-cell" style={{ padding: '64px 24px' }}>
              <strong>Create your personal signing wallet</strong>
              <p style={{ margin: '0 0 16px' }}>
                This wallet belongs to you, not the organization. You can later authorize it to sign for any treasury account you have access to.
              </p>
              <button
                type="button"
                className="button button-primary"
                onClick={() => setCreatePersonalWalletOpen(true)}
              >
                + Create personal wallet
              </button>
            </div>
          ) : (
            <table className="rd-table">
              <thead>
                <tr>
                  <th style={{ width: '20%' }}>Name</th>
                  <th style={{ width: '22%' }}>Address</th>
                  <th className="rd-num" style={{ width: '12%' }}>SOL</th>
                  <th className="rd-num" style={{ width: '12%' }}>USDC</th>
                  <th style={{ width: '12%' }}>Status</th>
                  <th style={{ width: '22%', textAlign: 'right' }}>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {personalWallets.map((wallet) => {
                  const bal = balancesByWalletId.get(wallet.userWalletId);
                  return (
                    <tr key={wallet.userWalletId}>
                      <td>
                        <div className="rd-payee-main">
                          <span className="rd-payee-name">
                            {wallet.label ?? 'Untitled wallet'}
                          </span>
                          <span className="rd-payee-ref" style={{ color: 'var(--ax-text-muted)' }}>
                            {wallet.provider ?? wallet.walletType}
                          </span>
                        </div>
                      </td>
                      <td>
                        <a
                          href={orbAccountUrl(wallet.walletAddress)}
                          target="_blank"
                          rel="noreferrer"
                          className="rd-addr-link"
                          title={wallet.walletAddress}
                        >
                          {shortenAddress(wallet.walletAddress)}
                        </a>
                      </td>
                      <td className="rd-num">
                        {bal ? (
                          <span>{formatSolFromLamports(bal.solLamports)}</span>
                        ) : (
                          <span style={{ color: 'var(--ax-text-faint)' }}>—</span>
                        )}
                      </td>
                      <td className="rd-num">
                        {bal?.usdcRaw === null || bal?.usdcRaw === undefined ? (
                          <span style={{ color: 'var(--ax-text-faint)' }}>—</span>
                        ) : (
                          <span>{formatRawUsdcCompact(bal.usdcRaw)}</span>
                        )}
                      </td>
                      <td>
                        <span
                          className={
                            wallet.verifiedAt ? 'rd-pill rd-pill-success' : 'rd-pill rd-pill-warning'
                          }
                        >
                          {wallet.verifiedAt ? 'verified' : 'pending'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {wallet.walletType === 'privy_embedded' ? (
                          <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              className="button button-secondary"
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => setAirdropWallet(wallet)}
                            >
                              Airdrop
                            </button>
                            <button
                              type="button"
                              className="button button-secondary"
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => setTransferWallet(wallet)}
                            >
                              Transfer
                            </button>
                            <button
                              type="button"
                              className="button button-secondary"
                              style={{
                                padding: '4px 10px',
                                fontSize: 12,
                                color: 'var(--ax-danger)',
                                borderColor: 'var(--ax-border)',
                              }}
                              onClick={() => setDeleteWallet(wallet)}
                              aria-label={`Delete ${wallet.label ?? 'wallet'}`}
                            >
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="rd-section">
        <div className="rd-section-head">
          <div>
            <p className="eyebrow">Membership</p>
            <h2>Your organizations</h2>
            <p style={{ margin: 0, color: 'var(--ax-text-muted)' }}>
              Organizations you can sign in to. Each organization owns its own treasury accounts.
            </p>
          </div>
          <div>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setCreateOrgOpen(true)}
            >
              + Create organization
            </button>
          </div>
        </div>

        <div className="rd-table-shell" style={{ marginTop: 12 }}>
          {organizations.length === 0 ? (
            <div className="rd-empty-cell" style={{ padding: '64px 24px' }}>
              <strong>No organizations yet</strong>
              <p style={{ margin: '0 0 16px' }}>
                Create one to start adding treasury accounts and running payment flows.
              </p>
              <button
                type="button"
                className="button button-primary"
                onClick={() => setCreateOrgOpen(true)}
              >
                + Create organization
              </button>
            </div>
          ) : (
            <table className="rd-table">
              <thead>
                <tr>
                  <th style={{ width: '60%' }}>Organization</th>
                  <th style={{ width: '20%' }}>Role</th>
                  <th style={{ width: '20%' }}>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {organizations.map((org) => (
                  <tr
                    key={org.organizationId}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/organizations/${org.organizationId}`)}
                  >
                    <td>
                      <span className="rd-payee-name">{org.organizationName}</span>
                    </td>
                    <td>
                      <span className="rd-pill rd-pill-info">{org.role}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ color: 'var(--ax-text-muted)', fontSize: 13 }}>Open →</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {createPersonalWalletOpen ? (
        <CreatePersonalWalletDialog
          pending={createPersonalWalletMutation.isPending}
          onClose={() => setCreatePersonalWalletOpen(false)}
          onSubmit={(form) => createPersonalWalletMutation.mutate(form)}
        />
      ) : null}
      {transferWallet ? (
        <TransferOutDialog
          wallet={transferWallet}
          pending={transferOutMutation.isPending}
          onClose={() => transferOutMutation.isPending ? undefined : setTransferWallet(null)}
          onSubmit={(input) =>
            transferOutMutation.mutate({
              userWalletId: transferWallet.userWalletId,
              ...input,
            })
          }
        />
      ) : null}
      {airdropWallet ? (
        <AirdropDialog
          wallet={airdropWallet}
          pending={airdropMutation.isPending}
          onClose={() => airdropMutation.isPending ? undefined : setAirdropWallet(null)}
          onSubmit={(amountSol) =>
            airdropMutation.mutate({
              userWalletId: airdropWallet.userWalletId,
              amountSol,
            })
          }
        />
      ) : null}
      {deleteWallet ? (
        <DeletePersonalWalletDialog
          wallet={deleteWallet}
          balance={balancesByWalletId.get(deleteWallet.userWalletId) ?? null}
          pending={deleteWalletMutation.isPending}
          onClose={() => deleteWalletMutation.isPending ? undefined : setDeleteWallet(null)}
          onConfirm={() =>
            deleteWalletMutation.mutate({ userWalletId: deleteWallet.userWalletId })
          }
        />
      ) : null}
      {createOrgOpen ? (
        <CreateOrganizationDialog
          pending={createOrganizationMutation.isPending}
          onClose={() => setCreateOrgOpen(false)}
          onSubmit={(form) => createOrganizationMutation.mutate(form)}
        />
      ) : null}
    </main>
  );
}

function formatProfileDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const PROFILE_LAMPORTS_PER_SOL = 1_000_000_000n;

// Lamports (string from API) -> human SOL with 4 decimal places.
// Inline duplicate of the same helper in pages/Wallets.tsx; small enough
// to not warrant hoisting yet.
function formatSolFromLamports(lamports: string): string {
  let value: bigint;
  try {
    value = BigInt(lamports);
  } catch {
    return '0.0000';
  }
  const whole = value / PROFILE_LAMPORTS_PER_SOL;
  const fractional = value % PROFILE_LAMPORTS_PER_SOL;
  const fracPadded = fractional.toString().padStart(9, '0').slice(0, 4);
  return `${whole.toString()}.${fracPadded}`;
}

function CreateOrganizationDialog(props: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
}) {
  const { pending, onClose, onSubmit } = props;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-create-org-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 460 }}>
        <h2 id="rd-create-org-title" className="rd-dialog-title">
          Create organization
        </h2>
        <p className="rd-dialog-body">
          Create a new company or treasury entity. You become its owner; you can invite members and add treasury accounts after.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(new FormData(e.currentTarget));
          }}
        >
          <label className="field">
            Organization name
            <input
              name="organizationName"
              required
              placeholder="Acme Treasury Group"
              autoComplete="off"
              autoFocus
            />
          </label>
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button type="button" className="button button-secondary" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
              {pending ? 'Creating…' : 'Create organization'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreatePersonalWalletDialog(props: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
}) {
  const { pending, onClose, onSubmit } = props;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-create-personal-wallet-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 480 }}>
        <h2 id="rd-create-personal-wallet-title" className="rd-dialog-title">
          Create personal wallet
        </h2>
        <p className="rd-dialog-body">
          Decimal will create a Privy-managed Solana wallet under your user. Keys never leave your browser. This wallet belongs to you — you can later authorize it to act for any organization treasury account.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(new FormData(e.currentTarget));
          }}
        >
          <div className="provider-modal-summary" style={{ marginBottom: 16 }}>
            <span
              className="provider-icon provider-icon-large provider-icon-logo"
              data-provider="privy"
              aria-hidden
            />
            <div>
              <strong>Privy</strong>
              <p>Embedded Solana wallet managed through Privy.</p>
            </div>
          </div>
          <label className="field">
            Wallet name
            <input
              name="label"
              placeholder="My signing wallet"
              autoComplete="off"
              autoFocus
            />
          </label>
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button type="button" className="button button-secondary" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
              {pending ? 'Creating…' : 'Create wallet'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// TransferOutDialog
//
// Sends SOL or USDC out of a Privy personal wallet via the backend
// transfer-out endpoint (which signs server-side via Privy and submits).
// Used to recover funds from a wallet that was funded for testing.
//
// Amount handling: user enters human-readable amount; we convert to
// raw base units before sending. SOL: 9 decimals. USDC: 6 decimals.
function TransferOutDialog(props: {
  wallet: UserWallet;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: { recipient: string; amountRaw: string; asset: 'sol' | 'usdc' }) => void;
}) {
  const { wallet, pending, onClose, onSubmit } = props;
  const [asset, setAsset] = useState<'sol' | 'usdc'>('sol');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedRecipient = recipient.trim();
    if (!trimmedRecipient) {
      setError('Recipient address is required.');
      return;
    }
    if (trimmedRecipient === wallet.walletAddress) {
      setError('Cannot transfer to the same wallet.');
      return;
    }
    const amountTrimmed = amount.trim();
    if (!/^\d+(\.\d+)?$/.test(amountTrimmed) || Number(amountTrimmed) <= 0) {
      setError('Enter a positive amount.');
      return;
    }
    const decimals = asset === 'sol' ? 9 : 6;
    const [whole, frac = ''] = amountTrimmed.split('.');
    const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    const amountRaw = (BigInt(whole || '0') * BigInt(10) ** BigInt(decimals) + BigInt(fracPadded || '0')).toString();
    if (amountRaw === '0') {
      setError('Amount is too small for the selected asset.');
      return;
    }
    onSubmit({ recipient: trimmedRecipient, amountRaw, asset });
  };

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-transfer-out-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 500 }}>
        <h2 id="rd-transfer-out-title" className="rd-dialog-title">
          Transfer from personal wallet
        </h2>
        <p className="rd-dialog-body">
          Send SOL or USDC out of this Privy-managed wallet. The backend signs via Privy and submits to the configured Solana network.
        </p>

        <div
          style={{
            padding: 12,
            background: 'var(--ax-surface-1)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ color: 'var(--ax-text-muted)', marginBottom: 4 }}>From</div>
          <div>
            <strong>{wallet.label ?? 'Untitled wallet'}</strong>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ax-text-muted)' }}>
            {wallet.walletAddress}
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field" style={{ marginBottom: 12 }}>
            <span style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>Asset</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['sol', 'usdc'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAsset(a)}
                  className={asset === a ? 'button button-primary' : 'button button-secondary'}
                  style={{ flex: 1, padding: '8px 12px', fontSize: 13 }}
                >
                  {a.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            Recipient address
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Solana wallet address"
              autoComplete="off"
              autoFocus
            />
          </label>

          <label className="field">
            Amount ({asset.toUpperCase()})
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={asset === 'sol' ? '0.1' : '10.00'}
              inputMode="decimal"
              autoComplete="off"
            />
          </label>

          <p style={{ fontSize: 12, color: 'var(--ax-text-muted)', margin: '4px 0 12px' }}>
            For USDC: a recipient associated token account is created automatically if it doesn't exist (~0.002 SOL fee paid from this wallet).
          </p>

          {error ? (
            <div
              style={{
                padding: 10,
                border: '1px solid var(--ax-danger)',
                borderRadius: 6,
                background: 'var(--ax-surface-1)',
                color: 'var(--ax-danger)',
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          ) : null}

          <div className="rd-dialog-actions" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="button button-secondary"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? 'Sending…' : `Send ${asset.toUpperCase()}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// AirdropDialog
//
// Devnet-only. SOL is requested directly via the backend airdrop
// endpoint (which always uses SOLANA_DEVNET_RPC_URL). USDC is not
// natively airdroppable on devnet — Circle's USDC test mint is
// faucet-controlled by Circle, so we just deep-link to their faucet
// with the wallet address pre-copied.
function AirdropDialog(props: {
  wallet: UserWallet;
  pending: boolean;
  onClose: () => void;
  onSubmit: (amountSol: number) => void;
}) {
  const { wallet, pending, onClose, onSubmit } = props;
  const [amountSol, setAmountSol] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const { success } = useToast();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = Number(amountSol);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter a positive amount.');
      return;
    }
    if (parsed > 2) {
      setError('Solana devnet caps airdrops at 2 SOL per call.');
      return;
    }
    onSubmit(parsed);
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(wallet.walletAddress);
      success('Wallet address copied.');
    } catch {
      // ignore — user can copy from the input below as a fallback
    }
  };

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-airdrop-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 500 }}>
        <h2 id="rd-airdrop-title" className="rd-dialog-title">
          Airdrop devnet funds
        </h2>
        <p className="rd-dialog-body">
          Top up this wallet on Solana devnet for testing. SOL is delivered through Decimal's devnet RPC; USDC has to be requested from Circle's faucet directly.
        </p>

        <div
          style={{
            padding: 12,
            background: 'var(--ax-surface-1)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ color: 'var(--ax-text-muted)', marginBottom: 4 }}>Wallet</div>
          <div>
            <strong>{wallet.label ?? 'Untitled wallet'}</strong>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ax-text-muted)' }}>
            {wallet.walletAddress}
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ marginBottom: 20 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <strong style={{ fontSize: 14 }}>SOL</strong>
            <span style={{ color: 'var(--ax-text-muted)', fontSize: 12 }}>devnet RPC · max 2 per call</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={amountSol}
              onChange={(e) => setAmountSol(e.target.value)}
              inputMode="decimal"
              placeholder="1"
              autoComplete="off"
              autoFocus
              style={{ flex: 1 }}
            />
            <button
              type="submit"
              className="button button-primary"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? 'Airdropping…' : 'Airdrop SOL'}
            </button>
          </div>
          {error ? (
            <div
              style={{
                marginTop: 8,
                color: 'var(--ax-danger)',
                fontSize: 13,
              }}
            >
              {error}
            </div>
          ) : null}
        </form>

        <div
          style={{
            paddingTop: 16,
            borderTop: '1px solid var(--ax-border)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <strong style={{ fontSize: 14 }}>USDC</strong>
            <span style={{ color: 'var(--ax-text-muted)', fontSize: 12 }}>via Circle faucet</span>
          </div>
          <p
            style={{
              margin: '0 0 12px',
              fontSize: 13,
              color: 'var(--ax-text-muted)',
              lineHeight: 1.5,
            }}
          >
            Circle owns the devnet USDC test mint, so we can't airdrop it from here. Copy this wallet's address and paste it into Circle's faucet, choose Solana, request USDC.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="button button-secondary" onClick={copyAddress}>
              Copy address
            </button>
            <a
              href="https://faucet.circle.com/"
              target="_blank"
              rel="noreferrer"
              className="button button-secondary"
              style={{ textDecoration: 'none' }}
            >
              Open Circle faucet ↗
            </a>
          </div>
        </div>

        <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={pending}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// DeletePersonalWalletDialog
//
// Permanent + irreversible. Backend destroys the Privy keys via
// Privy's DELETE /v1/wallets/:id, then archives the local row and
// revokes any active wallet authorizations. Funds left in the wallet
// at delete time are unrecoverable, so we surface the live balance
// (if non-zero) prominently in the dialog body and gate the action
// behind a typed-confirmation when there's value at stake.
function DeletePersonalWalletDialog(props: {
  wallet: UserWallet;
  balance: { solLamports: string; usdcRaw: string | null; rpcError: string | null } | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { wallet, balance, pending, onClose, onConfirm } = props;
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  // Detect non-zero balance to require typed confirmation. We don't
  // gate on USDC alone equalling 0 because rpcError or a missing ATA
  // returns null — only zero/null is treated as "no funds at risk".
  const lamportsAreZero = (() => {
    try {
      return BigInt(balance?.solLamports ?? '0') === 0n;
    } catch {
      return true;
    }
  })();
  const usdcIsZero = balance?.usdcRaw == null
    ? true
    : (() => {
        try {
          return BigInt(balance.usdcRaw) === 0n;
        } catch {
          return true;
        }
      })();
  const hasValueAtRisk = !lamportsAreZero || !usdcIsZero;
  const expectedConfirm = 'DELETE';
  const confirmOk = !hasValueAtRisk || confirmText.trim() === expectedConfirm;

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-delete-wallet-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 500 }}>
        <h2 id="rd-delete-wallet-title" className="rd-dialog-title" style={{ color: 'var(--ax-danger)' }}>
          Delete personal wallet
        </h2>
        <p className="rd-dialog-body">
          This permanently destroys the Privy keys for this wallet. The local record is archived and any organization wallet authorizations referencing it are revoked. <strong>Funds left in this wallet will be unrecoverable.</strong>
        </p>

        <div
          style={{
            padding: 12,
            background: 'var(--ax-surface-1)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ color: 'var(--ax-text-muted)', marginBottom: 4 }}>Wallet</div>
          <div>
            <strong>{wallet.label ?? 'Untitled wallet'}</strong>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ax-text-muted)' }}>
            {wallet.walletAddress}
          </div>
        </div>

        {hasValueAtRisk ? (
          <div
            style={{
              padding: 12,
              border: '1px solid var(--ax-danger)',
              borderRadius: 6,
              background: 'var(--ax-surface-1)',
              marginBottom: 16,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: 'var(--ax-danger)', display: 'block', marginBottom: 6 }}>
              This wallet has a non-zero balance
            </strong>
            <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
              {!lamportsAreZero ? (
                <span>
                  <span style={{ color: 'var(--ax-text-muted)' }}>SOL: </span>
                  <strong>{formatSolFromLamports(balance!.solLamports)}</strong>
                </span>
              ) : null}
              {!usdcIsZero ? (
                <span>
                  <span style={{ color: 'var(--ax-text-muted)' }}>USDC: </span>
                  <strong>{formatRawUsdcCompact(balance!.usdcRaw!)}</strong>
                </span>
              ) : null}
            </div>
            <div style={{ color: 'var(--ax-text-muted)' }}>
              Cancel and use the Transfer button to move these funds out before deleting. Once the keys are destroyed, no one can move them.
            </div>
            <label
              className="field"
              style={{ marginTop: 12, marginBottom: 0 }}
            >
              <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                Type <strong>{expectedConfirm}</strong> to confirm
              </span>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={expectedConfirm}
                autoComplete="off"
                disabled={pending}
              />
            </label>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--ax-text-muted)', marginBottom: 16 }}>
            No detectable balance on this wallet — safe to delete.
          </p>
        )}

        <div className="rd-dialog-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            style={{
              background: 'var(--ax-danger)',
              borderColor: 'var(--ax-danger)',
            }}
            disabled={pending || !confirmOk}
            aria-busy={pending}
            onClick={onConfirm}
          >
            {pending ? 'Deleting…' : 'Delete wallet'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PaymentRequestsPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const organization = findOrganization(session, organizationId);
  const requestsQuery = useQuery({
    queryKey: queryKeys(organizationId).paymentRequests,
    queryFn: () => api.listPaymentRequests(organizationId!),
    enabled: Boolean(organizationId),
  });
  const ordersQuery = useQuery({
    queryKey: queryKeys(organizationId).paymentOrders,
    queryFn: () => api.listPaymentOrders(organizationId!),
    enabled: Boolean(organizationId),
  });
  const destinationsQuery = useQuery({
    queryKey: queryKeys(organizationId).destinations,
    queryFn: () => api.listDestinations(organizationId!),
    enabled: Boolean(organizationId),
  });
  const addressesQuery = useQuery({
    queryKey: queryKeys(organizationId).addresses,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });
  const createRequestMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const destinationId = getFormString(formData, 'destinationId');
      const amount = getFormString(formData, 'amount');
      const reason = getFormString(formData, 'reason');
      if (!destinationId || !amount || !reason) {
        throw new Error('Destination, amount, and reason are required.');
      }
      return api.createPaymentRequest(organizationId!, {
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
        queryClient.invalidateQueries({ queryKey: queryKeys(organizationId).paymentRequests }),
        queryClient.invalidateQueries({ queryKey: queryKeys(organizationId).paymentOrders }),
      ]);
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Unable to create request.'),
  });

  if (!organizationId || !organization) {
    return <ScreenState title="Organization unavailable" description="Choose a organization from the sidebar." />;
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
          <Link className="button button-secondary" to={`/organizations/${organizationId}/runs`}>Import CSV batch</Link>
        </div>
      )}
    >
      <section className="panel">
        <SectionHeader title={`Requests [${requests.length}]`} description="Manual requests and imported rows become controlled payment orders." />
        <PaymentRequestsTable organizationId={organizationId} requests={requests} ordersByRequest={ordersByRequest} />
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

function AddressBookPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const organization = findOrganization(session, organizationId);
  const walletsQuery = useQuery({
    queryKey: queryKeys(organizationId).addresses,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });
  const counterpartiesQuery = useQuery({
    queryKey: queryKeys(organizationId).counterparties,
    queryFn: () => api.listCounterparties(organizationId!),
    enabled: Boolean(organizationId),
  });
  const destinationsQuery = useQuery({
    queryKey: queryKeys(organizationId).destinations,
    queryFn: () => api.listDestinations(organizationId!),
    enabled: Boolean(organizationId),
  });

  async function invalidateRegistry() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys(organizationId).addresses }),
      queryClient.invalidateQueries({ queryKey: queryKeys(organizationId).counterparties }),
      queryClient.invalidateQueries({ queryKey: queryKeys(organizationId).destinations }),
    ]);
  }

  const createTreasuryWalletMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      return api.createTreasuryWallet(organizationId!, {
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
      return api.createCounterparty(organizationId!, {
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
      return api.createDestination(organizationId!, {
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

  if (!organizationId || !organization) {
    return <ScreenState title="Organization unavailable" description="Choose a organization from the sidebar." />;
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


function PaymentRequestsTable({
  organizationId,
  requests,
  ordersByRequest,
}: {
  organizationId: string;
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
            <Link className="data-table-row data-table-link data-table-row-requests" key={request.paymentRequestId} to={`/organizations/${organizationId}/payments/${order.paymentOrderId}`}>
              {content}
            </Link>
          );
        }
        return <div className="data-table-row data-table-row-requests" key={request.paymentRequestId}>{content}</div>;
      })}
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

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return <PanelHeader title={title} description={description} />;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <EmptyPanel title={title} description={description} />;
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

function StatusBadge({ tone, state, children }: { tone?: 'success' | 'warning' | 'danger' | 'neutral'; state?: string; children: ReactNode }) {
  const resolved =
    tone ?? (state && isPaymentOrderState(state) ? statusToneForPayment(state) : toneForGenericState(state ?? ''));
  return <span className={`status-badge status-${resolved}`}>{children}</span>;
}

function getOrganizations(session: AuthenticatedSession) {
  return session.organizations.map((organization) => ({ organization }));
}

function findOrganization(session: AuthenticatedSession, organizationId?: string): Organization | null {
  if (!organizationId) return null;
  const organization = session.organizations.find((candidate) => candidate.organizationId === organizationId);
  return organization
    ? {
        organizationId: organization.organizationId,
        organizationName: organization.organizationName,
        status: organization.status,
        createdAt: '',
        updatedAt: '',
      }
    : null;
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
