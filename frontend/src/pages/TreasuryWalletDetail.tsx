import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  AuthenticatedSession,
  OrganizationPersonalWallet,
  SquadsDetailMember,
  SquadsMemberLinkStatus,
  SquadsPermission,
  SquadsTreasuryDetail,
  TreasuryWallet,
  UserWallet,
} from '../types';
import { orbAccountUrl, shortenAddress } from '../domain';
import { signAndSubmitIntent } from '../lib/squads-pipeline';
import { useToast } from '../ui/Toast';
import { ProposalsTable, type ProposalsTableBusy } from '../ui/ProposalsTable';
import type { DecimalProposal } from '../types';

const ALL_PERMISSIONS: SquadsPermission[] = ['initiate', 'vote', 'execute'];

type LinkStatusDescriptor = {
  label: string;
  tone: 'ok' | 'info' | 'warn' | 'danger';
  hint: string;
};

const LINK_STATUS: Record<SquadsMemberLinkStatus, LinkStatusDescriptor> = {
  linked: {
    label: 'Linked',
    tone: 'ok',
    hint: 'Active personal wallet, active org member, active wallet authorization.',
  },
  unlinked: {
    label: 'Unlinked',
    tone: 'info',
    hint: 'No personal wallet on Decimal matches this address.',
  },
  wallet_inactive: {
    label: 'Wallet inactive',
    tone: 'warn',
    hint: 'A matching personal wallet exists but is no longer active.',
  },
  not_org_member: {
    label: 'Not in org',
    tone: 'warn',
    hint: 'Personal wallet matches but the user is not an active member of this organization.',
  },
  authorization_missing: {
    label: 'Authorization missing',
    tone: 'warn',
    hint: 'Linked but the local Squads-member wallet authorization is not active.',
  },
};

const PERMISSION_LABEL: Record<SquadsPermission, string> = {
  initiate: 'Initiate',
  vote: 'Vote',
  execute: 'Execute',
};

