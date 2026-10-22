import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Shell } from './kit/Shell';
import { ToasterProvider } from './kit/Toast';
import { api, ApiError } from './api';
import type { AuthenticatedSession } from './api';
import { queryKeys } from './lib/app-helpers';
import { useLiveOrgEvents } from './lib/use-live-org-events';
import { rememberOrganization, rememberedOrganization, withReturn } from './pages/signin/landing';

// Lazy-loaded route pages. Each becomes its own chunk, so the main bundle
// only ships the shell + the first matched page. Notably keeps Solana web3
// (Wallets, PaymentDetail, TreasuryWalletDetail, OrganizationProposalDetail)
// out of the initial download for everyone else.
const HomePage = lazy(() => import('./pages/Home').then((m) => ({ default: m.HomePage })));
const ChatPage = lazy(() => import('./pages/Chat').then((m) => ({ default: m.ChatPage })));
const InboxPage = lazy(() => import('./pages/Inbox').then((m) => ({ default: m.InboxPage })));
const KnowledgePage = lazy(() => import('./pages/Knowledge').then((m) => ({ default: m.KnowledgePage })));
const ProposalRedirectPage = lazy(() => import('./pages/ProposalRedirect').then((m) => ({ default: m.ProposalRedirectPage })));
const BillsPage = lazy(() => import('./pages/Bills').then((m) => ({ default: m.BillsPage })));
const BillPage = lazy(() => import('./pages/bill/BillPage').then((m) => ({ default: m.BillPage })));
const DocumentPage = lazy(() => import('./pages/bill/Reading').then((m) => ({ default: m.DocumentPage })));
const ApprovalRulesPage = lazy(() => import('./pages/ApprovalRules').then((m) => ({ default: m.ApprovalRulesPage })));
const PaymentDetailPageV2 = lazy(() => import('./pages/PaymentDetail').then((m) => ({ default: m.PaymentDetailPage })));
const WalletsPage = lazy(() => import('./pages/Wallets').then((m) => ({ default: m.WalletsPage })));
const VendorsPage = lazy(() => import('./pages/Vendors').then((m) => ({ default: m.VendorsPage })));
const VendorPage = lazy(() => import('./pages/Vendor').then((m) => ({ default: m.VendorPage })));
const LandingPage = lazy(() => import('./pages/landing-v4').then((m) => ({ default: m.LandingPage })));
const TeamPage = lazy(() => import('./pages/Team').then((m) => ({ default: m.TeamPage })));
const ApprovalsPage = lazy(() => import('./pages/Approvals').then((m) => ({ default: m.ApprovalsPage })));
const OrganisationPage = lazy(() => import('./pages/Organisation').then((m) => ({ default: m.OrganisationPage })));
const AccountingPage = lazy(() => import('./pages/Accounting').then((m) => ({ default: m.AccountingPage })));
const TreasuryWalletDetailPage = lazy(() => import('./pages/TreasuryWalletDetail').then((m) => ({ default: m.TreasuryWalletDetailPage })));
const VaultDetailPage = lazy(() => import('./pages/VaultDetail').then((m) => ({ default: m.VaultDetailPage })));
const OrganizationProposalsPage = lazy(() => import('./pages/OrganizationProposals').then((m) => ({ default: m.OrganizationProposalsPage })));
const SpendingLimitsPage = lazy(() => import('./pages/SpendingLimits').then((m) => ({ default: m.SpendingLimitsPage })));
const SpendingLimitDetailPage = lazy(() => import('./pages/SpendingLimitDetail').then((m) => ({ default: m.SpendingLimitDetailPage })));
const OrganizationProposalDetailPage = lazy(() => import('./pages/OrganizationProposalDetail').then((m) => ({ default: m.OrganizationProposalDetailPage })));
const InviteAcceptPage = lazy(() => import('./pages/signin/Invite').then((m) => ({ default: m.InviteAcceptPage })));
const LoginPage = lazy(() => import('./pages/signin/SignIn').then((m) => ({ default: m.LoginPage })));
const DevLoginPage = lazy(() => import('./pages/signin/SignIn').then((m) => ({ default: m.DevLoginPage })));
const RegisterPage = lazy(() => import('./pages/signin/SignIn').then((m) => ({ default: m.RegisterPage })));
const OAuthCallbackPage = lazy(() => import('./pages/signin/SignIn').then((m) => ({ default: m.OAuthCallbackPage })));
const VerifyEmailPage = lazy(() => import('./pages/signin/SignIn').then((m) => ({ default: m.VerifyEmailPage })));
const HomeRedirect = lazy(() => import('./pages/signin/Organizations').then((m) => ({ default: m.HomeRedirect })));
const CreateOrganizationPage = lazy(() => import('./pages/signin/Organizations').then((m) => ({ default: m.CreateOrganizationPage })));
const ChooseOrganizationPage = lazy(() => import('./pages/signin/Organizations').then((m) => ({ default: m.ChooseOrganizationPage })));
const OnwardRedirect = lazy(() => import('./pages/signin/Organizations').then((m) => ({ default: m.OnwardRedirect })));
const SignInFrame = lazy(() => import('./pages/signin/parts').then((m) => ({ default: m.Frame })));
const AccountPage = lazy(() => import('./pages/Account').then((m) => ({ default: m.AccountPage })));

