import { useMemo } from 'react';
import { Link } from 'react-router';
import { formatRelativeTime, formatTimestamp, shortenAddress } from '../domain';
import type { DecimalProposal, UserWallet } from '../types';
import {
  StatusPill,
  TypePill,
  proposalTypeLabel,
  summarizeProposal,
} from './DecimalProposalCard';

export type ProposalsTableBusy = {
  decimalProposalId: string;
  action: 'approve' | 'execute';
};

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
  return (
    <div className="rd-table-shell">
      <table className="rd-table">
        <thead>
          <tr>
            <th>Proposal</th>
            {showTreasuryColumn ? <th>Treasury</th> : null}
            <th>Status</th>
            <th>Created</th>
            <th style={{ textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((proposal) => (
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
          ))}
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

  const isReadyToExecute = proposal.status === 'approved';
  const isClosed =
    proposal.status === 'executed'
    || proposal.status === 'cancelled'
    || proposal.status === 'rejected';
  const isThisRowBusy = busy?.decimalProposalId === proposal.decimalProposalId;
  const isAnyRowBusy = busy !== null;

  return (
    <tr>
      <td>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <TypePill label={proposalTypeLabel(proposal)} />
          </div>
          <Link
            to={detailHref}
            style={{
              color: 'inherit',
              textDecoration: 'none',
              fontWeight: 500,
              fontSize: 14,
            }}
          >
            {summarizeProposal(proposal)}
          </Link>
          <span style={{ fontSize: 11, color: 'var(--ax-text-muted)' }}>
            {proposal.squads.transactionIndex
              ? `Tx index #${proposal.squads.transactionIndex}`
              : `Local: ${proposal.localStatus}`}
            {proposal.squads.proposalPda
              ? ` · ${shortenAddress(proposal.squads.proposalPda, 4, 4)}`
              : ''}
          </span>
        </div>
      </td>
      {showTreasuryColumn ? (
        <td>
          {proposal.treasuryWalletId ? (
            <Link
              to={`/organizations/${organizationId}/wallets/${proposal.treasuryWalletId}`}
              style={{ color: 'inherit', textDecoration: 'underline', textDecorationColor: 'rgba(255,255,255,0.18)' }}
            >
              {treasuryName}
            </Link>
          ) : (
            <span style={{ color: 'var(--ax-text-muted)' }}>—</span>
          )}
        </td>
      ) : null}
      <td>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <StatusPill status={proposal.status} />
          {voting ? (
            <span style={{ fontSize: 11, color: 'var(--ax-text-muted)' }}>
              {voting.approvals.length} of {voting.threshold} approvals
            </span>
          ) : null}
        </div>
      </td>
      <td>
        <span title={formatTimestamp(proposal.createdAt)} style={{ fontSize: 12 }}>
          {formatRelativeTime(proposal.createdAt)}
        </span>
      </td>
      <td style={{ textAlign: 'right' }}>
        {isClosed ? (
          <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>—</span>
        ) : pendingVoterWallet ? (
          <button
            type="button"
            className="button button-primary"
            style={{ padding: '4px 12px', fontSize: 12 }}
            onClick={() => onApprove(proposal, pendingVoterWallet.userWalletId)}
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
            onClick={() => onExecute(proposal, executeWallet.userWalletId)}
            disabled={isAnyRowBusy}
            aria-busy={isThisRowBusy && busy?.action === 'execute'}
          >
            {isThisRowBusy && busy?.action === 'execute' ? 'Executing…' : 'Execute'}
          </button>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--ax-text-muted)' }}>
            {isReadyToExecute ? 'Awaiting execute' : 'Awaiting signers'}
          </span>
        )}
      </td>
    </tr>
  );
}
