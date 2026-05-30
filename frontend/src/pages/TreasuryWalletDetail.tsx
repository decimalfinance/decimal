import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  AuthenticatedSession,
  OrganizationPersonalWallet,
  SpendingLimitPolicy,
  SpendingLimitPolicyStatus,
  SquadsDetailMember,
  SquadsPermission,
  SquadsTreasuryDetail,
  TreasuryWallet,
  UserWallet,
} from '../types';
import { formatRawUsdcCompact, shortenAddress } from '../domain';
import { signAndSubmitIntent } from '../lib/squads-pipeline';
import { useToast } from '../ui/Toast';
import { ProposalsTable, type ProposalsTableBusy } from '../ui/ProposalsTable';
import type { DecimalProposal } from '../types';

const ALL_PERMISSIONS: SquadsPermission[] = ['initiate', 'vote', 'execute'];

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

  // Treasury balance — backend returns balances for ALL treasury wallets in
  // one call. Pick the one for THIS wallet to display in the header.
  const balancesQuery = useQuery({
    queryKey: ['treasury-wallet-balances', organizationId] as const,
    queryFn: () => api.listTreasuryWalletBalances(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 15_000,
  });
  const balanceForThisWallet = useMemo(
    () =>
      balancesQuery.data?.items.find((b) => b.treasuryWalletId === treasuryWalletId) ?? null,
    [balancesQuery.data, treasuryWalletId],
  );

  // True when the current user has at least one personal wallet that is an
  // on-chain Squads member of this multisig — gates the "Proposals" link.
  const isCurrentUserSquadsMember = useMemo(() => {
    const detail = detailQuery.data;
    if (!detail) return false;
    return detail.squads.members.some(
      (m) => m.personalWallet?.userId === session.user.userId,
    );
  }, [detailQuery.data, session.user.userId]);

  const [openDialog, setOpenDialog] = useState<'add-member' | 'change-threshold' | 'add-vault' | null>(null);
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
            {wallet.displayName || 'Untitled treasury'}
            {!wallet.isActive ? <span className="rd-pill rd-pill-info">Inactive</span> : null}
          </h1>
          {wallet.notes ? <p style={{ margin: '4px 0 0' }}>{wallet.notes}</p> : null}
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
                  onClick={() => setOpenDialog('add-vault')}
                >
                  + Add vault
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

      {isSquads ? (
        <div className="rd-metrics">
          <div className="rd-metric">
            <span className="rd-metric-label">Balance</span>
            <span className="rd-metric-value">
              {balanceForThisWallet?.usdcRaw
                ? formatRawUsdcCompact(balanceForThisWallet.usdcRaw)
                : balancesQuery.isLoading
                  ? '—'
                  : '0.00'}
            </span>
            <span className="rd-metric-sub">USDC</span>
          </div>
        </div>
      ) : null}

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
        <SquadsDetailContent detail={detail} />
      ) : null}

      {detail && isSquads ? (
        <SpendingLimitsSection
          organizationId={organizationId}
          treasuryWalletId={treasuryWalletId}
        />
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

      {wallet && openDialog === 'add-vault' ? (
        <AddSquadsVaultDialog
          organizationId={organizationId}
          baseWallet={wallet}
          siblingVaults={treasuryListQuery.data?.items ?? []}
          onClose={() => setOpenDialog(null)}
          onCreated={async (created) => {
            setOpenDialog(null);
            await queryClient.invalidateQueries({ queryKey: ['treasury-wallets', organizationId] });
            await queryClient.invalidateQueries({ queryKey: ['treasury-wallet-balances', organizationId] });
            success(`Vault "${created.displayName ?? 'untitled'}" added.`);
            navigate(`/organizations/${organizationId}/wallets/${created.treasuryWalletId}`);
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}
    </main>
  );
}

function SquadsDetailContent({
  detail,
}: {
  detail: SquadsTreasuryDetail;
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

      <section className="rd-section" style={{ marginTop: 24 }}>
        <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>Members</h2>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--ax-text-muted)' }}>
            {squads.threshold} of{' '}
            {squads.members.filter((m) => m.permissions.includes('vote')).length} approvals needed
          </p>
        </header>
        <div className="rd-table-shell">
          <table className="rd-table">
            <thead>
              <tr>
                <th>Member</th>
                <th style={{ width: 260, textAlign: 'right' }}>Permissions</th>
              </tr>
            </thead>
            <tbody>
              {squads.members.map((member) => (
                <MemberRow key={member.walletAddress} member={member} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function MemberRow({ member }: { member: SquadsDetailMember }) {
  const isAgent = Boolean(member.agentWallet || member.automationAgent);
  const linked = member.organizationMembership;

  return (
    <tr>
      <td>
        {isAgent ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <DecimalAgentAvatar />
            <div style={{ fontWeight: 500 }}>Decimal agent</div>
          </div>
        ) : linked ? (
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
                <div style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>{linked.user.email}</div>
              ) : null}
            </div>
          </div>
        ) : (
          <span style={{ color: 'var(--ax-text-muted)' }}>Unknown signer</span>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        <div style={{ display: 'inline-flex', gap: 5, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
          {member.permissions.length === 0 ? (
            <span style={{ color: 'var(--ax-text-muted)', fontSize: 11 }}>None</span>
          ) : (
            (['initiate', 'vote', 'execute'] as const).map((p) => {
              const active = member.permissions.includes(p);
              return (
                <span
                  key={p}
                  className={`permission-pill${active ? ' permission-pill-active' : ''}`}
                >
                  {PERMISSION_LABEL[p]}
                </span>
              );
            })
          )}
        </div>
      </td>
    </tr>
  );
}

function DecimalAgentAvatar() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: '50%',
        background: 'white',
        border: '1px solid var(--ax-border)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
      aria-hidden
    >
      <img
        src="/decimal-logo.png"
        alt=""
        style={{ width: '75%', height: '75%', objectFit: 'contain' }}
      />
    </span>
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
  const [failed, setFailed] = useState(false);
  const trimmedUrl = avatarUrl?.trim() || null;
  const showImage = trimmedUrl && !failed;

  if (showImage) {
    return (
      <img
        src={trimmedUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
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
        fontWeight: 700,
        color: 'var(--ax-text-secondary)',
        background: 'var(--ax-bg-elevated, #f6f6f6)',
        border: '1px solid var(--ax-border)',
        flexShrink: 0,
      }}
    >
      {initials || '?'}
    </span>
  );
}

// ─── Spending limits ───────────────────────────────────────────────────────
// "Spending limit" is the user-facing term for a Squads spending-limit policy.
// Each policy lets the Decimal agent pay vetted vendors up to an amount per
// period without going through the multisig vote for every single payment.

const SPENDING_LIMIT_STATUS_LABEL: Record<SpendingLimitPolicyStatus, string> = {
  proposed: 'Pending approval',
  active: 'Active',
  replacement_proposed: 'Editing',
  revocation_proposed: 'Removing',
  revoked: 'Removed',
  failed: 'Failed',
  paused: 'Paused',
};

const SPENDING_LIMIT_STATUS_TONE: Record<SpendingLimitPolicyStatus, 'success' | 'warning' | 'danger' | 'info'> = {
  proposed: 'warning',
  active: 'success',
  replacement_proposed: 'warning',
  revocation_proposed: 'warning',
  revoked: 'info',
  failed: 'danger',
  paused: 'info',
};

const SPENDING_LIMIT_PERIOD_LABEL: Record<string, string> = {
  one_time: 'one-time',
  day: 'per day',
  week: 'per week',
  month: 'per month',
};

function SpendingLimitsSection({
  organizationId,
  treasuryWalletId,
}: {
  organizationId: string;
  treasuryWalletId: string;
}) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [removingPolicy, setRemovingPolicy] = useState<SpendingLimitPolicy | null>(null);
  const policiesQuery = useQuery({
    queryKey: ['spending-limit-policies', organizationId, treasuryWalletId] as const,
    queryFn: () =>
      api.listSpendingLimitPolicies(organizationId, { treasuryWalletId }),
    enabled: Boolean(organizationId && treasuryWalletId),
  });

  const policies = policiesQuery.data?.items ?? [];

  return (
    <section className="rd-section" style={{ marginTop: 32 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 12,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>Spending limits</h2>
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 13,
              color: 'var(--ax-text-muted)',
              lineHeight: 1.5,
            }}
          >
            Let the Decimal agent pay allowlisted vendors up to a limit, without a vote each time.
          </p>
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={() => setCreateOpen(true)}
        >
          + New spending limit
        </button>
      </header>
      <div className="rd-table-shell">
        <table className="rd-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Limit</th>
              <th>Vendors</th>
              <th style={{ textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {policiesQuery.isLoading ? (
              <tr>
                <td colSpan={4} style={{ padding: 16 }}>
                  <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
                </td>
              </tr>
            ) : policies.length === 0 ? (
              <tr>
                <td colSpan={4} className="rd-empty-cell" style={{ padding: '28px 24px' }}>
                  <strong style={{ display: 'block', marginBottom: 4 }}>
                    No spending limits yet
                  </strong>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--ax-text-muted)', lineHeight: 1.55 }}>
                    Add one so the Decimal agent can pay vetted vendors for routine bills without
                    needing a human vote each time.
                  </p>
                </td>
              </tr>
            ) : (
              policies.map((policy) => (
                <SpendingLimitRow
                  key={policy.spendingLimitPolicyId}
                  policy={policy}
                  onRemove={() => setRemovingPolicy(policy)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {createOpen ? (
        <CreateSpendingLimitDialog
          organizationId={organizationId}
          treasuryWalletId={treasuryWalletId}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await queryClient.invalidateQueries({
              queryKey: ['spending-limit-policies', organizationId, treasuryWalletId],
            });
            await queryClient.invalidateQueries({
              queryKey: ['organization-proposals', organizationId],
            });
          }}
        />
      ) : null}

      {removingPolicy ? (
        <RemoveSpendingLimitDialog
          organizationId={organizationId}
          treasuryWalletId={treasuryWalletId}
          policy={removingPolicy}
          onClose={() => setRemovingPolicy(null)}
          onRemoved={async () => {
            setRemovingPolicy(null);
            await queryClient.invalidateQueries({
              queryKey: ['spending-limit-policies', organizationId, treasuryWalletId],
            });
            await queryClient.invalidateQueries({
              queryKey: ['organization-proposals', organizationId],
            });
          }}
        />
      ) : null}
    </section>
  );
}

function SpendingLimitRow({
  policy,
  onRemove,
}: {
  policy: SpendingLimitPolicy;
  onRemove: () => void;
}) {
  const status = policy.status as SpendingLimitPolicyStatus;
  const statusLabel = SPENDING_LIMIT_STATUS_LABEL[status] ?? policy.status;
  const statusTone = SPENDING_LIMIT_STATUS_TONE[status] ?? 'info';
  const periodLabel = SPENDING_LIMIT_PERIOD_LABEL[policy.period] ?? policy.period;
  const amountDisplay = `${formatRawUsdcCompact(policy.amountRaw)} USDC`;
  const destinationsCount = policy.destinations.length;
  // Remove only makes sense once the policy is live on chain. Pending /
  // already-revoked / failed states aren't removable from here.
  const canRemove = status === 'active';

  return (
    <tr>
      <td style={{ fontWeight: 500 }}>{policy.policyName}</td>
      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
        {amountDisplay} <span style={{ color: 'var(--ax-text-muted)', fontSize: 12 }}>{periodLabel}</span>
      </td>
      <td style={{ color: 'var(--ax-text-muted)', fontSize: 13 }}>
        {destinationsCount} vendor{destinationsCount === 1 ? '' : 's'}
      </td>
      <td style={{ textAlign: 'right' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <span className={`rd-pill rd-pill-${statusTone}`}>
            <span className="rd-pill-dot" aria-hidden />
            {statusLabel}
          </span>
          {canRemove ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={onRemove}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                color: 'var(--ax-danger)',
                borderColor: 'var(--ax-border)',
              }}
              aria-label={`Remove ${policy.policyName}`}
            >
              Remove
            </button>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

// ─── Create Spending Limit dialog ─────────────────────────────────────────
// 3-step flow mirroring Create Treasury:
//   1. config  — name, amount, period, vendor multi-select
//   2. review  — summary card
//   3. sign    — signing progress (signing → sending → confirming → saving)
// After step 3, the policy is created on-chain in `proposed` state and the
// existing multisig vote flow takes over.

type CreateSpendingLimitPhase =
  | 'idle'
  | 'signing'
  | 'submitting'
  | 'confirming-onchain'
  | 'persisting'
  | 'error';

const PERIOD_OPTIONS: Array<{ key: 'one_time' | 'day' | 'week' | 'month'; label: string }> = [
  { key: 'one_time', label: 'One-time' },
  { key: 'day', label: 'Per day' },
  { key: 'week', label: 'Per week' },
  { key: 'month', label: 'Per month' },
];

function CreateSpendingLimitDialog({
  organizationId,
  treasuryWalletId,
  onClose,
  onCreated,
}: {
  organizationId: string;
  treasuryWalletId: string;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const { success, error: toastError } = useToast();
  const [step, setStep] = useState<'config' | 'review' | 'sign'>('config');
  const [name, setName] = useState('');
  const [amountUsd, setAmountUsd] = useState('');
  const [period, setPeriod] = useState<'one_time' | 'day' | 'week' | 'month'>('month');
  const [selectedVendorIds, setSelectedVendorIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<CreateSpendingLimitPhase>('idle');
  const [phaseError, setPhaseError] = useState<string | null>(null);

  // Counterparty wallets — the vendors the agent can pay under this policy.
  const counterpartyWalletsQuery = useQuery({
    queryKey: ['counterparty-wallets', organizationId] as const,
    queryFn: () => api.listCounterpartyWallets(organizationId),
    enabled: Boolean(organizationId),
  });
  const counterpartyWallets = useMemo(
    () =>
      (counterpartyWalletsQuery.data?.items ?? []).filter(
        (w) => w.isActive && w.trustState === 'trusted',
      ),
    [counterpartyWalletsQuery.data],
  );

  // Auto-pick the user's personal wallet (signs the create proposal).
  const personalWalletsQuery = useQuery({
    queryKey: ['personal-wallets'] as const,
    queryFn: () => api.listPersonalWallets(),
  });
  const personalWallet = useMemo(() => {
    const items = personalWalletsQuery.data?.items ?? [];
    return items.find((w) => w.status === 'active' && w.chain === 'solana') ?? null;
  }, [personalWalletsQuery.data]);

  // Find the Decimal automation agent wallet (auto-added at org creation).
  const agentsQuery = useQuery({
    queryKey: ['automation-agents', organizationId] as const,
    queryFn: () => api.listAutomationAgents(organizationId),
    enabled: Boolean(organizationId),
  });
  const agentWallet = useMemo(() => {
    const agents = agentsQuery.data?.items ?? [];
    // Prefer the default decimal_operations agent; fall back to the first
    // active agent we find with at least one Privy wallet.
    const ordered = [
      ...agents.filter((a) => a.agentType === 'decimal_operations' && a.status === 'active'),
      ...agents.filter((a) => a.agentType !== 'decimal_operations' && a.status === 'active'),
    ];
    for (const agent of ordered) {
      const active = agent.wallets.find((w) => w.status === 'active');
      if (active) return { agent, wallet: active };
    }
    return null;
  }, [agentsQuery.data]);

  const intentMutation = useMutation({
    mutationFn: async () => {
      if (!personalWallet) throw new Error('Your signing wallet is still loading.');
      if (!agentWallet) throw new Error('No active Decimal agent found for this org.');
      const amountRaw = usdToRaw(amountUsd);
      const policyCode = nameToCode(name) || `policy-${Date.now()}`;
      return api.createSpendingLimitPolicyIntent(organizationId, treasuryWalletId, {
        creatorPersonalWalletId: personalWallet.userWalletId,
        agentWalletId: agentWallet.wallet.agentWalletId,
        policyName: name.trim(),
        policyCode,
        amountRaw,
        period,
        counterpartyWalletIds: selectedVendorIds,
      });
    },
    onSuccess: () => {
      setStep('review');
    },
    onError: (err) => {
      const message = err instanceof ApiError || err instanceof Error ? err.message : 'Could not prepare the proposal.';
      toastError(message);
    },
  });

  async function runSignAndConfirm() {
    const intent = intentMutation.data;
    if (!intent || !personalWallet) return;
    setStep('sign');
    setPhaseError(null);
    try {
      setPhase('signing');
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: personalWallet.userWalletId,
      });
      setPhase('submitting');
      setPhase('confirming-onchain');
      setPhase('persisting');
      await api.confirmProposalSubmission(organizationId, intent.decimalProposal.decimalProposalId, {
        signature: sig,
      });
      setPhase('idle');
      success('Spending limit submitted — needs team approval to activate.');
      await onCreated();
    } catch (err) {
      const message = err instanceof ApiError || err instanceof Error ? err.message : 'Could not create the spending limit.';
      setPhase('error');
      setPhaseError(message);
    }
  }

  const amountValid = amountUsd.trim().length > 0 && Number(amountUsd) > 0;
  const canContinue =
    name.trim().length > 0
    && amountValid
    && selectedVendorIds.length > 0
    && Boolean(personalWallet)
    && Boolean(agentWallet)
    && !intentMutation.isPending;

  return (
    <DialogShell labelledBy="rd-spending-title" onClose={onClose}>
      {step === 'config' ? (
        <>
          <h2 id="rd-spending-title" className="rd-dialog-title">New spending limit</h2>
          <p className="rd-dialog-body">
            Let the Decimal agent pay specific vendors up to a limit, without a team vote each time.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              intentMutation.mutate();
            }}
          >
            <label className="field" style={{ marginBottom: 20 }}>
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Cloud bills"
                autoComplete="off"
                autoFocus
                required
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
              <label className="field" style={{ marginBottom: 0 }}>
                Amount (USDC)
                <input
                  type="text"
                  inputMode="decimal"
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="5000"
                  required
                />
              </label>
              <div className="field" style={{ marginBottom: 0 }}>
                <span>Period</span>
                <div className="period-segmented" role="radiogroup" aria-label="Period">
                  {PERIOD_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={period === opt.key}
                      className={`period-btn${period === opt.key ? ' period-btn-selected' : ''}`}
                      onClick={() => setPeriod(opt.key)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="field" style={{ marginBottom: 24 }}>
              <span>Allowed vendors</span>
              {counterpartyWalletsQuery.isLoading ? (
                <div className="rd-skeleton rd-skeleton-block" style={{ height: 80 }} />
              ) : counterpartyWallets.length === 0 ? (
                <div
                  style={{
                    padding: 14,
                    border: '1px dashed var(--ax-border)',
                    borderRadius: 8,
                    fontSize: 13,
                    color: 'var(--ax-text-muted)',
                    lineHeight: 1.55,
                  }}
                >
                  No trusted vendors yet. Add vendors to the address book first.
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    border: '1px solid var(--ax-border)',
                    borderRadius: 8,
                    overflow: 'hidden',
                    maxHeight: 240,
                    overflowY: 'auto',
                  }}
                >
                  {counterpartyWallets.map((wallet, idx) => {
                    const selected = selectedVendorIds.includes(wallet.counterpartyWalletId);
                    return (
                      <label
                        key={wallet.counterpartyWalletId}
                        className="approver-row"
                        style={{
                          borderTop: idx === 0 ? 'none' : '1px solid var(--ax-border)',
                          background: selected ? 'var(--ax-surface-1)' : 'transparent',
                          cursor: 'pointer',
                          gridTemplateColumns: 'auto 1fr',
                        }}
                      >
                        <CustomCheckbox
                          checked={selected}
                          onChange={() =>
                            setSelectedVendorIds((prev) =>
                              prev.includes(wallet.counterpartyWalletId)
                                ? prev.filter((id) => id !== wallet.counterpartyWalletId)
                                : [...prev, wallet.counterpartyWalletId],
                            )
                          }
                        />
                        <div className="approver-row-body">
                          <div className="approver-row-name">
                            <span>{wallet.label}</span>
                          </div>
                          <div className="approver-row-sub">
                            {wallet.counterparty?.displayName ?? 'Vendor'}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
              <button type="button" className="button button-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="button button-primary"
                disabled={!canContinue}
                aria-busy={intentMutation.isPending}
              >
                {intentMutation.isPending ? 'Loading…' : 'Continue'}
              </button>
            </div>
          </form>
        </>
      ) : step === 'review' && intentMutation.data ? (
        <>
          <h2 id="rd-spending-title" className="rd-dialog-title">Review spending limit</h2>
          <p className="rd-dialog-body">
            Looks good? Submit it for team approval. The agent can only use it once approved.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SquadsReviewRow label="Name" value={name} />
            <SquadsReviewRow
              label="Limit"
              value={`${Number(amountUsd).toLocaleString()} USDC ${PERIOD_OPTIONS.find((o) => o.key === period)?.label.toLowerCase()}`}
            />
            <SquadsReviewRow
              label="Vendors"
              value={
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {selectedVendorIds.map((id) => {
                    const wallet = counterpartyWallets.find((w) => w.counterpartyWalletId === id);
                    return (
                      <li key={id} style={{ fontSize: 13 }}>
                        {wallet?.counterparty?.displayName ?? wallet?.label ?? 'Vendor'}
                      </li>
                    );
                  })}
                </ul>
              }
            />
          </div>
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button type="button" className="button button-secondary" onClick={() => setStep('config')}>
              Back
            </button>
            <button type="button" className="button button-primary" onClick={runSignAndConfirm}>
              Submit for approval
            </button>
          </div>
        </>
      ) : step === 'sign' ? (
        <>
          <h2 id="rd-spending-title" className="rd-dialog-title">Creating spending limit</h2>
          <p className="rd-dialog-body">This takes a few seconds. Don't close this window.</p>
          <ol style={{ listStyle: 'none', padding: 0, margin: '12px 0', display: 'grid', gap: 6 }}>
            {[
              { key: 'signing', label: 'Signing' },
              { key: 'submitting', label: 'Sending' },
              { key: 'confirming-onchain', label: 'Confirming' },
              { key: 'persisting', label: 'Saving spending limit' },
            ].map((s) => {
              const order = ['idle', 'signing', 'submitting', 'confirming-onchain', 'persisting'];
              const idx = order.indexOf(s.key);
              const cur = order.indexOf(phase === 'error' ? 'idle' : phase);
              const isDone = cur > idx;
              const isActive = phase === s.key;
              return (
                <li key={s.key} style={{
                  display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                  color: isActive ? 'var(--ax-text)' : isDone ? 'var(--ax-text-muted)' : 'var(--ax-text-faint)',
                }}>
                  <span aria-hidden style={{
                    width: 18, height: 18, borderRadius: 9, display: 'inline-grid', placeItems: 'center',
                    fontSize: 11, fontWeight: 600,
                    background: isDone ? 'var(--ax-accent-dim)' : 'var(--ax-surface-2)',
                    color: isDone ? 'var(--ax-accent)' : 'var(--ax-text-muted)',
                    border: isActive ? '1px solid var(--ax-accent)' : '1px solid transparent',
                  }}>{isDone ? '✓' : ''}</span>
                  {s.label}
                </li>
              );
            })}
          </ol>
          {phaseError ? (
            <div style={{
              padding: 12, border: '1px solid var(--ax-danger)', borderRadius: 6,
              fontSize: 13, lineHeight: 1.5, marginBottom: 12,
            }}>
              <strong style={{ display: 'block', marginBottom: 4, color: 'var(--ax-danger)' }}>
                Something went wrong
              </strong>
              <span style={{ color: 'var(--ax-text-muted)' }}>{phaseError}</span>
            </div>
          ) : null}
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setStep('review')}
              disabled={phase !== 'idle' && phase !== 'error'}
            >
              Back
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={() => runSignAndConfirm()}
              disabled={phase !== 'idle' && phase !== 'error'}
              aria-busy={phase !== 'idle' && phase !== 'error'}
            >
              {phase === 'idle' || phase === 'error' ? 'Submit for approval' : 'Working…'}
            </button>
          </div>
        </>
      ) : null}
    </DialogShell>
  );
}

// ─── Remove Spending Limit dialog ─────────────────────────────────────────
// Two-step flow:
//   1. confirm — surface what the policy is, what disappears, and what the
//      voting cost is. The remove is a Squads config proposal under the hood,
//      so it still needs the multisig to approve before the policy truly
//      goes away on chain.
//   2. sign    — same phased progress UI as Create / Replace so the user
//      gets a single mental model for "this is a chain-bound action".
type RemoveSpendingLimitPhase =
  | 'idle'
  | 'signing'
  | 'submitting'
  | 'confirming-onchain'
  | 'persisting'
  | 'error';

function RemoveSpendingLimitDialog({
  organizationId,
  policy,
  onClose,
  onRemoved,
}: {
  organizationId: string;
  treasuryWalletId: string;
  policy: SpendingLimitPolicy;
  onClose: () => void;
  onRemoved: () => void | Promise<void>;
}) {
  const { success, error: toastError } = useToast();
  const [step, setStep] = useState<'confirm' | 'sign'>('confirm');
  const [phase, setPhase] = useState<RemoveSpendingLimitPhase>('idle');
  const [phaseError, setPhaseError] = useState<string | null>(null);

  // Same signer-selection rule as Create: the operator's own personal wallet
  // submits the config-proposal-create instruction. Squads members vote
  // afterward; the agent wallet does NOT sign this — it's the one being
  // revoked.
  const personalWalletsQuery = useQuery({
    queryKey: ['personal-wallets'] as const,
    queryFn: () => api.listPersonalWallets(),
  });
  const personalWallet = useMemo(() => {
    const items = personalWalletsQuery.data?.items ?? [];
    return items.find((w) => w.status === 'active' && w.chain === 'solana') ?? null;
  }, [personalWalletsQuery.data]);

  async function runSignAndConfirm() {
    if (!personalWallet) {
      toastError('Your signing wallet is still loading.');
      return;
    }
    setStep('sign');
    setPhase('signing');
    setPhaseError(null);
    try {
      const intent = await api.removeSpendingLimitPolicyIntent(
        organizationId,
        policy.spendingLimitPolicyId,
        { creatorPersonalWalletId: personalWallet.userWalletId },
      );
      setPhase('submitting');
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: personalWallet.userWalletId,
      });
      setPhase('confirming-onchain');
      setPhase('persisting');
      await api.confirmProposalSubmission(
        organizationId,
        intent.decimalProposal.decimalProposalId,
        { signature: sig },
      );
      setPhase('idle');
      success('Removal submitted — needs team approval to take effect.');
      await onRemoved();
    } catch (err) {
      const message = err instanceof ApiError || err instanceof Error ? err.message : 'Could not submit the removal.';
      setPhase('error');
      setPhaseError(message);
    }
  }

  const periodLabel = SPENDING_LIMIT_PERIOD_LABEL[policy.period] ?? policy.period;
  const amountDisplay = `${formatRawUsdcCompact(policy.amountRaw)} USDC`;
  const destinationsCount = policy.destinations.length;
  const isWorking = phase !== 'idle' && phase !== 'error';

  return (
    <DialogShell labelledBy="rd-remove-spending-title" onClose={isWorking ? () => undefined : onClose}>
      {step === 'confirm' ? (
        <>
          <h2 id="rd-remove-spending-title" className="rd-dialog-title">Remove spending limit</h2>
          <p className="rd-dialog-body">
            The agent will stop being able to pay these vendors automatically. New invoices to them
            will go through the normal multisig vote instead.
          </p>

          <div
            style={{
              padding: 16,
              background: 'var(--ax-surface-1)',
              borderRadius: 8,
              marginBottom: 16,
              border: '1px solid var(--ax-border)',
            }}
          >
            <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 6 }}>
              {policy.policyName}
            </div>
            <div style={{ fontSize: 13, color: 'var(--ax-text-muted)' }}>
              {amountDisplay} <span style={{ marginLeft: 4 }}>· {periodLabel}</span>
              <span style={{ marginLeft: 4 }}>
                · {destinationsCount} vendor{destinationsCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          <div
            style={{
              padding: 12,
              border: '1px solid var(--ax-border)',
              borderRadius: 8,
              fontSize: 13,
              lineHeight: 1.55,
              color: 'var(--ax-text-muted)',
              marginBottom: 20,
            }}
          >
            <strong style={{ display: 'block', marginBottom: 4, color: 'var(--ax-text)' }}>
              This creates a Squads config proposal.
            </strong>
            Voters still need to approve and execute the proposal before the limit actually
            disappears on chain. Until then the agent can keep using it.
          </div>

          <div className="rd-dialog-actions" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="button button-secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              style={{
                background: 'var(--ax-danger)',
                borderColor: 'var(--ax-danger)',
              }}
              onClick={runSignAndConfirm}
              disabled={!personalWallet}
            >
              Remove spending limit
            </button>
          </div>
        </>
      ) : (
        <>
          <h2 id="rd-remove-spending-title" className="rd-dialog-title">Removing spending limit</h2>
          <p className="rd-dialog-body">This takes a few seconds. Don't close this window.</p>
          <ol style={{ listStyle: 'none', padding: 0, margin: '12px 0', display: 'grid', gap: 6 }}>
            {[
              { key: 'signing', label: 'Signing' },
              { key: 'submitting', label: 'Sending' },
              { key: 'confirming-onchain', label: 'Confirming' },
              { key: 'persisting', label: 'Saving removal proposal' },
            ].map((s) => {
              const order = ['idle', 'signing', 'submitting', 'confirming-onchain', 'persisting'];
              const idx = order.indexOf(s.key);
              const cur = order.indexOf(phase === 'error' ? 'idle' : phase);
              const isDone = cur > idx;
              const isActive = phase === s.key;
              return (
                <li key={s.key} style={{
                  display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
                  color: isActive ? 'var(--ax-text)' : isDone ? 'var(--ax-text-muted)' : 'var(--ax-text-faint)',
                }}>
                  <span aria-hidden style={{
                    width: 18, height: 18, borderRadius: 9, display: 'inline-grid', placeItems: 'center',
                    fontSize: 11, fontWeight: 600,
                    background: isDone ? 'var(--ax-accent-dim)' : 'var(--ax-surface-2)',
                    color: isDone ? 'var(--ax-accent)' : 'var(--ax-text-muted)',
                    border: isActive ? '1px solid var(--ax-accent)' : '1px solid transparent',
                  }}>{isDone ? '✓' : ''}</span>
                  {s.label}
                </li>
              );
            })}
          </ol>
          {phaseError ? (
            <div style={{
              padding: 12, border: '1px solid var(--ax-danger)', borderRadius: 6,
              fontSize: 13, lineHeight: 1.5, marginBottom: 12,
            }}>
              <strong style={{ display: 'block', marginBottom: 4, color: 'var(--ax-danger)' }}>
                Something went wrong
              </strong>
              <span style={{ color: 'var(--ax-text-muted)' }}>{phaseError}</span>
            </div>
          ) : null}
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setStep('confirm')}
              disabled={isWorking}
            >
              Back
            </button>
            <button
              type="button"
              className="button button-primary"
              style={{
                background: 'var(--ax-danger)',
                borderColor: 'var(--ax-danger)',
              }}
              onClick={runSignAndConfirm}
              disabled={isWorking}
              aria-busy={isWorking}
            >
              {!isWorking ? 'Retry removal' : 'Working…'}
            </button>
          </div>
        </>
      )}
    </DialogShell>
  );
}

// Convert "5000.50" → "5000500000" (USDC has 6 decimals).
function usdToRaw(value: string): string {
  const [whole, frac = ''] = value.replace(/[^0-9.]/g, '').split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return (BigInt(whole || '0') * 1_000_000n + BigInt(fracPadded || '0')).toString();
}

// Derive a stable policy code from the user-facing name. Backend uses this
// for idempotency; we slugify to keep it URL-safe.
function nameToCode(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

// ─── Local helpers (also in Wallets.tsx; duplicated to avoid extracting a
// shared ui module before there's a third use site). ───────────────────────

function CustomCheckbox({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`custom-checkbox${checked ? ' custom-checkbox-checked' : ''}${disabled ? ' custom-checkbox-disabled' : ''}`}
    >
      {checked ? (
        <svg viewBox="0 0 16 16" aria-hidden>
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  );
}

function SquadsReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '140px 1fr',
        gap: 12,
        alignItems: 'start',
        paddingBottom: 8,
        borderBottom: '1px solid var(--ax-border)',
      }}
    >
      <span style={{ color: 'var(--ax-text-muted)', fontSize: 13 }}>{label}</span>
      <div style={{ fontSize: 14 }}>{value}</div>
    </div>
  );
}

// ─── Add vault dialog ──────────────────────────────────────────────────
// Backend creates a deterministic vault PDA under the same multisig PDA.
// No on-chain signature needed. Only requires a display name and a vault
// index in 0..255 that isn't already taken on this multisig.
function AddSquadsVaultDialog({
  organizationId,
  baseWallet,
  siblingVaults,
  onClose,
  onCreated,
  onError,
}: {
  organizationId: string;
  baseWallet: TreasuryWallet;
  siblingVaults: TreasuryWallet[];
  onClose: () => void;
  onCreated: (created: TreasuryWallet) => void;
  onError: (message: string) => void;
}) {
  const usedVaultIndexes = useMemo(() => {
    const used = new Set<number>();
    for (const w of siblingVaults) {
      if (w.source !== 'squads_v4' || w.sourceRef !== baseWallet.sourceRef) continue;
      if (typeof w.sourceVaultIndex === 'number') used.add(w.sourceVaultIndex);
    }
    return used;
  }, [siblingVaults, baseWallet.sourceRef]);

  const nextIndex = useMemo(() => {
    for (let i = 0; i <= 255; i += 1) {
      if (!usedVaultIndexes.has(i)) return i;
    }
    return 255;
  }, [usedVaultIndexes]);

  const [displayName, setDisplayName] = useState('');
  const [vaultIndex, setVaultIndex] = useState<number>(nextIndex);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const noIndexesLeft = usedVaultIndexes.size > 255;

  const mutation = useMutation({
    mutationFn: () =>
      api.registerSquadsTreasuryVault(organizationId, baseWallet.treasuryWalletId, {
        displayName: displayName.trim() || null,
        vaultIndex,
      }),
    onSuccess: onCreated,
    onError: (err) => {
      const message = err instanceof ApiError || err instanceof Error ? err.message : 'Could not add vault.';
      onError(message);
    },
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLocalError(null);
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setLocalError('Vault name is required.');
      return;
    }
    if (!Number.isInteger(vaultIndex) || vaultIndex < 0 || vaultIndex > 255) {
      setLocalError('Vault index must be between 0 and 255.');
      return;
    }
    if (usedVaultIndexes.has(vaultIndex)) {
      setLocalError(`Vault index ${vaultIndex} is already registered for this treasury.`);
      return;
    }
    mutation.mutate();
  }

  // Show existing vaults so the user understands what they're adding alongside.
  const sortedSiblings = useMemo(
    () =>
      siblingVaults
        .filter((w) => w.source === 'squads_v4' && w.sourceRef === baseWallet.sourceRef)
        .sort((a, b) => (a.sourceVaultIndex ?? 999) - (b.sourceVaultIndex ?? 999)),
    [siblingVaults, baseWallet.sourceRef],
  );

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dec-add-vault-title">
        <div className="dialog-head">
          <div>
            <h2 id="dec-add-vault-title">Add vault</h2>
            <p>
              Create another vault controlled by the same team and approval threshold. Each vault
              has its own balance and can be used as a payment source.
            </p>
          </div>
          <button type="button" className="drawer-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="dialog-body">
            <div className="field">
              <label className="field-label">Vault name</label>
              <input
                className="input"
                type="text"
                placeholder="e.g. Payroll vault"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoFocus
                required
              />
            </div>

            <div className="field">
              <label className="field-label">Vault index</label>
              <input
                className="input"
                type="number"
                min={0}
                max={255}
                value={Number.isFinite(vaultIndex) ? vaultIndex : ''}
                onChange={(e) => setVaultIndex(Number(e.target.value))}
              />
              <span className="input-help">
                A number from 0 to 255 that uniquely identifies this vault under the same team.
              </span>
            </div>

            {sortedSiblings.length > 0 ? (
              <div className="field">
                <label className="field-label">Existing vaults</label>
                <div className="summary-card">
                  {sortedSiblings.map((w) => (
                    <div key={w.treasuryWalletId} className="summary-row">
                      <span className="sr-key">{w.displayName ?? 'Untitled vault'}</span>
                      <span className="sr-val mono">index {w.sourceVaultIndex ?? '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {localError ? (
              <div style={{ fontSize: 12, color: 'var(--danger)' }}>{localError}</div>
            ) : null}
            {noIndexesLeft ? (
              <div style={{ fontSize: 12, color: 'var(--danger)' }}>
                This treasury has no available vault indexes (0–255 all used).
              </div>
            ) : null}
          </div>
          <div className="dialog-foot">
            <button
              type="submit"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={mutation.isPending || noIndexesLeft}
              aria-busy={mutation.isPending}
            >
              {mutation.isPending ? 'Adding…' : 'Add vault'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
