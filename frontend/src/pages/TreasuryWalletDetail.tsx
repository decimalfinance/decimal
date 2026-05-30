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
import { Ico } from '../dec/icons';
import { Pill } from '../dec/primitives';

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

  // Org-wide spending-limit policies — used to surface a per-vault count
  // on the Vaults table. One query keyed by org is cheaper than N queries
  // (one per vault), and we render minimal fields so the loose shape is
  // fine.
  const spendingLimitsQuery = useQuery({
    queryKey: ['spending-limit-policies', organizationId, 'all'] as const,
    queryFn: () => api.listSpendingLimitPolicies(organizationId!),
    enabled: Boolean(organizationId && isSquads),
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

  // Sibling vaults — every TreasuryWallet sharing the same multisig PDA is
  // a vault under this "treasury account". Includes the current one.
  const siblingVaults = useMemo(() => {
    const all = treasuryListQuery.data?.items ?? [];
    if (!wallet || wallet.source !== 'squads_v4' || !wallet.sourceRef) return [];
    return all
      .filter((w) => w.source === 'squads_v4' && w.sourceRef === wallet.sourceRef)
      .sort((a, b) => (a.sourceVaultIndex ?? 999) - (b.sourceVaultIndex ?? 999));
  }, [treasuryListQuery.data, wallet]);

  // Balance map keyed by treasuryWalletId — used by the Vaults table.
  const balanceByWalletId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const b of balancesQuery.data?.items ?? []) {
      map.set(b.treasuryWalletId, b.usdcRaw);
    }
    return map;
  }, [balancesQuery.data]);

  // Account-level totals — sum across all sibling vaults.
  const accountTotalRaw = useMemo(() => {
    let total = 0n;
    for (const v of siblingVaults) {
      const raw = balanceByWalletId.get(v.treasuryWalletId);
      if (raw) total += BigInt(raw);
    }
    return total.toString();
  }, [siblingVaults, balanceByWalletId]);
  const vaultCount = siblingVaults.length;

  // Threshold + approver counts for the .sig-callout.
  const voterCount = detail?.squads.members.filter((m) => m.permissions.includes('vote')).length ?? 0;
  const threshold = detail?.squads.threshold ?? 0;

  return (
    <div className="page">
      <div
        className="crumb"
        onClick={() => navigate(`/organizations/${organizationId}/wallets`)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') navigate(`/organizations/${organizationId}/wallets`);
        }}
      >
        <Ico.chevRight w={15} style={{ transform: 'rotate(180deg)' }} />Treasury accounts
      </div>

      <div className="stack stack-32">
        {/* Page head — account name, balance/vault/status summary, actions. */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>TREASURY ACCOUNT</div>
          <div className="pagehead" style={{ paddingBottom: 18 }}>
            <div className="ph-titles">
              <h1>{wallet.displayName || 'Untitled treasury'}</h1>
              <p className="ph-desc">
                <span
                  className="mono"
                  style={{ fontSize: 18, color: 'var(--text-primary)', fontWeight: 500 }}
                >
                  {formatRawUsdcCompact(accountTotalRaw)} USDC
                </span>
                &nbsp;&nbsp;<span style={{ color: 'var(--text-faint)' }}>·</span>&nbsp;&nbsp;
                {vaultCount} {vaultCount === 1 ? 'vault' : 'vaults'}
                {isSquads ? (
                  <>
                    &nbsp;&nbsp;<span style={{ color: 'var(--text-faint)' }}>·</span>&nbsp;&nbsp;
                    <span style={{ verticalAlign: 'middle', marginLeft: 2 }}>
                      <Pill tone={wallet.isActive ? 'success' : 'neutral'}>
                        {wallet.isActive ? 'Active' : 'Inactive'}
                      </Pill>
                    </span>
                  </>
                ) : null}
              </p>
            </div>
            <div className="ph-actions">
              {isSquads && isCurrentUserSquadsMember ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    navigate(`/organizations/${organizationId}/proposals?treasuryWalletId=${treasuryWalletId}`)
                  }
                >
                  Proposals
                </button>
              ) : null}
              {isSquads && isAdmin ? (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setOpenDialog('add-member')}
                  >
                    <Ico.members w={15} />Add member
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setOpenDialog('change-threshold')}
                  >
                    Change required signatures
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {!isSquads ? (
          <div className="tbl-card" style={{ padding: 32 }}>
            <strong style={{ display: 'block', marginBottom: 4 }}>Externally registered wallet</strong>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              This treasury wallet was added by address. Team-approval detail isn't available.
            </p>
          </div>
        ) : detailQuery.isLoading ? (
          <>
            <div className="skeleton" style={{ height: 180, borderRadius: 12 }} />
            <div className="skeleton" style={{ height: 240, borderRadius: 12 }} />
          </>
        ) : detailError ? (
          <div className="tbl-card" style={{ padding: 32 }}>
            <strong style={{ display: 'block', marginBottom: 4 }}>Couldn't load team detail</strong>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              {detailError instanceof ApiError || detailError instanceof Error
                ? detailError.message
                : 'Unknown error.'}
            </p>
          </div>
        ) : detail ? (
          <>
            {/* Team & signers — the people who approve money movement. */}
            <div>
              <div className="sec-head">
                <div className="sh-titles">
                  <h2>Team &amp; signers</h2>
                  <p className="sh-desc">
                    People who authorize money. These signers govern <b>every vault</b> in this account.
                  </p>
                </div>
              </div>
              <div className="sig-callout">
                <span className="sc-badge">{threshold} of {voterCount}</span>
                <span className="sc-text">
                  <b>{threshold} of {voterCount}</b> approvals required to send a payment from any vault.
                </span>
              </div>
              <MembersTable
                members={detail.squads.members.filter(
                  (m) => !m.agentWallet && !m.automationAgent,
                )}
              />
            </div>

            {/* Vaults — sibling wallets sharing this team. */}
            <div>
              <div className="sec-head">
                <div className="sh-titles">
                  <h2>Vaults</h2>
                  <p className="sh-desc">
                    Separate wallets under this account — each with its own balance and spending limits,
                    all secured by the same signers above.
                  </p>
                </div>
                {isAdmin ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setOpenDialog('add-vault')}
                  >
                    <Ico.plus w={14} />New vault
                  </button>
                ) : null}
              </div>
              <VaultsTable
                vaults={siblingVaults}
                balanceByWalletId={balanceByWalletId}
                spendingLimits={spendingLimitsQuery.data?.items ?? []}
                organizationId={organizationId}
              />
            </div>
          </>
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
      </div>
    </div>
  );
}

