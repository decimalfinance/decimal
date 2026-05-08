import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  AuthenticatedSession,
  DecimalProposal,
  SquadsProposalDecision,
  SquadsProposalPendingVoter,
} from '../types';
import { signAndSubmitIntent } from '../lib/squads-pipeline';
import { readSettlementVerificationStatus } from '../lib/settlement';
import { orbAccountUrl, shortenAddress } from '../domain';
import { useToast } from '../ui/Toast';
import {
  DecisionPill,
  PendingVoterPill,
  StatusPill,
  TypePill,
  proposalTypeLabel,
  summarizeProposal,
} from '../ui/DecimalProposalCard';

export function OrganizationProposalDetailPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId, decimalProposalId } = useParams<{
    organizationId: string;
    decimalProposalId: string;
  }>();
  const queryClient = useQueryClient();
  const { success, error: toastError, info } = useToast();
  const [busyAction, setBusyAction] = useState<'approve' | 'execute' | 'reject' | null>(null);

  // Same retryable-confirmation surface as PaymentDetail/PaymentRunDetail.
  // 400s from confirm-execution that match this regex mean the on-chain
  // execution likely landed but RPC hasn't yet caught up; we treat them
  // as a soft retryable state instead of a hard failure.
  function isRetryableConfirmationError(err: unknown): boolean {
    if (!(err instanceof ApiError) || err.status !== 400) return false;
    return /(not confirmed yet|could not be verified from RPC yet)/i.test(err.message);
  }

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
    queryKey: ['organization-proposal', organizationId, decimalProposalId] as const,
    queryFn: () => api.getOrganizationProposal(organizationId!, decimalProposalId!),
    enabled: Boolean(organizationId && decimalProposalId),
    refetchInterval: 15_000,
  });

  async function refreshAll() {
    await queryClient.invalidateQueries({
      queryKey: ['organization-proposal', organizationId, decimalProposalId],
    });
    await queryClient.invalidateQueries({
      queryKey: ['organization-proposals', organizationId],
    });
    await queryClient.invalidateQueries({
      queryKey: ['payment-orders', organizationId],
    });
  }

  const rejectMutation = useMutation({
    mutationFn: async (input: { proposal: DecimalProposal; signerWalletId: string }) => {
      const intent = await api.createProposalRejectIntent(
        organizationId!,
        input.proposal.decimalProposalId,
        { memberPersonalWalletId: input.signerWalletId },
      );
      return signAndSubmitIntent({ intent, signerPersonalWalletId: input.signerWalletId });
    },
    onSuccess: async () => {
      success('Rejection submitted.');
      await refreshAll();
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Reject failed.');
    },
    onSettled: () => setBusyAction(null),
  });

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
      await refreshAll();
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Approve failed.');
    },
    onSettled: () => setBusyAction(null),
  });

  const executeMutation = useMutation({
    mutationFn: async (input: { proposal: DecimalProposal; signerWalletId: string }) => {
      const intent = await api.createProposalExecuteIntent(
        organizationId!,
        input.proposal.decimalProposalId,
        { memberPersonalWalletId: input.signerWalletId },
      );
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: input.signerWalletId,
      });
      // Backend persists the signature whether or not settlement verification
      // succeeds, so the auto-retry effect below can re-run verification on
      // refresh without us needing to keep the signature in component state.
      // We still call confirm-execution here to drive the immediate state
      // transition; retryable errors get surfaced as an info toast instead of
      // being swallowed.
      await api.confirmProposalExecution(organizationId!, input.proposal.decimalProposalId, {
        signature: sig,
      });
      if (input.proposal.proposalType === 'config_transaction' && input.proposal.treasuryWalletId) {
        try {
          await api.syncSquadsTreasuryMembers(organizationId!, input.proposal.treasuryWalletId);
        } catch {
          // sync is best-effort — surfacing this to the user adds noise
        }
      }
      return sig;
    },
    onSuccess: async () => {
      success('Proposal executed.');
      await refreshAll();
      await queryClient.invalidateQueries({
        queryKey: ['treasury-wallet-detail', organizationId],
      });
    },
    onError: async (err) => {
      if (isRetryableConfirmationError(err)) {
        info('Execution submitted. Verification pending — will retry automatically.');
        await refreshAll();
        return;
      }
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Execute failed.');
    },
    onSettled: () => setBusyAction(null),
  });

  // Auto-retry settlement verification while the proposal has an executed
  // signature stored but RPC settlement could not yet be verified. Idempotent
  // on the backend.
  const proposalForVerify = proposalQuery.data ?? null;
  const verificationStatus = readSettlementVerificationStatus(proposalForVerify);
  useEffect(() => {
    if (!organizationId) return;
    if (!proposalForVerify?.decimalProposalId) return;
    if (!proposalForVerify.executedSignature) return;
    if (verificationStatus !== 'pending') return;
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      if (cancelled) return;
      try {
        await api.confirmProposalExecution(organizationId, proposalForVerify.decimalProposalId, {
          signature: proposalForVerify.executedSignature!,
        });
        await refreshAll();
      } catch {
        // Stay pending — next render schedules another retry.
      }
    }, 6_000);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
    // refreshAll closes over organizationId/decimalProposalId/queryClient,
    // all of which are already in the dep set or stable, so it's safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    organizationId,
    proposalForVerify?.decimalProposalId,
    proposalForVerify?.executedSignature,
    verificationStatus,
  ]);

  if (!organizationId || !decimalProposalId) {
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
    if (!proposal?.voting) return null;
    const ownAddresses = new Set(ownPersonalWallets.map((w) => w.walletAddress));
    const match = proposal.voting.pendingVoters.find(
      (v) =>
        v.personalWallet?.userId === session.user.userId
        && ownAddresses.has(v.walletAddress),
    );
    if (!match) return null;
    return ownPersonalWallets.find((w) => w.walletAddress === match.walletAddress) ?? null;
  }, [proposal, ownPersonalWallets, session.user.userId]);

  const executeWallet = useMemo(() => {
    if (!proposal?.voting) return null;
    const executable = new Set(proposal.voting.canExecuteWalletAddresses);
    return ownPersonalWallets.find((w) => executable.has(w.walletAddress)) ?? null;
  }, [proposal, ownPersonalWallets]);

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">
            <Link to={`/organizations/${organizationId}/proposals`}>← Proposals</Link>
          </p>
          <h1 style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            {proposal ? summarizeProposal(proposal) : 'Proposal'}
            {proposal ? <StatusPill status={proposal.status} /> : null}
          </h1>
          <p style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {proposal ? <TypePill label={proposalTypeLabel(proposal)} /> : null}
            {proposal?.treasuryWallet ? (
              <Link
                to={`/organizations/${organizationId}/wallets/${proposal.treasuryWallet.treasuryWalletId}`}
                style={{ color: 'inherit', textDecoration: 'underline', textDecorationColor: 'rgba(255,255,255,0.25)' }}
              >
                {proposal.treasuryWallet.displayName ?? 'Treasury'}
              </Link>
            ) : null}
            {proposal?.squads.transactionIndex ? (
              <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                · #{proposal.squads.transactionIndex}
              </span>
            ) : null}
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
              You're not a signer on the treasury this proposal targets, so its detail isn't visible to you.
            </p>
          </div>
        </section>
      ) : isMissing ? (
        <section className="rd-section">
          <div className="rd-empty-cell" style={{ padding: '48px 24px' }}>
            <strong>Proposal not found</strong>
            <p style={{ margin: 0 }}>The proposal record doesn't exist.</p>
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
          onReject={(signerWalletId) => {
            if (
              !window.confirm(
                'Reject this proposal? This casts an on-chain rejection vote and cannot be undone.',
              )
            ) {
              return;
            }
            setBusyAction('reject');
            rejectMutation.mutate({ proposal, signerWalletId });
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
  onReject,
  onExecute,
}: {
  proposal: DecimalProposal;
  pendingVoterWallet: { userWalletId: string; walletAddress: string } | null;
  executeWallet: { userWalletId: string; walletAddress: string } | null;
  busy: 'approve' | 'execute' | 'reject' | null;
  onApprove: (signerWalletId: string) => void;
  onReject: (signerWalletId: string) => void;
  onExecute: (signerWalletId: string) => void;
}) {
  const isReadyToExecute = proposal.status === 'approved';
  const isClosed =
    proposal.status === 'executed'
    || proposal.status === 'cancelled'
    || proposal.status === 'rejected';
  // Squads' proposalApprove / proposalReject only accept proposals in
  // status === 'active'. Once threshold is met or the proposal moves on,
  // late voters cannot change the outcome — hide the action even if
  // pendingVoters still lists them.
  const canCastVote = pendingVoterWallet !== null && proposal.status === 'active';
  const voting = proposal.voting;

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
                {canCastVote
                  ? 'Your signature is needed'
                  : isReadyToExecute && executeWallet
                    ? 'Threshold met — you can execute'
                    : isReadyToExecute
                      ? 'Threshold met — awaiting execute'
                      : 'Awaiting other signers'}
              </strong>
              <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 4 }}>
                {canCastVote && pendingVoterWallet
                  ? `Approve as ${shortenAddress(pendingVoterWallet.walletAddress, 4, 4)}`
                  : isReadyToExecute && executeWallet
                    ? `Execute as ${shortenAddress(executeWallet.walletAddress, 4, 4)}`
                    : isReadyToExecute
                      ? 'A member with execute permission needs to submit the execute transaction.'
                      : voting
                        ? `${voting.threshold - voting.approvals.length} more approval${voting.threshold - voting.approvals.length === 1 ? '' : 's'} required.`
                        : 'Voting state not yet available.'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {pendingVoterWallet && proposal.status === 'active' ? (
                <>
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => onApprove(pendingVoterWallet.userWalletId)}
                    disabled={busy !== null}
                    aria-busy={busy === 'approve'}
                  >
                    {busy === 'approve' ? 'Approving…' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => onReject(pendingVoterWallet.userWalletId)}
                    disabled={busy !== null}
                    aria-busy={busy === 'reject'}
                    style={{
                      color: 'rgb(240, 130, 130)',
                      borderColor: 'rgba(220, 80, 80, 0.45)',
                    }}
                  >
                    {busy === 'reject' ? 'Rejecting…' : 'Reject'}
                  </button>
                </>
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

      <SettlementVerificationBanner proposal={proposal} />

      {proposal.semanticType === 'send_payment' ? (
        <PaymentSummary proposal={proposal} />
      ) : proposal.semanticType === 'send_payment_run' ? (
        <PaymentRunSummary proposal={proposal} />
      ) : (
        <SemanticSummary proposal={proposal} />
      )}

      <section className="rd-section" style={{ marginTop: 24 }}>
        <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Approvals</h2>
          {voting ? (
            <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
              {voting.approvals.length} of {voting.threshold} required
            </span>
          ) : null}
        </header>
        {voting ? (
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
                  ...voting.approvals.map((d) => ({ kind: 'approval' as const, decision: d })),
                  ...voting.rejections.map((d) => ({ kind: 'rejection' as const, decision: d })),
                  ...voting.cancellations.map((d) => ({ kind: 'cancellation' as const, decision: d })),
                ].map(({ kind, decision }) => (
                  <DecisionRow key={`${kind}-${decision.walletAddress}`} kind={kind} decision={decision} />
                ))}
                {voting.pendingVoters.map((voter) => (
                  <PendingRow key={`pending-${voter.walletAddress}`} voter={voter} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rd-empty-cell" style={{ padding: '24px' }}>
            Voting state not yet available.
          </div>
        )}
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
          {proposal.squads.proposalPda ? (
            <InfoRow label="Proposal account">
              <ChainLink address={proposal.squads.proposalPda} />
            </InfoRow>
          ) : null}
          {proposal.squads.transactionPda ? (
            <InfoRow label="Squads transaction">
              <ChainLink address={proposal.squads.transactionPda} />
            </InfoRow>
          ) : null}
          {proposal.squads.multisigPda ? (
            <InfoRow label="Multisig">
              <ChainLink address={proposal.squads.multisigPda} />
            </InfoRow>
          ) : null}
          {proposal.squads.transactionIndex ? (
            <InfoRow label="Tx index">{proposal.squads.transactionIndex}</InfoRow>
          ) : null}
          <InfoRow label="Proposal type">{proposal.proposalType}</InfoRow>
          <InfoRow label="Local status">{proposal.localStatus}</InfoRow>
          {proposal.submittedSignature ? (
            <InfoRow label="Submitted sig">
              <ChainLink address={proposal.submittedSignature} />
            </InfoRow>
          ) : null}
          {proposal.executedSignature ? (
            <InfoRow label="Executed sig">
              <ChainLink address={proposal.executedSignature} />
            </InfoRow>
          ) : null}
          {proposal.createdAt ? (
            <InfoRow label="Created">{new Date(proposal.createdAt).toLocaleString()}</InfoRow>
          ) : null}
        </div>
      </section>
    </>
  );
}

function SettlementVerificationBanner({ proposal }: { proposal: DecimalProposal }) {
  const isPayment = proposal.semanticType === 'send_payment' || proposal.semanticType === 'send_payment_run';
  const status = readSettlementVerificationStatus(proposal);
  // Don't render anything before execution lands or for non-payment proposals.
  if (!isPayment) return null;
  if (!proposal.executedSignature) return null;
  if (status === 'settled' || status === null) return null;

  if (status === 'pending') {
    return (
      <section
        className="rd-section"
        style={{
          marginTop: 16,
          padding: 14,
          border: '1px solid rgba(220, 180, 80, 0.45)',
          background: 'rgba(220, 180, 80, 0.08)',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span aria-hidden style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: 'rgb(220, 180, 80)' }} />
        <div>
          <strong style={{ fontSize: 13 }}>Settlement verification pending</strong>
          <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 4 }}>
            On-chain execution landed but RPC hasn't returned the parsed transaction yet. Verifying USDC deltas will retry automatically.
          </div>
        </div>
      </section>
    );
  }

  if (status === 'mismatch') {
    return (
      <section
        className="rd-section"
        style={{
          marginTop: 16,
          padding: 14,
          border: '1px solid rgba(220, 80, 80, 0.45)',
          background: 'rgba(220, 80, 80, 0.08)',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span aria-hidden style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: 'rgb(240, 90, 90)' }} />
        <div>
          <strong style={{ fontSize: 13 }}>Settlement deltas did not match</strong>
          <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 4 }}>
            The execution transaction landed but the observed USDC transfers don't match what this proposal expected. Investigate before treating these payments as settled.
          </div>
        </div>
      </section>
    );
  }

  return null;
}

