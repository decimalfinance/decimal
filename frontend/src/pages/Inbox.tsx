// Overview / Inbox — landing page after sign-in. Editorial v2 from the design
// handoff (pages-overview.jsx). Three-column actionable grid + agent band +
// treasury snapshot. No crypto language — operator-facing only.

import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { AuthenticatedSession, PaymentOrder } from '../types';
import { formatRawUsdcCompact } from '../domain';
import { Ico } from '../dec/icons';
import { SLPill } from '../dec/primitives';

type ApprovalItem = { id: string; vendor: string; amt: string; approved: number; total: number };
type AutopaidItem = { id: string; vendor: string; amt: string; policy: string };
type ReviewItem = { id: string; vendor: string; amt: string; reason: string };

function vendorName(order: PaymentOrder): string {
  return order.counterparty?.displayName
    ?? order.counterpartyWallet.label
    ?? 'Untitled vendor';
}

function reviewReason(order: PaymentOrder): string {
  if (order.counterpartyWallet?.trustState && order.counterpartyWallet.trustState !== 'trusted') {
    return 'Vendor wallet unreviewed';
  }
  return 'Flagged by the agent';
}

export function InboxPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const navigate = useNavigate();
  const firstName = (session.user.displayName ?? session.user.email.split('@')[0]).split(/\s+/)[0] ?? 'there';
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return 'Working late';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  // Pending proposals — the "needs your approval" column. We pair them with
  // the linked payment order to surface vendor + amount.
  const proposalsQuery = useQuery({
    queryKey: ['organization-proposals', organizationId, 'pending'] as const,
    queryFn: () => api.listOrganizationProposals(organizationId!, { status: 'pending' }),
    enabled: Boolean(organizationId),
    refetchInterval: 15_000,
  });

  // All payment orders — used to compute auto-paid, review, and to join
  // proposals back to their vendor + amount.
  const ordersQuery = useQuery({
    queryKey: ['payment-orders', organizationId] as const,
    queryFn: () => api.listPaymentOrders(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
  });

  // Treasury snapshot — name + balance per treasury.
  const treasuriesQuery = useQuery({
    queryKey: ['treasury-wallets', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });
  const balancesQuery = useQuery({
    queryKey: ['treasury-wallet-balances', organizationId] as const,
    queryFn: () => api.listTreasuryWalletBalances(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
  });
  const policiesQuery = useQuery({
    queryKey: ['spending-limit-policies', organizationId, 'all'] as const,
    queryFn: () => api.listSpendingLimitPolicies(organizationId!),
    enabled: Boolean(organizationId),
  });

  const orders = ordersQuery.data?.items ?? [];
  const orderById = useMemo(() => {
    const map = new Map<string, PaymentOrder>();
    for (const o of orders) map.set(o.paymentOrderId, o);
    return map;
  }, [orders]);

  const approval: ApprovalItem[] = useMemo(() => {
    const items = proposalsQuery.data?.items ?? [];
    return items
      .filter((p) => p.status === 'active' && p.paymentOrderId)
      .slice(0, 5)
      .map((p) => {
        const o = p.paymentOrderId ? orderById.get(p.paymentOrderId) : null;
        const voting = p.voting;
        const approved = voting?.approvals.length ?? 0;
        const total = voting?.threshold ?? 0;
        return {
          id: p.decimalProposalId,
          vendor: o ? vendorName(o) : (p.semanticType ?? 'Payment'),
          amt: o ? `${formatRawUsdcCompact(o.amountRaw)} USDC` : '—',
          approved,
          total,
        };
      });
  }, [proposalsQuery.data, orderById]);

  const autopaid: AutopaidItem[] = useMemo(
    () =>
      orders
        .filter((o) => o.spendingLimitExecution)
        .slice(0, 5)
        .map((o) => ({
          id: o.paymentOrderId,
          vendor: vendorName(o),
          amt: `${formatRawUsdcCompact(o.amountRaw)} USDC`,
          policy: o.spendingLimitExecution?.spendingLimitPolicy?.policyName ?? 'auto-pay rule',
        })),
    [orders],
  );

  const review: ReviewItem[] = useMemo(
    () =>
      orders
        .filter((o) => o.derivedState === 'needs_review')
        .slice(0, 5)
        .map((o) => ({
          id: o.paymentOrderId,
          vendor: vendorName(o),
          amt: `${formatRawUsdcCompact(o.amountRaw)} USDC`,
          reason: reviewReason(o),
        })),
    [orders],
  );

  const treasuries = treasuriesQuery.data?.items ?? [];
  const balancesByWalletId = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of balancesQuery.data?.items ?? []) {
      m.set(b.treasuryWalletId, b.usdcRaw ?? '0');
    }
    return m;
  }, [balancesQuery.data]);
  const policies = policiesQuery.data?.items ?? [];
  const activePolicyCountByTreasury = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of policies) {
      if (p.status !== 'active') continue;
      m.set(p.treasuryWalletId, (m.get(p.treasuryWalletId) ?? 0) + 1);
    }
    return m;
  }, [policies]);

  if (!organizationId) {
    return null;
  }

  const approvalCount = approval.length;
  const autopaidCount = autopaid.length;
  const reviewCount = review.length;
  const treasuryCount = treasuries.length;
  // First-run: org exists but no treasury yet. Per the design (pages-onboard
  // → FirstRunDashboard), Overview replaces the 3-column grid with a
  // "Finish setting up" checklist + an empty treasury snapshot.
  const isFirstRun = treasuryCount === 0;

  const orgBase = `/organizations/${organizationId}`;
  const orgName =
    session.organizations.find((o) => o.organizationId === organizationId)?.organizationName
    ?? 'your workspace';

  return (
    <div className="page">
      <div className="stack stack-24">
        {/* Hero greeting */}
        <div className="ov-hero">
          <div className="eyebrow" style={{ marginBottom: 10 }}>WORKSPACE</div>
          <h1>
            {isFirstRun
              ? `Welcome to ${orgName}, ${firstName}`
              : `${greeting}, ${firstName}`}
          </h1>
          <p className="ov-summary">
            {isFirstRun ? (
              <>Two quick steps and your agent can start paying vendors. Knock these out whenever you're ready — nothing's blocking you.</>
            ) : (
              <>
                <b>{approvalCount} payment{approvalCount === 1 ? '' : 's'}</b>{' '}
                {approvalCount === 0 ? 'waiting on your approval' : (approvalCount === 1 ? 'is waiting on your approval' : 'are waiting on your approval')}.
                This month your agent auto-paid <b>{autopaidCount} bill{autopaidCount === 1 ? '' : 's'}</b> on its own
                and flagged <b>{reviewCount}</b> for review.
              </>
            )}
          </p>
        </div>

        {isFirstRun ? (
          <>
            <div className="surface">
              <div className="snap-head">Finish setting up</div>
              <GetStartedRow
                n="1"
                done
                title={`Create your organization`}
                desc={`${orgName} is live.`}
                cta={<span className="pill pill-success"><span className="dot" />Done</span>}
              />
              <GetStartedRow
                n="2"
                title="Create your first treasury"
                desc="Hold funds and set the team of signers who approve payments."
                cta={
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => navigate(`${orgBase}/wallets`)}
                  >
                    <Ico.plus w={14} />New treasury
                  </button>
                }
              />
              <GetStartedRow
                n="3"
                title="Invite your team"
                desc="Add the people who'll review and approve payments."
                cta={
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => navigate(`${orgBase}/members`)}
                  >
                    <Ico.userPlus w={14} />Invite member
                  </button>
                }
              />
            </div>

            <div className="snap">
              <div className="snap-head">Treasury snapshot</div>
              <div className="empty" style={{ padding: '40px 24px' }}>
                <div className="empty-icon"><Ico.treasury w={22} /></div>
                <h4>No treasuries yet</h4>
                <p>Create a treasury to hold funds and let the agent pay vendors on your terms.</p>
                <div style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => navigate(`${orgBase}/wallets`)}
                  >
                    <Ico.plus w={15} />New treasury
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : null}

        {!isFirstRun ? (
        <>
        {/* Three-column actionable grid */}
        <div className="ov-grid">
          <InboxColumn
            primary
            title="Needs your approval"
            icon={<Ico.inbox w={15} />}
            count={approvalCount}
            footerHref={`${orgBase}/proposals`}
            footerLabel="View all awaiting approval"
            empty="Nothing waiting for you"
          >
            {approval.map((r) => (
              <InboxRow
                key={r.id}
                vendor={r.vendor}
                amt={r.amt}
                onClick={() => navigate(`${orgBase}/proposals/${r.id}`)}
              >
                <ApprDots approved={r.approved} total={Math.max(r.total, 1)} />
              </InboxRow>
            ))}
          </InboxColumn>

          <InboxColumn
            title="Recently auto-paid"
            icon={<Ico.bolt w={15} />}
            count={autopaidCount}
            footerHref={`${orgBase}/spending-limits`}
            footerLabel="View auto-pay"
            empty="No autonomous payments yet"
          >
            {autopaid.map((r) => (
              <InboxRow
                key={r.id}
                vendor={r.vendor}
                amt={r.amt}
                onClick={() => navigate(`${orgBase}/payments/${r.id}`)}
              >
                <SLPill /> via {r.policy}
              </InboxRow>
            ))}
          </InboxColumn>

          <InboxColumn
            title="Needs review"
            icon={<Ico.shield w={15} />}
            count={reviewCount}
            alert
            footerHref={`${orgBase}/payments?filter=needs_review`}
            footerLabel="View all needing review"
            empty="Nothing flagged"
          >
            {review.map((r) => (
              <InboxRow
                key={r.id}
                vendor={r.vendor}
                amt={r.amt}
                onClick={() => navigate(`${orgBase}/payments/${r.id}`)}
              >
                {r.reason}
              </InboxRow>
            ))}
          </InboxColumn>
        </div>

        {/* Agent band — the differentiator celebration */}
        {autopaidCount > 0 ? (
          <div className="agent-band">
            <span className="ag-bolt">
              <Ico.bolt w={20} fill="currentColor" sw={0} />
            </span>
            <span className="ag-copy">
              Your agent auto-paid <b>{autopaidCount} bill{autopaidCount === 1 ? '' : 's'}</b> this month
              {' '}— paid under auto-pay rules your team approved, with <b>no vote needed</b>.
            </span>
            <Link to={`${orgBase}/spending-limits`} className="link ag-link">
              View auto-pay<Ico.arrowRight w={13} />
            </Link>
          </div>
        ) : null}

        {/* Treasury snapshot */}
        {treasuries.length > 0 && !isFirstRun ? (
          <div className="snap">
            <div className="snap-head">Treasury snapshot</div>
            {treasuries.map((t) => {
              const balRaw = balancesByWalletId.get(t.treasuryWalletId) ?? '0';
              const bal = formatRawUsdcCompact(balRaw);
              const limits = activePolicyCountByTreasury.get(t.treasuryWalletId) ?? 0;
              return (
                <div
                  key={t.treasuryWalletId}
                  className="snap-row"
                  onClick={() => navigate(`${orgBase}/wallets/${t.treasuryWalletId}`)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="sn-icon"><Ico.treasury w={16} /></span>
                  <div className="col" style={{ flex: 1 }}>
                    <span className="sn-name">{t.displayName ?? 'Untitled treasury'}</span>
                    <span className="sn-meta">
                      {limits > 0 ? `${limits} active ${limits === 1 ? 'rule' : 'rules'}` : 'no auto-pay rules'}
                    </span>
                  </div>
                  <span className="sn-bal">{bal}<small>USDC</small></span>
                  <span className="row-arrow" style={{ opacity: 0.5 }}>
                    <Ico.chevRight w={15} />
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
        </>
        ) : null}
      </div>
    </div>
  );
}

function GetStartedRow({
  n,
  done,
  title,
  desc,
  cta,
}: {
  n: string;
  done?: boolean;
  title: string;
  desc: string;
  cta: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="sr-info" style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
        <span
          className="gs-num"
          style={done ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-contrast)' } : undefined}
        >
          {done ? <Ico.checkSm w={12} /> : n}
        </span>
        <div className="col" style={{ gap: 3 }}>
          <span className="sr-title">{title}</span>
          <span className="sr-desc">{desc}</span>
        </div>
      </div>
      <div className="sr-action">{cta}</div>
    </div>
  );
}

function InboxColumn({
  title,
  icon,
  count,
  primary,
  alert,
  footerHref,
  footerLabel,
  empty,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  primary?: boolean;
  alert?: boolean;
  footerHref: string;
  footerLabel: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasContent = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className={`inbox-col${primary ? ' primary' : ''}`}>
      <div className={`inbox-head${alert ? ' alert' : ''}`}>
        <span className="ih-title">{icon}{title}</span>
        <span className="ih-count">{count}</span>
      </div>
      <div className="inbox-list">
        {hasContent ? children : <div className="inbox-empty">{empty}</div>}
      </div>
      <div className="inbox-foot">
        <Link to={footerHref}>
          {footerLabel}<Ico.arrowRight w={13} />
        </Link>
      </div>
    </div>
  );
}

function InboxRow({
  vendor,
  amt,
  onClick,
  children,
}: {
  vendor: string;
  amt: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="inbox-row" onClick={onClick} role="button" tabIndex={0}>
      <div className="ir-body">
        <div className="ir-top">
          <span className="ir-vendor">{vendor}</span>
          <span className="ir-amt">{amt}</span>
        </div>
        <span className="ir-sub">{children}</span>
      </div>
      <span className="row-arrow" style={{ opacity: 0.5 }}>
        <Ico.chevRight w={15} />
      </span>
    </div>
  );
}

function ApprDots({ approved, total }: { approved: number; total: number }) {
  return (
    <span className="appr-dots">
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} className={`ad${i < approved ? ' on' : ''}`} />
      ))}
      <span className="appr-meta">&nbsp;{approved} of {total}</span>
    </span>
  );
}
