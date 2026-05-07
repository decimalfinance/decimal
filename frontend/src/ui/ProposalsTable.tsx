import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { formatRelativeTime, formatTimestamp } from '../domain';
import type { DecimalProposal, SquadsProposalStatus, UserWallet } from '../types';
import { proposalTypeLabel, summarizeProposal } from './DecimalProposalCard';

export type ProposalsTableBusy = {
  decimalProposalId: string;
  action: 'approve' | 'execute';
};

const STATUS_DISPLAY: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  prepared: { label: 'Prepared', tone: 'info' },
  submitted: { label: 'Submitted', tone: 'info' },
  active: { label: 'Active', tone: 'info' },
  approved: { label: 'Ready to execute', tone: 'success' },
  executed: { label: 'Executed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

function statusDisplay(status: SquadsProposalStatus | string) {
  return STATUS_DISPLAY[status] ?? { label: status, tone: 'neutral' as const };
}

export function ProposalsTable({
  proposals,
  ownPersonalWallets,
  currentUserId,
  organizationId,
  busy,
  showTreasuryColumn,
  onApprove,
  onExecute,
}: {
  proposals: DecimalProposal[];
  ownPersonalWallets: UserWallet[];
  currentUserId: string;
  organizationId: string;
  busy: ProposalsTableBusy | null;
  showTreasuryColumn: boolean;
  onApprove: (proposal: DecimalProposal, signerWalletId: string) => void;
  onExecute: (proposal: DecimalProposal, signerWalletId: string) => void;
}) {
  const colCount = showTreasuryColumn ? 6 : 5;
  return (
    <div className="rd-table-shell">
      <table className="rd-table">
        <thead>
          <tr>
            <th style={{ width: showTreasuryColumn ? '32%' : '40%' }}>Proposal</th>
            <th style={{ width: '12%' }}>Type</th>
            {showTreasuryColumn ? <th style={{ width: '16%' }}>Treasury</th> : null}
            <th style={{ width: '14%' }}>Status</th>
            <th style={{ width: '20%' }}>Approvals</th>
            <th aria-label="Actions" style={{ width: '6%', textAlign: 'right' }} />
          </tr>
        </thead>
        <tbody>
          {proposals.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="rd-empty-cell">
                <strong>No proposals yet</strong>
                <p style={{ margin: 0 }}>Pending proposals will show up here.</p>
              </td>
            </tr>
          ) : (
            proposals.map((proposal) => (
              <ProposalRow
                key={proposal.decimalProposalId}
                proposal={proposal}
                ownPersonalWallets={ownPersonalWallets}
                currentUserId={currentUserId}
                organizationId={organizationId}
                busy={busy}
                showTreasuryColumn={showTreasuryColumn}
                onApprove={onApprove}
                onExecute={onExecute}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function ProposalRow({
  proposal,
  ownPersonalWallets,
  currentUserId,
  organizationId,
  busy,
  showTreasuryColumn,
  onApprove,
  onExecute,
}: {
  proposal: DecimalProposal;
  ownPersonalWallets: UserWallet[];
  currentUserId: string;
  organizationId: string;
  busy: ProposalsTableBusy | null;
  showTreasuryColumn: boolean;
  onApprove: (proposal: DecimalProposal, signerWalletId: string) => void;
  onExecute: (proposal: DecimalProposal, signerWalletId: string) => void;
}) {
  const navigate = useNavigate();
  const voting = proposal.voting;
  const treasuryName = proposal.treasuryWallet?.displayName ?? 'Untitled treasury';
  const detailHref = `/organizations/${organizationId}/proposals/${proposal.decimalProposalId}`;

  const pendingVoterWallet = useMemo(() => {
    if (!voting) return null;
    const ownAddresses = new Set(ownPersonalWallets.map((w) => w.walletAddress));
    const match = voting.pendingVoters.find(
      (v) =>
        v.personalWallet?.userId === currentUserId
        && ownAddresses.has(v.walletAddress),
    );
    if (!match) return null;
    return ownPersonalWallets.find((w) => w.walletAddress === match.walletAddress) ?? null;
  }, [voting, ownPersonalWallets, currentUserId]);

  const executeWallet = useMemo(() => {
    if (!voting) return null;
    const executable = new Set(voting.canExecuteWalletAddresses);
    return ownPersonalWallets.find((w) => executable.has(w.walletAddress)) ?? null;
  }, [voting, ownPersonalWallets]);

  const status = statusDisplay(proposal.status);
  const isReadyToExecute = proposal.status === 'approved';
  const isClosed =
    proposal.status === 'executed'
    || proposal.status === 'cancelled'
    || proposal.status === 'rejected';
  const isThisRowBusy = busy?.decimalProposalId === proposal.decimalProposalId;
  const isAnyRowBusy = busy !== null;

  const stopRow = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <tr
      onClick={() => navigate(detailHref)}
      style={{ cursor: 'pointer' }}
    >
      <td>
        <div className="rd-recipient-main">
          <span className="rd-recipient-name">{summarizeProposal(proposal)}</span>
          <span className="rd-recipient-ref">
            {formatRelativeTime(proposal.createdAt)}
            {proposal.squads.transactionIndex
              ? ` · #${proposal.squads.transactionIndex}`
              : ''}
          </span>
        </div>
      </td>
      <td>
        <span className="rd-origin">{proposalTypeLabel(proposal)}</span>
      </td>
      {showTreasuryColumn ? (
        <td>
          {proposal.treasuryWalletId ? (
            <span style={{ color: 'var(--ax-text)', fontWeight: 500 }}>{treasuryName}</span>
          ) : (
            <span style={{ color: 'var(--ax-text-faint)' }}>—</span>
          )}
        </td>
      ) : null}
      <td>
        <span className="rd-pill" data-tone={status.tone} title={formatTimestamp(proposal.createdAt)}>
          <span className="rd-pill-dot" aria-hidden />
          {status.label}
        </span>
      </td>
      <td>
        {voting ? (
          <span style={{ fontSize: 13, color: 'var(--ax-text-secondary)' }}>
            {voting.approvals.length} of {voting.threshold}
            {voting.pendingVoters.length > 0 && !isClosed ? (
              <span style={{ color: 'var(--ax-text-muted)', fontSize: 12 }}>
                {' '}· {voting.pendingVoters.length} awaiting
              </span>
            ) : null}
          </span>
        ) : (
          <span style={{ color: 'var(--ax-text-faint)', fontSize: 12 }}>—</span>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        {isClosed ? (
          <span className="rd-btn-arrow" style={{ color: 'var(--ax-text-muted)' }} aria-hidden>
            →
          </span>
        ) : pendingVoterWallet ? (
          <button
            type="button"
            className="button button-primary"
            style={{ padding: '4px 12px', fontSize: 12 }}
            onClick={(e) => {
              stopRow(e);
              onApprove(proposal, pendingVoterWallet.userWalletId);
            }}
            disabled={isAnyRowBusy}
            aria-busy={isThisRowBusy && busy?.action === 'approve'}
          >
            {isThisRowBusy && busy?.action === 'approve' ? 'Approving…' : 'Approve'}
          </button>
        ) : isReadyToExecute && executeWallet ? (
          <button
            type="button"
            className="button button-primary"
            style={{ padding: '4px 12px', fontSize: 12 }}
            onClick={(e) => {
              stopRow(e);
              onExecute(proposal, executeWallet.userWalletId);
            }}
            disabled={isAnyRowBusy}
            aria-busy={isThisRowBusy && busy?.action === 'execute'}
          >
            {isThisRowBusy && busy?.action === 'execute' ? 'Executing…' : 'Execute'}
          </button>
        ) : (
          <span className="rd-btn-arrow" style={{ color: 'var(--ax-text-muted)' }} aria-hidden>
            →
          </span>
        )}
      </td>
    </tr>
  );
}
