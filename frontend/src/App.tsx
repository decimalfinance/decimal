import type { FormEvent, ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppSidebar } from './Sidebar';
import { api, ApiError } from './api';
import { InboxPage } from './pages/Inbox';
import { ProposalRedirectPage } from './pages/ProposalRedirect';
import { PaymentsPage as PaymentsPageV2 } from './pages/Payments';
import { PaymentDetailPage as PaymentDetailPageV2 } from './pages/PaymentDetail';
import { CollectionsPage } from './pages/Collections';
import { CollectionDetailPage } from './pages/CollectionDetail';
import { CollectionRunDetailPage } from './pages/CollectionRunDetail';
import { WalletsPage } from './pages/Wallets';
import { CounterpartiesPage } from './pages/Counterparties';
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
  PaymentOrder,
  PaymentOrderState,
  TreasuryWallet,
  Organization,
  UserWallet,
} from './api';
import {
  discoverSolanaWallets,
  formatRawUsdcCompact,
  formatRelativeTime,
  formatTimestamp,
  shortenAddress,
  signAndSubmitPreparedPayment,
  subscribeSolanaWallets,
  type BrowserWalletOption,
} from './domain';
import { setRuntimeSolanaConfig } from './solana-network';
import { parseCsvPreview } from './csv-parse';
import { ProofJsonView } from './proof-json-view';
import {
  displayPaymentStatus,
  displayReconciliationState,
  humanizeExceptionReason,
  isPaymentOrderState,
  statusToneForPayment,
  toneForGenericState,
} from './status-labels';
import {
  ChainLink,
  Collapsible,
  DataTableShell,
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
    counterpartyWallets: ['counterparty-wallets', organizationId] as const,
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
  // Destination and CollectionSource are now one CounterpartyWallet entity. The
  // backend still emits both legacy fields with the same total — read either.
  const unreviewedWalletsCount =
    organizationSummaryQuery.data?.destinationsUnreviewedCount ??
    organizationSummaryQuery.data?.payersUnreviewedCount ??
    0;

  // Treasury gate: payments / collections / overview are useless without a
  // treasury to send money from. When the active org has no treasury, replace
  // the page content with a full-page setup CTA. We don't gate /wallets,
  // /members, /counterparties, /profile, or /setup — those work standalone.
  const treasuryWalletsQuery = useQuery({
    queryKey: ['treasury-wallets', activeOrganizationId] as const,
    queryFn: () => api.listTreasuryWallets(activeOrganizationId!),
    enabled: Boolean(activeOrganizationId),
  });
  const treasuryCheckResolved =
    treasuryWalletsQuery.isSuccess || treasuryWalletsQuery.isError;
  const hasTreasury = (treasuryWalletsQuery.data?.items?.length ?? 0) > 0;
  const shouldShowTreasuryGate =
    Boolean(activeOrganizationId) &&
    treasuryCheckResolved &&
    !hasTreasury &&
    pathRequiresTreasury(location.pathname);

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
        unreviewedWalletsCount={unreviewedWalletsCount}
        onOrganizationSwitch={(organizationId) => navigate(`/organizations/${organizationId}`)}
        onLogout={logout}
      />
      <main className="main-surface">
        {shouldShowTreasuryGate ? (
          <TreasurySetupGate organizationId={activeOrganizationId!} />
        ) : (
        <Routes>
          <Route path="/" element={<HomeRedirect session={session} />} />
          <Route path="/setup" element={<SetupPage session={session} />} />
          <Route path="/profile" element={<ProfilePage session={session} />} />
          <Route path="/organizations/:organizationId" element={<InboxPage session={session} />} />
          <Route path="/organizations/:organizationId/wallets" element={<WalletsPage session={session} />} />
          <Route path="/organizations/:organizationId/wallets/:treasuryWalletId" element={<TreasuryWalletDetailPage session={session} />} />
          <Route path="/organizations/:organizationId/proposals" element={<OrganizationProposalsPage session={session} />} />
          <Route path="/organizations/:organizationId/proposals/:decimalProposalId" element={<ProposalRedirectPage />} />
          <Route path="/organizations/:organizationId/proposals/:decimalProposalId/legacy" element={<OrganizationProposalDetailPage session={session} />} />
          <Route path="/organizations/:organizationId/members" element={<MembersPage session={session} />} />
          <Route path="/organizations/:organizationId/counterparties" element={<CounterpartiesPage session={session} />} />
          <Route path="/organizations/:organizationId/destinations" element={<Navigate to="counterparties" replace />} />
          <Route path="/organizations/:organizationId/payments" element={<PaymentsPageV2 session={session} />} />
          <Route path="/organizations/:organizationId/payments/:paymentOrderId" element={<PaymentDetailPageV2 />} />
          <Route path="/organizations/:organizationId/collections" element={<CollectionsPage session={session} />} />
          <Route path="/organizations/:organizationId/collections/:collectionRequestId" element={<CollectionDetailPage />} />
          <Route path="/organizations/:organizationId/collection-runs/:collectionRunId" element={<CollectionRunDetailPage />} />
          <Route path="/organizations/:organizationId/payers" element={<Navigate to="../counterparties" replace />} />
        </Routes>
        )}
      </main>
    </div>
  );
}

