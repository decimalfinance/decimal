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
  SpendingLimitPolicy,
  SquadsProposalDecision,
  SquadsProposalPendingVoter,
} from '../types';
import { useAutoRetryProposalVerification } from '../lib/settlement';
import { useSquadsProposalActions } from '../lib/squads-actions';
import { shortenAddress } from '../domain';
import { orbAccountUrl } from '../lib/app';
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
    // Live updates come over SSE (see useLiveOrgEvents), so this poll is just a
    // fallback if the stream drops: refetch while the proposal is live, and stop
    // once it reaches a terminal state. refetchOnWindowFocus also catches a
    // missed update the moment you switch back to this tab.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'executed' || status === 'cancelled' || status === 'rejected') return false;
      return 15_000;
    },
    refetchOnWindowFocus: true,
  });

  // Pull all SL policies for this org so spending-limit proposals can
  // be enriched with the policy name + the actual vendor names (the
  // raw config-action payload only carries wallet addresses). One
  // query, cached across the spending-limits page.
  const spendingLimitsQuery = useQuery({
    queryKey: ['spending-limit-policies', organizationId, 'all'] as const,
    queryFn: () => api.listSpendingLimitPolicies(organizationId!),
    enabled: Boolean(organizationId),
  });
  const linkedSpendingLimitPolicy = useMemo<SpendingLimitPolicy | null>(() => {
    const proposal = proposalQuery.data;
    if (!proposal) return null;
    const semantic = proposal.semanticType ?? '';
    const policies = spendingLimitsQuery.data?.items ?? [];
    // add_spending_limit / replace_spending_limit — the new policy
    // points back at this proposal via decimalProposalId.
    if (semantic === 'add_spending_limit' || semantic === 'replace_spending_limit') {
      return policies.find((p) => p.decimalProposalId === proposal.decimalProposalId) ?? null;
    }
    // remove_spending_limit — the policy id is stamped on the proposal
    // metadataJson at create time (api/src/squads/treasury.ts:559).
    if (semantic === 'remove_spending_limit') {
      const meta = proposal.metadataJson as { spendingLimitPolicyId?: string } | null;
      const id = meta?.spendingLimitPolicyId;
      if (!id) return null;
      return policies.find((p) => p.spendingLimitPolicyId === id) ?? null;
    }
    return null;
  }, [proposalQuery.data, spendingLimitsQuery.data]);

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

  // Manual sync — reconcile the proposal from chain. The backend finds the real
  // on-chain execution signature (even one the app never recorded), stores it,
  // and re-runs settlement verification across clusters. This fixes proposals
  // stuck at "submitted"/"executed but unverified" after an RPC/cluster mismatch.
  const syncMutation = useMutation({
    mutationFn: async () => {
      const fresh = proposalQuery.data;
      if (!fresh || !organizationId) return;
      await api.reconcileProposalFromChain(organizationId, fresh.decimalProposalId);
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
          linkedSpendingLimitPolicy={linkedSpendingLimitPolicy}
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
  linkedSpendingLimitPolicy,
  onTreasuryClick,
}: {
  proposal: DecimalProposal;
  organizationId: string;
  actions: ReturnType<typeof useSquadsProposalActions>;
  syncing: boolean;
  onSync: () => void;
  linkedSpendingLimitPolicy: SpendingLimitPolicy | null;
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

  // Suppress the unused #tx-index — we deliberately hide the on-chain
  // sequence number from operators per the no-crypto-jargon rule.
  void txIndex;

  return (
    <div className="stack stack-16">
      {/* Header */}
      <div>
        <div className="eyebrow" style={{ marginBottom: 10 }}>PROPOSAL</div>
        <div className="pagehead" style={{ paddingBottom: 16 }}>
          <div className="ph-titles">
            <h1>{friendlyTitle(proposal, linkedSpendingLimitPolicy)}</h1>
            <p className="ph-desc">
              {friendlySubtitle(proposal)}
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
      <SemanticSummary
        proposal={proposal}
        organizationId={organizationId}
        linkedSpendingLimitPolicy={linkedSpendingLimitPolicy}
      />

      {/* Approvals */}
      <ApprovalsSection proposal={proposal} />
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
  linkedSpendingLimitPolicy,
}: {
  proposal: DecimalProposal;
  organizationId: string;
  linkedSpendingLimitPolicy: SpendingLimitPolicy | null;
}) {
  const semantic = proposal.semanticType ?? '';

  if (semantic === 'send_payment') {
    return <PaymentSummary proposal={proposal} organizationId={organizationId} />;
  }
  if (semantic === 'send_payment_run') {
    return <PaymentRunSummary proposal={proposal} organizationId={organizationId} />;
  }
  // Spending-limit family — render the actual policy detail when we
  // can resolve the linked policy. The policy has the human name and
  // resolved vendor labels; the raw action payload only carries
  // wallet addresses, which read as gibberish to an operator.
  if (semantic === 'add_spending_limit' || semantic === 'replace_spending_limit') {
    return (
      <SpendingLimitProposalSummary
        proposal={proposal}
        policy={linkedSpendingLimitPolicy}
        action={semantic === 'add_spending_limit' ? 'add' : 'replace'}
      />
    );
  }
  if (semantic === 'remove_spending_limit') {
    return (
      <SpendingLimitProposalSummary
        proposal={proposal}
        policy={linkedSpendingLimitPolicy}
        action="remove"
      />
    );
  }
  if (semantic === 'add_member') return <AddMemberSummary proposal={proposal} />;
  if (semantic === 'remove_member') return <RemoveMemberSummary proposal={proposal} />;
  if (semantic === 'change_threshold') return <ChangeThresholdSummary proposal={proposal} />;
  // Fallback for any remaining config-transaction proposal (e.g.
  // add_agent_member, future kinds). The semanticPayloadJson carries
  // an `actions` array shaped by the backend's serializeConfigActions
  // — render whatever fields each action exposes in plain language.
  return <ConfigActionsSummary proposal={proposal} />;
}

function SpendingLimitProposalSummary({
  proposal,
  policy,
  action,
}: {
  proposal: DecimalProposal;
  policy: SpendingLimitPolicy | null;
  action: 'add' | 'remove' | 'replace';
}) {
  // Pull amount / period / destinations from the policy when we can
  // resolve it; fall back to the raw config-action payload otherwise.
  const payload = proposal.semanticPayloadJson as { actions?: unknown };
  const firstAction =
    (Array.isArray(payload?.actions) ? (payload.actions[0] as Record<string, unknown> | undefined) : undefined) ?? {};
  const amountRaw = policy?.amountRaw ?? (firstAction.amountRaw as string | undefined);
  const period = policy?.period ?? (firstAction.period as string | undefined);
  const policyName = policy?.policyName ?? null;
  const treasuryName = proposal.treasuryWallet?.displayName ?? null;
  const destinations = policy?.destinations ?? [];
  const rawDestinationAddresses = Array.isArray(firstAction.destinations)
    ? (firstAction.destinations as string[])
    : [];
  const vendorCount = destinations.length || rawDestinationAddresses.length;
  const actionLabel = action === 'add' ? 'New limit' : action === 'remove' ? 'Removing' : 'Updating';

  return (
    <div className="stack stack-16">
      {/* Summary sheet — same .pay-summary pattern used on Payment
          Detail. Top: the amount + period as the hero number; right:
          a pill tagging the change type. Then a Policy → Vault route,
          and a defs grid for the at-a-glance facts. */}
      <div className="pay-summary">
        <div className="ps-amount-row">
          <div>
            <div className="ps-lab">Cap</div>
            <div className="ps-amount">
              {amountRaw ? formatRawAmount(amountRaw, 6) : '—'}
              <small>USDC</small>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 6 }}>
              {periodSentence(period)}
            </div>
          </div>
          <span className="pill-origin" style={{ marginTop: 4 }}>{actionLabel}</span>
        </div>

        <div className="ps-route">
          <div className="ps-endpoint">
            <span className="pe-lab">Policy</span>
            <span className="pe-name">{policyName ?? 'Untitled policy'}</span>
            <span className="pe-sub">{action === 'add' ? 'will be created' : action === 'remove' ? 'will be removed' : 'will be updated'}</span>
          </div>
          <Ico.arrowRight w={18} />
          <div className="ps-endpoint">
            <span className="pe-lab">Vault</span>
            <span className="pe-name">{treasuryName ?? '—'}</span>
            <span className="pe-sub">
              {vendorCount} verified {vendorCount === 1 ? 'vendor' : 'vendors'}
            </span>
          </div>
        </div>

        <div className="ps-defs">
          <div className="ps-def">
            <span className="pd-lab">Period</span>
            <span className="pd-val">{periodTitle(period)}</span>
          </div>
          <div className="ps-def">
            <span className="pd-lab">Vendors</span>
            <span className="pd-val">{vendorCount}</span>
          </div>
          <div className="ps-def">
            <span className="pd-lab">Effect</span>
            <span className="pd-val">
              {action === 'remove'
                ? 'Agent stops auto-paying'
                : 'Agent can auto-pay these vendors'}
            </span>
          </div>
          <div className="ps-def">
            <span className="pd-lab">Approval needed</span>
            <span className="pd-val">Treasury signers</span>
          </div>
        </div>
      </div>

      {/* Vendors covered. List by name when the linked policy is
          resolvable; fall back to truncated wallet addresses
          otherwise so something still renders. */}
      <div>
        <div className="sec-head">
          <div className="sh-titles">
            <h2>Vendors covered</h2>
            <p className="sh-desc">
              {action === 'remove'
                ? 'These vendors will no longer be auto-payable under this policy.'
                : 'The agent can pay these vendors automatically — no team vote needed per payment.'}
            </p>
          </div>
        </div>
        <div className="tbl-card">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: '55%' }}>Vendor</th>
                <th>Trust</th>
                <th>Wallet</th>
              </tr>
            </thead>
            <tbody>
              {destinations.length > 0 ? (
                destinations.map((d) => {
                  const label =
                    d.counterpartyWallet?.label ??
                    d.counterpartyWallet?.counterparty?.displayName ??
                    shortenAddress(d.walletAddress, 4, 4);
                  const trust = d.counterpartyWallet?.trustState ?? 'unreviewed';
                  const trustTone: PillTone =
                    trust === 'trusted'
                      ? 'success'
                      : trust === 'blocked' || trust === 'restricted'
                        ? 'danger'
                        : 'warning';
                  const trustLabel =
                    trust === 'trusted'
                      ? 'Verified'
                      : trust.charAt(0).toUpperCase() + trust.slice(1);
                  return (
                    <tr key={d.spendingLimitPolicyDestinationId}>
                      <td>
                        <div className="member-cell">
                          <span className="m-avatar">{vendorInitials(label)}</span>
                          <span className="m-name">{label}</span>
                        </div>
                      </td>
                      <td>
                        <Pill tone={trustTone}>{trustLabel}</Pill>
                      </td>
                      <td>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {shortenAddress(d.walletAddress, 4, 4)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ) : rawDestinationAddresses.length > 0 ? (
                rawDestinationAddresses.map((addr) => (
                  <tr key={addr}>
                    <td>
                      <div className="member-cell">
                        <span className="m-avatar">??</span>
                        <span className="m-name" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          {shortenAddress(addr, 4, 4)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <Pill tone="neutral">Unknown</Pill>
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {shortenAddress(addr, 4, 4)}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} style={{ padding: 18, color: 'var(--text-muted)', fontSize: 13 }}>
                    No vendors on this policy yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function vendorInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return '??';
}

function periodSentence(period: string | undefined): string {
  if (period === 'month') return 'per month, resets the 1st';
  if (period === 'week') return 'per week, resets every Monday';
  if (period === 'day') return 'per day, resets at midnight';
  // Squads' Period::OneTime means the cap never resets — it's a total
  // budget the agent can spend across any number of payments until
  // exhausted, NOT "one payment then done". (See Squads IDL:
  // "the remaining amount is reset, unless it's Period::OneTime".)
  if (period === 'one_time') return 'total budget — does not reset';
  return `per ${period ?? 'period'}`;
}

function periodTitle(period: string | undefined): string {
  if (period === 'month') return 'Monthly';
  if (period === 'week') return 'Weekly';
  if (period === 'day') return 'Daily';
  if (period === 'one_time') return 'One-time budget';
  return period ?? '—';
}

function ConfigActionsSummary({ proposal }: { proposal: DecimalProposal }) {
  const payload = proposal.semanticPayloadJson as { actions?: unknown };
  const actions = Array.isArray(payload?.actions) ? payload.actions : [];
  if (!actions.length) return null;
  return (
    <div>
      <div className="sec-head">
        <div className="sh-titles"><h2>What this changes</h2></div>
      </div>
      <div className="review-card">
        {actions.map((raw, i) => {
          const action = raw as Record<string, unknown>;
          const kind = String(action.kind ?? '');
          if (kind === 'add_member') {
            const addr = action.walletAddress as string | undefined;
            const perms = (action.permissions as string[] | undefined) ?? [];
            return (
              <RvRow key={i} label="Add signer">
                <span className="mono">{addr ? shortenAddress(addr, 4, 4) : '—'}</span>
                {perms.length ? (
                  <span style={{ color: 'var(--text-faint)' }}> · {perms.join(' / ')}</span>
                ) : null}
              </RvRow>
            );
          }
          if (kind === 'remove_member') {
            const addr = action.walletAddress as string | undefined;
            return (
              <RvRow key={i} label="Remove signer">
                <span className="mono">{addr ? shortenAddress(addr, 4, 4) : '—'}</span>
              </RvRow>
            );
          }
          if (kind === 'change_threshold') {
            const next = action.newThreshold as number | undefined;
            return (
              <RvRow key={i} label="New required approvals">
                <b>{next ?? '—'}</b>
              </RvRow>
            );
          }
          if (kind === 'add_spending_limit') {
            const amount = action.amountRaw as string | undefined;
            const period = action.period as string | undefined;
            const destinations = (action.destinations as string[] | undefined) ?? [];
            return (
              <RvRow key={i} label="New auto-pay rule">
                <span className="mono">
                  {amount ? formatRawAmount(amount, 6) : '—'} USDC
                </span>
                <span style={{ color: 'var(--text-faint)' }}> · {periodLabel(period)}</span>
                <div style={{ marginTop: 2, fontSize: 11, color: 'var(--text-muted)' }}>
                  {destinations.length} {destinations.length === 1 ? 'vendor' : 'vendors'}
                </div>
              </RvRow>
            );
          }
          if (kind === 'remove_spending_limit') {
            return (
              <RvRow key={i} label="Remove auto-pay rule">
                <span style={{ color: 'var(--text-muted)' }}>
                  The agent can no longer pay vendors automatically under this policy.
                </span>
              </RvRow>
            );
          }
          return (
            <RvRow key={i} label="Change">
              <span style={{ color: 'var(--text-muted)' }}>{kind || 'Treasury configuration update'}</span>
            </RvRow>
          );
        })}
      </div>
    </div>
  );
}

function RvRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rv-row">
      <span className="rv-k">{label}</span>
      <span className="rv-v">{children}</span>
    </div>
  );
}

function periodLabel(period: string | undefined): string {
  if (period === 'month') return 'per month';
  if (period === 'week') return 'per week';
  if (period === 'day') return 'per day';
  // 'total' rather than 'one-time' — the Squads OneTime period is a
  // total budget that never resets, not a single payment cap.
  if (period === 'one_time') return 'total';
  return period ?? 'per period';
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
                <th style={{ width: '70%' }}>Signer</th>
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

// ─── Friendly title / subtitle ──────────────────────────────────────────
// summarizeProposal is the cross-app fallback (used in the proposals
// list); on the detail page we have room for a more descriptive
// rendering, especially for config proposals where the semanticType
// alone ("Treasury config") doesn't tell the operator what's changing.

function friendlyTitle(
  proposal: DecimalProposal,
  linkedSpendingLimitPolicy: SpendingLimitPolicy | null,
): string {
  const semantic = proposal.semanticType ?? '';
  const policyName = linkedSpendingLimitPolicy?.policyName;
  if (semantic === 'add_spending_limit') {
    return policyName ? `New auto-pay rule · ${policyName}` : 'New auto-pay rule';
  }
  if (semantic === 'remove_spending_limit') {
    return policyName ? `Remove auto-pay rule · ${policyName}` : 'Remove auto-pay rule';
  }
  if (semantic === 'replace_spending_limit') {
    return policyName ? `Update auto-pay rule · ${policyName}` : 'Update auto-pay rule';
  }
  if (semantic === 'add_agent_member') return 'Add agent as signer';
  return summarizeProposal(proposal);
}

function friendlySubtitle(proposal: DecimalProposal): string {
  const semantic = proposal.semanticType ?? '';
  if (semantic.startsWith('add_spending_limit')) return 'Auto-pay rule';
  if (semantic === 'remove_spending_limit' || semantic === 'replace_spending_limit') return 'Auto-pay rule';
  if (semantic === 'add_member' || semantic === 'remove_member' || semantic === 'add_agent_member')
    return 'Team membership';
  if (semantic === 'change_threshold') return 'Required approvals';
  if (semantic === 'send_payment' || semantic === 'send_payment_run') return 'Payment';
  return proposalTypeLabel(proposal);
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