// ─── MembersTable ────────────────────────────────────────────────────────
// Renders the team & signers list per the design's MembersTable: avatar,
// name + email, three permission pills, and a row-arrow affordance. The
// Decimal agent row uses the accent-bordered .m-avatar.agent variant and
// shows the bolt glyph in place of initials.

function MembersTable({ members }: { members: SquadsDetailMember[] }) {
  return (
    <div className="tbl-card">
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: '42%' }}>Member</th>
            <th>Permissions</th>
            <th className="num" style={{ width: 60 }}></th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <MemberRow key={member.walletAddress} member={member} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberRow({ member }: { member: SquadsDetailMember }) {
  const isAgent = Boolean(member.agentWallet || member.automationAgent);
  const linked = member.organizationMembership;
  const displayName = isAgent
    ? 'Decimal agent'
    : linked?.user.displayName || linked?.user.email || 'Unknown signer';
  const subtext = isAgent
    ? 'Automation — bounded by spending limits'
    : linked?.user.email && linked?.user.displayName
      ? linked.user.email
      : shortenAddress(member.walletAddress);
  const initials = isAgent
    ? ''
    : linked
      ? initialsFromName(linked.user.displayName, linked.user.email)
      : '??';

  return (
    <tr>
      <td>
        <div className="member-cell">
          {isAgent ? (
            <span className="m-avatar agent" aria-hidden>
              <Ico.bolt w={15} fill="currentColor" sw={0} />
            </span>
          ) : (
            <MemberAvatar avatarUrl={linked?.user.avatarUrl ?? null} initials={initials} />
          )}
          <div className="col">
            <span className="m-name">{displayName}</span>
            <span className="m-sub">{subtext}</span>
          </div>
        </div>
      </td>
      <td>
        <div className="perm-pills">
          {(['initiate', 'vote', 'execute'] as const).map((p) => {
            const active = member.permissions.includes(p);
            return (
              <span key={p} className={`perm${active ? ' on' : ''}`}>
                {PERMISSION_LABEL[p]}
              </span>
            );
          })}
        </div>
      </td>
      <td>
        <span className="row-arrow" style={{ opacity: 0.5 }}>
          <Ico.chevRight w={15} />
        </span>
      </td>
    </tr>
  );
}