export function TreasuryWalletDetailPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId, treasuryWalletId } = useParams<{
    organizationId: string;
    treasuryWalletId: string;
  }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const currentMembership = useMemo(
    () => session.organizations.find((o) => o.organizationId === organizationId),
    [session.organizations, organizationId],
  );
  const isAdmin =
    currentMembership?.role === 'owner' || currentMembership?.role === 'admin';

  const treasuryListQuery = useQuery({
    queryKey: ['treasury-wallets', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });

  const wallet: TreasuryWallet | undefined = useMemo(
    () =>
      treasuryListQuery.data?.items.find((w) => w.treasuryWalletId === treasuryWalletId),
    [treasuryListQuery.data, treasuryWalletId],
  );

  const isSquads = wallet?.source === 'squads_v4';

  const detailQuery = useQuery({
    queryKey: ['treasury-wallet-detail', organizationId, treasuryWalletId] as const,
    queryFn: () => api.getSquadsTreasuryDetail(organizationId!, treasuryWalletId!),
    enabled: Boolean(organizationId && treasuryWalletId && isSquads),
    refetchInterval: 30_000,
  });

  const ownPersonalWalletsQuery = useQuery({
    queryKey: ['personal-wallets'] as const,
    queryFn: () => api.listPersonalWallets(),
    // Needed by both the admin-only AddMember flow AND any Squads voter who
    // wants to approve / execute proposals from the inline section below.
    enabled: Boolean(isSquads),
  });
  const ownPersonalWallets = useMemo(
    () =>
      (ownPersonalWalletsQuery.data?.items ?? []).filter(
        (w) => w.status === 'active' && w.chain === 'solana',
      ),
    [ownPersonalWalletsQuery.data],
  );

  const orgPersonalWalletsQuery = useQuery({
    queryKey: ['organization-personal-wallets', organizationId] as const,
    queryFn: () => api.listOrganizationPersonalWallets(organizationId!),
    enabled: Boolean(organizationId && isSquads && isAdmin),
  });
  const orgPersonalWallets = orgPersonalWalletsQuery.data?.items ?? [];

  // True when the current user has at least one personal wallet that is an
  // on-chain Squads member of this multisig — gates the "Proposals" link.
  const isCurrentUserSquadsMember = useMemo(() => {
    const detail = detailQuery.data;
    if (!detail) return false;
    return detail.squads.members.some(
      (m) => m.personalWallet?.userId === session.user.userId,
    );
  }, [detailQuery.data, session.user.userId]);

  const [openDialog, setOpenDialog] = useState<'add-member' | 'change-threshold' | null>(null);
  const [proposalsBusy, setProposalsBusy] = useState<ProposalsTableBusy | null>(null);

  // Inline proposals (this treasury only). Only fetch once we know the wallet
  // is a Squads treasury; non-members get a 403 silently and the section
  // stays hidden.
  const treasuryProposalsQuery = useQuery({
    queryKey: ['organization-proposals', organizationId, 'pending', treasuryWalletId] as const,
    queryFn: () =>
      api.listOrganizationProposals(organizationId!, {
        status: 'pending',
        treasuryWalletId: treasuryWalletId!,
        limit: 25,
      }),
    enabled: Boolean(organizationId && treasuryWalletId && isSquads),
    refetchInterval: 20_000,
    retry: false,
  });
  const treasuryProposals = treasuryProposalsQuery.data?.items ?? [];

  async function refreshProposals(decimalProposalId?: string) {
    await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
    if (decimalProposalId) {
      await queryClient.invalidateQueries({
        queryKey: ['organization-proposal', organizationId, decimalProposalId],
      });
    }
  }

  const proposalApproveMutation = useMutation({
    mutationFn: async (input: { proposal: DecimalProposal; signerWalletId: string }) => {
      const intent = await api.createProposalApprovalIntent(
        organizationId!,
        input.proposal.decimalProposalId,
        { memberPersonalWalletId: input.signerWalletId },
      );
      return signAndSubmitIntent({ intent, signerPersonalWalletId: input.signerWalletId });
    },
    onSuccess: async (_sig, vars) => {
      success('Approval submitted.');
      await refreshProposals(vars.proposal.decimalProposalId);
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Approve failed.');
    },
    onSettled: () => setProposalsBusy(null),
  });

  const proposalExecuteMutation = useMutation({
    mutationFn: async (input: { proposal: DecimalProposal; signerWalletId: string }) => {
      const decimalProposalId = input.proposal.decimalProposalId;
      const intent = await api.createProposalExecuteIntent(
        organizationId!,
        decimalProposalId,
        { memberPersonalWalletId: input.signerWalletId },
      );
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: input.signerWalletId,
      });
      try {
        await api.confirmProposalExecution(organizationId!, decimalProposalId, { signature: sig });
      } catch {
        // ignore
      }
      if (input.proposal.proposalType === 'config_transaction') {
        try {
          await api.syncSquadsTreasuryMembers(organizationId!, treasuryWalletId!);
        } catch {
          // ignore
        }
      }
      return { decimalProposalId, signature: sig };
    },
    onSuccess: async (result) => {
      success('Proposal executed.');
      await refreshProposals(result.decimalProposalId);
      await queryClient.invalidateQueries({
        queryKey: ['treasury-wallet-detail', organizationId, treasuryWalletId],
      });
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Execute failed.');
    },
    onSettled: () => setProposalsBusy(null),
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncSquadsTreasuryMembers(organizationId!, treasuryWalletId!),
    onSuccess: (synced) => {
      queryClient.setQueryData(
        ['treasury-wallet-detail', organizationId, treasuryWalletId],
        synced,
      );
      success('Synced from chain.');
    },
    onError: (err) => {
      toastError(err instanceof Error ? err.message : 'Sync failed.');
    },
  });

  async function refreshDetail() {
    await queryClient.invalidateQueries({
      queryKey: ['treasury-wallet-detail', organizationId, treasuryWalletId],
    });
  }

  if (!organizationId || !treasuryWalletId) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Treasury wallet unavailable</h2>
          <p className="rd-state-body">Pick a treasury wallet from the list.</p>
        </div>
      </main>
    );
  }

  if (treasuryListQuery.isLoading) {
    return (
      <main className="page-frame">
        <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
        <div className="rd-skeleton rd-skeleton-block" style={{ height: 240 }} />
      </main>
    );
  }

  if (!wallet) {
    return (
      <main className="page-frame">
        <header className="page-header">
          <div>
            <p className="eyebrow">
              <Link to={`/organizations/${organizationId}/wallets`}>← Treasury accounts</Link>
            </p>
            <h1>Treasury wallet not found</h1>
            <p>This wallet doesn't exist in this organization.</p>
          </div>
        </header>
      </main>
    );
  }

  const detail = detailQuery.data;
  const detailError = detailQuery.error;

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">
            <Link to={`/organizations/${organizationId}/wallets`}>← Treasury accounts</Link>
          </p>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {wallet.displayName || 'Untitled wallet'}
            {isSquads ? <span className="rd-pill rd-pill-info">Squads</span> : null}
            {!wallet.isActive ? <span className="rd-pill rd-pill-info">Inactive</span> : null}
          </h1>
          <p>
            <a
              href={orbAccountUrl(wallet.address)}
              target="_blank"
              rel="noreferrer"
              className="rd-addr-link"
            >
              {shortenAddress(wallet.address, 6, 6)}
            </a>
            {wallet.notes ? <> · {wallet.notes}</> : null}
          </p>
        </div>
        {isSquads ? (
          <div className="page-actions">
            {isCurrentUserSquadsMember ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  navigate(`/organizations/${organizationId}/proposals?treasuryWalletId=${treasuryWalletId}`)
                }
              >
                Proposals
              </button>
            ) : null}
            {isAdmin ? (
              <>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending}
                  aria-busy={syncMutation.isPending}
                  title="Re-pull on-chain Squads state and refresh local Decimal authorizations."
                >
                  {syncMutation.isPending ? 'Syncing…' : 'Sync from chain'}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setOpenDialog('change-threshold')}
                >
                  Change threshold
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setOpenDialog('add-member')}
                >
                  + Add member
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      {!isSquads ? (
        <section className="rd-section" style={{ marginTop: 8 }}>
          <div className="rd-empty-cell" style={{ padding: '32px 24px' }}>
            <strong>Externally registered wallet</strong>
            <p style={{ margin: 0 }}>
              This treasury wallet was added by address. Squads-specific detail isn't available.
            </p>
          </div>
        </section>
      ) : detailQuery.isLoading ? (
        <section className="rd-section" style={{ marginTop: 8 }}>
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 180, marginBottom: 8 }} />
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 240 }} />
        </section>
      ) : detailError ? (
        <section className="rd-section" style={{ marginTop: 8 }}>
          <div className="rd-empty-cell" style={{ padding: '32px 24px' }}>
            <strong>Couldn't load Squads detail</strong>
            <p style={{ margin: 0 }}>
              {detailError instanceof ApiError || detailError instanceof Error
                ? detailError.message
                : 'Unknown error.'}
            </p>
          </div>
        </section>
      ) : detail ? (
        <SquadsDetailContent detail={detail} wallet={wallet} />
      ) : null}

      {detail && isCurrentUserSquadsMember ? (
        <section className="rd-section" style={{ marginTop: 24 }}>
          <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>Pending proposals</h2>
            <Link
              to={`/organizations/${organizationId}/proposals?treasuryWalletId=${treasuryWalletId}`}
              style={{ fontSize: 13, color: 'var(--ax-accent)', textDecoration: 'none' }}
            >
              View all proposals →
            </Link>
          </header>
          {treasuryProposalsQuery.isLoading ? (
            <div className="rd-skeleton rd-skeleton-block" style={{ height: 80 }} />
          ) : treasuryProposalsQuery.error ? (
            <div className="rd-empty-cell" style={{ padding: '24px' }}>
              <span style={{ fontSize: 13, color: 'var(--ax-text-muted)' }}>
                Couldn't load proposals.
              </span>
            </div>
          ) : (
            <ProposalsTable
              proposals={treasuryProposals}
              ownPersonalWallets={ownPersonalWallets}
              currentUserId={session.user.userId}
              organizationId={organizationId}
              busy={proposalsBusy}
              showTreasuryColumn={false}
              emptyHint="No pending proposals for this treasury."
              onApprove={(proposal, signerWalletId) => {
                setProposalsBusy({ decimalProposalId: proposal.decimalProposalId, action: 'approve' });
                proposalApproveMutation.mutate({ proposal, signerWalletId });
              }}
              onExecute={(proposal, signerWalletId) => {
                setProposalsBusy({ decimalProposalId: proposal.decimalProposalId, action: 'execute' });
                proposalExecuteMutation.mutate({ proposal, signerWalletId });
              }}
            />
          )}
        </section>
      ) : null}

      {detail && openDialog === 'add-member' ? (
        <AddMemberDialog
          organizationId={organizationId}
          treasuryWalletId={treasuryWalletId}
          detail={detail}
          ownPersonalWallets={ownPersonalWallets}
          orgPersonalWallets={orgPersonalWallets}
          orgPersonalWalletsLoading={orgPersonalWalletsQuery.isLoading}
          onClose={() => setOpenDialog(null)}
          onConfirmed={async () => {
            setOpenDialog(null);
            await refreshDetail();
            success('Member added and synced from chain.');
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}

      {detail && openDialog === 'change-threshold' ? (
        <ChangeThresholdDialog
          organizationId={organizationId}
          treasuryWalletId={treasuryWalletId}
          detail={detail}
          ownPersonalWallets={ownPersonalWallets}
          onClose={() => setOpenDialog(null)}
          onConfirmed={async () => {
            setOpenDialog(null);
            await refreshDetail();
            success('Threshold changed.');
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}
    </main>
  );
}

function SquadsDetailContent({
  detail,
  wallet,
}: {
  detail: SquadsTreasuryDetail;
  wallet: TreasuryWallet;
}) {
  const { squads } = detail;

  return (
    <>
      {!squads.localStateMatchesChain ? (
        <section
          className="rd-section"
          style={{
            marginTop: 8,
            border: '1px solid rgba(220, 170, 60, 0.45)',
            borderRadius: 12,
            padding: 16,
            background: 'rgba(220, 170, 60, 0.08)',
          }}
        >
          <strong>Local cache differs from on-chain state.</strong>
          <p style={{ margin: '4px 0 0', fontSize: 13, opacity: 0.85 }}>
            Some fields on this page were read live from chain. The treasury wallet record will be reconciled the next time the wallet is updated.
          </p>
        </section>
      ) : null}

      <section className="rd-section" style={{ marginTop: 16 }}>
        <header style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>Multisig configuration</h2>
        </header>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '14px 24px',
          }}
        >
          <InfoRow label="Vault PDA">
            <ExplorerAddress value={squads.vaultPda} />
          </InfoRow>
          <InfoRow label="Multisig PDA">
            <ExplorerAddress value={squads.multisigPda} />
          </InfoRow>
          <InfoRow label="Vault index">{squads.vaultIndex}</InfoRow>
          <InfoRow label="Threshold">
            {squads.threshold} of {squads.members.length}
          </InfoRow>
          <InfoRow label="Time lock">
            {squads.timeLockSeconds === 0 ? 'None' : `${squads.timeLockSeconds}s`}
          </InfoRow>
          <InfoRow label="Authority">
            {squads.isAutonomous ? (
              <span title="Multisig governs itself — no external config authority.">Autonomous</span>
            ) : squads.configAuthority ? (
              <ExplorerAddress value={squads.configAuthority} />
            ) : (
              '—'
            )}
          </InfoRow>
          <InfoRow label="Transaction index">
            {squads.transactionIndex}
            {squads.staleTransactionIndex !== '0' ? (
              <span style={{ marginLeft: 8, opacity: 0.7, fontSize: 12 }}>
                (stale ≤ {squads.staleTransactionIndex})
              </span>
            ) : null}
          </InfoRow>
          <InfoRow label="Program">
            <ExplorerAddress value={squads.programId} />
          </InfoRow>
        </div>
      </section>

      <section className="rd-section" style={{ marginTop: 24 }}>
        <header style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>Capabilities</h2>
        </header>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <CapabilityPill ok={squads.capabilities.canInitiate} label="Initiate" />
          <CapabilityPill ok={squads.capabilities.canVote} label="Vote" />
          <CapabilityPill ok={squads.capabilities.canExecute} label="Execute" />
        </div>
      </section>

      <section className="rd-section" style={{ marginTop: 24 }}>
        <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>Members</h2>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
            {squads.members.length} on-chain · {squads.members.filter((m) => m.linkStatus === 'linked').length} linked
          </p>
        </header>
        <div className="rd-table-shell">
          <table className="rd-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Address</th>
                <th>Permissions</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {squads.members.map((member) => (
                <MemberRow key={member.walletAddress} member={member} />
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: 12, fontSize: 12, opacity: 0.6 }}>
          Wallet record last updated {new Date(wallet.updatedAt).toLocaleString()}.
        </p>
      </section>
    </>
  );
}

function MemberRow({ member }: { member: SquadsDetailMember }) {
  const linked = member.organizationMembership;
  const status = LINK_STATUS[member.linkStatus];

  return (
    <tr>
      <td>
        {linked ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar
              avatarUrl={linked.user.avatarUrl}
              fallback={linked.user.displayName || linked.user.email}
            />
            <div>
              <div style={{ fontWeight: 500 }}>
                {linked.user.displayName || linked.user.email}
              </div>
              {linked.user.displayName ? (
                <div style={{ fontSize: 12, opacity: 0.7 }}>{linked.user.email}</div>
              ) : null}
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
                Org role: {linked.role}
              </div>
            </div>
          </div>
        ) : (
          <span style={{ opacity: 0.7, fontStyle: 'italic' }}>External signer</span>
        )}
      </td>
      <td>
        <a
          href={orbAccountUrl(member.walletAddress)}
          target="_blank"
          rel="noreferrer"
          className="rd-addr-link"
          title={member.walletAddress}
        >
          {shortenAddress(member.walletAddress, 4, 4)}
        </a>
      </td>
      <td>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {member.permissions.length === 0 ? (
            <span style={{ opacity: 0.6 }}>None</span>
          ) : (
            member.permissions.map((p) => (
              <span key={p} className="rd-pill rd-pill-info" style={{ fontSize: 11 }}>
                {PERMISSION_LABEL[p]}
              </span>
            ))
          )}
        </div>
      </td>
      <td>
        <span
          className="rd-pill rd-pill-info"
          title={status.hint}
          style={{
            fontSize: 11,
            background:
              status.tone === 'warn'
                ? 'rgba(220, 170, 60, 0.18)'
                : status.tone === 'danger'
                  ? 'rgba(220, 80, 80, 0.18)'
                  : undefined,
          }}
        >
          {status.label}
        </span>
      </td>
    </tr>
  );
}

function CapabilityPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className="rd-pill rd-pill-info"
      style={{
        fontSize: 12,
        opacity: ok ? 1 : 0.45,
      }}
      title={ok ? `At least one member can ${label.toLowerCase()}.` : `No member has ${label.toLowerCase()} permission.`}
    >
      <span className="rd-pill-dot" />
      {label}: {ok ? 'yes' : 'no'}
    </span>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.6 }}>
        {label}
      </span>
      <span style={{ fontSize: 14 }}>{children}</span>
    </div>
  );
}

