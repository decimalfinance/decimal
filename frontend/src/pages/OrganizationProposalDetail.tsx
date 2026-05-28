import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  AuthenticatedSession,
  DecimalProposal,
  SquadsProposalDecision,
  SquadsProposalPendingVoter,
} from '../types';
import { useAutoRetryProposalVerification } from '../lib/settlement';
import { useSquadsProposalActions, type SquadsProposalActionTarget } from '../lib/squads-actions';
import { shortenAddress } from '../domain';
import { ChainLink, InfoRow } from '../ui-primitives';
import { SettlementBanner } from '../ui/SettlementBanner';
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
  const toast = useToast();

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

  const actions = useSquadsProposalActions({
    organizationId,
    proposal: proposalQuery.data,
    ownPersonalWallets,
    currentUserId: session.user.userId,
    invalidationKeys: [
      ['organization-proposal', organizationId, decimalProposalId],
      ['organization-proposals', organizationId],
      ['payment-orders', organizationId],
      ['treasury-wallet-detail', organizationId],
    ],
    toast: { success: toast.success, error: toast.error, info: toast.info },
    syncTreasuryMembersOnConfigExecute: true,
  });

  useAutoRetryProposalVerification({
    organizationId,
    proposal: proposalQuery.data,
    invalidationKeys: [
      ['organization-proposal', organizationId, decimalProposalId],
      ['organization-proposals', organizationId],
      ['payment-orders', organizationId],
    ],
  });

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
        <ProposalDetailBody proposal={proposal} actions={actions} />
      ) : null}
    </main>
  );
}

