// Cross-treasury Spending Limits page — rebuilt to the design handoff
// (PageLimits in pages-governance.jsx). Shows every policy in the org,
// surface-level metrics, and the recent execution stream so an operator
// can audit agent activity at a glance.

import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type { SpendingLimitPolicy, SpendingLimitPolicyStatus, TreasuryWallet } from '../types';
import { formatRawUsdcCompact } from '../domain';
import { useToast } from '../ui/Toast';
import { Ico } from '../dec/icons';
import { Pill, PageHead, SLPill, type PillTone } from '../dec/primitives';
import { orbTransactionUrl } from '../lib/app';
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
  // Squads' OneTime is a non-resetting total budget, not a per-payment
  // cap (see Squads IDL + SpendingLimitDetail.tsx for the longer note).
  one_time: 'total',
  day: 'per day',
  week: 'per week',
  month: 'per month',
};

export function SpendingLimitsPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedTreasuryId, setPickedTreasuryId] = useState<string | null>(null);

  const policiesQuery = useQuery({
    queryKey: ['spending-limit-policies', organizationId, 'all'] as const,
    queryFn: () => api.listSpendingLimitPolicies(organizationId!),
    enabled: Boolean(organizationId),
  });

  // Recent executions for the "Auto-paid this month" metric AND the
  // RecentExecutions feed at the bottom. One call, used twice.
  const executionsQuery = useQuery({
    queryKey: ['spending-limit-executions', organizationId, 'recent'] as const,
    queryFn: () => api.listSpendingLimitExecutions(organizationId!, { limit: 25 }),
    enabled: Boolean(organizationId),
  });

  // Treasury list — for the "Pick a treasury" chooser the New button opens
  // (a policy is always scoped to one treasury, so we ask up-front rather
  // than baking it into the dialog).
  const treasuriesQuery = useQuery({
    queryKey: ['treasury-wallets', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });

  const syncMutation = useMutation({
    mutationFn: (spendingLimitPolicyId: string) =>
      api.syncSpendingLimitPolicy(organizationId!, spendingLimitPolicyId),
    onSuccess: async () => {
      success('Policy synced from chain.');
      await queryClient.invalidateQueries({
        queryKey: ['spending-limit-policies', organizationId, 'all'],
      });
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Sync failed.');
    },
  });

  if (!organizationId) {
    return (
      <div className="page">
        <div className="empty">
          <h4>Organization unavailable</h4>
          <p>Pick an organization from the sidebar.</p>
        </div>
      </div>
    );
  }

  const policies = policiesQuery.data?.items ?? [];
  const executions = executionsQuery.data?.items ?? [];
  const treasuries = (treasuriesQuery.data?.items ?? []).filter(
    (w) => w.source === 'squads_v4' && w.isActive,
  );

  const activeCount = policies.filter((p) => p.status === 'active').length;
  const pendingCount = policies.filter(
    (p) =>
      p.status === 'proposed' ||
      p.status === 'revocation_proposed' ||
      p.status === 'replacement_proposed',
  ).length;

  // "Auto-paid this month" — count + sum of executions whose executedAt
  // (fallback createdAt) falls in the current calendar month. Filter by
  // settled to avoid double-counting in-flight ones.
  const { autoPaidCount, autoPaidRawSum } = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let count = 0;
    let total = 0n;
    for (const e of executions) {
      const when = e.executedAt ?? e.submittedAt ?? e.createdAt;
      if (!when) continue;
      const t = new Date(when).getTime();
      if (Number.isNaN(t) || t < monthStart) continue;
      if (e.status !== 'settled' && e.status !== 'submitted') continue;
      count += 1;
      try {
        total += BigInt(e.amountRaw);
      } catch {
        // ignore malformed raw amounts
      }
    }
    return { autoPaidCount: count, autoPaidRawSum: total.toString() };
  }, [executions]);

  function openNewPolicy() {
    if (treasuries.length === 0) {
      toastError('Create a treasury account first.');
      return;
    }
    if (treasuries.length === 1) {
      setPickedTreasuryId(treasuries[0]!.treasuryWalletId);
    } else {
      setPickerOpen(true);
    }
  }

  return (
    <div className="page">
      <div className="stack stack-24">
        <PageHead
          eyebrow="GOVERNANCE"
          title="Spending limits"
          desc="Bounded autonomy for the Decimal agent. Each policy lets the agent pay specific vendors up to a cap without a team vote on every payment."
          actions={
            <button type="button" className="btn btn-primary" onClick={openNewPolicy}>
              <Ico.plus w={15} />New spending limit
            </button>
          }
        />

        <div className="metrics" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="metric">
            <div className="m-label">Active</div>
            <div className="m-value">{activeCount}</div>
            <div className="m-sub">policies</div>
          </div>
          <div className={`metric${pendingCount > 0 ? ' is-alert' : ''}`}>
            <div className="m-label">Awaiting vote</div>
            <div className="m-value">{pendingCount}</div>
            <div className="m-sub">{pendingCount === 1 ? 'needs approval' : 'need approval'}</div>
          </div>
          <div className="metric">
            <div className="m-label">Total</div>
            <div className="m-value">{policies.length}</div>
            <div className="m-sub">policies</div>
          </div>
          <div className="metric">
            <div className="m-label">Auto-paid this month</div>
            <div className="m-value">{autoPaidCount}</div>
            <div className="m-sub">
              {autoPaidRawSum === '0' ? '—' : `${formatRawUsdcCompact(autoPaidRawSum)} USDC`}
            </div>
          </div>
        </div>

        <PoliciesTable
          loading={policiesQuery.isLoading}
          policies={policies}
          organizationId={organizationId}
          onSync={(id) => syncMutation.mutate(id)}
          syncingId={syncMutation.isPending ? syncMutation.variables ?? null : null}
        />

        <RecentExecutions
          loading={executionsQuery.isLoading}
          executions={executions}
        />
      </div>

      {pickerOpen ? (
        <PickTreasuryDialog
          treasuries={treasuries}
          onClose={() => setPickerOpen(false)}
          onPick={(treasuryWalletId) => {
            setPickerOpen(false);
            setPickedTreasuryId(treasuryWalletId);
          }}
        />
      ) : null}

      {pickedTreasuryId ? (
        <CreateSpendingLimitDialog
          organizationId={organizationId}
          treasuryWalletId={pickedTreasuryId}
          onClose={() => setPickedTreasuryId(null)}
          onCreated={async () => {
            setPickedTreasuryId(null);
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

// ─── PoliciesTable ───────────────────────────────────────────────────────

function PoliciesTable({
  loading,
  policies,
  organizationId,
  onSync,
  syncingId,
}: {
  loading: boolean;
  policies: SpendingLimitPolicy[];
  organizationId: string;
  onSync: (id: string) => void;
  syncingId: string | null;
}) {
  if (loading) {
    return (
      <div className="tbl-card" style={{ padding: 16 }}>
        <div className="skeleton" style={{ height: 48, marginBottom: 6 }} />
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
          <h4>No spending limits yet</h4>
          <p>
            Open a treasury account and create one. The agent can then pay vetted vendors for
            routine bills without a team vote each time.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="tbl-card">
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: '22%' }}>Policy</th>
            <th>Treasury</th>
            <th>Limit</th>
            <th>Vendors</th>
            <th>Status</th>
            <th className="num" style={{ width: 200 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {policies.map((p) => (
            <PolicyRow
              key={p.spendingLimitPolicyId}
              policy={p}
              organizationId={organizationId}
              onSync={() => onSync(p.spendingLimitPolicyId)}
              syncing={syncingId === p.spendingLimitPolicyId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PolicyRow({
  policy,
  organizationId,
  onSync,
  syncing,
}: {
  policy: SpendingLimitPolicy;
  organizationId: string;
  onSync: () => void;
  syncing: boolean;
}) {
  const navigate = useNavigate();
  const status = policy.status as SpendingLimitPolicyStatus;
  const statusLabel = STATUS_LABEL[status] ?? policy.status;
  const tone = STATUS_TONE[status] ?? 'neutral';
  const periodLabel = PERIOD_LABEL[policy.period] ?? policy.period;
  const treasuryName =
    policy.treasuryWallet?.displayName ??
    (policy.treasuryWallet?.address
      ? `${policy.treasuryWallet.address.slice(0, 4)}…${policy.treasuryWallet.address.slice(-4)}`
      : '—');
  const vendorCount = policy.destinations.length;
  const hasPendingProposal =
    (status === 'proposed' || status === 'revocation_proposed' || status === 'replacement_proposed') &&
    Boolean(policy.decimalProposalId);

  return (
    <tr>
      <td>
        <span className="v-name" style={{ fontWeight: 600 }}>{policy.policyName}</span>
      </td>
      <td>
        <span
          className="cell-source"
          onClick={() =>
            navigate(`/organizations/${organizationId}/wallets/${policy.treasuryWalletId}`)
          }
          role="link"
          tabIndex={0}
          style={{ cursor: 'pointer' }}
        >
          <Ico.treasury w={15} />{treasuryName}
        </span>
      </td>
      <td>
        <div className="limit-cell">
          <span className="lc-amt">{formatRawUsdcCompact(policy.amountRaw)} USDC</span>
          <span className="lc-period">{periodLabel}</span>
        </div>
      </td>
      <td>
        <VendorCount n={vendorCount} />
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
                navigate(`/organizations/${organizationId}/proposals/${policy.decimalProposalId}`)
              }
            >
              View proposal<Ico.arrowRight w={13} />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() =>
                navigate(`/organizations/${organizationId}/spending-limits/${policy.spendingLimitPolicyId}`)
              }
            >
              Manage<Ico.arrowRight w={13} />
            </button>
          )}
          {status !== 'revoked' && status !== 'failed' ? (
            <button
              type="button"
              className="btn btn-sm btn-icon"
              onClick={onSync}
              disabled={syncing}
              aria-busy={syncing}
              title="Sync from chain"
            >
              <Ico.download w={13} style={{ transform: 'rotate(180deg)' }} />
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function VendorCount({ n }: { n: number }) {
  const dots = Math.min(n, 3);
  return (
    <span className="vendor-count">
      <span className="vc-stack">
        {Array.from({ length: dots }).map((_, i) => (
          <span className="vc-dot" key={i} />
        ))}
      </span>
      {n} {n === 1 ? 'vendor' : 'vendors'}
    </span>
  );
}

// ─── RecentExecutions ────────────────────────────────────────────────────

function RecentExecutions({
  loading,
  executions,
}: {
  loading: boolean;
  executions: Array<{
    spendingLimitExecutionId: string;
    amountRaw: string;
    signature: string | null;
    counterpartyWallet: { displayName?: string | null; walletAddress: string } | null;
    spendingLimitPolicy: { policyName: string } | null;
  }>;
}) {
  // Take the most recent 6 for the inline feed; users can drill into a
  // policy for the full history.
  const recent = executions.slice(0, 6);

  return (
    <div className="surface">
      <div
        className="sec-head"
        style={{ margin: 0, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}
      >
        <div className="sh-titles">
          <h2 style={{ fontSize: 15 }}>Recent executions</h2>
        </div>
      </div>
      <div>
        {loading ? (
          <div style={{ padding: 16 }}>
            <div className="skeleton" style={{ height: 36, marginBottom: 6 }} />
            <div className="skeleton" style={{ height: 36 }} />
          </div>
        ) : recent.length === 0 ? (
          <div style={{ padding: '20px 16px', fontSize: 13, color: 'var(--text-muted)' }}>
            No agent payments yet. They'll show up here once a spending limit fires.
          </div>
        ) : (
          recent.map((e) => {
            const vendor =
              e.counterpartyWallet?.displayName ||
              (e.counterpartyWallet?.walletAddress
                ? `${e.counterpartyWallet.walletAddress.slice(0, 4)}…${e.counterpartyWallet.walletAddress.slice(-4)}`
                : 'Unknown vendor');
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
                <span className="ex-policy">
                  <SLPill /> &nbsp;{e.spendingLimitPolicy?.policyName ?? '—'}
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

// ─── PickTreasuryDialog ──────────────────────────────────────────────────
// A new policy is always scoped to one treasury — when the org has more
// than one we ask the operator up-front, then hand off to the existing
// CreateSpendingLimitDialog. A native <select> kept things small.

function PickTreasuryDialog({
  treasuries,
  onClose,
  onPick,
}: {
  treasuries: TreasuryWallet[];
  onClose: () => void;
  onPick: (treasuryWalletId: string) => void;
}) {
  const [picked, setPicked] = useState<string>(treasuries[0]?.treasuryWalletId ?? '');

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dec-pick-treasury-title">
        <div className="dialog-head">
          <div>
            <h2 id="dec-pick-treasury-title">Choose a treasury</h2>
            <p>Each spending limit is scoped to one treasury account. Pick which one this policy belongs to.</p>
          </div>
          <button type="button" className="drawer-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="dialog-body">
          <div className="field">
            <label className="field-label" htmlFor="dec-pick-treasury">Treasury</label>
            <div className="select">
              <select
                id="dec-pick-treasury"
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
              >
                {treasuries.map((t) => (
                  <option key={t.treasuryWalletId} value={t.treasuryWalletId}>
                    {t.displayName ?? 'Untitled treasury'}
                  </option>
                ))}
              </select>
              <Ico.chevDown w={14} />
            </div>
          </div>
        </div>
        <div className="dialog-foot">
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={!picked}
            onClick={() => onPick(picked)}
          >
            Continue<Ico.arrowRight w={13} />
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
