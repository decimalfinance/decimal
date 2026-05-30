// One proposal in full — implements the design's detail pattern
// (PROPOSAL eyebrow + title + status pill, .action-bar driven by who
// can do what, member-cell rows for voters with verified-style badges,
// detail-grid for the on-chain primitives, semantic-specific summary
// cards). Reuses useSquadsProposalActions + useAutoRetryProposal-
// Verification so the action wiring matches every other surface.

import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  AuthenticatedSession,
  DecimalProposal,
  SquadsProposalDecision,
  SquadsProposalPendingVoter,
} from '../types';
import { useAutoRetryProposalVerification } from '../lib/settlement';
import { useSquadsProposalActions } from '../lib/squads-actions';
import { shortenAddress } from '../domain';
import { orbAccountUrl, orbTransactionUrl } from '../lib/app';
import { useToast } from '../ui/Toast';
import {
  proposalTypeLabel,
  summarizeProposal,
} from '../ui/DecimalProposalCard';
import { Ico } from '../dec/icons';
import { Pill, type PillTone } from '../dec/primitives';

const STATUS_TONE: Record<string, PillTone> = {
  active: 'warning',
  approved: 'info',
  executed: 'success',
  cancelled: 'neutral',
  rejected: 'danger',
};
const STATUS_LABEL: Record<string, string> = {
  active: 'Awaiting votes',
  approved: 'Ready to execute',
  executed: 'Executed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

export function OrganizationProposalDetailPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId, decimalProposalId } = useParams<{
    organizationId: string;
    decimalProposalId: string;
  }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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

  // Manual sync — same pattern as the payment detail's Sync. Re-runs
  // confirm-execution against any stored signature so a stuck proposal
  // can reconcile after a flaky RPC window.
  const syncMutation = useMutation({
    mutationFn: async () => {
      const fresh = proposalQuery.data;
      if (!fresh) return;
      const sig = fresh.executedSignature ?? fresh.submittedSignature ?? null;
      if (sig) {
        try {
          await api.confirmProposalExecution(organizationId!, fresh.decimalProposalId, { signature: sig });
        } catch {
          // Backend may say "already settled" — that's fine, the invalidate
          // below will pull the fresh state regardless.
        }
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['organization-proposal', organizationId, decimalProposalId] });
      await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
      toast.success('Synced from chain.');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Sync failed.'),
  });

  if (!organizationId || !decimalProposalId) {
    return (
      <div className="page">
        <div className="empty">
          <h4>Proposal unavailable</h4>
          <p>Missing route parameters.</p>
        </div>
      </div>
    );
  }

  const proposalError = proposalQuery.error;
  const isForbidden = proposalError instanceof ApiError && proposalError.code === 'not_squads_member';
  const isMissing = proposalError instanceof ApiError && proposalError.status === 404;

  if (proposalQuery.isLoading) {
    return (
      <div className="page">
        <div className="detail-col">
          <div className="stack stack-16">
            <div className="skeleton" style={{ height: 80, borderRadius: 12 }} />
            <div className="skeleton" style={{ height: 60, borderRadius: 12 }} />
            <div className="skeleton" style={{ height: 240, borderRadius: 12 }} />
          </div>
        </div>
      </div>
    );
  }

  if (isForbidden || isMissing || !proposalQuery.data) {
    return (
      <div className="page">
        <div className="detail-col">
          <Crumb
            onBack={() => navigate(`/organizations/${organizationId}/proposals`)}
          />
          <div className="empty" style={{ marginTop: 24 }}>
            <h4>
              {isForbidden
                ? 'Not a signer here'
                : isMissing
                  ? 'Proposal not found'
                  : "Couldn't load proposal"}
            </h4>
            <p>
              {isForbidden
                ? "You're not a signer on the treasury this proposal targets, so its detail isn't visible to you."
                : isMissing
                  ? "This proposal doesn't exist in this organization."
                  : proposalError instanceof Error
                    ? proposalError.message
                    : 'Something went wrong.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const proposal = proposalQuery.data;
  return (
    <div className="page">
      <div className="detail-col">
        <Crumb onBack={() => navigate(`/organizations/${organizationId}/proposals`)} />
        <ProposalBody
          proposal={proposal}
          organizationId={organizationId}
          actions={actions}
          syncing={syncMutation.isPending}
          onSync={() => syncMutation.mutate()}
          onTreasuryClick={(treasuryWalletId) =>
            navigate(`/organizations/${organizationId}/wallets/${treasuryWalletId}`)
          }
        />
      </div>
    </div>
  );
}

function Crumb({ onBack }: { onBack: () => void }) {
  return (
    <div
      className="crumb"
      onClick={onBack}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onBack();
      }}
    >
      <Ico.chevRight w={15} style={{ transform: 'rotate(180deg)' }} />Proposals
    </div>
  );
}

