// Vault Detail — one vault under a treasury account.
// Implements design_handoff_vault_detail/pages-vault-detail.jsx.
// Reached from the "Manage →" action on a row of the Vaults table on
// Treasury Detail. Signers are inherited from the parent account and
// shown read-only here — change them on the account.

import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  SpendingLimitPolicy,
  SpendingLimitPolicyStatus,
  SquadsDetailMember,
  PaymentOrder,
  TreasuryWallet,
} from '../types';
import { formatRawUsdcCompact } from '../domain';
import { Ico } from '../dec/icons';
import { Pill, SLPill, OriginPill, type PillTone } from '../dec/primitives';
import { CreateSpendingLimitDialog } from './TreasuryWalletDetail';

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

// Mirrors the payment-list view tone mapping. Kept minimal — full set
// lives on the Payments page.
const PAYMENT_STATUS_TONE: Record<string, PillTone> = {
  settled: 'success',
  signing: 'warning',
  send: 'info',
  reviewed: 'info',
  received: 'neutral',
  cancelled: 'neutral',
  exception: 'danger',
};

export function VaultDetailPage() {
  const { organizationId, treasuryWalletId } = useParams<{
    organizationId: string;
    treasuryWalletId: string;
  }>();
  const navigate = useNavigate();
  const [createSLOpen, setCreateSLOpen] = useState(false);

  const treasuryListQuery = useQuery({
    queryKey: ['treasury-wallets', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });

  const balancesQuery = useQuery({
    queryKey: ['treasury-wallet-balances', organizationId] as const,
    queryFn: () => api.listTreasuryWalletBalances(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 15_000,
  });

  const vault = useMemo(
    () =>
      treasuryListQuery.data?.items.find((w) => w.treasuryWalletId === treasuryWalletId) ?? null,
    [treasuryListQuery.data, treasuryWalletId],
  );

  // Parent account = the primary sibling (lowest sourceVaultIndex) sharing
  // this multisig PDA. Use its displayName as the account name surfaced
  // in the breadcrumb + treasury chip.
  const parentVault = useMemo(() => {
    if (!vault || vault.source !== 'squads_v4' || !vault.sourceRef) return null;
    const siblings = (treasuryListQuery.data?.items ?? [])
      .filter((w) => w.source === 'squads_v4' && w.sourceRef === vault.sourceRef)
      .sort((a, b) => (a.sourceVaultIndex ?? 999) - (b.sourceVaultIndex ?? 999));
    return siblings[0] ?? vault;
  }, [vault, treasuryListQuery.data]);
  const parentAccountName = parentVault?.displayName ?? 'Treasury account';
  const parentTreasuryWalletId = parentVault?.treasuryWalletId ?? null;

  const isSquads = vault?.source === 'squads_v4';

  const detailQuery = useQuery({
    queryKey: ['treasury-wallet-detail', organizationId, parentTreasuryWalletId] as const,
    queryFn: () => api.getSquadsTreasuryDetail(organizationId!, parentTreasuryWalletId!),
    enabled: Boolean(organizationId && parentTreasuryWalletId && isSquads),
  });

  // Policies scoped to this exact vault.
  const policiesQuery = useQuery({
    queryKey: ['spending-limit-policies', organizationId, treasuryWalletId] as const,
    queryFn: () =>
      api.listSpendingLimitPolicies(organizationId!, { treasuryWalletId: treasuryWalletId! }),
    enabled: Boolean(organizationId && treasuryWalletId),
  });

  // Recent payments — we need to filter by sourceTreasuryWalletId since
  // the list endpoint doesn't have that filter. Pull the recent 100 and
  // narrow client-side.
  const paymentsQuery = useQuery({
    queryKey: ['payment-orders', organizationId, 'recent'] as const,
    queryFn: () => api.listPaymentOrders(organizationId!),
    enabled: Boolean(organizationId),
  });

  // Org-wide spending-limit executions for the auto-paid metric.
  const executionsQuery = useQuery({
    queryKey: ['spending-limit-executions', organizationId, 'vault', treasuryWalletId] as const,
    queryFn: () =>
      api.listSpendingLimitExecutions(organizationId!, { treasuryWalletId: treasuryWalletId! }),
    enabled: Boolean(organizationId && treasuryWalletId),
  });

  if (!organizationId || !treasuryWalletId) {
    return (
      <div className="page">
        <div className="empty">
          <h4>Vault unavailable</h4>
          <p>Pick a vault from a treasury account.</p>
        </div>
      </div>
    );
  }

  if (treasuryListQuery.isLoading) {
    return (
      <div className="page">
        <div className="stack stack-24">
          <div className="skeleton" style={{ height: 80, borderRadius: 12 }} />
          <div className="skeleton" style={{ height: 120, borderRadius: 12 }} />
          <div className="skeleton" style={{ height: 240, borderRadius: 12 }} />
        </div>
      </div>
    );
  }

  if (!vault) {
    return (
      <div className="page">
        <div
          className="crumb"
          onClick={() => navigate(`/organizations/${organizationId}/wallets`)}
          role="button"
          tabIndex={0}
        >
          <Ico.chevRight w={15} style={{ transform: 'rotate(180deg)' }} />Treasury accounts
        </div>
        <div className="empty" style={{ marginTop: 24 }}>
          <h4>Vault not found</h4>
          <p>This vault doesn't exist in this organization.</p>
        </div>
      </div>
    );
  }

  const balanceRaw =
    balancesQuery.data?.items.find((b) => b.treasuryWalletId === treasuryWalletId)?.usdcRaw ?? null;
  const policies = policiesQuery.data?.items ?? [];
  const activePoliciesCount = policies.filter((p) => p.status === 'active').length;

  // Auto-paid this month — settled+submitted executions whose timestamp
  // falls in the current calendar month.
  const allExecutions = executionsQuery.data?.items ?? [];
  const { autoCount, autoSumRaw } = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let n = 0;
    let total = 0n;
    for (const e of allExecutions) {
      const when = e.executedAt ?? e.submittedAt ?? e.createdAt;
      const t = when ? new Date(when).getTime() : NaN;
      if (Number.isNaN(t) || t < monthStart) continue;
      if (e.status !== 'settled' && e.status !== 'submitted') continue;
      n += 1;
      try { total += BigInt(e.amountRaw); } catch { /* ignore */ }
    }
    return { autoCount: n, autoSumRaw: total.toString() };
  }, [allExecutions]);

  // Recent payments from this vault (server returns up to 100; narrow
  // by source and keep the most recent 6 for the inline table).
  const recentPayments = useMemo(() => {
    const all = paymentsQuery.data?.items ?? [];
    return all
      .filter((p) => p.sourceTreasuryWalletId === treasuryWalletId)
      .slice(0, 6);
  }, [paymentsQuery.data, treasuryWalletId]);

  return (
    <div className="page">
      <div className="crumb">
        <Ico.chevRight w={15} style={{ transform: 'rotate(180deg)' }} />
        <span
          onClick={() => navigate(`/organizations/${organizationId}/wallets`)}
          role="link"
          tabIndex={0}
          style={{ cursor: 'pointer' }}
        >
          Treasury accounts
        </span>
        {parentTreasuryWalletId ? (
          <>
            <span className="cb-sep">/</span>
            <span
              className="cb-mid"
              onClick={() =>
                navigate(`/organizations/${organizationId}/wallets/${parentTreasuryWalletId}`)
              }
              role="link"
              tabIndex={0}
              style={{ cursor: 'pointer' }}
            >
              {parentAccountName}
            </span>
          </>
        ) : null}
      </div>

      <div className="stack stack-32">
        {/* Header */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>VAULT</div>
          <div className="pagehead" style={{ paddingBottom: 18 }}>
            <div className="ph-titles">
              <h1>{vault.displayName || 'Untitled vault'}</h1>
              <p className="ph-desc">
                <span
                  className="cell-source"
                  style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer' }}
                  onClick={() =>
                    parentTreasuryWalletId &&
                    navigate(`/organizations/${organizationId}/wallets/${parentTreasuryWalletId}`)
                  }
                  role="link"
                  tabIndex={0}
                >
                  <Ico.treasury w={15} />{parentAccountName} account
                </span>
                {vault.notes ? (
                  <>
                    &nbsp;&nbsp;<span style={{ color: 'var(--text-faint)' }}>·</span>&nbsp;&nbsp;
                    {vault.notes}
                  </>
                ) : null}
              </p>
            </div>
            <div className="ph-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setCreateSLOpen(true)}
              >
                <Ico.shield w={15} />New spending limit
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => navigate(`/organizations/${organizationId}/payments`)}
              >
                <Ico.plus w={15} />New payment
              </button>
            </div>
          </div>
        </div>

        {/* Metrics */}
        <div className="metrics" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="metric">
            <div className="m-label">Vault balance</div>
            <div className="m-value">
              {balanceRaw ? formatRawUsdcCompact(balanceRaw) : balancesQuery.isLoading ? '—' : '0.00'}
            </div>
            <div className="m-sub">USDC</div>
          </div>
          <div className="metric">
            <div className="m-label">Spending limits</div>
            <div className="m-value">{activePoliciesCount}</div>
            <div className="m-sub">active {activePoliciesCount === 1 ? 'policy' : 'policies'}</div>
          </div>
          <div className="metric">
            <div className="m-label">Auto-paid this month</div>
            <div className="m-value">{autoCount}</div>
            <div className="m-sub">
              {autoSumRaw === '0' ? '—' : `${formatRawUsdcCompact(autoSumRaw)} USDC`}
            </div>
          </div>
        </div>

        {/* Inherited signers callout */}
        {isSquads ? (
          <div>
            <div className="sec-head">
              <div className="sh-titles">
                <h2>Signers</h2>
                <p className="sh-desc">Who authorizes payments from this vault.</p>
              </div>
            </div>
            <VaultSigners
              loading={detailQuery.isLoading}
              error={detailQuery.error}
              members={detailQuery.data?.squads.members ?? []}
              threshold={detailQuery.data?.squads.threshold ?? 0}
              parentAccountName={parentAccountName}
              parentTreasuryWalletId={parentTreasuryWalletId}
              organizationId={organizationId}
            />
          </div>
        ) : null}

        {/* Spending limits scoped to this vault */}
        <div>
          <div className="sec-head">
            <div className="sh-titles">
              <h2>Spending limits</h2>
              <p className="sh-desc">
                Policies that let the agent pay from this vault without a team vote.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setCreateSLOpen(true)}
            >
              <Ico.plus w={14} />New spending limit
            </button>
          </div>
          <ScopedSpendingLimitsTable
            loading={policiesQuery.isLoading}
            policies={policies}
            organizationId={organizationId}
          />
        </div>

        {/* Recent payments from this vault */}
        <div>
          <div className="sec-head">
            <div className="sh-titles">
              <h2>Recent payments</h2>
              <p className="sh-desc">Payments sent from this vault.</p>
            </div>
            <Link
              to={`/organizations/${organizationId}/payments`}
              className="link"
              style={{ fontSize: 13, textDecoration: 'none', color: 'var(--text-muted)' }}
            >
              View all<Ico.arrowRight w={13} />
            </Link>
          </div>
          <RecentPaymentsTable
            loading={paymentsQuery.isLoading}
            payments={recentPayments}
            organizationId={organizationId}
          />
        </div>
      </div>

      {createSLOpen ? (
        <CreateSpendingLimitDialog
          organizationId={organizationId}
          treasuryWalletId={treasuryWalletId}
          onClose={() => setCreateSLOpen(false)}
          onCreated={async () => {
            setCreateSLOpen(false);
            await policiesQuery.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

// ─── VaultSigners callout ────────────────────────────────────────────────

function VaultSigners({
  loading,
  error,
  members,
  threshold,
  parentAccountName,
  parentTreasuryWalletId,
  organizationId,
}: {
  loading: boolean;
  error: unknown;
  members: SquadsDetailMember[];
  threshold: number;
  parentAccountName: string;
  parentTreasuryWalletId: string | null;
  organizationId: string;
}) {
  if (loading) {
    return <div className="skeleton" style={{ height: 70, borderRadius: 12 }} />;
  }
  if (error) {
    return (
      <div className="tbl-card" style={{ padding: 20 }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {error instanceof ApiError || error instanceof Error
            ? error.message
            : 'Couldn\'t load signers.'}
        </span>
      </div>
    );
  }
  const peopleSigners = members.filter((m) => !m.agentWallet && !m.automationAgent);
  const voterCount = members.filter((m) => m.permissions.includes('vote')).length;
  return (
    <div className="vault-signers">
      <div className="vs-left">
        <span className="sc-badge">{threshold} of {voterCount}</span>
        <div className="vs-text">
          <div className="vs-title">
            Secured by <b>{parentAccountName}</b>'s signers
          </div>
          <div className="vs-sub">
            Every vault in this account shares the same team. Change signers or the threshold on the account.
          </div>
        </div>
      </div>
      <div className="vs-right">
        <div className="avatar-stack">
          {peopleSigners.slice(0, 4).map((m) => (
            <SignerDot key={m.walletAddress} member={m} />
          ))}
          <span className="as-more">{peopleSigners.length}</span>
        </div>
        {parentTreasuryWalletId ? (
          <Link
            to={`/organizations/${organizationId}/wallets/${parentTreasuryWalletId}`}
            className="link"
            style={{ textDecoration: 'none' }}
          >
            View account<Ico.arrowRight w={13} />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function SignerDot({ member }: { member: SquadsDetailMember }) {
  const user = member.organizationMembership?.user;
  const initials = (() => {
    if (!user) return '??';
    const name = user.displayName?.trim();
    if (name) {
      const parts = name.split(/\s+/);
      if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
      return name.slice(0, 2).toUpperCase();
    }
    return user.email.slice(0, 2).toUpperCase();
  })();
  const avatarUrl = user?.avatarUrl ?? null;
  return <StackAvatar avatarUrl={avatarUrl} initials={initials} />;
}

function StackAvatar({ avatarUrl, initials }: { avatarUrl: string | null; initials: string }) {
  const [failed, setFailed] = useState(false);
  if (!avatarUrl || failed) return <span className="as-dot">{initials}</span>;
  return (
    <span className="as-dot" style={{ padding: 0, overflow: 'hidden', background: 'transparent' }}>
      <img
        src={avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </span>
  );
}

// ─── ScopedSpendingLimitsTable ───────────────────────────────────────────
// Same shape as the cross-treasury table on /spending-limits but the
// Treasury column is omitted — implied by context.

function ScopedSpendingLimitsTable({
  loading,
  policies,
  organizationId,
}: {
  loading: boolean;
  policies: SpendingLimitPolicy[];
  organizationId: string;
}) {
  const navigate = useNavigate();
  if (loading) {
    return (
      <div className="tbl-card" style={{ padding: 16 }}>
        <div className="skeleton" style={{ height: 48, marginBottom: 6 }} />
        <div className="skeleton" style={{ height: 48 }} />
      </div>
    );
  }
  if (policies.length === 0) {
    return (
      <div className="tbl-card">
        <div className="empty">
          <div className="empty-icon"><Ico.shield w={22} /></div>
          <h4>No spending limits on this vault</h4>
          <p>Add one so the agent can pay vetted vendors without a team vote each time.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="tbl-card">
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: '32%' }}>Policy</th>
            <th>Limit</th>
            <th>Vendors</th>
            <th>Status</th>
            <th className="num" style={{ width: 160 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {policies.map((p) => {
            const status = p.status as SpendingLimitPolicyStatus;
            const statusLabel = STATUS_LABEL[status] ?? p.status;
            const tone = STATUS_TONE[status] ?? 'neutral';
            const period = PERIOD_LABEL[p.period] ?? p.period;
            const vendorCount = p.destinations.length;
            const hasPendingProposal =
              (status === 'proposed' || status === 'revocation_proposed' || status === 'replacement_proposed') &&
              Boolean(p.decimalProposalId);
            return (
              <tr key={p.spendingLimitPolicyId}>
                <td>
                  <span style={{ fontWeight: 600 }}>{p.policyName}</span>
                </td>
                <td>
                  <div className="limit-cell">
                    <span className="lc-amt">{formatRawUsdcCompact(p.amountRaw)} USDC</span>
                    <span className="lc-period">{period}</span>
                  </div>
                </td>
                <td>
                  <span className="vendor-count">
                    <span className="vc-stack">
                      {Array.from({ length: Math.min(vendorCount, 3) }).map((_, i) => (
                        <span className="vc-dot" key={i} />
                      ))}
                    </span>
                    {vendorCount} {vendorCount === 1 ? 'vendor' : 'vendors'}
                  </span>
                </td>
                <td>
                  <Pill tone={tone}>{statusLabel}</Pill>
                </td>
                <td>
                  <div className="row-actions">
                    {hasPendingProposal ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() =>
                          navigate(`/organizations/${organizationId}/proposals/${p.decimalProposalId}`)
                        }
                      >
                        View proposal<Ico.arrowRight w={13} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() =>
                          navigate(`/organizations/${organizationId}/spending-limits/${p.spendingLimitPolicyId}`)
                        }
                      >
                        Manage<Ico.arrowRight w={13} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── RecentPaymentsTable ─────────────────────────────────────────────────

function RecentPaymentsTable({
  loading,
  payments,
  organizationId,
}: {
  loading: boolean;
  payments: PaymentOrder[];
  organizationId: string;
}) {
  const navigate = useNavigate();
  if (loading) {
    return (
      <div className="tbl-card" style={{ padding: 16 }}>
        <div className="skeleton" style={{ height: 48, marginBottom: 6 }} />
        <div className="skeleton" style={{ height: 48 }} />
      </div>
    );
  }
  if (payments.length === 0) {
    return (
      <div className="tbl-card">
        <div className="empty">
          <div className="empty-icon"><Ico.payments w={22} /></div>
          <h4>No payments yet from this vault</h4>
          <p>Once a payment is sent from this vault, it'll show up here.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="tbl-card">
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: '34%' }}>Vendor</th>
            <th className="num">Amount</th>
            <th>Origin</th>
            <th>Status</th>
            <th>Date</th>
            <th style={{ width: 28 }}></th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => {
            const vendor = p.counterpartyWallet?.label ?? 'Unknown vendor';
            const originLabel = p.inputBatchLabel ?? 'Single';
            const state = String(p.derivedState ?? p.state).toLowerCase();
            const statusTone = PAYMENT_STATUS_TONE[state] ?? 'neutral';
            const statusLabel = state.charAt(0).toUpperCase() + state.slice(1);
            const isAgentRoute = Boolean(p.spendingLimitExecution);
            const date = new Date(p.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
            return (
              <tr
                key={p.paymentOrderId}
                onClick={() =>
                  navigate(`/organizations/${organizationId}/payments/${p.paymentOrderId}`)
                }
                style={{ cursor: 'pointer' }}
              >
                <td>
                  <span style={{ fontWeight: 600 }}>{vendor}</span>
                </td>
                <td className="td-num">
                  {formatRawUsdcCompact(p.amountRaw)}{' '}
                  <span style={{ color: 'var(--text-faint)' }}>USDC</span>
                </td>
                <td>
                  <OriginPill>{originLabel}</OriginPill>
                </td>
                <td>
                  <span className="status-cell">
                    <Pill tone={statusTone}>{statusLabel}</Pill>
                    {isAgentRoute ? <SLPill /> : null}
                  </span>
                </td>
                <td>
                  <span className="joined">{date}</span>
                </td>
                <td>
                  <span className="row-arrow"><Ico.chevRight w={16} /></span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
