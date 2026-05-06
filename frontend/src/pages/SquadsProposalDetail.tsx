import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  AuthenticatedSession,
  SquadsConfigProposal,
  SquadsProposalDecision,
  SquadsProposalPendingVoter,
  TreasuryWallet,
} from '../types';
import { signAndSubmitIntent } from '../lib/squads-pipeline';
import { orbAccountUrl, shortenAddress } from '../domain';
import { useToast } from '../ui/Toast';
import {
  ActionsSummary,
  DecisionPill,
  PendingVoterPill,
  StatusPill,
  summarizeActions,
} from '../ui/SquadsProposalCard';

export function SquadsProposalDetailPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId, treasuryWalletId, transactionIndex } = useParams<{
    organizationId: string;
    treasuryWalletId: string;
    transactionIndex: string;
  }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [busyAction, setBusyAction] = useState<'approve' | 'execute' | null>(null);

  const treasuryListQuery = useQuery({
    queryKey: ['treasury-wallets', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });
  const wallet: TreasuryWallet | undefined = useMemo(
    () => treasuryListQuery.data?.items.find((w) => w.treasuryWalletId === treasuryWalletId),
    [treasuryListQuery.data, treasuryWalletId],
  );

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

  const proposalQuery = useQuery({
    queryKey: [
      'squads-config-proposal',
      organizationId,
      treasuryWalletId,
      transactionIndex,
    ] as const,
    queryFn: () =>
      api.getSquadsConfigProposal(organizationId!, treasuryWalletId!, transactionIndex!),
    enabled: Boolean(organizationId && treasuryWalletId && transactionIndex),
    refetchInterval: 15_000,
  });

  async function refreshAll() {
    await queryClient.invalidateQueries({
      queryKey: [
        'squads-config-proposal',
        organizationId,
        treasuryWalletId,
        transactionIndex,
      ],
    });
    await queryClient.invalidateQueries({
      queryKey: ['squads-config-proposals', organizationId, treasuryWalletId],
    });
    await queryClient.invalidateQueries({
      queryKey: ['organization-squads-proposals', organizationId],
    });
    await queryClient.invalidateQueries({
      queryKey: ['treasury-wallet-detail', organizationId, treasuryWalletId],
    });
  }

  const approveMutation = useMutation({
    mutationFn: async (input: { proposal: SquadsConfigProposal; signerWalletId: string }) => {
      const intent = await api.createSquadsConfigProposalApprovalIntent(
        organizationId!,
        treasuryWalletId!,
        input.proposal.transactionIndex,
        { memberPersonalWalletId: input.signerWalletId },
      );
      return signAndSubmitIntent({ intent, signerPersonalWalletId: input.signerWalletId });
    },
    onSuccess: async () => {
      success('Approval submitted.');
      await refreshAll();
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Approve failed.');
    },
    onSettled: () => setBusyAction(null),
  });

  const executeMutation = useMutation({
    mutationFn: async (input: { proposal: SquadsConfigProposal; signerWalletId: string }) => {
      const intent = await api.createSquadsConfigProposalExecuteIntent(
        organizationId!,
        treasuryWalletId!,
        input.proposal.transactionIndex,
        { memberPersonalWalletId: input.signerWalletId },
      );
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: input.signerWalletId,
      });
      try {
        await api.syncSquadsTreasuryMembers(organizationId!, treasuryWalletId!);
      } catch {
        // ignore — sync is recoverable from the treasury detail page
      }
      return sig;
    },
    onSuccess: async () => {
      success('Proposal executed and synced.');
      await refreshAll();
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Execute failed.');
    },
    onSettled: () => setBusyAction(null),
  });

  if (!organizationId || !treasuryWalletId || !transactionIndex) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Proposal unavailable</h2>
          <p className="rd-state-body">Missing route parameters.</p>
        </div>
      </main>
    );
  }

  const proposal = proposalQuery.data;
  const proposalError = proposalQuery.error;
  const isForbidden =
    proposalError instanceof ApiError && proposalError.code === 'not_squads_member';
  const isMissing = proposalError instanceof ApiError && proposalError.status === 404;

  const pendingVoterWallet = useMemo(() => {
    if (!proposal) return null;
    const ownAddresses = new Set(ownPersonalWallets.map((w) => w.walletAddress));
    const match = proposal.pendingVoters.find(
      (v) =>
        v.personalWallet?.userId === session.user.userId
        && ownAddresses.has(v.walletAddress),
    );
    if (!match) return null;
    return ownPersonalWallets.find((w) => w.walletAddress === match.walletAddress) ?? null;
  }, [proposal, ownPersonalWallets, session.user.userId]);

  const executeWallet = useMemo(() => {
    if (!proposal) return null;
    const executable = new Set(proposal.canExecuteWalletAddresses);
    return ownPersonalWallets.find((w) => executable.has(w.walletAddress)) ?? null;
  }, [proposal, ownPersonalWallets]);

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">
            <Link
              to={`/organizations/${organizationId}/wallets/${treasuryWalletId}/proposals`}
            >
              ← Proposals · {wallet?.displayName || 'Treasury wallet'}
            </Link>
          </p>
          <h1 style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            {proposal ? summarizeActions(proposal.actions) : `Proposal #${transactionIndex}`}
            {proposal ? <StatusPill status={proposal.status} /> : null}
          </h1>
          <p>
            On-chain Squads config proposal #{transactionIndex} on{' '}
            <strong>{wallet?.displayName ?? 'this treasury'}</strong>.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => proposalQuery.refetch()}
            disabled={proposalQuery.isFetching}
            aria-busy={proposalQuery.isFetching}
          >
            {proposalQuery.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {isForbidden ? (
        <section className="rd-section">
          <div className="rd-empty-cell" style={{ padding: '48px 24px' }}>
            <strong>Not a Squads member</strong>
            <p style={{ margin: 0 }}>
              You're not a signer on this Squads treasury, so this proposal isn't
              visible to you.
            </p>
          </div>
        </section>
      ) : isMissing ? (
        <section className="rd-section">
          <div className="rd-empty-cell" style={{ padding: '48px 24px' }}>
            <strong>Proposal not found</strong>
            <p style={{ margin: 0 }}>
              The proposal account doesn't exist on chain. It may have been cancelled
              and cleaned up.
            </p>
          </div>
        </section>
      ) : proposalQuery.isLoading ? (
        <section className="rd-section">
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 80, marginBottom: 8 }} />
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 200 }} />
        </section>
      ) : proposalError ? (
        <section className="rd-section">
          <div className="rd-empty-cell" style={{ padding: '48px 24px' }}>
            <strong>Couldn't load proposal</strong>
            <p style={{ margin: 0 }}>
              {proposalError instanceof Error ? proposalError.message : 'Unknown error.'}
            </p>
          </div>
        </section>
      ) : proposal ? (
        <ProposalDetailBody
          proposal={proposal}
          pendingVoterWallet={pendingVoterWallet}
          executeWallet={executeWallet}
          busy={busyAction}
          onApprove={(signerWalletId) => {
            setBusyAction('approve');
            approveMutation.mutate({ proposal, signerWalletId });
          }}
          onExecute={(signerWalletId) => {
            setBusyAction('execute');
            executeMutation.mutate({ proposal, signerWalletId });
          }}
        />
      ) : null}
    </main>
  );
}