function PaymentSummary({ proposal }: { proposal: DecimalProposal }) {
  const payload = proposal.semanticPayloadJson as {
    amountRaw?: string;
    asset?: string;
    destinationWalletAddress?: string;
    destinationTokenAccountAddress?: string;
    sourceWalletAddress?: string;
    token?: { symbol?: string; mint?: string; decimals?: number };
    reference?: string | null;
    memo?: string | null;
  };
  const order = proposal.paymentOrder;
  return (
    <section className="rd-section" style={{ marginTop: 16 }}>
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Payment details</h2>
      </header>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '14px 24px',
        }}
      >
        <InfoRow label="Amount">
          {payload?.amountRaw ? (
            <span>
              {formatRawAmount(payload.amountRaw, payload.token?.decimals ?? 6)}{' '}
              {payload.token?.symbol ?? payload.asset?.toUpperCase() ?? ''}
            </span>
          ) : (
            '—'
          )}
        </InfoRow>
        {payload?.destinationWalletAddress ? (
          <InfoRow label="Destination">
            <ChainLink address={payload.destinationWalletAddress} />
            {order?.destination?.label ? (
              <div style={{ fontSize: 11, opacity: 0.7 }}>{order.destination.label}</div>
            ) : null}
          </InfoRow>
        ) : null}
        {payload?.sourceWalletAddress ? (
          <InfoRow label="Source vault">
            <ChainLink address={payload.sourceWalletAddress} />
          </InfoRow>
        ) : null}
        {order ? (
          <InfoRow label="Payment order">
            <Link
              to={`/organizations/${proposal.organizationId}/payments/${order.paymentOrderId}`}
              style={{ color: 'inherit', textDecoration: 'underline', textDecorationColor: 'rgba(255,255,255,0.25)' }}
            >
              {order.invoiceNumber ?? order.externalReference ?? shortenAddress(order.paymentOrderId, 4, 4)}
            </Link>
          </InfoRow>
        ) : null}
        {payload?.reference ? <InfoRow label="Reference">{payload.reference}</InfoRow> : null}
        {payload?.memo ? <InfoRow label="Memo">{payload.memo}</InfoRow> : null}
      </div>
    </section>
  );
}

