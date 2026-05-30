import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { SpendingLimitPolicy, SpendingLimitPolicyStatus } from '../types';
import { formatRawUsdcCompact } from '../domain';
import { EmptyIcon, RdEmptyState } from '../ui-primitives';

// Cross-treasury Spending Limits page. The per-treasury view at
// /wallets/:id has the same data but scoped to one treasury and bundles
// the Create + Remove dialogs. This page is the operator's single
// surface to see every policy in the org and jump to the right place
// (vote on the pending proposal, or open the treasury to remove).

const STATUS_LABEL: Record<SpendingLimitPolicyStatus, string> = {
  proposed: 'Pending approval',
  active: 'Active',
  replacement_proposed: 'Editing',
  revocation_proposed: 'Removing',
  revoked: 'Removed',
  failed: 'Failed',
  paused: 'Paused',
};

const STATUS_TONE: Record<SpendingLimitPolicyStatus, 'success' | 'warning' | 'danger' | 'info'> = {
  proposed: 'warning',
  active: 'success',
  replacement_proposed: 'warning',
  revocation_proposed: 'warning',
  revoked: 'info',
  failed: 'danger',
  paused: 'info',
};

const PERIOD_LABEL: Record<string, string> = {
  one_time: 'one-time',
  day: 'per day',
  week: 'per week',
  month: 'per month',
};

export function SpendingLimitsPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const policiesQuery = useQuery({
    queryKey: ['spending-limit-policies', organizationId, 'all'] as const,
    queryFn: () => api.listSpendingLimitPolicies(organizationId!),
    enabled: Boolean(organizationId),
  });

  if (!organizationId) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Organization unavailable</h2>
          <p className="rd-state-body">Pick an organization from the sidebar.</p>
        </div>
      </main>
    );
  }

  const policies = policiesQuery.data?.items ?? [];
  const activeCount = policies.filter((p) => p.status === 'active').length;
  const pendingCount = policies.filter((p) => p.status === 'proposed' || p.status === 'revocation_proposed' || p.status === 'replacement_proposed').length;

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Governance</p>
          <h1>Spending limits</h1>
          <p>
            Bounded autonomy for the Decimal agent. Each policy lets the agent pay specific vendors
            up to a cap without a team vote on every payment.
          </p>
        </div>
      </header>

      <div className="rd-metrics">
        <div className="rd-metric">
          <span className="rd-metric-label">Active</span>
          <span className="rd-metric-value">{activeCount}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Awaiting vote</span>
          <span className="rd-metric-value">{pendingCount}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Total</span>
          <span className="rd-metric-value">{policies.length}</span>
        </div>
      </div>

      <section className="rd-section" style={{ marginTop: 8 }}>
        <div className="rd-table-shell" style={{ marginTop: 12 }}>
          {policiesQuery.isLoading ? (
            <div style={{ padding: 16 }}>
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
            </div>
          ) : policies.length === 0 ? (
            <div style={{ padding: '48px 24px' }}>
              <RdEmptyState
                icon={<EmptyIcon kind="proposal" />}
                title="No spending limits yet"
                description="Open a treasury account to create one. The agent can then pay vetted vendors for routine bills without a team vote each time."
              />
            </div>
          ) : (
            <table className="rd-table">
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Treasury</th>
                  <th className="rd-num">Limit</th>
                  <th>Vendors</th>
                  <th>Status</th>
                  <th style={{ width: 160, textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <PolicyRow
                    key={policy.spendingLimitPolicyId}
                    organizationId={organizationId}
                    policy={policy}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}

function PolicyRow({
  organizationId,
  policy,
}: {
  organizationId: string;
  policy: SpendingLimitPolicy;
}) {
  const status = policy.status as SpendingLimitPolicyStatus;
  const statusLabel = STATUS_LABEL[status] ?? policy.status;
  const statusTone = STATUS_TONE[status] ?? 'info';
  const periodLabel = PERIOD_LABEL[policy.period] ?? policy.period;
  const amountDisplay = `${formatRawUsdcCompact(policy.amountRaw)} USDC`;
  const treasuryName = policy.treasuryWallet?.displayName
    ?? (policy.treasuryWallet?.address ? `${policy.treasuryWallet.address.slice(0, 4)}…${policy.treasuryWallet.address.slice(-4)}` : '—');
  const destinationsCount = policy.destinations.length;

  // Action targets — for "pending vote" states, link straight to the
  // proposal so the operator can approve / execute. For active policies
  // we send them back to the treasury page where the Remove dialog lives.
  const hasPendingProposal =
    (status === 'proposed' || status === 'revocation_proposed' || status === 'replacement_proposed')
    && Boolean(policy.decimalProposalId);

  return (
    <tr>
      <td style={{ fontWeight: 500 }}>{policy.policyName}</td>
      <td>
        <Link
          to={`/organizations/${organizationId}/wallets/${policy.treasuryWalletId}`}
          style={{ color: 'var(--ax-text)', textDecoration: 'none' }}
        >
          {treasuryName}
        </Link>
      </td>
      <td className="rd-num" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {amountDisplay}
        <span style={{ color: 'var(--ax-text-muted)', fontSize: 12, marginLeft: 6 }}>{periodLabel}</span>
      </td>
      <td style={{ color: 'var(--ax-text-muted)', fontSize: 13 }}>
        {destinationsCount} vendor{destinationsCount === 1 ? '' : 's'}
      </td>
      <td>
        <span className={`rd-pill rd-pill-${statusTone}`}>
          <span className="rd-pill-dot" aria-hidden />
          {statusLabel}
        </span>
      </td>
      <td style={{ textAlign: 'right' }}>
        {hasPendingProposal ? (
          <Link
            to={`/organizations/${organizationId}/proposals/${policy.decimalProposalId}`}
            className="button button-primary"
            style={{ padding: '4px 12px', fontSize: 12 }}
          >
            View proposal →
          </Link>
        ) : status === 'active' ? (
          <Link
            to={`/organizations/${organizationId}/wallets/${policy.treasuryWalletId}#spending-limits`}
            className="button button-secondary"
            style={{ padding: '4px 12px', fontSize: 12 }}
          >
            Manage →
          </Link>
        ) : (
          <span style={{ color: 'var(--ax-text-faint)', fontSize: 12 }}>—</span>
        )}
      </td>
    </tr>
  );
}