function ProposalDetailBody({
  proposal,
  pendingVoterWallet,
  executeWallet,
  busy,
  onApprove,
  onExecute,
}: {
  proposal: SquadsConfigProposal;
  pendingVoterWallet: { userWalletId: string; walletAddress: string } | null;
  executeWallet: { userWalletId: string; walletAddress: string } | null;
  busy: 'approve' | 'execute' | null;
  onApprove: (signerWalletId: string) => void;
  onExecute: (signerWalletId: string) => void;
}) {
  const isReadyToExecute = proposal.status === 'approved';
  const isClosed =
    proposal.status === 'executed'
    || proposal.status === 'cancelled'
    || proposal.status === 'rejected';

  return (
    <>
      {!isClosed ? (
        <section
          className="rd-section"
          style={{ marginTop: 8, padding: 16, border: '1px solid var(--ax-border)', borderRadius: 12 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <strong style={{ fontSize: 14 }}>
                {pendingVoterWallet
                  ? 'Your signature is needed'
                  : isReadyToExecute && executeWallet
                    ? 'Threshold met — you can execute'
                    : isReadyToExecute
                      ? 'Threshold met — awaiting execute'
                      : 'Awaiting other signers'}
              </strong>
              <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 4 }}>
                {pendingVoterWallet
                  ? `Approve as ${shortenAddress(pendingVoterWallet.walletAddress, 4, 4)}`
                  : isReadyToExecute && executeWallet
                    ? `Execute as ${shortenAddress(executeWallet.walletAddress, 4, 4)}`
                    : isReadyToExecute
                      ? 'A member with execute permission needs to submit the execute transaction.'
                      : `${proposal.threshold - proposal.approvals.length} more approval${proposal.threshold - proposal.approvals.length === 1 ? '' : 's'} required.`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {pendingVoterWallet ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => onApprove(pendingVoterWallet.userWalletId)}
                  disabled={busy !== null}
                  aria-busy={busy === 'approve'}
                >
                  {busy === 'approve' ? 'Approving…' : 'Approve'}
                </button>
              ) : null}
              {isReadyToExecute && executeWallet ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => onExecute(executeWallet.userWalletId)}
                  disabled={busy !== null}
                  aria-busy={busy === 'execute'}
                >
                  {busy === 'execute' ? 'Executing…' : 'Execute proposal'}
                </button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <section className="rd-section" style={{ marginTop: 16 }}>
        <header style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Actions</h2>
        </header>
        <ActionsSummary actions={proposal.actions} />
      </section>

      <section className="rd-section" style={{ marginTop: 24 }}>
        <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Approvals</h2>
          <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
            {proposal.approvals.length} of {proposal.threshold} required
          </span>
        </header>
        <div className="rd-table-shell">
          <table className="rd-table">
            <thead>
              <tr>
                <th>Voter</th>
                <th>Wallet</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...proposal.approvals.map((d) => ({ kind: 'approval' as const, decision: d })),
                ...proposal.rejections.map((d) => ({ kind: 'rejection' as const, decision: d })),
                ...proposal.cancellations.map((d) => ({ kind: 'cancellation' as const, decision: d })),
              ].map(({ kind, decision }) => (
                <DecisionRow key={`${kind}-${decision.walletAddress}`} kind={kind} decision={decision} />
              ))}
              {proposal.pendingVoters.map((voter) => (
                <PendingRow key={`pending-${voter.walletAddress}`} voter={voter} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rd-section" style={{ marginTop: 24 }}>
        <header style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>On-chain</h2>
        </header>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '14px 24px',
          }}
        >
          <InfoRow label="Proposal account">
            <ChainLink address={proposal.proposalPda} />
          </InfoRow>
          <InfoRow label="Config transaction">
            <ChainLink address={proposal.configTransactionPda} />
          </InfoRow>
          <InfoRow label="Tx index">{proposal.transactionIndex}</InfoRow>
          <InfoRow label="Stale tx index">{proposal.staleTransactionIndex}</InfoRow>
          <InfoRow label="Threshold (snapshot)">{proposal.threshold}</InfoRow>
          <InfoRow label="Status">{proposal.status}</InfoRow>
        </div>
      </section>
    </>
  );
}

