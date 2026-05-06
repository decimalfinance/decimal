import { useMemo } from 'react';
import { Link } from 'react-router';
import { orbAccountUrl, shortenAddress } from '../domain';
import type {
  SquadsConfigAction,
  SquadsConfigProposal,
  SquadsProposalDecision,
  SquadsProposalPendingVoter,
  SquadsProposalStatus,
  UserWallet,
} from '../types';

export const STATUS_LABEL: Record<SquadsProposalStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  approved: 'Approved · ready to execute',
  executed: 'Executed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

export const STATUS_TONE: Record<SquadsProposalStatus, 'ok' | 'info' | 'warn' | 'danger'> = {
  draft: 'info',
  active: 'info',
  approved: 'ok',
  executed: 'ok',
  cancelled: 'warn',
  rejected: 'danger',
};

export function ProposalCard({
  proposal,
  ownPersonalWallets,
  currentUserId,
  busy,
  onApprove,
  onExecute,
  treasuryLabel,
  treasuryLinkTo,
  detailLinkTo,
}: {
  proposal: SquadsConfigProposal;
  ownPersonalWallets: UserWallet[];
  currentUserId: string;
  busy: 'approve' | 'execute' | null;
  onApprove: (signerWalletId: string) => void;
  onExecute: (signerWalletId: string) => void;
  treasuryLabel?: string | null;
  treasuryLinkTo?: string | null;
  detailLinkTo?: string | null;
}) {
  const pendingVoterWallet = useMemo(() => {
    const ownAddresses = new Set(ownPersonalWallets.map((w) => w.walletAddress));
    const match = proposal.pendingVoters.find(
      (v) =>
        v.personalWallet?.userId === currentUserId
        && ownAddresses.has(v.walletAddress),
    );
    if (!match) return null;
    return ownPersonalWallets.find((w) => w.walletAddress === match.walletAddress) ?? null;
  }, [proposal.pendingVoters, ownPersonalWallets, currentUserId]);

  const executeWallet = useMemo(() => {
    const executable = new Set(proposal.canExecuteWalletAddresses);
    return ownPersonalWallets.find((w) => executable.has(w.walletAddress)) ?? null;
  }, [proposal.canExecuteWalletAddresses, ownPersonalWallets]);

  const approvalCount = proposal.approvals.length;
  const isReadyToExecute = proposal.status === 'approved';
  const isClosed =
    proposal.status === 'executed'
    || proposal.status === 'cancelled'
    || proposal.status === 'rejected';

  const titleNode = (
    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>
      {summarizeActions(proposal.actions)}
    </h2>
  );

  return (
    <article
      style={{
        border: '1px solid var(--ax-border)',
        borderRadius: 12,
        padding: 16,
        background: 'var(--ax-surface-1)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          {treasuryLabel ? (
            treasuryLinkTo ? (
              <Link
                to={treasuryLinkTo}
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--ax-text-muted)',
                  textDecoration: 'none',
                }}
              >
                {treasuryLabel}
              </Link>
            ) : (
              <div
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--ax-text-muted)',
                  marginBottom: 2,
                }}
              >
                {treasuryLabel}
              </div>
            )
          ) : null}
          {detailLinkTo ? (
            <Link
              to={detailLinkTo}
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              {titleNode}
            </Link>
          ) : (
            titleNode
          )}
          <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 4 }}>
            Tx index #{proposal.transactionIndex} ·{' '}
            <a
              href={orbAccountUrl(proposal.proposalPda)}
              target="_blank"
              rel="noreferrer"
              className="rd-addr-link"
              title={proposal.proposalPda}
            >
              proposal {shortenAddress(proposal.proposalPda, 4, 4)}
            </a>
            {detailLinkTo ? (
              <>
                {' · '}
                <Link to={detailLinkTo} style={{ textDecoration: 'underline', textDecorationColor: 'rgba(255,255,255,0.25)', color: 'inherit' }}>
                  Open detail
                </Link>
              </>
            ) : null}
          </div>
        </div>
        <StatusPill status={proposal.status} />
      </header>

      <ActionsSummary actions={proposal.actions} />

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginBottom: 6 }}>
          Approvals: <strong>{approvalCount}</strong> of <strong>{proposal.threshold}</strong> required
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {proposal.approvals.map((decision) => (
            <DecisionPill key={decision.walletAddress} kind="approval" decision={decision} />
          ))}
          {proposal.pendingVoters.map((voter) => (
            <PendingVoterPill key={voter.walletAddress} voter={voter} />
          ))}
          {proposal.rejections.map((decision) => (
            <DecisionPill key={`rej-${decision.walletAddress}`} kind="rejection" decision={decision} />
          ))}
        </div>
      </div>

      {!isClosed ? (
        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            marginTop: 16,
            flexWrap: 'wrap',
          }}
        >
          {pendingVoterWallet ? (
            <button
              type="button"
              className="button button-primary"
              onClick={() => onApprove(pendingVoterWallet.userWalletId)}
              disabled={busy !== null}
              aria-busy={busy === 'approve'}
              title={`Approve as ${shortenAddress(pendingVoterWallet.walletAddress, 4, 4)}`}
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
              title={`Execute as ${shortenAddress(executeWallet.walletAddress, 4, 4)}`}
            >
              {busy === 'execute' ? 'Executing…' : 'Execute proposal'}
            </button>
          ) : null}
          {!pendingVoterWallet && !isReadyToExecute ? (
            <span style={{ fontSize: 12, color: 'var(--ax-text-muted)', alignSelf: 'center' }}>
              Awaiting other signers
            </span>
          ) : null}
          {isReadyToExecute && !executeWallet ? (
            <span style={{ fontSize: 12, color: 'var(--ax-text-muted)', alignSelf: 'center' }}>
              Threshold met. Awaiting execute from a member with execute permission.
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function ActionsSummary({ actions }: { actions: SquadsConfigAction[] }) {
  if (actions.length === 0) return null;
  return (
    <ul
      style={{
        margin: '12px 0 0',
        padding: 0,
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {actions.map((action, idx) => (
        <li
          key={idx}
          style={{
            fontSize: 13,
            padding: '6px 10px',
            border: '1px solid var(--ax-border)',
            borderRadius: 6,
            background: 'var(--ax-surface-2)',
          }}
        >
          {describeAction(action)}
        </li>
      ))}
    </ul>
  );
}

export function summarizeActions(actions: SquadsConfigAction[]): string {
  if (actions.length === 0) return 'Empty proposal';
  if (actions.length === 1) return describeAction(actions[0]!);
  return `${describeAction(actions[0]!)} (+ ${actions.length - 1} more)`;
}

export function describeAction(action: SquadsConfigAction): string {
  if (action.kind === 'add_member' && 'walletAddress' in action) {
    const perms = (action.permissions ?? []).join('/') || 'no permissions';
    return `Add member ${shortenAddress(action.walletAddress, 4, 4)} with ${perms}`;
  }
  if (action.kind === 'remove_member' && 'walletAddress' in action) {
    return `Remove member ${shortenAddress(action.walletAddress, 4, 4)}`;
  }
  if (action.kind === 'change_threshold' && 'newThreshold' in action) {
    return `Change threshold to ${action.newThreshold}`;
  }
  return action.kind;
}

export function StatusPill({ status }: { status: SquadsProposalStatus }) {
  const tone = STATUS_TONE[status];
  const palette = {
    ok: { bg: 'rgba(60, 180, 110, 0.18)', fg: 'rgb(120, 220, 160)' },
    info: { bg: 'rgba(255, 255, 255, 0.06)', fg: 'var(--ax-text-muted)' },
    warn: { bg: 'rgba(220, 170, 60, 0.18)', fg: 'rgb(240, 200, 100)' },
    danger: { bg: 'rgba(220, 80, 80, 0.18)', fg: 'rgb(240, 130, 130)' },
  }[tone];
  return (
    <span
      className="rd-pill"
      style={{
        padding: '4px 10px',
        fontSize: 12,
        background: palette.bg,
        color: palette.fg,
        border: '1px solid transparent',
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function DecisionPill({
  kind,
  decision,
}: {
  kind: 'approval' | 'rejection' | 'cancellation';
  decision: SquadsProposalDecision;
}) {
  const palette = kind === 'approval'
    ? { bg: 'rgba(60, 180, 110, 0.18)', fg: 'rgb(120, 220, 160)', icon: '✓' }
    : kind === 'rejection'
      ? { bg: 'rgba(220, 80, 80, 0.18)', fg: 'rgb(240, 130, 130)', icon: '✗' }
      : { bg: 'rgba(220, 170, 60, 0.18)', fg: 'rgb(240, 200, 100)', icon: '⊘' };
  const name = decision.organizationMembership?.user.displayName
    ?? decision.organizationMembership?.user.email
    ?? shortenAddress(decision.walletAddress, 4, 4);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 12,
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
      }}
      title={decision.walletAddress}
    >
      <span aria-hidden>{palette.icon}</span>
      {name}
    </span>
  );
}

export function PendingVoterPill({ voter }: { voter: SquadsProposalPendingVoter }) {
  const name = voter.organizationMembership?.user.displayName
    ?? voter.organizationMembership?.user.email
    ?? shortenAddress(voter.walletAddress, 4, 4);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 12,
        borderRadius: 999,
        background: 'transparent',
        color: 'var(--ax-text-muted)',
        border: '1px dashed var(--ax-border)',
      }}
      title={voter.walletAddress}
    >
      <span aria-hidden>○</span>
      {name}
    </span>
  );
}
