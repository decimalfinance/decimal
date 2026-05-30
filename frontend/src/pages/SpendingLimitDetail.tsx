// Spending Limit Detail — one policy. Rebuilt to the design handoff
// (design_handoff_spending_limit_detail/pages-limit-detail.jsx).
// Reachable from the Spending Limits list "Manage →" action.

import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  SpendingLimitPolicy,
  SpendingLimitPolicyStatus,
  SpendingLimitExecution,
  SpendingLimitPolicyDestination,
  DecimalProposal,
} from '../types';
import { formatRawUsdcCompact } from '../domain';
import { useToast } from '../ui/Toast';
import { Ico } from '../dec/icons';
import { Pill, type PillTone } from '../dec/primitives';
import { orbTransactionUrl } from '../lib/app';
import { RemoveSpendingLimitDialog } from './TreasuryWalletDetail';

const STATUS_LABEL: Record<SpendingLimitPolicyStatus, string> = {
  proposed: 'Pending approval',
  active: 'Active',
  replacement_proposed: 'Editing',
  revocation_proposed: 'Removing',
  revoked: 'Removed',
  failed: 'Failed',
  paused: 'Paused',
};

const STATUS_TONE: Record<SpendingLimitPolicyStatus, PillTone> = {
  proposed: 'warning',
  active: 'success',
  replacement_proposed: 'warning',
  revocation_proposed: 'warning',
  revoked: 'neutral',
  failed: 'danger',
  paused: 'neutral',
};

const PERIOD_LABEL: Record<string, string> = {
  one_time: 'per payment',
  day: 'per day',
  week: 'per week',
  month: 'per month',
};

const PERIOD_NOUN: Record<string, string> = {
  one_time: 'this policy',
  day: 'today',
  week: 'this week',
  month: 'this month',
};