function DecisionRow({
  kind,
  decision,
}: {
  kind: 'approval' | 'rejection' | 'cancellation';
  decision: SquadsProposalDecision;
}) {
  const name = decision.organizationMembership?.user.displayName
    ?? decision.organizationMembership?.user.email
    ?? '—';
  const email = decision.organizationMembership?.user.email ?? null;
  return (
    <tr>
      <td>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontWeight: 500 }}>{name}</span>
          {email && email !== name ? (
            <span style={{ fontSize: 11, color: 'var(--ax-text-muted)' }}>{email}</span>
          ) : null}
        </div>
      </td>
      <td>
        <a
          href={orbAccountUrl(decision.walletAddress)}
          target="_blank"
          rel="noreferrer"
          className="rd-addr-link"
          title={decision.walletAddress}
        >
          {shortenAddress(decision.walletAddress, 4, 4)}
        </a>
      </td>
      <td>
        <DecisionPill kind={kind} decision={decision} />
      </td>
    </tr>
  );
}

function PendingRow({ voter }: { voter: SquadsProposalPendingVoter }) {
  const name = voter.organizationMembership?.user.displayName
    ?? voter.organizationMembership?.user.email
    ?? '—';
  const email = voter.organizationMembership?.user.email ?? null;
  return (
    <tr>
      <td>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontWeight: 500 }}>{name}</span>
          {email && email !== name ? (
            <span style={{ fontSize: 11, color: 'var(--ax-text-muted)' }}>{email}</span>
          ) : null}
        </div>
      </td>
      <td>
        <a
          href={orbAccountUrl(voter.walletAddress)}
          target="_blank"
          rel="noreferrer"
          className="rd-addr-link"
          title={voter.walletAddress}
        >
          {shortenAddress(voter.walletAddress, 4, 4)}
        </a>
      </td>
      <td>
        <PendingVoterPill voter={voter} />
      </td>
    </tr>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          opacity: 0.6,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 14 }}>{children}</span>
    </div>
  );
}

function ChainLink({ address }: { address: string }) {
  return (
    <a
      href={orbAccountUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="rd-addr-link"
      title={address}
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
    >
      {shortenAddress(address, 6, 6)}
    </a>
  );
}
