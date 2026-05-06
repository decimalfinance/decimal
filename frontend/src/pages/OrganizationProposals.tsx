import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  AuthenticatedSession,
  SquadsConfigProposalWithTreasury,
  SquadsProposalListStatusFilter,
} from '../types';
import { signAndSubmitIntent } from '../lib/squads-pipeline';
import { useToast } from '../ui/Toast';
import { ProposalCard } from '../ui/SquadsProposalCard';

type BusyKey = string; // `${treasuryWalletId}:${transactionIndex}`

export function OrganizationProposalsPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const [statusFilter, setStatusFilter] = useState<SquadsProposalListStatusFilter>('pending');
  const [busyKey, setBusyKey] = useState<BusyKey | null>(null);
  const [busyAction, setBusyAction] = useState<'approve' | 'execute' | null>(null);

  const ownPersonalWalletsQuery = useQuery({
    queryKey: ['personal-wallets'] as const,
    queryFn: () => api.listPersonalWallets(),
    enabled: Boolean(organizationId),
  });
  const ownPersonalWallets = useMemo(
    () =>
      (ownPersonalWalletsQuery.data?.items ?? []).filter(
        (w) => w.status === 'active' && w.chain === 'solana',
      ),
    [ownPersonalWalletsQuery.data],
  );

  const proposalsQuery = useQuery({
    queryKey: ['organization-squads-proposals', organizationId, statusFilter] as const,
    queryFn: () =>
      api.listOrganizationSquadsProposals(organizationId!, { status: statusFilter }),
    enabled: Boolean(organizationId),
    refetchInterval: 20_000,
  });

  async function refreshProposals(treasuryWalletId?: string) {
    await queryClient.invalidateQueries({
      queryKey: ['organization-squads-proposals', organizationId],
    });
    if (treasuryWalletId) {
      await queryClient.invalidateQueries({
        queryKey: ['squads-config-proposals', organizationId, treasuryWalletId],
      });
      await queryClient.invalidateQueries({
        queryKey: ['treasury-wallet-detail', organizationId, treasuryWalletId],
      });
    }
  }

  const approveMutation = useMutation({
    mutationFn: async (input: {
      proposal: SquadsConfigProposalWithTreasury;
      signerWalletId: string;
    }) => {
      const intent = await api.createSquadsConfigProposalApprovalIntent(
        organizationId!,
        input.proposal.treasuryWallet.treasuryWalletId,
        input.proposal.transactionIndex,
        { memberPersonalWalletId: input.signerWalletId },
      );
      return signAndSubmitIntent({ intent, signerPersonalWalletId: input.signerWalletId });
    },
    onSuccess: async (_sig, vars) => {
      success('Approval submitted.');
      await refreshProposals(vars.proposal.treasuryWallet.treasuryWalletId);
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Approve failed.');
    },
    onSettled: () => {
      setBusyKey(null);
      setBusyAction(null);
    },
  });

  const executeMutation = useMutation({
    mutationFn: async (input: {
      proposal: SquadsConfigProposalWithTreasury;
      signerWalletId: string;
    }) => {
      const treasuryWalletId = input.proposal.treasuryWallet.treasuryWalletId;
      const intent = await api.createSquadsConfigProposalExecuteIntent(
        organizationId!,
        treasuryWalletId,
        input.proposal.transactionIndex,
        { memberPersonalWalletId: input.signerWalletId },
      );
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: input.signerWalletId,
      });
      try {
        await api.syncSquadsTreasuryMembers(organizationId!, treasuryWalletId);
      } catch {
        // ignore — sync failure is recoverable from the treasury detail page
      }
      return sig;
    },
    onSuccess: async (_sig, vars) => {
      success('Proposal executed and synced.');
      await refreshProposals(vars.proposal.treasuryWallet.treasuryWalletId);
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Execute failed.');
    },
    onSettled: () => {
      setBusyKey(null);
      setBusyAction(null);
    },
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

  const items = proposalsQuery.data?.items ?? [];

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Squads proposals</h1>
          <p>
            Config proposals across every Squads treasury you sign for in this
            organization. Approve and execute from here, or open a proposal for
            the full detail.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => proposalsQuery.refetch()}
            disabled={proposalsQuery.isFetching}
            aria-busy={proposalsQuery.isFetching}
          >
            {proposalsQuery.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['pending', 'all', 'closed'] as SquadsProposalListStatusFilter[]).map((filter) => {
          const active = statusFilter === filter;
          return (
            <button
              key={filter}
              type="button"
              onClick={() => setStatusFilter(filter)}
              style={{
                padding: '6px 14px',
                fontSize: 13,
                borderRadius: 999,
                border: '1px solid var(--ax-border)',
                background: active ? 'var(--ax-accent-dim)' : 'transparent',
                color: active ? 'var(--ax-accent)' : 'var(--ax-text-muted)',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {filter}
            </button>
          );
        })}
      </div>

      {proposalsQuery.isLoading ? (
        <section className="rd-section">
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 140, marginBottom: 8 }} />
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 140 }} />
        </section>
      ) : proposalsQuery.error ? (
        <section className="rd-section">
          <div className="rd-empty-cell" style={{ padding: '48px 24px' }}>
            <strong>Couldn't load proposals</strong>
            <p style={{ margin: 0 }}>
              {proposalsQuery.error instanceof Error
                ? proposalsQuery.error.message
                : 'Unknown error.'}
            </p>
          </div>
        </section>
      ) : items.length === 0 ? (
        <section className="rd-section">
          <div className="rd-empty-cell" style={{ padding: '48px 24px' }}>
            <strong>No {statusFilter === 'all' ? '' : statusFilter} proposals</strong>
            <p style={{ margin: 0 }}>
              {statusFilter === 'pending'
                ? "When a proposal needs your signature, it'll show up here."
                : 'Nothing matches this filter.'}
            </p>
          </div>
        </section>
      ) : (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((proposal) => {
            const key: BusyKey = `${proposal.treasuryWallet.treasuryWalletId}:${proposal.transactionIndex}`;
            const treasuryName = proposal.treasuryWallet.displayName || 'Untitled Squads treasury';
            return (
              <ProposalCard
                key={key}
                proposal={proposal}
                ownPersonalWallets={ownPersonalWallets}
                currentUserId={session.user.userId}
                busy={busyKey === key ? busyAction : null}
                treasuryLabel={treasuryName}
                treasuryLinkTo={`/organizations/${organizationId}/wallets/${proposal.treasuryWallet.treasuryWalletId}`}
                detailLinkTo={`/organizations/${organizationId}/wallets/${proposal.treasuryWallet.treasuryWalletId}/proposals/${proposal.transactionIndex}`}
                onApprove={(signerWalletId) => {
                  setBusyKey(key);
                  setBusyAction('approve');
                  approveMutation.mutate({ proposal, signerWalletId });
                }}
                onExecute={(signerWalletId) => {
                  setBusyKey(key);
                  setBusyAction('execute');
                  executeMutation.mutate({ proposal, signerWalletId });
                }}
              />
            );
          })}
        </section>
      )}
    </main>
  );
}