function ProposalDetailBody({
  proposal,
  actions,
}: {
  proposal: DecimalProposal;
  actions: SquadsProposalActionTarget;
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
  const { pendingVoterWallet, executeWallet, busy, approving, rejecting, executing } = actions;
  const canCastVote = pendingVoterWallet !== null && proposal.status === 'active';
  const voting = proposal.voting;

  function handleReject(signerWalletId: string) {
    if (!window.confirm(
      'Reject this proposal? This casts an on-chain rejection vote and cannot be undone.',
    )) return;
    actions.reject(signerWalletId);
  }

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
                    onClick={() => actions.approve(pendingVoterWallet.userWalletId)}
                    disabled={busy}
                    aria-busy={approving}
                  >
                    {approving ? 'Approving…' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => handleReject(pendingVoterWallet.userWalletId)}
                    disabled={busy}
                    aria-busy={rejecting}
                    style={{
                      color: 'rgb(240, 130, 130)',
                      borderColor: 'rgba(220, 80, 80, 0.45)',
                    }}
                  >
                    {rejecting ? 'Rejecting…' : 'Reject'}
                  </button>
                </>
              ) : null}
              {isReadyToExecute && executeWallet ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => actions.execute(executeWallet.userWalletId)}
                  disabled={busy}
                  aria-busy={executing}
                >
                  {executing ? 'Executing…' : 'Execute proposal'}
                </button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <SettlementBanner proposal={proposal} />

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
            <InfoRow label={<LabelWithInfo label="Proposal account" info="The Squads proposal PDA — the on-chain account that records this proposal and tracks each member's approve/reject vote." />}>
              <ChainLink address={proposal.squads.proposalPda} />
            </InfoRow>
          ) : null}
          {proposal.squads.transactionPda ? (
            <InfoRow label={<LabelWithInfo label="Squads transaction" info="The Squads transaction PDA — holds the actual instructions (e.g. USDC transfer) that will run if this proposal is approved and executed." />}>
              <ChainLink address={proposal.squads.transactionPda} />
            </InfoRow>
          ) : null}
          {proposal.squads.multisigPda ? (
            <InfoRow label={<LabelWithInfo label="Multisig" info="The Squads multisig PDA — the governance account that defines the members and the approval threshold. Owns the source vault." />}>
              <ChainLink address={proposal.squads.multisigPda} />
            </InfoRow>
          ) : null}
          {proposal.squads.transactionIndex ? (
            <InfoRow label={<LabelWithInfo label="Tx index" info="Sequence number of this transaction within the multisig. Squads transactions execute in order — gaps block later transactions." />}>{proposal.squads.transactionIndex}</InfoRow>
          ) : null}
          <InfoRow label={<LabelWithInfo label="Proposal type" info="vault_transaction = move funds out of the vault. config_transaction = change the multisig (members or threshold)." />}>{proposal.proposalType}</InfoRow>
          <InfoRow label={<LabelWithInfo label="Local status" info="Decimal's view of the proposal lifecycle. May briefly differ from on-chain state during sync." />}>{proposal.localStatus}</InfoRow>
          {proposal.submittedSignature ? (
            <InfoRow label={<LabelWithInfo label="Submitted sig" info="Solana transaction signature for the create-proposal transaction — proof the proposal was published on-chain." />}>
              <ChainLink signature={proposal.submittedSignature} />
            </InfoRow>
          ) : null}
          {proposal.executedSignature ? (
            <InfoRow label={<LabelWithInfo label="Executed sig" info="Solana transaction signature for the execute-proposal transaction — proof the funds actually moved on-chain." />}>
              <ChainLink signature={proposal.executedSignature} />
            </InfoRow>
          ) : null}
          {proposal.createdAt ? (
            <InfoRow label={<LabelWithInfo label="Created" info="When the proposal was first recorded in Decimal." />}>{new Date(proposal.createdAt).toLocaleString()}</InfoRow>
          ) : null}
        </div>
      </section>
    </>
  );
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
            {order?.counterpartyWallet?.label ? (
              <div style={{ fontSize: 11, opacity: 0.7 }}>{order.counterpartyWallet.label}</div>
            ) : null}
          </InfoRow>
        ) : null}
        {payload?.sourceWalletAddress ? (
          <InfoRow label={<LabelWithInfo label="Source vault" info="The Squads vault PDA the funds are sent FROM. Owned by the multisig — every transfer out needs the threshold of approvals." />}>
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
    inputBatchId?: string;
    inputBatchLabel?: string;
    paymentOrderIds?: string[];
    sourceWalletAddress?: string;
    sourceTokenAccountAddress?: string;
    totalAmountRaw?: string;
    orderCount?: number;
    asset?: string;
    orders?: Array<{
      index: number;
      paymentOrderId: string;
      counterpartyWalletId: string;
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
          {payload?.inputBatchLabel ? (
            <InfoRow label="Batch">{payload.inputBatchLabel}</InfoRow>
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
            <InfoRow label={<LabelWithInfo label="Source vault" info="The Squads vault PDA the funds are sent FROM. Owned by the multisig — every transfer out needs the threshold of approvals." />}>
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
                    <td onClick={(e) => e.stopPropagation()}>
                      <ChainLink address={row.destinationWalletAddress} prefix={4} suffix={4} />
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
        <ChainLink address={decision.walletAddress} prefix={4} suffix={4} />
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
        <ChainLink address={voter.walletAddress} prefix={4} suffix={4} />
      </td>
      <td>
        <PendingVoterPill voter={voter} />
      </td>
    </tr>
  );
}

// Inline label + hover-tooltip used to demystify the on-chain Squads /
// PDA jargon on this page. Scoped here on purpose — the rest of the app
// doesn't need this density of explanation, but a proposal page exposes
// enough Solana primitives that operators benefit from per-field hints.
function LabelWithInfo({ label, info }: { label: string; info: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, position: 'relative' }}>
      <span>{label}</span>
      <button
        type="button"
        aria-label={`What is ${label}?`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'help',
          color: 'currentColor',
          opacity: 0.7,
          display: 'inline-flex',
          alignItems: 'center',
          lineHeight: 0,
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </button>
      {open ? (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 50,
            width: 280,
            padding: '8px 10px',
            background: 'var(--ax-surface-3)',
            border: '1px solid var(--ax-border-strong)',
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.45,
            color: 'var(--ax-text)',
            textTransform: 'none',
            letterSpacing: 'normal',
            fontWeight: 400,
            opacity: 1,
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(0, 0, 0, 0.4)',
            pointerEvents: 'none',
          }}
        >
          {info}
        </span>
      ) : null}
    </span>
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