// Pages that need a treasury to function. Treasury setup itself, members,
// address book, and profile remain accessible because they don't require
// money movement.
const TREASURY_GATED_ROUTE_PATTERNS = [
  /^\/organizations\/[^/]+$/, // overview / inbox
  /^\/organizations\/[^/]+\/payments(\/.*)?$/,
  /^\/organizations\/[^/]+\/collections(\/.*)?$/,
  /^\/organizations\/[^/]+\/collection-runs(\/.*)?$/,
  /^\/organizations\/[^/]+\/proposals(\/.*)?$/,
];

function pathRequiresTreasury(pathname: string): boolean {
  return TREASURY_GATED_ROUTE_PATTERNS.some((r) => r.test(pathname));
}

function TreasurySetupGate({ organizationId }: { organizationId: string }) {
  return (
    <div className="treasury-gate">
      <div className="treasury-gate-card">
        <div className="treasury-gate-intro">
          <div className="treasury-gate-icon" aria-hidden>
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="8" y="14" width="32" height="24" rx="3" />
              <path d="M8 20h32" />
              <path d="M14 28h6" />
              <path d="M24 28h10" />
              <path d="M14 32h20" />
              <path d="M16 14V10a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" />
            </svg>
          </div>
          <h1 className="treasury-gate-title">Get started</h1>
          <p className="treasury-gate-body">
            Two quick steps and you'll be ready to process your first invoice.
          </p>
        </div>

        <ol className="treasury-gate-steps">
          <li className="treasury-gate-step">
            <span className="treasury-gate-step-num">1</span>
            <div className="treasury-gate-step-body">
              <div className="treasury-gate-step-title">Invite team members</div>
              <div className="treasury-gate-step-sub">The people who'll approve payments before they go out.</div>
            </div>
            <Link
              to={`/organizations/${organizationId}/members`}
              className="button button-primary treasury-gate-step-cta"
            >
              Invite
            </Link>
          </li>
          <li className="treasury-gate-step">
            <span className="treasury-gate-step-num">2</span>
            <div className="treasury-gate-step-body">
              <div className="treasury-gate-step-title">Create a programmable treasury</div>
              <div className="treasury-gate-step-sub">A secure account that holds funds for vendor payments.</div>
            </div>
            <Link
              to={`/organizations/${organizationId}/wallets`}
              className="button button-primary treasury-gate-step-cta"
            >
              Create
            </Link>
          </li>
        </ol>
      </div>
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
      navigate(session.organizations[0] ? `/organizations/${session.organizations[0].organizationId}` : '/setup', { replace: true });
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
    return (
      <Navigate
        to={firstOrganization ? `/organizations/${firstOrganization.organizationId}` : '/setup'}
        replace
      />
    );
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
        throw new Error('Company name is required.');
      }
      return api.createOrganization({ organizationName });
    },
    onSuccess: async (organization) => {
      // Backend auto-provisions the owner's personal wallet + a default
      // automation agent + the agent's wallet on org creation. Happy path
      // is silent — only surface a warning if provisioning didn't complete.
      const personalStatus = organization.provisioning?.personalWallet?.status;
      const agentStatus = organization.provisioning?.defaultAgent?.status;
      const setupIncomplete =
        personalStatus === 'failed' ||
        personalStatus === 'skipped' ||
        agentStatus === 'failed' ||
        agentStatus === 'skipped';
      if (setupIncomplete) {
        toastError(
          'Workspace created, but background setup is incomplete. You can retry from settings.',
        );
      } else {
        success('Welcome to Decimal.');
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      navigate(`/organizations/${organization.organizationId}`, { replace: true });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to set up workspace.'),
  });
  return (
    <PageFrame
      eyebrow="Welcome"
      title="Name your company"
      description="This is what teammates and vendors will see. You can change it later in settings."
    >
      <div className="split-panels">
        <section className="panel">
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              createOrganizationMutation.mutate(new FormData(event.currentTarget));
            }}
          >
            <label className="field">
              Company name
              <input
                name="organizationName"
                placeholder="Acme Corp"
                autoComplete="organization"
                autoFocus
              />
            </label>
            <button
              className="button button-primary"
              disabled={createOrganizationMutation.isPending}
              type="submit"
              aria-busy={createOrganizationMutation.isPending}
            >
              {createOrganizationMutation.isPending ? 'Setting up your workspace…' : 'Continue'}
            </button>
            <p className="form-help">
              We'll set up your workspace in the background. You can invite teammates after.
            </p>
          </form>
        </section>
        <section className="panel">
          <SectionHeader
            title="Have an invite?"
            description="Open the link your admin sent while signed in with the email it was sent to."
          />
          <p className="form-help">
            Invites are accepted by opening the link directly — there's nothing to enter here.
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
                        <ChainLink address={wallet.walletAddress} />
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
