import { Suspense, lazy, useEffect, useMemo } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppSidebar } from './Sidebar';
import { api } from './api';
import type { AuthenticatedSession } from './api';
import { setRuntimeSolanaConfig } from './solana-network';
import { ScreenState } from './ui-primitives';
import { getOrganizations, queryKeys } from './lib/app-helpers';

// Lazy-loaded route pages. Each becomes its own chunk, so the main bundle
// only ships the shell + the first matched page. Notably keeps Three.js
// (Landing) and Solana web3 (Wallets, PaymentDetail, TreasuryWalletDetail,
// OrganizationProposalDetail) out of the initial download for everyone else.
const InboxPage = lazy(() => import('./pages/Inbox').then((m) => ({ default: m.InboxPage })));
const ProposalRedirectPage = lazy(() => import('./pages/ProposalRedirect').then((m) => ({ default: m.ProposalRedirectPage })));
const PaymentsPageV2 = lazy(() => import('./pages/Payments').then((m) => ({ default: m.PaymentsPage })));
const PaymentDetailPageV2 = lazy(() => import('./pages/PaymentDetail').then((m) => ({ default: m.PaymentDetailPage })));
const CollectionsPage = lazy(() => import('./pages/Collections').then((m) => ({ default: m.CollectionsPage })));
const CollectionDetailPage = lazy(() => import('./pages/CollectionDetail').then((m) => ({ default: m.CollectionDetailPage })));
const CollectionRunDetailPage = lazy(() => import('./pages/CollectionRunDetail').then((m) => ({ default: m.CollectionRunDetailPage })));
const WalletsPage = lazy(() => import('./pages/Wallets').then((m) => ({ default: m.WalletsPage })));
const CounterpartiesPage = lazy(() => import('./pages/Counterparties').then((m) => ({ default: m.CounterpartiesPage })));
const LandingPageV2 = lazy(() => import('./pages/Landing').then((m) => ({ default: m.LandingPage })));
const MembersPage = lazy(() => import('./pages/Members').then((m) => ({ default: m.MembersPage })));
const TreasuryWalletDetailPage = lazy(() => import('./pages/TreasuryWalletDetail').then((m) => ({ default: m.TreasuryWalletDetailPage })));
const OrganizationProposalsPage = lazy(() => import('./pages/OrganizationProposals').then((m) => ({ default: m.OrganizationProposalsPage })));
const OrganizationProposalDetailPage = lazy(() => import('./pages/OrganizationProposalDetail').then((m) => ({ default: m.OrganizationProposalDetailPage })));
const InviteAcceptPage = lazy(() => import('./pages/InviteAccept').then((m) => ({ default: m.InviteAcceptPage })));
const LoginPage = lazy(() => import('./pages/auth').then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('./pages/auth').then((m) => ({ default: m.RegisterPage })));
const OAuthCallbackPage = lazy(() => import('./pages/auth').then((m) => ({ default: m.OAuthCallbackPage })));
const VerifyEmailPage = lazy(() => import('./pages/auth').then((m) => ({ default: m.VerifyEmailPage })));
const HomeRedirect = lazy(() => import('./pages/Setup').then((m) => ({ default: m.HomeRedirect })));
const SetupPage = lazy(() => import('./pages/Setup').then((m) => ({ default: m.SetupPage })));
const ProfilePage = lazy(() => import('./pages/Profile').then((m) => ({ default: m.ProfilePage })));

const RouteFallback = () => (
  <ScreenState title="Loading" description="Fetching the next page." />
);

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
    <Suspense fallback={<RouteFallback />}>
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
    </Suspense>
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
  const unreviewedWalletsCount = organizationSummaryQuery.data?.unreviewedWalletsCount ?? 0;

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
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<HomeRedirect session={session} />} />
              <Route path="/setup" element={<SetupPage />} />
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
              <Route path="/organizations/:organizationId/payments" element={<PaymentsPageV2 />} />
              <Route path="/organizations/:organizationId/payments/:paymentOrderId" element={<PaymentDetailPageV2 />} />
              <Route path="/organizations/:organizationId/collections" element={<CollectionsPage session={session} />} />
              <Route path="/organizations/:organizationId/collections/:collectionRequestId" element={<CollectionDetailPage />} />
              <Route path="/organizations/:organizationId/collection-runs/:collectionRunId" element={<CollectionRunDetailPage />} />
              <Route path="/organizations/:organizationId/payers" element={<Navigate to="../counterparties" replace />} />
            </Routes>
          </Suspense>
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