export function SpendingLimitDetailPage() {
  const { organizationId, spendingLimitPolicyId } = useParams<{
    organizationId: string;
    spendingLimitPolicyId: string;
  }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [removeOpen, setRemoveOpen] = useState(false);

  const policyQuery = useQuery({
    queryKey: ['spending-limit-policy', organizationId, spendingLimitPolicyId] as const,
    queryFn: () => api.getSpendingLimitPolicy(organizationId!, spendingLimitPolicyId!),
    enabled: Boolean(organizationId && spendingLimitPolicyId),
  });

  const executionsQuery = useQuery({
    queryKey: ['spending-limit-executions', organizationId, spendingLimitPolicyId] as const,
    queryFn: () =>
      api.listSpendingLimitPolicyExecutions(organizationId!, spendingLimitPolicyId!, { limit: 50 }),
    enabled: Boolean(organizationId && spendingLimitPolicyId),
  });

  // We pull the create-proposal for "Created by" + "Approved" details. Only
  // request it if we have a proposalId — older policies may not have one
  // linked.
  const policy = policyQuery.data ?? null;
  const proposalId = policy?.decimalProposalId ?? null;
  const proposalQuery = useQuery({
    queryKey: ['organization-proposal', organizationId, proposalId] as const,
    queryFn: () => api.getOrganizationProposal(organizationId!, proposalId!),
    enabled: Boolean(organizationId && proposalId),
    retry: false,
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncSpendingLimitPolicy(organizationId!, spendingLimitPolicyId!),
    onSuccess: async () => {
      success('Policy synced from chain.');
      await queryClient.invalidateQueries({
        queryKey: ['spending-limit-policy', organizationId, spendingLimitPolicyId],
      });
      await queryClient.invalidateQueries({
        queryKey: ['spending-limit-policies', organizationId, 'all'],
      });
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Sync failed.');
    },
  });

  if (!organizationId || !spendingLimitPolicyId) {
    return (
      <div className="page">
        <div className="empty">
          <h4>Policy unavailable</h4>
          <p>Pick a spending limit from the list.</p>
        </div>
      </div>
    );
  }

  if (policyQuery.isLoading) {
    return (
      <div className="page">
        <div className="stack stack-24">
          <div className="skeleton" style={{ height: 80, borderRadius: 12 }} />
          <div className="skeleton" style={{ height: 180, borderRadius: 12 }} />
          <div className="skeleton" style={{ height: 240, borderRadius: 12 }} />
        </div>
      </div>
    );
  }

  if (policyQuery.error || !policy) {
    return (
      <div className="page">
        <div
          className="crumb"
          onClick={() => navigate(`/organizations/${organizationId}/spending-limits`)}
          role="button"
          tabIndex={0}
        >
          <Ico.chevRight w={15} style={{ transform: 'rotate(180deg)' }} />Spending limits
        </div>
        <div className="empty" style={{ marginTop: 24 }}>
          <h4>Policy unavailable</h4>
          <p>
            {policyQuery.error instanceof Error
              ? policyQuery.error.message
              : 'We couldn\'t load this spending limit.'}
          </p>
        </div>
      </div>
    );
  }

  const status = policy.status as SpendingLimitPolicyStatus;
  const statusLabel = STATUS_LABEL[status] ?? policy.status;
  const statusTone = STATUS_TONE[status] ?? 'neutral';
  const periodLabel = PERIOD_LABEL[policy.period] ?? policy.period;
  const periodNoun = PERIOD_NOUN[policy.period] ?? 'this period';
  const treasuryName = policy.treasuryWallet?.displayName ?? 'Untitled treasury';

  const executions = executionsQuery.data?.items ?? [];
  const proposal = proposalQuery.data ?? null;

  function notWired() {
    toastError('Not wired yet — coming soon.');
  }

  return (
    <div className="page">
      <div
        className="crumb"
        onClick={() => navigate(`/organizations/${organizationId}/spending-limits`)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ')
            navigate(`/organizations/${organizationId}/spending-limits`);
        }}
      >
        <Ico.chevRight w={15} style={{ transform: 'rotate(180deg)' }} />Spending limits
      </div>

      <div className="stack stack-32">
        {/* Header */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>SPENDING LIMIT</div>
          <div className="pagehead" style={{ paddingBottom: 18 }}>
            <div className="ph-titles">
              <h1>{policy.policyName}</h1>
              <p className="ph-desc">
                <span
                  className="cell-source"
                  style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer' }}
                  onClick={() =>
                    navigate(`/organizations/${organizationId}/wallets/${policy.treasuryWalletId}`)
                  }
                  role="link"
                  tabIndex={0}
                >
                  <Ico.treasury w={15} />{treasuryName}
                </span>
                &nbsp;<span style={{ color: 'var(--text-faint)' }}>·</span>&nbsp;
                <span style={{ verticalAlign: 'middle' }}>
                  <Pill tone={statusTone}>{statusLabel}</Pill>
                </span>
              </p>
            </div>
            <div className="ph-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                aria-busy={syncMutation.isPending}
              >
                <Ico.download w={15} style={{ transform: 'rotate(180deg)' }} />
                {syncMutation.isPending ? 'Syncing…' : 'Sync'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={notWired}>
                {status === 'paused' ? (
                  <>
                    <Ico.bolt w={15} fill="currentColor" sw={0} />Resume
                  </>
                ) : (
                  'Pause'
                )}
              </button>
              <button type="button" className="btn btn-secondary" onClick={notWired}>
                Edit policy
              </button>
              <button
                type="button"
                className="btn btn-danger-ghost"
                onClick={() => setRemoveOpen(true)}
                disabled={status === 'revoked' || status === 'revocation_proposed'}
              >
                Remove
              </button>
            </div>
          </div>
        </div>

        {/* Plain-language banner */}
        <PolicyBanner policy={policy} treasuryName={treasuryName} />

        {/* Cap usage hero */}
        <CapSection
          policy={policy}
          executions={executions}
          periodLabel={periodLabel}
          periodNoun={periodNoun}
        />

        {/* Vendors */}
        <VendorsSection
          destinations={policy.destinations}
          executions={executions}
          capRaw={policy.amountRaw}
          onAdd={notWired}
          onRemoveVendor={notWired}
        />

        {/* Recent executions */}
        <RecentExecutionsSection executions={executions} />

        {/* Policy details */}
        <PolicyDetails
          policy={policy}
          proposal={proposal}
          periodLabel={periodLabel}
          treasuryName={treasuryName}
        />
      </div>

      {removeOpen ? (
        <RemoveSpendingLimitDialog
          organizationId={organizationId}
          treasuryWalletId={policy.treasuryWalletId}
          policy={policy}
          onClose={() => setRemoveOpen(false)}
          onRemoved={async () => {
            setRemoveOpen(false);
            await queryClient.invalidateQueries({
              queryKey: ['spending-limit-policy', organizationId, spendingLimitPolicyId],
            });
            await queryClient.invalidateQueries({
              queryKey: ['spending-limit-policies', organizationId, 'all'],
            });
            await queryClient.invalidateQueries({
              queryKey: ['organization-proposals', organizationId],
            });
          }}
        />
      ) : null}
    </div>
  );
}

// ─── Banner ──────────────────────────────────────────────────────────────

function PolicyBanner({
  policy,
  treasuryName,
}: {
  policy: SpendingLimitPolicy;
  treasuryName: string;
}) {
  const vendorCount = policy.destinations.length;
  const periodLabel = PERIOD_LABEL[policy.period] ?? policy.period;
  return (
    <div className="sl-banner">
      <span className="slb-icon">
        <Ico.bolt w={16} fill="currentColor" sw={0} />
      </span>
      <span className="slb-text">
        The agent can pay <b>{vendorCount} verified {vendorCount === 1 ? 'vendor' : 'vendors'}</b>
        {' '}up to{' '}
        <b>
          {formatRawUsdcCompact(policy.amountRaw)} USDC {periodLabel}
        </b>
        {' '}from {treasuryName} — <b>no team vote needed</b> for each payment.
      </span>
    </div>
  );
}

// ─── Cap usage ───────────────────────────────────────────────────────────

function periodStart(period: string, now: Date): Date {
  const d = new Date(now);
  if (period === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  if (period === 'week') {
    const day = d.getDay();
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((day + 6) % 7));
    return monday;
  }
  if (period === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // one_time: there's no period — treat all executions as in-period (i.e. epoch start).
  return new Date(0);
}

function periodResetLabel(period: string, now: Date): string {
  if (period === 'one_time') return 'single-use policy';
  if (period === 'month') {
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return `resets ${next.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }
  if (period === 'week') {
    const day = now.getDay();
    const nextMonday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + ((8 - day) % 7 || 7),
    );
    return `resets ${nextMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }
  if (period === 'day') {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return `resets ${tomorrow.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }
  return '';
}

function CapSection({
  policy,
  executions,
  periodLabel,
  periodNoun,
}: {
  policy: SpendingLimitPolicy;
  executions: SpendingLimitExecution[];
  periodLabel: string;
  periodNoun: string;
}) {
  const now = new Date();
  const start = periodStart(policy.period, now).getTime();

  // Sum spent + count auto-paid for the current period.
  const { spentRaw, count } = useMemo(() => {
    let total = 0n;
    let n = 0;
    for (const e of executions) {
      const when = e.executedAt ?? e.submittedAt ?? e.createdAt;
      const t = when ? new Date(when).getTime() : NaN;
      if (Number.isNaN(t) || t < start) continue;
      if (e.status !== 'settled' && e.status !== 'submitted') continue;
      n += 1;
      try {
        total += BigInt(e.amountRaw);
      } catch {
        // ignore malformed raw amounts
      }
    }
    return { spentRaw: total.toString(), count: n };
  }, [executions, start]);

  const capRawBig = (() => {
    try { return BigInt(policy.amountRaw); } catch { return 0n; }
  })();
  const spentBig = (() => {
    try { return BigInt(spentRaw); } catch { return 0n; }
  })();
  const remainingBig = capRawBig > spentBig ? capRawBig - spentBig : 0n;
  const pct = capRawBig > 0n
    ? Math.min(100, Math.round(Number((spentBig * 1000n) / capRawBig) / 10))
    : 0;
  const resetLabel = periodResetLabel(policy.period, now);

  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles">
          <h2>Cap used {periodNoun}</h2>
          <p className="sh-desc">
            How much of the {periodLabel.replace('per ', '')}ly limit the agent has spent.
            {policy.period !== 'one_time' ? ` ${resetLabel.charAt(0).toUpperCase()}${resetLabel.slice(1)}.` : ''}
          </p>
        </div>
      </div>
      <div className="cap-card">
        <div className="cap-top">
          <div className="cap-spent">
            <span className="cs-lab">Spent {periodNoun}</span>
            <span className="cs-amt">
              {formatRawUsdcCompact(spentRaw)}
              <small>USDC</small>
            </span>
            <span className="cs-of">
              of {formatRawUsdcCompact(policy.amountRaw)} {periodLabel} limit
            </span>
          </div>
          <div className="cap-right">
            <span className="cr-lab">Remaining</span>
            <span className="cr-rem">{formatRawUsdcCompact(remainingBig.toString())}</span>
            <span className="cr-reset">{resetLabel || '—'}</span>
          </div>
        </div>
        <div className="cap-meter">
          <span
            className={`cm-fill${pct >= 80 ? ' warn' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="cap-foot">
          <span className="cf-item">
            <Ico.bolt w={13} fill="currentColor" sw={0} style={{ color: 'var(--accent)' }} />
            <span className="mono">{count}</span> {count === 1 ? 'payment' : 'payments'} auto-paid
          </span>
          <span className="cf-sep" />
          <span className="cf-item">
            <span className="mono">{pct}%</span> of cap used
          </span>
          <span className="cf-sep" />
          <span className="cf-item">
            {policy.destinations.length} verified {policy.destinations.length === 1 ? 'vendor' : 'vendors'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Vendors ─────────────────────────────────────────────────────────────

function VendorsSection({
  destinations,
  executions,
  capRaw,
  onAdd,
  onRemoveVendor,
}: {
  destinations: SpendingLimitPolicyDestination[];
  executions: SpendingLimitExecution[];
  capRaw: string;
  onAdd: () => void;
  onRemoveVendor: () => void;
}) {
  // Per-vendor totals for the current period (use month as the default
  // visualization window — matches the design).
  const start = useMemo(() => periodStart('month', new Date()).getTime(), []);
  const totalsByCounterparty = useMemo(() => {
    const map = new Map<string, { paid: bigint; last: string | null }>();
    for (const e of executions) {
      const when = e.executedAt ?? e.submittedAt ?? e.createdAt;
      const t = when ? new Date(when).getTime() : NaN;
      if (Number.isNaN(t) || t < start) continue;
      if (e.status !== 'settled' && e.status !== 'submitted') continue;
      const key = e.counterpartyWalletId ?? e.destinationWalletAddress;
      if (!key) continue;
      const prev = map.get(key) ?? { paid: 0n, last: null };
      try { prev.paid += BigInt(e.amountRaw); } catch { /* ignore */ }
      if (!prev.last || (when && when > prev.last)) prev.last = when;
      map.set(key, prev);
    }
    return map;
  }, [executions, start]);

  const cap = (() => {
    try { return BigInt(capRaw); } catch { return 0n; }
  })();

  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles">
          <h2>Vendors</h2>
          <p className="sh-desc">Only these verified vendors can be auto-paid under this policy.</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onAdd}>
          <Ico.plus w={14} />Add vendor
        </button>
      </div>
      <div className="tbl-card">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: '34%' }}>Vendor</th>
              <th>Trust</th>
              <th className="num">Paid this month</th>
              <th>Last payment</th>
              <th className="num" style={{ width: 110 }}></th>
            </tr>
          </thead>
          <tbody>
            {destinations.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>
                  No vendors on this policy yet.
                </td>
              </tr>
            ) : (
              destinations.map((d) => (
                <VendorRow
                  key={d.spendingLimitPolicyDestinationId}
                  destination={d}
                  totals={totalsByCounterparty.get(d.counterpartyWalletId ?? d.walletAddress) ?? null}
                  cap={cap}
                  onRemove={onRemoveVendor}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VendorRow({
  destination,
  totals,
  cap,
  onRemove,
}: {
  destination: SpendingLimitPolicyDestination;
  totals: { paid: bigint; last: string | null } | null;
  cap: bigint;
  onRemove: () => void;
}) {
  const label =
    destination.counterpartyWallet?.label ??
    destination.counterpartyWallet?.counterparty?.displayName ??
    `${destination.walletAddress.slice(0, 4)}…${destination.walletAddress.slice(-4)}`;
  const trustState = destination.counterpartyWallet?.trustState ?? 'unreviewed';
  const trustLabel = trustState === 'trusted' ? 'Verified' : trustState.charAt(0).toUpperCase() + trustState.slice(1);
  const trustTone: PillTone = trustState === 'trusted' ? 'success' : trustState === 'blocked' ? 'danger' : 'neutral';

  const paidStr = totals ? formatRawUsdcCompact(totals.paid.toString()) : '0.00';
  const pct =
    totals && cap > 0n
      ? Math.min(100, Math.round(Number((totals.paid * 1000n) / cap) / 10))
      : 0;
  const lastDate = totals?.last
    ? new Date(totals.last).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—';

  return (
    <tr>
      <td>
        <div className="member-cell">
          <span className="m-avatar">{initialsFromLabel(label)}</span>
          <span className="m-name">{label}</span>
        </div>
      </td>
      <td>
        <Pill tone={trustTone}>{trustLabel}</Pill>
      </td>
      <td className="td-num">
        <span className="paid-bar">
          <span className="pb-fill" style={{ width: `${pct}%` }} />
        </span>
        {paidStr} <span style={{ color: 'var(--text-faint)' }}>USDC</span>
      </td>
      <td>
        <span className="joined">{lastDate}</span>
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="btn btn-sm btn-danger-ghost" onClick={onRemove}>
            Remove
          </button>
        </div>
      </td>
    </tr>
  );
}

function initialsFromLabel(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return '??';
}

// ─── Recent executions ───────────────────────────────────────────────────

function RecentExecutionsSection({ executions }: { executions: SpendingLimitExecution[] }) {
  const recent = executions.slice(0, 6);
  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles">
          <h2>Recent executions</h2>
          <p className="sh-desc">Payments the agent made automatically under this policy.</p>
        </div>
      </div>
      <div className="surface">
        {recent.length === 0 ? (
          <div style={{ padding: '20px 16px', fontSize: 13, color: 'var(--text-muted)' }}>
            No agent payments yet under this policy.
          </div>
        ) : (
          recent.map((e) => {
            const vendor =
              e.counterpartyWallet?.label ??
              (e.counterpartyWallet?.walletAddress
                ? `${e.counterpartyWallet.walletAddress.slice(0, 4)}…${e.counterpartyWallet.walletAddress.slice(-4)}`
                : 'Unknown vendor');
            const when = e.executedAt ?? e.submittedAt ?? e.createdAt;
            const dateLabel = when
              ? new Date(when).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              : '—';
            const sigShort = e.signature
              ? `${e.signature.slice(0, 4)}…${e.signature.slice(-4)}`
              : null;
            return (
              <div className="exec-row" key={e.spendingLimitExecutionId}>
                <span className="ex-vendor">{vendor}</span>
                <span className="ex-amt">
                  {formatRawUsdcCompact(e.amountRaw)}{' '}
                  <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>USDC</span>
                </span>
                <span
                  className="ex-policy"
                  style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                >
                  {dateLabel}
                </span>
                <span className="ex-sig">
                  {e.signature && sigShort ? (
                    <a
                      href={orbTransactionUrl(e.signature)}
                      target="_blank"
                      rel="noreferrer"
                      className="chainlink"
                      style={{ padding: '5px 9px', fontSize: 11, textDecoration: 'none' }}
                    >
                      <Ico.link w={13} />
                      <span className="sig">{sigShort}</span>
                      <Ico.external w={12} />
                    </a>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>—</span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Policy details record grid ─────────────────────────────────────────

function PolicyDetails({
  policy,
  proposal,
  periodLabel,
  treasuryName,
}: {
  policy: SpendingLimitPolicy;
  proposal: DecimalProposal | null;
  periodLabel: string;
  treasuryName: string;
}) {
  const createdByName =
    proposal?.createdByUser?.displayName || proposal?.createdByUser?.email || '—';
  const createdAtLabel = proposal?.createdAt
    ? new Date(proposal.createdAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '—';
  const approvalsCount = proposal?.voting?.approvals.length ?? 0;
  const threshold = proposal?.voting?.threshold ?? 0;
  const approverNames =
    proposal?.voting?.approvals
      .map((a) => a.organizationMembership?.user.displayName ?? a.organizationMembership?.user.email ?? '')
      .filter(Boolean)
      .join(' · ') || '';

  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles">
          <h2>Policy details</h2>
        </div>
      </div>
      <div className="detail-grid">
        <div className="detail-cell">
          <span className="d-label">Treasury</span>
          <span className="d-value">{treasuryName}</span>
          <span className="d-sub">{policy.treasuryWallet?.displayName ? '' : '—'}</span>
        </div>
        <div className="detail-cell">
          <span className="d-label">Limit</span>
          <span className="d-value mono">
            {formatRawUsdcCompact(policy.amountRaw)} USDC
          </span>
          <span className="d-sub">{periodLabel}</span>
        </div>
        <div className="detail-cell">
          <span className="d-label">Asset</span>
          <span className="d-value mono">{policy.asset.toUpperCase()}</span>
        </div>
        <div className="detail-cell">
          <span className="d-label">Vendors</span>
          <span className="d-value">
            {policy.destinations.length} verified
          </span>
        </div>
      </div>
      {proposal ? (
        <div className="detail-row2">
          <div className="detail-cell">
            <span className="d-label">Created by</span>
            <span className="d-value">{createdByName}</span>
            <span className="d-sub">{createdAtLabel}</span>
          </div>
          <div className="detail-cell">
            <span className="d-label">Approved</span>
            <span className="d-value">
              {approvalsCount} of {threshold} {threshold === 1 ? 'signer' : 'signers'}
            </span>
            {approverNames ? <span className="d-sub">{approverNames}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