// ─── Body ────────────────────────────────────────────────────────────────

function ProposalBody({
  proposal,
  organizationId,
  actions,
  syncing,
  onSync,
  onTreasuryClick,
}: {
  proposal: DecimalProposal;
  organizationId: string;
  actions: ReturnType<typeof useSquadsProposalActions>;
  syncing: boolean;
  onSync: () => void;
  onTreasuryClick: (treasuryWalletId: string) => void;
}) {
  const { pendingVoterWallet, executeWallet, approving, rejecting, executing } = actions;
  const canCastVote = pendingVoterWallet !== null && proposal.status === 'active';
  const canExecute = proposal.status === 'approved' && executeWallet !== null;
  const statusKey =
    proposal.status === 'active' && canCastVote ? 'needs_vote' : proposal.status;
  const statusTone =
    statusKey === 'needs_vote' ? 'warning' : STATUS_TONE[proposal.status] ?? 'neutral';
  const statusLabel =
    statusKey === 'needs_vote' ? 'Needs your vote' : STATUS_LABEL[proposal.status] ?? proposal.status;

  const treasuryName = proposal.treasuryWallet?.displayName ?? null;
  const txIndex = proposal.squads.transactionIndex;
  const busy = approving || rejecting || executing;
  const isClosed =
    proposal.status === 'executed' ||
    proposal.status === 'cancelled' ||
    proposal.status === 'rejected';

  function handleReject(signerWalletId: string) {
    const ok = window.confirm(
      'Reject this proposal? This casts an on-chain rejection vote and cannot be undone.',
    );
    if (!ok) return;
    actions.reject(signerWalletId);
  }

  return (
    <div className="stack stack-16">
      {/* Header */}
      <div>
        <div className="eyebrow" style={{ marginBottom: 10 }}>PROPOSAL</div>
        <div className="pagehead" style={{ paddingBottom: 16 }}>
          <div className="ph-titles">
            <h1>{summarizeProposal(proposal)}</h1>
            <p className="ph-desc">
              {proposalTypeLabel(proposal)}
              {treasuryName ? (
                <>
                  &nbsp;&nbsp;<span style={{ color: 'var(--text-faint)' }}>·</span>&nbsp;&nbsp;
                  <span
                    className="cell-source"
                    style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer' }}
                    onClick={() =>
                      proposal.treasuryWallet && onTreasuryClick(proposal.treasuryWallet.treasuryWalletId)
                    }
                    role="link"
                    tabIndex={0}
                  >
                    <Ico.treasury w={15} />{treasuryName}
                  </span>
                </>
              ) : null}
              {txIndex ? (
                <>
                  &nbsp;&nbsp;<span style={{ color: 'var(--text-faint)' }}>·</span>&nbsp;&nbsp;
                  <span className="mono" style={{ fontSize: 12 }}>#{txIndex}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="ph-actions" style={{ alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onSync}
              disabled={syncing}
              aria-busy={syncing}
              title="Reconcile on-chain state"
            >
              <Ico.download w={13} style={{ transform: 'rotate(180deg)' }} />
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
            <div className="head-status">
              <Pill tone={statusTone}>{statusLabel}</Pill>
            </div>
          </div>
        </div>
      </div>

      {/* Action bar */}
      {!isClosed ? (
        <ActionBar
          proposal={proposal}
          canCastVote={canCastVote}
          canExecute={canExecute}
          pendingVoterAddress={pendingVoterWallet?.walletAddress ?? null}
          executeAddress={executeWallet?.walletAddress ?? null}
          busy={busy}
          approving={approving}
          rejecting={rejecting}
          executing={executing}
          onApprove={() => pendingVoterWallet && actions.approve(pendingVoterWallet.userWalletId)}
          onReject={() => pendingVoterWallet && handleReject(pendingVoterWallet.userWalletId)}
          onExecute={() => executeWallet && actions.execute(executeWallet.userWalletId)}
        />
      ) : null}

      {/* Semantic-specific summary */}
      <SemanticSummary proposal={proposal} organizationId={organizationId} />

      {/* Approvals */}
      <ApprovalsSection proposal={proposal} />

      {/* On-chain detail grid */}
      <OnChainSection proposal={proposal} />
    </div>
  );
}

// ─── Action bar ─────────────────────────────────────────────────────────

function ActionBar({
  proposal,
  canCastVote,
  canExecute,
  pendingVoterAddress,
  executeAddress,
  busy,
  approving,
  rejecting,
  executing,
  onApprove,
  onReject,
  onExecute,
}: {
  proposal: DecimalProposal;
  canCastVote: boolean;
  canExecute: boolean;
  pendingVoterAddress: string | null;
  executeAddress: string | null;
  busy: boolean;
  approving: boolean;
  rejecting: boolean;
  executing: boolean;
  onApprove: () => void;
  onReject: () => void;
  onExecute: () => void;
}) {
  const voting = proposal.voting;
  const remaining = voting ? Math.max(0, voting.threshold - voting.approvals.length) : 0;

  const tone: 'amber' | 'neutral' | 'success' = canCastVote
    ? 'amber'
    : canExecute
      ? 'amber'
      : 'neutral';

  let eyebrow: string;
  let title: React.ReactNode;
  let body: React.ReactNode;
  let controls: React.ReactNode;

  if (canCastVote) {
    eyebrow = 'Needs your vote';
    title = 'Your signature is needed';
    body = pendingVoterAddress
      ? `Approve as ${shortenAddress(pendingVoterAddress, 4, 4)}.`
      : 'Cast your approval on chain.';
    controls = (
      <>
        <button
          type="button"
          className="btn btn-danger-ghost"
          onClick={onReject}
          disabled={busy}
          aria-busy={rejecting}
        >
          {rejecting ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onApprove}
          disabled={busy}
          aria-busy={approving}
        >
          {approving ? 'Approving…' : <>Approve<Ico.arrowRight w={14} /></>}
        </button>
      </>
    );
  } else if (proposal.status === 'approved' && canExecute) {
    eyebrow = 'Ready to send';
    title = 'Threshold met — execute when ready';
    body = executeAddress
      ? `Execute as ${shortenAddress(executeAddress, 4, 4)}.`
      : 'A member with execute permission needs to send it.';
    controls = (
      <button
        type="button"
        className="btn btn-primary"
        onClick={onExecute}
        disabled={busy}
        aria-busy={executing}
      >
        {executing ? 'Executing…' : (
          <>
            <Ico.bolt w={14} fill="currentColor" sw={0} />
            Execute
          </>
        )}
      </button>
    );
  } else if (proposal.status === 'approved') {
    eyebrow = 'Ready to send';
    title = 'Threshold met — awaiting execute';
    body = 'A member with execute permission needs to submit the execute transaction.';
    controls = <span />;
  } else {
    eyebrow = 'Awaiting others';
    title = voting
      ? `${voting.approvals.length} of ${voting.threshold} approved`
      : 'Voting state not yet available';
    body = voting
      ? remaining > 0
        ? `${remaining} more approval${remaining === 1 ? '' : 's'} required.`
        : 'All approvals in — settling.'
      : 'Voting state not yet available.';
    controls = <span />;
  }

  return (
    <div className={`action-bar tone-${tone}`}>
      <div className="ab-text">
        <span className="ab-eyebrow">{eyebrow}</span>
        <h3 className="ab-title">{title}</h3>
        {body ? <p className="ab-body">{body}</p> : null}
      </div>
      <div className="ab-controls">{controls}</div>
    </div>
  );
}

// ─── Semantic summary ───────────────────────────────────────────────────

function SemanticSummary({
  proposal,
  organizationId,
}: {
  proposal: DecimalProposal;
  organizationId: string;
}) {
  const semantic = proposal.semanticType ?? '';

  if (semantic === 'send_payment') {
    return <PaymentSummary proposal={proposal} organizationId={organizationId} />;
  }
  if (semantic === 'send_payment_run') {
    return <PaymentRunSummary proposal={proposal} organizationId={organizationId} />;
  }
  if (semantic === 'add_member') return <AddMemberSummary proposal={proposal} />;
  if (semantic === 'remove_member') return <RemoveMemberSummary proposal={proposal} />;
  if (semantic === 'change_threshold') return <ChangeThresholdSummary proposal={proposal} />;
  return null;
}

function PaymentSummary({
  proposal,
  organizationId,
}: {
  proposal: DecimalProposal;
  organizationId: string;
}) {
  const payload = proposal.semanticPayloadJson as {
    amountRaw?: string;
    asset?: string;
    destinationWalletAddress?: string;
    sourceWalletAddress?: string;
    token?: { symbol?: string; decimals?: number };
    reference?: string | null;
    memo?: string | null;
  };
  const order = proposal.paymentOrder;
  const navigate = useNavigate();
  const amountLabel = payload?.amountRaw
    ? `${formatRawAmount(payload.amountRaw, payload.token?.decimals ?? 6)} ${payload.token?.symbol ?? payload.asset?.toUpperCase() ?? ''}`
    : '—';
  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles"><h2>Payment</h2></div>
      </div>
      <div className="review-card">
        <div className="rv-row">
          <span className="rv-k">Amount</span>
          <span className="rv-v mono">{amountLabel}</span>
        </div>
        {payload?.destinationWalletAddress ? (
          <div className="rv-row">
            <span className="rv-k">Destination</span>
            <span className="rv-v">
              {order?.counterpartyWallet?.label ? `${order.counterpartyWallet.label} · ` : ''}
              <a
                href={orbAccountUrl(payload.destinationWalletAddress)}
                target="_blank"
                rel="noreferrer"
                className="mono"
                style={{ color: 'var(--text-muted)', textDecoration: 'none' }}
              >
                {shortenAddress(payload.destinationWalletAddress, 4, 4)}
              </a>
            </span>
          </div>
        ) : null}
        {payload?.sourceWalletAddress ? (
          <div className="rv-row">
            <span className="rv-k">Source vault</span>
            <span className="rv-v mono">
              {shortenAddress(payload.sourceWalletAddress, 4, 4)}
            </span>
          </div>
        ) : null}
        {order ? (
          <div className="rv-row">
            <span className="rv-k">Payment order</span>
            <span
              className="rv-v"
              onClick={() => navigate(`/organizations/${organizationId}/payments/${order.paymentOrderId}`)}
              style={{ cursor: 'pointer', textDecoration: 'underline', color: 'var(--text-muted)' }}
            >
              {order.invoiceNumber ?? order.externalReference ?? shortenAddress(order.paymentOrderId, 4, 4)}
            </span>
          </div>
        ) : null}
        {payload?.reference ? (
          <div className="rv-row">
            <span className="rv-k">Reference</span>
            <span className="rv-v">{payload.reference}</span>
          </div>
        ) : null}
        {payload?.memo ? (
          <div className="rv-row">
            <span className="rv-k">Memo</span>
            <span className="rv-v">{payload.memo}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PaymentRunSummary({
  proposal,
  organizationId,
}: {
  proposal: DecimalProposal;
  organizationId: string;
}) {
  const payload = proposal.semanticPayloadJson as {
    inputBatchLabel?: string;
    totalAmountRaw?: string;
    orderCount?: number;
    asset?: string;
    sourceWalletAddress?: string;
    orders?: Array<{
      index: number;
      paymentOrderId: string;
      destinationWalletAddress: string;
      amountRaw: string;
      asset: string;
      reference: string | null;
      memo: string | null;
    }>;
  };
  const orders = payload?.orders ?? [];
  const symbol = (payload?.asset ?? 'usdc').toUpperCase();
  const navigate = useNavigate();
  return (
    <>
      <div>
        <div className="sec-head">
          <div className="sh-titles"><h2>Batch</h2></div>
        </div>
        <div className="review-card">
          {payload?.inputBatchLabel ? (
            <div className="rv-row">
              <span className="rv-k">Label</span>
              <span className="rv-v">{payload.inputBatchLabel}</span>
            </div>
          ) : null}
          {payload?.totalAmountRaw ? (
            <div className="rv-row">
              <span className="rv-k">Total</span>
              <span className="rv-v mono">
                {formatRawAmount(payload.totalAmountRaw, 6)} {symbol}
              </span>
            </div>
          ) : null}
          <div className="rv-row">
            <span className="rv-k">Rows</span>
            <span className="rv-v">{payload?.orderCount ?? orders.length}</span>
          </div>
          {payload?.sourceWalletAddress ? (
            <div className="rv-row">
              <span className="rv-k">Source vault</span>
              <span className="rv-v mono">
                {shortenAddress(payload.sourceWalletAddress, 4, 4)}
              </span>
            </div>
          ) : null}
        </div>
      </div>
      {orders.length > 0 ? (
        <div>
          <div className="sec-head">
            <div className="sh-titles"><h2>Rows ({orders.length})</h2></div>
          </div>
          <div className="tbl-card">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Destination</th>
                  <th className="num">Amount</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((row) => (
                  <tr
                    key={row.paymentOrderId}
                    onClick={() => navigate(`/organizations/${organizationId}/payments/${row.paymentOrderId}`)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{row.index + 1}</td>
                    <td>
                      <span className="mono" style={{ fontSize: 12 }}>
                        {shortenAddress(row.destinationWalletAddress, 4, 4)}
                      </span>
                    </td>
                    <td className="td-num">
                      {formatRawAmount(row.amountRaw, 6)}{' '}
                      <span style={{ color: 'var(--text-faint)' }}>{row.asset.toUpperCase()}</span>
                    </td>
                    <td>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {row.reference ?? row.memo ?? '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

function AddMemberSummary({ proposal }: { proposal: DecimalProposal }) {
  const payload = proposal.semanticPayloadJson as {
    walletAddress?: string;
    permissions?: string[];
    newThreshold?: number;
  };
  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles"><h2>Add member</h2></div>
      </div>
      <div className="review-card">
        {payload.walletAddress ? (
          <div className="rv-row">
            <span className="rv-k">New member</span>
            <span className="rv-v mono">{shortenAddress(payload.walletAddress, 4, 4)}</span>
          </div>
        ) : null}
        <div className="rv-row">
          <span className="rv-k">Permissions</span>
          <span className="rv-v">{payload.permissions?.length ? payload.permissions.join(' / ') : '—'}</span>
        </div>
        {payload.newThreshold !== undefined ? (
          <div className="rv-row">
            <span className="rv-k">Threshold (after)</span>
            <span className="rv-v">{payload.newThreshold}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RemoveMemberSummary({ proposal }: { proposal: DecimalProposal }) {
  const payload = proposal.semanticPayloadJson as {
    walletAddress?: string;
    newThreshold?: number;
  };
  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles"><h2>Remove member</h2></div>
      </div>
      <div className="review-card">
        {payload.walletAddress ? (
          <div className="rv-row">
            <span className="rv-k">Member</span>
            <span className="rv-v mono">{shortenAddress(payload.walletAddress, 4, 4)}</span>
          </div>
        ) : null}
        {payload.newThreshold !== undefined ? (
          <div className="rv-row">
            <span className="rv-k">Threshold (after)</span>
            <span className="rv-v">{payload.newThreshold}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChangeThresholdSummary({ proposal }: { proposal: DecimalProposal }) {
  const payload = proposal.semanticPayloadJson as { newThreshold?: number };
  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles"><h2>Change required approvals</h2></div>
      </div>
      <div className="review-card">
        <div className="rv-row">
          <span className="rv-k">New threshold</span>
          <span className="rv-v">{payload.newThreshold ?? '—'}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Approvals ──────────────────────────────────────────────────────────

function ApprovalsSection({ proposal }: { proposal: DecimalProposal }) {
  const voting = proposal.voting;
  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles">
          <h2>Approvals</h2>
        </div>
        {voting ? (
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {voting.approvals.length} of {voting.threshold} required
          </span>
        ) : null}
      </div>
      {!voting ? (
        <div className="tbl-card" style={{ padding: 20 }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Voting state not yet available.</span>
        </div>
      ) : (
        <div className="tbl-card">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: '50%' }}>Signer</th>
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
              {voting.pendingVoters.map((v) => (
                <PendingRow key={`pending-${v.walletAddress}`} voter={v} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const DECISION_TONE: Record<'approval' | 'rejection' | 'cancellation', PillTone> = {
  approval: 'success',
  rejection: 'danger',
  cancellation: 'neutral',
};
const DECISION_LABEL: Record<'approval' | 'rejection' | 'cancellation', string> = {
  approval: 'Approved',
  rejection: 'Rejected',
  cancellation: 'Cancelled',
};

function DecisionRow({
  kind,
  decision,
}: {
  kind: 'approval' | 'rejection' | 'cancellation';
  decision: SquadsProposalDecision;
}) {
  const user = decision.organizationMembership?.user;
  return (
    <tr>
      <td>
        <SignerCell user={user} fallbackAddress={decision.walletAddress} />
      </td>
      <td>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {shortenAddress(decision.walletAddress, 4, 4)}
        </span>
      </td>
      <td>
        <Pill tone={DECISION_TONE[kind]}>{DECISION_LABEL[kind]}</Pill>
      </td>
    </tr>
  );
}

function PendingRow({ voter }: { voter: SquadsProposalPendingVoter }) {
  const user = voter.organizationMembership?.user;
  return (
    <tr>
      <td>
        <SignerCell user={user} fallbackAddress={voter.walletAddress} />
      </td>
      <td>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {shortenAddress(voter.walletAddress, 4, 4)}
        </span>
      </td>
      <td>
        <Pill tone="neutral">Pending</Pill>
      </td>
    </tr>
  );
}

function SignerCell({
  user,
  fallbackAddress,
}: {
  user: { displayName: string; email: string; avatarUrl: string | null } | undefined;
  fallbackAddress: string;
}) {
  const name = user?.displayName || user?.email || shortenAddress(fallbackAddress, 4, 4);
  const sub = user?.email && user.email !== name ? user.email : '';
  const initials = computeInitials(user?.displayName ?? null, user?.email ?? fallbackAddress);
  return (
    <div className="member-cell">
      <SignerAvatar avatarUrl={user?.avatarUrl ?? null} initials={initials} />
      <div className="col">
        <span className="m-name">{name}</span>
        {sub ? <span className="m-sub" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-faint)' }}>{sub}</span> : null}
      </div>
    </div>
  );
}

function SignerAvatar({ avatarUrl, initials }: { avatarUrl: string | null; initials: string }) {
  const [failed, setFailed] = useState(false);
  if (!avatarUrl || failed) {
    return <span className="m-avatar">{initials}</span>;
  }
  return (
    <span className="m-avatar" style={{ padding: 0, overflow: 'hidden', background: 'transparent' }}>
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

function computeInitials(name: string | null, fallback: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  return fallback.slice(0, 2).toUpperCase();
}

// ─── On-chain ───────────────────────────────────────────────────────────

function OnChainSection({ proposal }: { proposal: DecimalProposal }) {
  const cells: Array<{ label: string; value: React.ReactNode; sub?: string }> = [];
  if (proposal.squads.proposalPda) {
    cells.push({
      label: 'Proposal account',
      value: <AddrLink address={proposal.squads.proposalPda} />,
    });
  }
  if (proposal.squads.transactionPda) {
    cells.push({
      label: 'Squads transaction',
      value: <AddrLink address={proposal.squads.transactionPda} />,
    });
  }
  if (proposal.squads.multisigPda) {
    cells.push({
      label: 'Multisig',
      value: <AddrLink address={proposal.squads.multisigPda} />,
    });
  }
  if (proposal.squads.transactionIndex) {
    cells.push({
      label: 'Tx index',
      value: <span className="mono">#{proposal.squads.transactionIndex}</span>,
    });
  }

  const row2: Array<{ label: string; value: React.ReactNode; sub?: string }> = [];
  if (proposal.submittedSignature) {
    row2.push({
      label: 'Submitted',
      value: <SigLink signature={proposal.submittedSignature} />,
      sub: proposal.submittedAt ? new Date(proposal.submittedAt).toLocaleString() : undefined,
    });
  }
  if (proposal.executedSignature) {
    row2.push({
      label: 'Executed',
      value: <SigLink signature={proposal.executedSignature} />,
      sub: proposal.executedAt ? new Date(proposal.executedAt).toLocaleString() : undefined,
    });
  }

  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles"><h2>On-chain</h2></div>
      </div>
      {cells.length > 0 ? (
        <div className="detail-grid" style={{ gridTemplateColumns: `repeat(${Math.min(cells.length, 4)}, 1fr)` }}>
          {cells.map((c) => (
            <div className="detail-cell" key={c.label}>
              <span className="d-label">{c.label}</span>
              <span className="d-value">{c.value}</span>
              {c.sub ? <span className="d-sub">{c.sub}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {row2.length > 0 ? (
        <div className="detail-row2" style={{ gridTemplateColumns: `repeat(${Math.min(row2.length, 2)}, 1fr)` }}>
          {row2.map((c) => (
            <div className="detail-cell" key={c.label}>
              <span className="d-label">{c.label}</span>
              <span className="d-value">{c.value}</span>
              {c.sub ? <span className="d-sub">{c.sub}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AddrLink({ address }: { address: string }) {
  return (
    <a
      href={orbAccountUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="chainlink"
      style={{ textDecoration: 'none', padding: '5px 9px', fontSize: 11 }}
    >
      <Ico.link w={13} />
      <span className="sig">{shortenAddress(address, 4, 4)}</span>
      <Ico.external w={12} />
    </a>
  );
}

function SigLink({ signature }: { signature: string }) {
  return (
    <a
      href={orbTransactionUrl(signature)}
      target="_blank"
      rel="noreferrer"
      className="chainlink"
      style={{ textDecoration: 'none', padding: '5px 9px', fontSize: 11 }}
    >
      <Ico.link w={13} />
      <span className="sig">{shortenAddress(signature, 4, 4)}</span>
      <Ico.external w={12} />
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