function ExplorerAddress({ value }: { value: string }) {
  return (
    <a
      href={orbAccountUrl(value)}
      target="_blank"
      rel="noreferrer"
      className="rd-addr-link"
      title={value}
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
    >
      {shortenAddress(value, 6, 6)}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Dialogs: Add Member + Change Threshold
// ---------------------------------------------------------------------------

type ProposalDialogPhase =
  | 'config'
  | 'review'
  | 'creating'
  | 'awaiting-approvals'
  | 'executing'
  | 'syncing'
  | 'done'
  | 'error';

type ProposalDialogState = {
  phase: ProposalDialogPhase;
  errorMessage: string | null;
  createSignature: string | null;
  executeSignature: string | null;
};

const initialProposalState: ProposalDialogState = {
  phase: 'config',
  errorMessage: null,
  createSignature: null,
  executeSignature: null,
};

// Personal wallets that the current user owns AND are on-chain multisig
// members with the given permission.
function ownWalletsThatAreMembers(
  ownWallets: UserWallet[],
  detail: SquadsTreasuryDetail,
  permission: SquadsPermission,
) {
  const memberAddresses = new Set(
    detail.squads.members
      .filter((m) => m.permissions.includes(permission))
      .map((m) => m.walletAddress),
  );
  return ownWallets.filter((w) => memberAddresses.has(w.walletAddress));
}

function DialogShell({
  labelledBy,
  onClose,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="rd-dialog" style={{ maxWidth: 600 }}>
        {children}
      </div>
    </div>
  );
}

function PermissionTogglePills({
  permissions,
  onToggle,
  disabled,
}: {
  permissions: SquadsPermission[];
  onToggle: (perm: SquadsPermission) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {ALL_PERMISSIONS.map((perm) => {
        const active = permissions.includes(perm);
        return (
          <button
            key={perm}
            type="button"
            onClick={() => onToggle(perm)}
            disabled={disabled}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 999,
              border: '1px solid var(--ax-border)',
              background: active ? 'var(--ax-accent-dim)' : 'transparent',
              color: active ? 'var(--ax-accent)' : 'var(--ax-text-muted)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {PERMISSION_LABEL[perm]}
          </button>
        );
      })}
    </div>
  );
}

function AddMemberDialog(props: {
  organizationId: string;
  treasuryWalletId: string;
  detail: SquadsTreasuryDetail;
  ownPersonalWallets: UserWallet[];
  orgPersonalWallets: OrganizationPersonalWallet[];
  orgPersonalWalletsLoading: boolean;
  onClose: () => void;
  onConfirmed: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const {
    organizationId,
    treasuryWalletId,
    detail,
    ownPersonalWallets,
    orgPersonalWallets,
    orgPersonalWalletsLoading,
    onClose,
    onConfirmed,
    onError,
  } = props;

  const eligibleNewMembers = useMemo(() => {
    const existing = new Set(detail.squads.members.map((m) => m.walletAddress));
    return orgPersonalWallets.filter((w) => !existing.has(w.walletAddress));
  }, [orgPersonalWallets, detail.squads.members]);

  const eligibleCreators = useMemo(
    () => ownWalletsThatAreMembers(ownPersonalWallets, detail, 'initiate'),
    [ownPersonalWallets, detail],
  );
  const [newMemberWalletId, setNewMemberWalletId] = useState('');
  const [permissions, setPermissions] = useState<SquadsPermission[]>([...ALL_PERMISSIONS]);
  const [adjustThreshold, setAdjustThreshold] = useState(false);
  const [newThreshold, setNewThreshold] = useState<number>(detail.squads.threshold);
  const [creatorWalletId, setCreatorWalletId] = useState('');
  const [state, setState] = useState<ProposalDialogState>(initialProposalState);

  // Auto-select sole creator if only one option.
  useEffect(() => {
    if (!creatorWalletId && eligibleCreators.length >= 1) {
      setCreatorWalletId(eligibleCreators[0]!.userWalletId);
    }
  }, [eligibleCreators, creatorWalletId]);

  const newMemberWallet = useMemo(
    () => eligibleNewMembers.find((w) => w.userWalletId === newMemberWalletId) ?? null,
    [eligibleNewMembers, newMemberWalletId],
  );

  const togglePermission = (perm: SquadsPermission) => {
    setPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  };

  const isWorking =
    state.phase === 'creating'
    || state.phase === 'executing'
    || state.phase === 'syncing';

  async function runCreateProposal() {
    if (!newMemberWalletId || !creatorWalletId || permissions.length === 0) return;
    setState({ ...initialProposalState, phase: 'creating' });
    try {
      const intent = await api.createSquadsAddMemberProposalIntent(
        organizationId,
        treasuryWalletId,
        {
          creatorPersonalWalletId: creatorWalletId,
          newMemberPersonalWalletId: newMemberWalletId,
          permissions,
          newThreshold: adjustThreshold ? newThreshold : undefined,
        },
      );
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: creatorWalletId,
      });
      // Record the creation tx signature against the persisted DecimalProposal
      // record so the org-level proposal listing shows localStatus=submitted
      // until the next chain refetch. Backend now returns the proposal row
      // alongside the intent.
      const decimalProposalId = intent.decimalProposal?.decimalProposalId ?? null;
      if (decimalProposalId) {
        try {
          await api.confirmProposalSubmission(organizationId, decimalProposalId, { signature: sig });
        } catch {
          // ignore — local status will catch up on refresh
        }
      }
      setState((s) => ({ ...s, phase: 'awaiting-approvals', createSignature: sig }));
      await onConfirmed();
    } catch (err) {
      const msg = err instanceof ApiError || err instanceof Error
        ? err.message
        : 'Add member failed.';
      setState((s) => ({ ...s, phase: 'error', errorMessage: msg }));
      onError(msg);
    }
  }

  // Empty / pre-conditions
  if (eligibleCreators.length === 0) {
    return (
      <DialogShell labelledBy="rd-add-member-empty" onClose={onClose}>
        <h2 id="rd-add-member-empty" className="rd-dialog-title">
          You can't initiate a proposal
        </h2>
        <p className="rd-dialog-body">
          To add a Squads member, the proposal must be initiated by one of your personal wallets that already holds the <strong>Initiate</strong> permission on this multisig. None of your personal wallets are members with that permission.
        </p>
        <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
          <button type="button" className="button button-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </DialogShell>
    );
  }

  if (state.phase === 'config' || state.phase === 'review') {
    const validForm =
      newMemberWalletId
      && creatorWalletId
      && permissions.length > 0
      && (!adjustThreshold || (newThreshold >= 1 && newThreshold <= 65_535));

    return (
      <DialogShell labelledBy="rd-add-member-title" onClose={onClose}>
        <h2 id="rd-add-member-title" className="rd-dialog-title">
          Add Squads member
        </h2>
        <p className="rd-dialog-body">
          Create a Squads <code>AddMember</code> config proposal. {detail.squads.threshold <= 1
            ? 'Your single signature creates, approves, and executes the proposal in two transactions, then Decimal syncs local state.'
            : `Your signature creates and casts the first approval. ${detail.squads.threshold - 1} more approvals are needed before the proposal can execute.`}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label className="field">
            New member
            {orgPersonalWalletsLoading ? (
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 36 }} />
            ) : eligibleNewMembers.length === 0 ? (
              <div
                style={{
                  padding: 10,
                  border: '1px dashed var(--ax-border)',
                  borderRadius: 6,
                  fontSize: 13,
                  color: 'var(--ax-text-muted)',
                }}
              >
                No eligible org members. Either everyone with a personal wallet is already a Squads member, or no other org members have created a personal wallet yet.
              </div>
            ) : (
              <select
                value={newMemberWalletId}
                onChange={(e) => setNewMemberWalletId(e.target.value)}
                required
              >
                <option value="">Pick a personal wallet…</option>
                {eligibleNewMembers.map((w) => (
                  <option key={w.userWalletId} value={w.userWalletId}>
                    {w.user.displayName || w.user.email} · {shortenAddress(w.walletAddress, 4, 4)}
                  </option>
                ))}
              </select>
            )}
          </label>

          <div className="field">
            Permissions
            <PermissionTogglePills
              permissions={permissions}
              onToggle={togglePermission}
            />
            {permissions.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--ax-warning)', margin: '4px 0 0' }}>
                Pick at least one permission.
              </p>
            ) : null}
          </div>

          <div className="field">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={adjustThreshold}
                onChange={(e) => setAdjustThreshold(e.target.checked)}
              />
              <span>Also change approval threshold</span>
            </label>
            {adjustThreshold ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <input
                  type="number"
                  min={1}
                  max={65_535}
                  value={newThreshold}
                  onChange={(e) => setNewThreshold(Math.max(1, Number(e.target.value) || 1))}
                  style={{ width: 80 }}
                />
                <span style={{ fontSize: 13, color: 'var(--ax-text-muted)' }}>
                  approvals required after this proposal executes (current: {detail.squads.threshold})
                </span>
              </div>
            ) : null}
          </div>

          <label className="field">
            Your signing wallet
            <select
              value={creatorWalletId}
              onChange={(e) => setCreatorWalletId(e.target.value)}
              disabled={eligibleCreators.length <= 1}
              required
            >
              {eligibleCreators.map((w) => (
                <option key={w.userWalletId} value={w.userWalletId}>
                  {(w.label ?? 'Untitled')} · {shortenAddress(w.walletAddress, 4, 4)}
                </option>
              ))}
            </select>
            <p style={{ fontSize: 12, color: 'var(--ax-text-muted)', margin: '4px 0 0' }}>
              Must be a current Squads member with the <strong>Initiate</strong> permission.
            </p>
          </label>
        </div>

        <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!validForm}
            onClick={() => runCreateProposal()}
          >
            {detail.squads.threshold <= 1 ? 'Sign and add member' : 'Sign and submit proposal'}
          </button>
        </div>
      </DialogShell>
    );
  }

  // In-flight phases (creating / executing / syncing) and terminal phases.
  return (
    <DialogShell labelledBy="rd-add-member-progress" onClose={onClose}>
      <h2 id="rd-add-member-progress" className="rd-dialog-title">
        {state.phase === 'done'
          ? 'Member added'
          : state.phase === 'awaiting-approvals'
            ? 'Proposal submitted — awaiting more approvals'
            : state.phase === 'error'
              ? 'Add member failed'
              : 'Working…'}
      </h2>
      <p className="rd-dialog-body">
        {newMemberWallet ? (
          <>
            Adding{' '}
            <strong>{newMemberWallet.user.displayName || newMemberWallet.user.email}</strong>
            {' '}({shortenAddress(newMemberWallet.walletAddress, 4, 4)}) with permissions {permissions.join(', ')}.
          </>
        ) : null}
      </p>

      <ProposalProgress
        steps={[
          { key: 'creating', label: 'Sign + submit create proposal' },
          { key: 'executing', label: 'Sign + submit execute' },
          { key: 'syncing', label: 'Sync Decimal authorizations' },
        ]}
        currentPhase={state.phase}
        skippedExecute={detail.squads.threshold > 1}
        signatures={{
          create: state.createSignature,
          execute: state.executeSignature,
        }}
      />

      {state.phase === 'awaiting-approvals' ? (
        <div
          style={{
            padding: 12,
            border: '1px solid rgba(220, 170, 60, 0.45)',
            borderRadius: 8,
            background: 'rgba(220, 170, 60, 0.08)',
            marginTop: 12,
            fontSize: 13,
          }}
        >
          The proposal landed and you've cast the first approval.
          {' '}
          <strong>{detail.squads.threshold - 1} more approval{detail.squads.threshold - 1 === 1 ? '' : 's'}</strong>
          {' '}from other Squads voters are required before it can execute.
        </div>
      ) : null}

      {state.errorMessage ? (
        <div
          style={{
            padding: 12,
            border: '1px solid var(--ax-danger)',
            borderRadius: 8,
            background: 'var(--ax-surface-1)',
            marginTop: 12,
            fontSize: 13,
          }}
        >
          <strong style={{ color: 'var(--ax-danger)' }}>Error:</strong> {state.errorMessage}
        </div>
      ) : null}

      <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
        {state.phase === 'error' ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setState(initialProposalState)}
          >
            Back to form
          </button>
        ) : null}
        <button
          type="button"
          className="button button-primary"
          onClick={onClose}
          disabled={isWorking}
        >
          {state.phase === 'done' ? 'Close' : isWorking ? 'Working…' : 'Close'}
        </button>
      </div>
    </DialogShell>
  );
}

