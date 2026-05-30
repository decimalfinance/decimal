// Cross-treasury proposals page — implements PageProposals from the
// design handoff. Lists every active/closed Squads proposal in the org
// with vote dots, status pill, and per-row action (Vote / Execute /
// View). Approve + Execute mutations land where they do everywhere
// else; this surface just lets the user reach them faster.

import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  AuthenticatedSession,
  DecimalProposal,
  SquadsProposalListStatusFilter,
} from '../types';
import { signAndSubmitIntent } from '../lib/squads-pipeline';
import { useToast } from '../ui/Toast';
import { PageHead, Pill, type PillTone } from '../dec/primitives';
import { Ico } from '../dec/icons';
import { proposalTypeLabel, summarizeProposal } from '../ui/DecimalProposalCard';

// "All" loads pending + closed without server-side scoping; we'd
// otherwise need two queries to derive the 3 metrics + the All tab.
const STATUS_FILTERS: SquadsProposalListStatusFilter[] = ['all', 'pending', 'closed'];

type LocalTab = 'all' | 'needs_vote' | 'active' | 'completed';

export function OrganizationProposalsPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const [tab, setTab] = useState<LocalTab>('all');
  const [search, setSearch] = useState('');

  const treasuryWalletFilter = searchParams.get('treasuryWalletId') ?? '';

  const ownPersonalWalletsQuery = useQuery({
    queryKey: ['personal-wallets'] as const,
    queryFn: () => api.listPersonalWallets(),
    enabled: Boolean(organizationId),
  });
  const ownPersonalWalletAddresses = useMemo(
    () =>
      new Set(
        (ownPersonalWalletsQuery.data?.items ?? [])
          .filter((w) => w.status === 'active' && w.chain === 'solana')
          .map((w) => w.walletAddress),
      ),
    [ownPersonalWalletsQuery.data],
  );

  const treasuriesQuery = useQuery({
    queryKey: ['treasury-wallets', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });
  const treasuries = treasuriesQuery.data?.items ?? [];
  const treasuryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of treasuries) map.set(t.treasuryWalletId, t.displayName ?? 'Untitled treasury');
    return map;
  }, [treasuries]);

  // Pull the full universe of proposals up-front so the local-tabs and
  // metrics can be computed without bouncing back to the server. The
  // list endpoint is cheap; pending+closed combined is bounded by how
  // many proposals an org has, which stays small.
  const proposalsQuery = useQuery({
    queryKey: [
      'organization-proposals',
      organizationId,
      'all',
      treasuryWalletFilter,
    ] as const,
    queryFn: async () => {
      const results = await Promise.all(
        STATUS_FILTERS.filter((s) => s !== 'all').map((status) =>
          api.listOrganizationProposals(organizationId!, {
            status,
            treasuryWalletId: treasuryWalletFilter || undefined,
          }),
        ),
      );
      return { items: results.flatMap((r) => r.items) };
    },
    enabled: Boolean(organizationId),
    refetchInterval: 20_000,
  });

  const allItems = proposalsQuery.data?.items ?? [];
  const currentUserId = session.user.userId;

  // "Needs your vote" = the proposal is active AND one of the pending
  // voters is a wallet the current user owns.
  function needsMyVote(p: DecimalProposal): boolean {
    if (p.status !== 'active') return false;
    return (p.voting?.pendingVoters ?? []).some(
      (v) =>
        v.personalWallet?.userId === currentUserId &&
        ownPersonalWalletAddresses.has(v.walletAddress),
    );
  }

  const counts = useMemo(() => {
    let needsVote = 0;
    let active = 0;
    let completed = 0;
    for (const p of allItems) {
      if (needsMyVote(p)) needsVote += 1;
      if (p.status === 'active' || p.status === 'approved') active += 1;
      if (p.status === 'executed') completed += 1;
    }
    return { needsVote, active, completed, all: allItems.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allItems, currentUserId, ownPersonalWalletAddresses]);

  const filteredRows = useMemo(() => {
    let out = allItems;
    if (tab === 'needs_vote') out = out.filter(needsMyVote);
    else if (tab === 'active') out = out.filter((p) => p.status === 'active' || p.status === 'approved');
    else if (tab === 'completed') out = out.filter((p) => p.status === 'executed');

    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((p) => {
        const title = summarizeProposal(p).toLowerCase();
        const treasuryName = p.treasuryWalletId
          ? (treasuryNameById.get(p.treasuryWalletId) ?? '').toLowerCase()
          : '';
        return title.includes(q) || treasuryName.includes(q);
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allItems, tab, search, treasuryNameById, currentUserId, ownPersonalWalletAddresses]);

  async function refreshProposals() {
    await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
    await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
  }

  const approveMutation = useMutation({
    mutationFn: async (input: { proposal: DecimalProposal; signerWalletId: string }) => {
      const intent = await api.createProposalApprovalIntent(
        organizationId!,
        input.proposal.decimalProposalId,
        { memberPersonalWalletId: input.signerWalletId },
      );
      return signAndSubmitIntent({ intent, signerPersonalWalletId: input.signerWalletId });
    },
    onSuccess: async () => {
      success('Approval submitted.');
      await refreshProposals();
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Approve failed.');
    },
  });

  const executeMutation = useMutation({
    mutationFn: async (input: { proposal: DecimalProposal; signerWalletId: string }) => {
      const decimalProposalId = input.proposal.decimalProposalId;
      const intent = await api.createProposalExecuteIntent(
        organizationId!,
        decimalProposalId,
        { memberPersonalWalletId: input.signerWalletId },
      );
      const sig = await signAndSubmitIntent({ intent, signerPersonalWalletId: input.signerWalletId });
      try {
        await api.confirmProposalExecution(organizationId!, decimalProposalId, { signature: sig });
      } catch {
        // ignore — auto-retry / sync reconciles
      }
      if (input.proposal.proposalType === 'config_transaction' && input.proposal.treasuryWalletId) {
        try {
          await api.syncSquadsTreasuryMembers(organizationId!, input.proposal.treasuryWalletId);
        } catch {
          // ignore
        }
      }
      return { decimalProposalId };
    },
    onSuccess: async () => {
      success('Proposal executed.');
      await refreshProposals();
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Execute failed.');
    },
  });

  // Pick the user's own personal wallet that's listed as a pending voter
  // (or has execute permission) on a given proposal, so the row's Vote/
  // Execute button knows which wallet to sign with.
  function pickPendingVoterWallet(p: DecimalProposal): string | null {
    const match = (p.voting?.pendingVoters ?? []).find(
      (v) =>
        v.personalWallet?.userId === currentUserId &&
        ownPersonalWalletAddresses.has(v.walletAddress),
    );
    return match?.personalWallet?.userWalletId ?? null;
  }
  function pickExecuteWallet(p: DecimalProposal): string | null {
    const canExec = new Set(p.voting?.canExecuteWalletAddresses ?? []);
    for (const addr of ownPersonalWalletAddresses) {
      if (canExec.has(addr)) {
        const own = (ownPersonalWalletsQuery.data?.items ?? []).find((w) => w.walletAddress === addr);
        if (own) return own.userWalletId;
      }
    }
    return null;
  }

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

  const tabs: Array<{ id: LocalTab; label: string; count: number }> = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'needs_vote', label: 'Needs your vote', count: counts.needsVote },
    { id: 'active', label: 'Active', count: counts.active },
    { id: 'completed', label: 'Completed', count: counts.completed },
  ];

  return (
    <div className="page">
      <div className="stack stack-24">
        <PageHead
          eyebrow="GOVERNANCE"
          title="Proposals"
          desc="Team decisions that need signer approval — new spending limits, members, and changes to how money moves."
        />

        <div className="metrics" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className={`metric${counts.needsVote > 0 ? ' is-alert' : ''}`}>
            <div className="m-label">Needs your vote</div>
            <div className="m-value">{counts.needsVote}</div>
            <div className="m-sub">{counts.needsVote === 1 ? 'awaits you' : 'awaiting you'}</div>
          </div>
          <div className="metric">
            <div className="m-label">Active</div>
            <div className="m-value">{counts.active}</div>
            <div className="m-sub">in progress</div>
          </div>
          <div className="metric">
            <div className="m-label">Completed</div>
            <div className="m-value">{counts.completed}</div>
            <div className="m-sub">executed</div>
          </div>
        </div>

        <div className="filterbar">
          <div className="tabs">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tab${tab === t.id ? ' on' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                <span className="tab-count">{t.count}</span>
              </button>
            ))}
          </div>
          <div className="filter-right">
            <div className="input-search">
              <Ico.search w={15} />
              <input
                className="input"
                placeholder="Search proposals"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="tbl-card">
          {proposalsQuery.isLoading ? (
            <div style={{ padding: 16 }}>
              <div className="skeleton" style={{ height: 48, marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 48, marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 48 }} />
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Ico.proposals w={22} /></div>
              <h4>No proposals here</h4>
              <p>
                {tab === 'needs_vote'
                  ? "Nothing's waiting on your signature right now."
                  : tab === 'active'
                    ? 'No active proposals.'
                    : tab === 'completed'
                      ? 'No completed proposals yet.'
                      : 'No proposals match these filters.'}
              </p>
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>Proposal</th>
                  <th>Treasury</th>
                  <th>Approvals</th>
                  <th>Status</th>
                  <th className="num" style={{ width: 140 }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((p) => (
                  <ProposalRow
                    key={p.decimalProposalId}
                    proposal={p}
                    treasuryName={
                      p.treasuryWalletId ? treasuryNameById.get(p.treasuryWalletId) ?? '—' : '—'
                    }
                    needsMyVote={needsMyVote(p)}
                    pendingVoterWalletId={pickPendingVoterWallet(p)}
                    executeWalletId={pickExecuteWallet(p)}
                    busy={approveMutation.isPending || executeMutation.isPending}
                    onView={() =>
                      navigate(`/organizations/${organizationId}/proposals/${p.decimalProposalId}`)
                    }
                    onApprove={(walletId) => approveMutation.mutate({ proposal: p, signerWalletId: walletId })}
                    onExecute={(walletId) => executeMutation.mutate({ proposal: p, signerWalletId: walletId })}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ProposalRow ─────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, PillTone> = {
  active: 'warning',
  approved: 'info',
  executed: 'success',
  cancelled: 'neutral',
  rejected: 'neutral',
};
const STATUS_LABEL: Record<string, string> = {
  active: 'Awaiting others',
  approved: 'Ready to execute',
  executed: 'Executed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

function ProposalRow({
  proposal,
  treasuryName,
  needsMyVote,
  pendingVoterWalletId,
  executeWalletId,
  busy,
  onView,
  onApprove,
  onExecute,
}: {
  proposal: DecimalProposal;
  treasuryName: string;
  needsMyVote: boolean;
  pendingVoterWalletId: string | null;
  executeWalletId: string | null;
  busy: boolean;
  onView: () => void;
  onApprove: (walletId: string) => void;
  onExecute: (walletId: string) => void;
}) {
  const title = summarizeProposal(proposal);
  const typeLabel = proposalTypeLabel(proposal);
  const approved = proposal.voting?.approvals.length ?? 0;
  const total = proposal.voting?.threshold ?? 0;
  const statusKey = proposal.status === 'active' && needsMyVote ? 'needs_vote' : proposal.status;
  const statusTone =
    statusKey === 'needs_vote' ? 'warning' : STATUS_TONE[proposal.status] ?? 'neutral';
  const statusLabel =
    statusKey === 'needs_vote' ? 'Needs your vote' : STATUS_LABEL[proposal.status] ?? proposal.status;

  return (
    <tr onClick={onView} style={{ cursor: 'pointer' }}>
      <td>
        <div className="cell-vendor">
          <span className="v-name">{title}</span>
          <span className="v-sub" style={{ fontFamily: 'var(--font-body)' }}>{typeLabel}</span>
        </div>
      </td>
      <td>
        <span className="cell-source">
          {treasuryName !== '—' ? <Ico.treasury w={15} /> : null}
          {treasuryName}
        </span>
      </td>
      <td>
        <VoteDots approved={approved} total={total} />
      </td>
      <td>
        <Pill tone={statusTone}>{statusLabel}</Pill>
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        <div className="row-actions">
          {needsMyVote && pendingVoterWalletId ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => onApprove(pendingVoterWalletId)}
            >
              Vote<Ico.arrowRight w={13} />
            </button>
          ) : proposal.status === 'approved' && executeWalletId ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => onExecute(executeWalletId)}
            >
              <Ico.bolt w={13} fill="currentColor" sw={0} />Execute
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={onView}
            >
              View<Ico.arrowRight w={13} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function VoteDots({ approved, total }: { approved: number; total: number }) {
  // Cap at 6 dots so very wide thresholds don't blow up the row.
  const dots = Math.min(total, 6);
  return (
    <span className="appr-dots">
      {Array.from({ length: dots }).map((_, i) => (
        <span className={`ad${i < approved ? ' on' : ''}`} key={i} />
      ))}
      <span className="appr-meta">&nbsp;{approved} of {total}</span>
    </span>
  );
}