// Avatar that fits inside `.m-avatar` — shows the Google profile photo
// when present, falls back to initials. Google's CDN blocks unfamiliar
// referers so we strip the header; the onError fallback covers stale or
// removed URLs.
function MemberAvatar({ avatarUrl, initials }: { avatarUrl: string | null; initials: string }) {
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

function initialsFromName(name: string | null, email: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  const local = email.split('@')[0] ?? '?';
  return local.slice(0, 2).toUpperCase();
}

// ─── VaultsTable ─────────────────────────────────────────────────────────
// Sibling vaults (TreasuryWallet rows sharing the same multisig PDA). All
// rows get a Manage action — including the current vault, since the user
// asked for a uniform shape. Spending-limit counts come from one
// org-wide policies query grouped per vault.

function VaultsTable({
  vaults,
  balanceByWalletId,
  spendingLimits,
  organizationId,
}: {
  vaults: TreasuryWallet[];
  balanceByWalletId: Map<string, string | null>;
  spendingLimits: SpendingLimitPolicy[];
  organizationId: string;
}) {
  const navigate = useNavigate();

  // Per-vault active spending-limit count.
  const activeByWallet = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of spendingLimits) {
      if (p.status !== 'active') continue;
      map.set(p.treasuryWalletId, (map.get(p.treasuryWalletId) ?? 0) + 1);
    }
    return map;
  }, [spendingLimits]);

  if (vaults.length === 0) {
    return (
      <div className="tbl-card" style={{ padding: 24 }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No vaults yet.</span>
      </div>
    );
  }

  return (
    <div className="tbl-card">
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: '40%' }}>Vault</th>
            <th className="num">Balance</th>
            <th>Spending limits</th>
            <th className="num" style={{ width: 130 }}></th>
          </tr>
        </thead>
        <tbody>
          {vaults.map((v) => {
            const raw = balanceByWalletId.get(v.treasuryWalletId);
            const activeCount = activeByWallet.get(v.treasuryWalletId) ?? 0;
            return (
              <tr key={v.treasuryWalletId}>
                <td>
                  <div className="treas-cell">
                    <span className="tc-icon"><Ico.vault w={17} /></span>
                    <span className="tc-name">{v.displayName || 'Untitled vault'}</span>
                  </div>
                </td>
                <td className="td-num" style={{ paddingRight: 28 }}>
                  {raw ? formatRawUsdcCompact(raw) : '0.00'}{' '}
                  <span style={{ color: 'var(--text-faint)' }}>USDC</span>
                </td>
                <td>
                  <span className={`sl-count${activeCount === 0 ? ' zero' : ''}`}>
                    <span className="slc-icon"><Ico.shield w={15} /></span>
                    {activeCount > 0 ? `${activeCount} active` : 'None'}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      onClick={() =>
                        navigate(`/organizations/${organizationId}/vaults/${v.treasuryWalletId}`)
                      }
                    >
                      Manage<Ico.arrowRight w={13} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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

export function CreateSpendingLimitDialog({
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
  // Three-step flow per the design: Scope → Limit & vendors → Review.
  // `sign` is a transient sub-state of step 2 once the user hits "Send for
  // approval" — the button label changes through signing phases but the
  // stepper stays on Review.
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [amountUsd, setAmountUsd] = useState('');
  const [period, setPeriod] = useState<'one_time' | 'day' | 'week' | 'month'>('month');
  const [selectedVendorIds, setSelectedVendorIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<CreateSpendingLimitPhase>('idle');
  const [phaseError, setPhaseError] = useState<string | null>(null);

  // Treasury wallet — needed for the read-only Treasury / Vault chips in
  // step 0. Cached per org so multiple instances share the result.
  const treasuryListQuery = useQuery({
    queryKey: ['treasury-wallets', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId),
  });
  const vault = useMemo(
    () =>
      treasuryListQuery.data?.items.find((w) => w.treasuryWalletId === treasuryWalletId) ?? null,
    [treasuryListQuery.data, treasuryWalletId],
  );
  // Parent account = primary sibling (lowest vault index) sharing the
  // multisig PDA. Used as the read-only "Treasury" chip; this vault row
  // becomes the "Vault" chip.
  const parentAccountName = useMemo(() => {
    if (!vault || vault.source !== 'squads_v4' || !vault.sourceRef) return vault?.displayName ?? '—';
    const siblings = (treasuryListQuery.data?.items ?? [])
      .filter((w) => w.source === 'squads_v4' && w.sourceRef === vault.sourceRef)
      .sort((a, b) => (a.sourceVaultIndex ?? 999) - (b.sourceVaultIndex ?? 999));
    return siblings[0]?.displayName ?? vault.displayName ?? '—';
  }, [vault, treasuryListQuery.data]);

  // Parent multisig detail — for the "needs N of M approvals" sl-banner.
  const detailQuery = useQuery({
    queryKey: ['treasury-wallet-detail', organizationId, treasuryWalletId] as const,
    queryFn: () => api.getSquadsTreasuryDetail(organizationId, treasuryWalletId),
    enabled: Boolean(organizationId && treasuryWalletId),
  });
  const threshold = detailQuery.data?.squads.threshold ?? 0;
  const voterCount =
    detailQuery.data?.squads.members.filter((m) => m.permissions.includes('vote')).length ?? 0;

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
      setStep(2);
    },
    onError: (err) => {
      const message = err instanceof ApiError || err instanceof Error ? err.message : 'Could not prepare the proposal.';
      toastError(message);
    },
  });

  async function runSignAndConfirm() {
    const intent = intentMutation.data;
    if (!intent || !personalWallet) return;
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
  const isWorking =
    phase === 'signing' ||
    phase === 'submitting' ||
    phase === 'confirming-onchain' ||
    phase === 'persisting';
  const canContinueStep0 = name.trim().length > 0;
  const canContinueStep1 =
    amountValid &&
    selectedVendorIds.length > 0 &&
    Boolean(personalWallet) &&
    Boolean(agentWallet);
  const periodLabel = PERIOD_OPTIONS.find((o) => o.key === period)?.label.toLowerCase() ?? 'per month';

  const reviewButtonLabel = (() => {
    if (intentMutation.isPending) return 'Preparing…';
    if (phase === 'signing') return 'Signing…';
    if (phase === 'submitting') return 'Sending…';
    if (phase === 'confirming-onchain') return 'Confirming…';
    if (phase === 'persisting') return 'Saving…';
    return 'Send for approval';
  })();

  // Escape closes when not mid-flight.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isWorking) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isWorking, onClose]);

  // When intent is ready (mutation succeeds), advance to review.
  useEffect(() => {
    if (intentMutation.data && step === 1) setStep(2);
  }, [intentMutation.data, step]);

  function handleNext() {
    if (step === 0) {
      if (canContinueStep0) setStep(1);
      return;
    }
    if (step === 1) {
      if (canContinueStep1) {
        intentMutation.mutate();
      }
      return;
    }
    if (step === 2) {
      void runSignAndConfirm();
    }
  }

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isWorking) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dec-new-sl-title"
        style={{ maxWidth: 560 }}
      >
        <div className="dialog-head">
          <div>
            <h2 id="dec-new-sl-title">New spending limit</h2>
            <p>Let the agent pay specific vendors up to a cap without a team vote each time.</p>
          </div>
          <button
            type="button"
            className="drawer-x"
            onClick={onClose}
            disabled={isWorking}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          <Stepper step={step} />

          {step === 0 ? (
            <>
              <div className="field">
                <label className="field-label" htmlFor="dec-sl-name">Policy name</label>
                <input
                  id="dec-sl-name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Apr cloud bills"
                  autoFocus
                />
              </div>
              <div className="row" style={{ display: 'flex', gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">Treasury</label>
                  <div
                    className="input"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      background: 'var(--bg-surface-2)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    <Ico.treasury w={14} />{parentAccountName}
                  </div>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">Vault</label>
                  <div
                    className="input"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      background: 'var(--bg-surface-2)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    <Ico.vault w={14} />{vault?.displayName ?? '—'}
                  </div>
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="dec-sl-desc">
                  Description{' '}
                  <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· optional</span>
                </label>
                <textarea
                  id="dec-sl-desc"
                  className="input"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does the agent get to pay for under this policy?"
                  style={{ resize: 'vertical' }}
                />
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="field">
                <label className="field-label">Limit</label>
                <div className="amount-input">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amountUsd}
                    onChange={(e) => setAmountUsd(e.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="5,000"
                    autoFocus
                  />
                  <span className="ai-cur">USDC</span>
                </div>
              </div>
              <div className="field">
                <label className="field-label">Period</label>
                <div className="seg-pick" role="radiogroup" aria-label="Period">
                  {PERIOD_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={period === opt.key}
                      className={period === opt.key ? 'on' : ''}
                      onClick={() => setPeriod(opt.key)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label className="field-label">Vendors the agent can pay</label>
                {counterpartyWalletsQuery.isLoading ? (
                  <div className="skeleton" style={{ height: 100, borderRadius: 8 }} />
                ) : counterpartyWallets.length === 0 ? (
                  <div
                    style={{
                      padding: 14,
                      border: '1px dashed var(--border-strong)',
                      borderRadius: 8,
                      fontSize: 13,
                      color: 'var(--text-muted)',
                      lineHeight: 1.55,
                    }}
                  >
                    No trusted vendors yet. Add vendors to the address book first.
                  </div>
                ) : (
                  <div className="check-list">
                    {counterpartyWallets.map((wallet) => {
                      const checked = selectedVendorIds.includes(wallet.counterpartyWalletId);
                      return (
                        <div
                          key={wallet.counterpartyWalletId}
                          className={`check-item${checked ? ' on' : ''}`}
                          role="checkbox"
                          aria-checked={checked}
                          tabIndex={0}
                          onClick={() =>
                            setSelectedVendorIds((prev) =>
                              prev.includes(wallet.counterpartyWalletId)
                                ? prev.filter((id) => id !== wallet.counterpartyWalletId)
                                : [...prev, wallet.counterpartyWalletId],
                            )
                          }
                          onKeyDown={(e) => {
                            if (e.key === ' ' || e.key === 'Enter') {
                              e.preventDefault();
                              setSelectedVendorIds((prev) =>
                                prev.includes(wallet.counterpartyWalletId)
                                  ? prev.filter((id) => id !== wallet.counterpartyWalletId)
                                  : [...prev, wallet.counterpartyWalletId],
                              );
                            }
                          }}
                          style={{ cursor: 'pointer' }}
                        >
                          <span className="check-box" aria-hidden>
                            {checked ? <Ico.checkSm w={12} /> : null}
                          </span>
                          <span className="ci-av">{vendorInitials(wallet.label)}</span>
                          <span className="ci-name">
                            {wallet.counterparty?.displayName ?? wallet.label}
                          </span>
                          <span className="ci-sub">
                            {wallet.trustState === 'trusted' ? 'Verified' : wallet.trustState}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <div className="review-card">
                <div className="rv-row">
                  <span className="rv-k">Policy</span>
                  <span className="rv-v">{name}</span>
                </div>
                <div className="rv-row">
                  <span className="rv-k">Vault</span>
                  <span className="rv-v">
                    {parentAccountName} · {vault?.displayName ?? '—'}
                  </span>
                </div>
                <div className="rv-row">
                  <span className="rv-k">Limit</span>
                  <span className="rv-v mono">
                    {Number(amountUsd).toLocaleString()} USDC {periodLabel}
                  </span>
                </div>
                <div className="rv-row">
                  <span className="rv-k">Vendors</span>
                  <span className="rv-v">
                    {selectedVendorIds.length}{' '}
                    {selectedVendorIds.length === 1 ? 'vendor' : 'vendors'}
                  </span>
                </div>
                {description.trim() ? (
                  <div className="rv-row">
                    <span className="rv-k">Description</span>
                    <span className="rv-v">{description.trim()}</span>
                  </div>
                ) : null}
              </div>
              <div className="sl-banner">
                <span className="slb-icon">
                  <Ico.shield w={16} />
                </span>
                <span className="slb-text">
                  Creating this policy needs{' '}
                  <b>
                    {threshold || '—'} of {voterCount || '—'}
                  </b>{' '}
                  approvals from the treasury signers before it goes live.
                </span>
              </div>
              {phaseError ? (
                <div style={{ fontSize: 12, color: 'var(--danger)' }}>{phaseError}</div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="dialog-foot">
          {step === 0 ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={handleNext}
                disabled={!canContinueStep0}
              >
                Continue<Ico.arrowRight w={14} />
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
            </>
          ) : null}
          {step === 1 ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={handleNext}
                disabled={!canContinueStep1 || intentMutation.isPending}
                aria-busy={intentMutation.isPending}
              >
                {intentMutation.isPending ? 'Preparing…' : (
                  <>Review<Ico.arrowRight w={14} /></>
                )}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep(0)}
                disabled={intentMutation.isPending}
              >
                Back
              </button>
            </>
          ) : null}
          {step === 2 ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={handleNext}
                disabled={isWorking}
                aria-busy={isWorking}
              >
                {reviewButtonLabel}
                {isWorking ? null : <Ico.arrowRight w={14} />}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep(1)}
                disabled={isWorking}
              >
                Back
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: 0 | 1 | 2 }) {
  const steps = ['Scope', 'Limit & vendors', 'Review'];
  return (
    <div className="stepper">
      {steps.map((label, i) => (
        <span key={label} style={{ display: 'contents' }}>
          <div className={`st${i === step ? ' on' : i < step ? ' done' : ''}`}>
            <span className="st-n">{i < step ? <Ico.checkSm w={10} /> : i + 1}</span>
            {label}
          </div>
          {i < steps.length - 1 ? <span className="st-sep" /> : null}
        </span>
      ))}
    </div>
  );
}

function vendorInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return '??';
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

export function RemoveSpendingLimitDialog({
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