// While a page's code loads, the page area waits blank, as a redesigned page
// waits for its data.
const RouteFallback = () => <div className="ui page" />;

export function App() {
  const location = useLocation();
  // Every page but the landing page reads at 110% (html.app-zoom, styles/ui/shell.css).
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('app-zoom', location.pathname !== '/');
  }, [location.pathname]);
  const capabilitiesQuery = useQuery({
    queryKey: ['capabilities'] as const,
    queryFn: () => api.getCapabilities(),
    // Same transient-failure problem as the session query below: this is
    // public runtime config, so a restart window should be retried, not
    // silently left unset.
    retry: 3,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4_000),
    staleTime: 60_000,
  });
  const shouldCheckSession =
    location.pathname !== '/login' &&
    location.pathname !== '/register' &&
    location.pathname !== '/dev-login' &&
    api.hasSessionToken();
  // Only a 401 means "you are signed out". Anything else — the API restarting
  // under `tsx watch`, a dropped tunnel, a 5xx — is a transient failure, and
  // treating it as a logout is what used to bounce you to /login every time a
  // backend file was edited. The token was still in localStorage and the
  // session still valid in the database; the app just gave up after one try.
  const sessionQuery = useQuery({
    queryKey: queryKeys().session,
    queryFn: () => api.getSession(),
    enabled: shouldCheckSession,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 401) && failureCount < 3,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4_000),
  });

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        {/* Testing sign-in. Not linked from anywhere in the product, and the
            page reports itself unavailable when the server has dev mode off. */}
        <Route path="/dev-login" element={<DevLoginPage />} />
        <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
        <Route path="/invites/:inviteToken" element={<InviteAcceptPage />} />
        <Route path="/verify-email" element={<RequireSession sessionQuery={sessionQuery} page={(s) => <OnwardRedirect session={s} />} />} />
        {/* Signed in but outside the app, like Sign in: no sidebar until there
            is an organisation to open. */}
        <Route path="/setup" element={<RequireSession sessionQuery={sessionQuery} page={(s) => <CreateOrganizationPage session={s} />} />} />
        <Route path="/choose-organization" element={<RequireSession sessionQuery={sessionQuery} page={(s) => <ChooseOrganizationPage session={s} />} />} />
        <Route path="/*" element={<RequireSession sessionQuery={sessionQuery} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

// Org-scoped redirect: `Navigate to="../x"` resolves against the ROUTE
// hierarchy (flat here), silently dropping the org id and dumping users into
// the default org (testbench 006, finding 1). This keeps the org explicit.
function OrgRedirect({ to }: { to: string }) {
  const { organizationId } = useParams();
  return <Navigate to={`/organizations/${organizationId}/${to}`} replace />;
}

/** A page not yet redesigned: the old .dec system, scrolling in the new frame. */
function Legacy({ children }: { children: ReactNode }) {
  return <div className="dec shell-legacy">{children}</div>;
}

function RequireSession({
  sessionQuery,
  page,
}: {
  sessionQuery: ReturnType<typeof useQuery<AuthenticatedSession>>;
  /** A signed-in page that stands outside the app frame. */
  page?: (session: AuthenticatedSession) => ReactNode;
}) {
  const location = useLocation();
  if (sessionQuery.isLoading) {
    // A page outside the app waits in its own frame, as Sign in does.
    if (page) return <SignInFrame />;
    return <div className="ui page" />;
  }

  // A failure that is NOT a 401 means we could not ask, not that the answer was
  // no. Sending someone to the sign-in page in that case tells them something
  // untrue about their own account, and loses whatever they were doing.
  if (sessionQuery.isError && !(sessionQuery.error instanceof ApiError && sessionQuery.error.status === 401)) {
    // From what the first load already has, so it shows when nothing more will load.
    // The query has stopped retrying by now, so the person gets the next go.
    const trying = sessionQuery.isFetching;
    return (
      <div className="ui page">
        <h1 className="page-title">Can’t reach Decimal</h1>
        <p className="page-sub">You’re still signed in. Decimal didn’t answer, so check your connection and try again.</p>
        <div className="page-actions">
          <button
            type="button"
            className={`btn is-primary${trying ? ' is-busy' : ''}`}
            aria-busy={trying || undefined}
            disabled={trying}
            onClick={() => void sessionQuery.refetch()}
          >
            {trying ? 'Trying…' : 'Try again'}
          </button>
        </div>
      </div>
    );
  }

  if (!sessionQuery.data) {
    // Signed out on the way somewhere: signing in comes back here.
    const here = `${location.pathname}${location.search}`;
    return <Navigate to={here === '/' || location.pathname === '/verify-email' ? '/login' : withReturn('/login', here)} replace />;
  }

  if (!sessionQuery.data.user.emailVerifiedAt) {
    return <VerifyEmailPage session={sessionQuery.data} />;
  }

  return page ? <>{page(sessionQuery.data)}</> : <AppShell session={sessionQuery.data} />;
}

function AppShell({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const activeOrganizationId = useMemo(() => {
    const match = location.pathname.match(/^\/organizations\/([^/]+)/);
    // A page outside any organisation (Your account) keeps the one open last.
    return match?.[1] ?? rememberedOrganization(session.organizations);
  }, [location.pathname, session.organizations]);
  // Live updates: stream this org's changes over SSE and invalidate queries so
  // a co-signer's screen reflects a new signature/execution the instant it lands.
  useLiveOrgEvents(activeOrganizationId);
  // Signing in again opens the organisation this browser had open last.
  useEffect(() => {
    if (activeOrganizationId) rememberOrganization(activeOrganizationId);
  }, [activeOrganizationId]);
  async function logout() {
    await queryClient.cancelQueries();
    await api.logout().catch(() => undefined);
    api.clearSessionToken();
    queryClient.removeQueries({ queryKey: queryKeys().session });
    queryClient.clear();
    navigate('/', { replace: true });
  }

  // The frame is the redesign's (kit/Shell). A page that hasn't been
  // redesigned yet renders inside <Legacy>, which turns the old .dec system
  // back on for it alone; the two never nest.
  return (
    <ToasterProvider>
      <Shell
        session={session}
        organizations={session.organizations}
        activeOrganizationId={activeOrganizationId}
        onLogout={logout}
      >
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<HomeRedirect session={session} />} />
              <Route path="/profile" element={<AccountPage />} />
              <Route path="/organizations/:organizationId" element={<HomePage />} />
              <Route path="/organizations/:organizationId/chat/:chatId" element={<Legacy><ChatPage /></Legacy>} />
              <Route path="/organizations/:organizationId/inbox" element={<InboxPage />} />
              <Route path="/organizations/:organizationId/knowledge" element={<Legacy><KnowledgePage /></Legacy>} />
              <Route path="/organizations/:organizationId/wallets" element={<Legacy><WalletsPage session={session} /></Legacy>} />
              <Route path="/organizations/:organizationId/wallets/:treasuryWalletId" element={<Legacy><TreasuryWalletDetailPage session={session} /></Legacy>} />
              <Route path="/organizations/:organizationId/vaults/:treasuryWalletId" element={<Legacy><VaultDetailPage /></Legacy>} />
              <Route path="/organizations/:organizationId/proposals" element={<Legacy><OrganizationProposalsPage session={session} /></Legacy>} />
              <Route path="/organizations/:organizationId/approvals" element={<Legacy><ApprovalsPage /></Legacy>} />
              <Route path="/organizations/:organizationId/approval-flow" element={<ApprovalRulesPage />} />
              <Route path="/organizations/:organizationId/policies" element={<OrganisationPage />} />
              {/* Protections grew into Policies (P1) — old links land there. */}
              <Route path="/organizations/:organizationId/protections" element={<OrgRedirect to="policies" />} />
              <Route path="/organizations/:organizationId/spending-limits" element={<Legacy><SpendingLimitsPage /></Legacy>} />
              <Route path="/organizations/:organizationId/spending-limits/:spendingLimitPolicyId" element={<Legacy><SpendingLimitDetailPage /></Legacy>} />
              <Route path="/organizations/:organizationId/proposals/:decimalProposalId" element={<Legacy><ProposalRedirectPage /></Legacy>} />
              <Route path="/organizations/:organizationId/proposals/:decimalProposalId/legacy" element={<Legacy><OrganizationProposalDetailPage session={session} /></Legacy>} />
              <Route path="/organizations/:organizationId/members" element={<TeamPage />} />
              <Route path="/organizations/:organizationId/accounting" element={<Legacy><AccountingPage session={session} /></Legacy>} />
              {/* The Coding inbox is gone: categories are chosen in review, and approved bills post to QuickBooks. */}
              <Route path="/organizations/:organizationId/accounting/coding" element={<OrgRedirect to="inbox" />} />
              <Route path="/organizations/:organizationId/counterparties" element={<VendorsPage />} />
              <Route path="/organizations/:organizationId/counterparties/:counterpartyId" element={<VendorPage />} />
              <Route path="/organizations/:organizationId/destinations" element={<OrgRedirect to="counterparties" />} />
              <Route path="/organizations/:organizationId/bills" element={<BillsPage />} />
              <Route path="/organizations/:organizationId/bills/:paymentOrderId" element={<BillPage />} />
              <Route path="/organizations/:organizationId/bills/:paymentOrderId/draft" element={<BillPage />} />
              <Route path="/organizations/:organizationId/bills/documents/:invoiceDocumentId/draft" element={<DocumentPage />} />
              {/* The Payments list is retired — Bills IS the payments surface. Old links land on Bills. */}
              <Route path="/organizations/:organizationId/payments" element={<OrgRedirect to="bills" />} />
              <Route path="/organizations/:organizationId/payments/:paymentOrderId" element={<Legacy><PaymentDetailPageV2 /></Legacy>} />
              <Route path="/organizations/:organizationId/payers" element={<OrgRedirect to="counterparties" />} />
              {/* Unknown paths (e.g. an org-less /approval-flow) rendered a
                  blank content pane — land on home instead. */}
              <Route path="*" element={<HomeRedirect session={session} />} />
            </Routes>
          </Suspense>
      </Shell>
    </ToasterProvider>
  );
}