function PaymentRunSummary({ proposal }: { proposal: DecimalProposal }) {
  const payload = proposal.semanticPayloadJson as {
    paymentRunId?: string;
    runName?: string;
    sourceWalletAddress?: string;
    sourceTokenAccountAddress?: string;
    totalAmountRaw?: string;
    orderCount?: number;
    asset?: string;
    orders?: Array<{
      index: number;
      paymentOrderId: string;
      destinationId: string;
      destinationWalletAddress: string;
      destinationTokenAccountAddress: string;
      amountRaw: string;
      asset: string;
      reference: string | null;
      memo: string | null;
    }>;
  };
  const orders = payload?.orders ?? [];
  const totalDecimals = 6; // USDC for now
  const symbol = (payload?.asset ?? 'usdc').toUpperCase();

  return (
    <>
      <section className="rd-section" style={{ marginTop: 16 }}>
        <header style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Batch summary</h2>
        </header>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '14px 24px',
          }}
        >
          {payload?.runName ? (
            <InfoRow label="Run">
              {payload.paymentRunId ? (
                <Link
                  to={`/organizations/${proposal.organizationId}/runs/${payload.paymentRunId}`}
                  style={{ color: 'inherit', textDecoration: 'underline', textDecorationColor: 'rgba(255,255,255,0.25)' }}
                >
                  {payload.runName}
                </Link>
              ) : (
                payload.runName
              )}
            </InfoRow>
          ) : null}
          {payload?.totalAmountRaw ? (
            <InfoRow label="Total amount">
              <span>
                {formatRawAmount(payload.totalAmountRaw, totalDecimals)} {symbol}
              </span>
            </InfoRow>
          ) : null}
          <InfoRow label="Rows">{payload?.orderCount ?? orders.length}</InfoRow>
          {payload?.sourceWalletAddress ? (
            <InfoRow label="Source vault">
              <ChainLink address={payload.sourceWalletAddress} />
            </InfoRow>
          ) : null}
        </div>
      </section>
      {orders.length > 0 ? (
        <section className="rd-section" style={{ marginTop: 16 }}>
          <header style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Rows ({orders.length})</h2>
          </header>
          <div className="rd-table-shell">
            <table className="rd-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Destination</th>
                  <th className="rd-num">Amount</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((row) => (
                  <tr
                    key={row.paymentOrderId}
                    onClick={() => {
                      window.location.href = `/organizations/${proposal.organizationId}/payments/${row.paymentOrderId}`;
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={{ color: 'var(--ax-text-muted)', fontSize: 12 }}>{row.index + 1}</td>
                    <td>
                      <a
                        href={orbAccountUrl(row.destinationWalletAddress)}
                        target="_blank"
                        rel="noreferrer"
                        className="rd-addr-link"
                        title={row.destinationWalletAddress}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {shortenAddress(row.destinationWalletAddress, 4, 4)}
                      </a>
                    </td>
                    <td className="rd-num">
                      {formatRawAmount(row.amountRaw, totalDecimals)} {row.asset.toUpperCase()}
                    </td>
                    <td>
                      <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                        {row.reference ?? row.memo ?? '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}

function SemanticSummary({ proposal }: { proposal: DecimalProposal }) {
  const semantic = proposal.semanticType ?? '';
  const payload = proposal.semanticPayloadJson as Record<string, unknown>;

  if (semantic === 'add_member') {
    const walletAddress = (payload.walletAddress as string | undefined) ?? null;
    const permissions = (payload.permissions as string[] | undefined) ?? [];
    const newThreshold = payload.newThreshold as number | undefined;
    return (
      <section className="rd-section" style={{ marginTop: 16 }}>
        <header style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Action: Add member</h2>
        </header>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '14px 24px',
          }}
        >
          {walletAddress ? (
            <InfoRow label="New member">
              <ChainLink address={walletAddress} />
            </InfoRow>
          ) : null}
          <InfoRow label="Permissions">
            {permissions.length ? permissions.join(' / ') : '—'}
          </InfoRow>
          {newThreshold !== undefined ? (
            <InfoRow label="Threshold (after)">{newThreshold}</InfoRow>
          ) : null}
        </div>
      </section>
    );
  }

  if (semantic === 'change_threshold') {
    const newThreshold = payload.newThreshold as number | undefined;
    return (
      <section className="rd-section" style={{ marginTop: 16 }}>
        <header style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Action: Change threshold</h2>
        </header>
        <div style={{ fontSize: 14 }}>
          New threshold: <strong>{newThreshold ?? '—'}</strong>
        </div>
      </section>
    );
  }

  return null;
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

function formatRawAmount(amountRaw: string | null, decimals: number): string {
  if (!amountRaw) return '?';
  try {
    const value = BigInt(amountRaw);
    if (decimals === 0) return value.toString();
    const scale = 10n ** BigInt(decimals);
    const whole = value / scale;
    const frac = value % scale;
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  } catch {
    return amountRaw;
  }
}
