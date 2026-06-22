import { Suspense, lazy, useEffect, useMemo } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppSidebar } from './Sidebar';
import { api } from './api';
import type { AuthenticatedSession } from './api';
import { setRuntimeSolanaConfig } from './solana-network';
import { ScreenState } from './ui-primitives';
import { getOrganizations, queryKeys } from './lib/app-helpers';
import { useLiveOrgEvents } from './lib/use-live-org-events';

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
const LandingPageV3 = lazy(() => import('./pages/landing-v3').then((m) => ({ default: m.LandingPage })));
const MembersPage = lazy(() => import('./pages/Members').then((m) => ({ default: m.MembersPage })));
const AccountingPage = lazy(() => import('./pages/Accounting').then((m) => ({ default: m.AccountingPage })));
const CodingInboxPage = lazy(() => import('./pages/CodingInbox').then((m) => ({ default: m.CodingInboxPage })));
const TreasuryWalletDetailPage = lazy(() => import('./pages/TreasuryWalletDetail').then((m) => ({ default: m.TreasuryWalletDetailPage })));
const VaultDetailPage = lazy(() => import('./pages/VaultDetail').then((m) => ({ default: m.VaultDetailPage })));
const OrganizationProposalsPage = lazy(() => import('./pages/OrganizationProposals').then((m) => ({ default: m.OrganizationProposalsPage })));
const SpendingLimitsPage = lazy(() => import('./pages/SpendingLimits').then((m) => ({ default: m.SpendingLimitsPage })));
const SpendingLimitDetailPage = lazy(() => import('./pages/SpendingLimitDetail').then((m) => ({ default: m.SpendingLimitDetailPage })));
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
        <Route path="/" element={<LandingPageV3 />} />
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
  // Live updates: stream this org's changes over SSE and invalidate queries so
  // a co-signer's screen reflects a new signature/execution the instant it lands.
  useLiveOrgEvents(activeOrganizationId);
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

  // Treasury gate removed — per the design handoff, Overview itself shows
  // a "Finish setting up" checklist when the org has no treasury yet, instead
  // of a full-page interruption. Other pages render their own empty states.

  async function logout() {
    await queryClient.cancelQueries();
    await api.logout().catch(() => undefined);
    api.clearSessionToken();
    queryClient.removeQueries({ queryKey: queryKeys().session });
    queryClient.clear();
    navigate('/', { replace: true });
  }

  // Shell follows the design handoff: .dec namespace → .app flex container →
  // sidebar + .app-main → .app-scroll for page content. All .dec * styles
  // (from frontend/src/styles/decimal/) only activate inside this wrapper.
  return (
    <div className="dec" style={{ height: '100vh' }}>
      <div className="app">
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
        <div className="app-main">
          <div className="app-scroll" style={{ overflowY: 'auto' }}>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<HomeRedirect session={session} />} />
              <Route path="/setup" element={<SetupPage />} />
              <Route path="/profile" element={<ProfilePage session={session} />} />
              <Route path="/organizations/:organizationId" element={<InboxPage session={session} />} />
              <Route path="/organizations/:organizationId/wallets" element={<WalletsPage session={session} />} />
              <Route path="/organizations/:organizationId/wallets/:treasuryWalletId" element={<TreasuryWalletDetailPage session={session} />} />
              <Route path="/organizations/:organizationId/vaults/:treasuryWalletId" element={<VaultDetailPage />} />
              <Route path="/organizations/:organizationId/proposals" element={<OrganizationProposalsPage session={session} />} />
              <Route path="/organizations/:organizationId/spending-limits" element={<SpendingLimitsPage />} />
              <Route path="/organizations/:organizationId/spending-limits/:spendingLimitPolicyId" element={<SpendingLimitDetailPage />} />
              <Route path="/organizations/:organizationId/proposals/:decimalProposalId" element={<ProposalRedirectPage />} />
              <Route path="/organizations/:organizationId/proposals/:decimalProposalId/legacy" element={<OrganizationProposalDetailPage session={session} />} />
              <Route path="/organizations/:organizationId/members" element={<MembersPage session={session} />} />
              <Route path="/organizations/:organizationId/accounting" element={<AccountingPage session={session} />} />
              <Route path="/organizations/:organizationId/accounting/coding" element={<CodingInboxPage session={session} />} />
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
          </div>
        </div>
      </div>
    </div>
  );
}