function ChangeThresholdDialog(props: {
  organizationId: string;
  treasuryWalletId: string;
  detail: SquadsTreasuryDetail;
  ownPersonalWallets: UserWallet[];
  onClose: () => void;
  onConfirmed: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const {
    organizationId,
    treasuryWalletId,
    detail,
    ownPersonalWallets,
    onClose,
    onConfirmed,
    onError,
  } = props;

  const eligibleCreators = useMemo(
    () => ownWalletsThatAreMembers(ownPersonalWallets, detail, 'initiate'),
    [ownPersonalWallets, detail],
  );
  const voterCount = detail.squads.members.filter((m) => m.permissions.includes('vote')).length;

  const [newThreshold, setNewThreshold] = useState<number>(detail.squads.threshold);
  const [creatorWalletId, setCreatorWalletId] = useState('');
  const [state, setState] = useState<ProposalDialogState>(initialProposalState);

  useEffect(() => {
    if (!creatorWalletId && eligibleCreators.length >= 1) {
      setCreatorWalletId(eligibleCreators[0]!.userWalletId);
    }
  }, [eligibleCreators, creatorWalletId]);

  const isWorking =
    state.phase === 'creating'
    || state.phase === 'executing'
    || state.phase === 'syncing';

  async function runChangeThreshold() {
    if (!creatorWalletId) return;
    if (newThreshold === detail.squads.threshold) {
      onError('New threshold is the same as the current threshold.');
      return;
    }
    if (newThreshold > voterCount) {
      onError(`Threshold cannot exceed the number of voters (${voterCount}).`);
      return;
    }
    setState({ ...initialProposalState, phase: 'creating' });
    try {
      const intent = await api.createSquadsChangeThresholdProposalIntent(
        organizationId,
        treasuryWalletId,
        {
          creatorPersonalWalletId: creatorWalletId,
          newThreshold,
        },
      );
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: creatorWalletId,
      });
      const decimalProposalId = intent.decimalProposal?.decimalProposalId ?? null;
      if (decimalProposalId) {
        try {
          await api.confirmProposalSubmission(organizationId, decimalProposalId, { signature: sig });
        } catch {
          // ignore — local status will catch up on refresh
        }
      }
      setState((s) => ({ ...s, phase: 'awaiting-approvals', createSignature: sig }));
      await onConfirmed();
    } catch (err) {
      const msg = err instanceof ApiError || err instanceof Error
        ? err.message
        : 'Change threshold failed.';
      setState((s) => ({ ...s, phase: 'error', errorMessage: msg }));
      onError(msg);
    }
  }

  if (eligibleCreators.length === 0) {
    return (
      <DialogShell labelledBy="rd-threshold-empty" onClose={onClose}>
        <h2 id="rd-threshold-empty" className="rd-dialog-title">
          You can't initiate a proposal
        </h2>
        <p className="rd-dialog-body">
          None of your personal wallets are Squads members with the <strong>Initiate</strong> permission on this multisig.
        </p>
        <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
          <button type="button" className="button button-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </DialogShell>
    );
  }

  if (state.phase === 'config' || state.phase === 'review') {
    const valid =
      creatorWalletId
      && newThreshold >= 1
      && newThreshold <= voterCount
      && newThreshold !== detail.squads.threshold;

    return (
      <DialogShell labelledBy="rd-threshold-title" onClose={onClose}>
        <h2 id="rd-threshold-title" className="rd-dialog-title">
          Change approval threshold
        </h2>
        <p className="rd-dialog-body">
          Create a Squads <code>ChangeThreshold</code> config proposal. Current threshold:{' '}
          <strong>{detail.squads.threshold} of {voterCount}</strong>.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label className="field">
            New threshold
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="number"
                min={1}
                max={voterCount}
                value={newThreshold}
                onChange={(e) => setNewThreshold(Math.max(1, Number(e.target.value) || 1))}
                style={{ width: 80 }}
              />
              <span style={{ fontSize: 13, color: 'var(--ax-text-muted)' }}>
                of {voterCount} voting member{voterCount === 1 ? '' : 's'}
              </span>
            </div>
          </label>

          <label className="field">
            Your signing wallet
            <select
              value={creatorWalletId}
              onChange={(e) => setCreatorWalletId(e.target.value)}
              disabled={eligibleCreators.length <= 1}
              required
            >
              {eligibleCreators.map((w) => (
                <option key={w.userWalletId} value={w.userWalletId}>
                  {(w.label ?? 'Untitled')} · {shortenAddress(w.walletAddress, 4, 4)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!valid}
            onClick={() => runChangeThreshold()}
          >
            {detail.squads.threshold <= 1 ? 'Sign and change threshold' : 'Sign and submit proposal'}
          </button>
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell labelledBy="rd-threshold-progress" onClose={onClose}>
      <h2 id="rd-threshold-progress" className="rd-dialog-title">
        {state.phase === 'done'
          ? 'Threshold changed'
          : state.phase === 'awaiting-approvals'
            ? 'Proposal submitted — awaiting more approvals'
            : state.phase === 'error'
              ? 'Change threshold failed'
              : 'Working…'}
      </h2>
      <p className="rd-dialog-body">
        Changing threshold from <strong>{detail.squads.threshold}</strong> to <strong>{newThreshold}</strong>.
      </p>

      <ProposalProgress
        steps={[
          { key: 'creating', label: 'Sign + submit create proposal' },
          { key: 'executing', label: 'Sign + submit execute' },
          { key: 'syncing', label: 'Sync Decimal authorizations' },
        ]}
        currentPhase={state.phase}
        skippedExecute={detail.squads.threshold > 1}
        signatures={{
          create: state.createSignature,
          execute: state.executeSignature,
        }}
      />

      {state.phase === 'awaiting-approvals' ? (
        <div
          style={{
            padding: 12,
            border: '1px solid rgba(220, 170, 60, 0.45)',
            borderRadius: 8,
            background: 'rgba(220, 170, 60, 0.08)',
            marginTop: 12,
            fontSize: 13,
          }}
        >
          The proposal landed and you've cast the first approval.
          {' '}
          <strong>{detail.squads.threshold - 1} more approval{detail.squads.threshold - 1 === 1 ? '' : 's'}</strong>
          {' '}from other Squads voters are required before it can execute.
        </div>
      ) : null}

      {state.errorMessage ? (
        <div
          style={{
            padding: 12,
            border: '1px solid var(--ax-danger)',
            borderRadius: 8,
            background: 'var(--ax-surface-1)',
            marginTop: 12,
            fontSize: 13,
          }}
        >
          <strong style={{ color: 'var(--ax-danger)' }}>Error:</strong> {state.errorMessage}
        </div>
      ) : null}

      <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
        {state.phase === 'error' ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setState(initialProposalState)}
          >
            Back to form
          </button>
        ) : null}
        <button
          type="button"
          className="button button-primary"
          onClick={onClose}
          disabled={isWorking}
        >
          {state.phase === 'done' ? 'Close' : isWorking ? 'Working…' : 'Close'}
        </button>
      </div>
    </DialogShell>
  );
}

function ProposalProgress({
  steps,
  currentPhase,
  skippedExecute,
  signatures,
}: {
  steps: Array<{ key: ProposalDialogPhase; label: string }>;
  currentPhase: ProposalDialogPhase;
  skippedExecute: boolean;
  signatures: { create: string | null; execute: string | null };
}) {
  const order: ProposalDialogPhase[] = ['creating', 'executing', 'syncing', 'done'];
  const currentIndex = order.indexOf(currentPhase);

  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6 }}>
      {steps.map((step, i) => {
        const stepIndex = order.indexOf(step.key);
        const skipped = skippedExecute && (step.key === 'executing' || step.key === 'syncing');
        const active = currentPhase === step.key;
        const done = !skipped && currentIndex > stepIndex;
        return (
          <li
            key={step.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 13,
              color: skipped
                ? 'var(--ax-text-faint)'
                : active
                  ? 'var(--ax-text)'
                  : done
                    ? 'var(--ax-text-muted)'
                    : 'var(--ax-text-faint)',
              opacity: skipped ? 0.5 : 1,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                display: 'inline-grid',
                placeItems: 'center',
                fontSize: 11,
                fontWeight: 600,
                background: done ? 'var(--ax-accent-dim)' : 'var(--ax-surface-2)',
                color: done ? 'var(--ax-accent)' : 'var(--ax-text-muted)',
                border: active ? '1px solid var(--ax-accent)' : '1px solid transparent',
              }}
            >
              {done ? '✓' : i + 1}
            </span>
            {step.label}
            {skipped ? (
              <span style={{ fontSize: 11 }}>· deferred (more approvals needed)</span>
            ) : active ? (
              <span style={{ fontSize: 12 }}>· in progress…</span>
            ) : null}
          </li>
        );
      })}
      {signatures.create ? (
        <li style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--ax-text-muted)', marginTop: 6 }}>
          create sig: {shortenAddress(signatures.create, 6, 6)}
        </li>
      ) : null}
      {signatures.execute ? (
        <li style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--ax-text-muted)' }}>
          execute sig: {shortenAddress(signatures.execute, 6, 6)}
        </li>
      ) : null}
    </ol>
  );
}

function Avatar({ avatarUrl, fallback }: { avatarUrl: string | null; fallback: string }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }}
      />
    );
  }
  const initials = fallback
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
  return (
    <span
      aria-hidden
      style={{
        width: 32,
        height: 32,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 600,
        background: 'rgba(255, 255, 255, 0.08)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
      }}
    >
      {initials || '?'}
    </span>
  );
}
