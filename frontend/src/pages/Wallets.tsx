import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  CreateSquadsTreasuryIntentRequest,
  CreateSquadsTreasuryIntentResponse,
  SquadsPermission,
  UserWallet,
} from '../types';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { formatRawUsdcCompact } from '../domain';
import { resolveSolanaRpcUrl, waitForSignatureVisible } from '../lib/solana-wallet';
import { useToast } from '../ui/Toast';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function sumUsdc(values: Array<string | null>): string {
  let total = 0n;
  for (const v of values) {
    if (v === null) continue;
    try {
      total += BigInt(v);
    } catch {
      // skip
    }
  }
  return total.toString();
}


export function WalletsPage({ session: _session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [createSquadsOpen, setCreateSquadsOpen] = useState(false);

  const balancesQuery = useQuery({
    queryKey: ['treasury-wallet-balances', organizationId] as const,
    queryFn: () => api.listTreasuryWalletBalances(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 15_000,
  });

  // Pulled separately so we can show source-specific UI (Squads badge,
  // multisig PDA secondary text). The balances endpoint omits source /
  // sourceRef / propertiesJson — push those into the balances response
  // backend-side later to drop this round-trip.
  const treasuryWalletsQuery = useQuery({
    queryKey: ['treasury-wallets', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });
  const treasuryWalletMetaById = useMemo(() => {
    const map = new Map<string, { source: string; sourceRef: string | null; sourceVaultIndex: number | null }>();
    for (const w of treasuryWalletsQuery.data?.items ?? []) {
      map.set(w.treasuryWalletId, {
        source: w.source,
        sourceRef: w.sourceRef,
        sourceVaultIndex: w.sourceVaultIndex,
      });
    }
    return map;
  }, [treasuryWalletsQuery.data]);

  const personalWalletsQuery = useQuery({
    queryKey: ['personal-wallets'] as const,
    queryFn: () => api.listPersonalWallets(),
  });
  const personalWallets = useMemo(
    () =>
      (personalWalletsQuery.data?.items ?? []).filter(
        (w) => w.status === 'active' && w.chain === 'solana',
      ),
    [personalWalletsQuery.data],
  );

  const createMutation = useMutation({
    // Treasury accounts are organization-owned wallets. Their address can
    // be a Squads multisig, a personal wallet the user already has, or any
    // other Solana address the org controls. We do NOT auto-create a Privy
    // wallet here — personal wallets live on the Profile page, and the
    // user can later authorize one of them to act for this treasury via
    // the wallet authorization flow.
    mutationFn: (form: FormData) =>
      api.createTreasuryWallet(organizationId!, {
        address: String(form.get('address') ?? '').trim(),
        displayName: String(form.get('displayName') ?? '').trim() || undefined,
        notes: String(form.get('notes') ?? '').trim() || undefined,
      }),
    onSuccess: async () => {
      success('Treasury account added.');
      setAddOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['treasury-wallet-balances', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['addresses', organizationId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to add treasury account.'),
  });

  const rows = balancesQuery.data?.items ?? [];
  const totalUsdcRaw = useMemo(() => sumUsdc(rows.map((r) => r.usdcRaw)), [rows]);
  const isInitialLoading = balancesQuery.isLoading && rows.length === 0;

  // Group rows by multisig — every Squads vault under the same multisig
  // PDA collapses into ONE display row showing the team-of-signers + summed
  // balance + vault count. Non-Squads wallets stay one-row-per-wallet.
  // The display row points to the lowest-vault-index treasuryWalletId so
  // "click row to open" lands on the canonical/base treasury detail.
  type GroupedRow = {
    key: string;
    primaryTreasuryWalletId: string;
    displayName: string;
    isSquads: boolean;
    vaultCount: number;
    usdcRawSum: string;
    isActive: boolean;
    rpcError: string | null;
  };
  const groupedRows = useMemo<GroupedRow[]>(() => {
    const groups = new Map<string, GroupedRow & { _vaultIndexes: Array<{ id: string; index: number | null; name: string | null }> }>();
    for (const row of rows) {
      const meta = treasuryWalletMetaById.get(row.treasuryWalletId);
      const isSquads = meta?.source === 'squads_v4';
      const key = isSquads && meta?.sourceRef ? `squads:${meta.sourceRef}` : `wallet:${row.treasuryWalletId}`;
      const existing = groups.get(key);
      if (existing) {
        existing.vaultCount += 1;
        try {
          existing.usdcRawSum = (BigInt(existing.usdcRawSum) + BigInt(row.usdcRaw ?? '0')).toString();
        } catch {
          // skip malformed amount
        }
        existing.isActive = existing.isActive && row.isActive;
        existing._vaultIndexes.push({
          id: row.treasuryWalletId,
          index: meta?.sourceVaultIndex ?? null,
          name: row.displayName,
        });
      } else {
        groups.set(key, {
          key,
          primaryTreasuryWalletId: row.treasuryWalletId,
          displayName: row.displayName ?? 'Untitled treasury',
          isSquads,
          vaultCount: 1,
          usdcRawSum: row.usdcRaw ?? '0',
          isActive: row.isActive,
          rpcError: row.rpcError,
          _vaultIndexes: [{
            id: row.treasuryWalletId,
            index: meta?.sourceVaultIndex ?? null,
            name: row.displayName,
          }],
        });
      }
    }
    // For Squads groups, pick the lowest-vault-index entry as the canonical
    // landing point + use its name as the group display name.
    return Array.from(groups.values()).map((g) => {
      if (g.isSquads) {
        const sorted = [...g._vaultIndexes].sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
        const base = sorted[0]!;
        return {
          key: g.key,
          primaryTreasuryWalletId: base.id,
          displayName: base.name ?? 'Untitled treasury',
          isSquads: true,
          vaultCount: g.vaultCount,
          usdcRawSum: g.usdcRawSum,
          isActive: g.isActive,
          rpcError: g.rpcError,
        };
      }
      return g;
    });
  }, [rows, treasuryWalletMetaById]);

  // Metric counts derive from groups, not raw rows — one Squads multisig
  // with 3 vaults reads as "1 account, 3 vaults".
  const accountCount = groupedRows.length;
  const vaultCount = groupedRows.reduce((acc, g) => acc + g.vaultCount, 0);
  const activeAccountCount = groupedRows.filter((g) => g.isActive).length;

  if (!organizationId) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Organization unavailable</h2>
          <p className="rd-state-body">Pick a organization from the sidebar.</p>
        </div>
      </main>
    );
  }

  // Sum balances across all treasuries — surfaces in the "Total balance"
  // metric. Compact USDC display since amounts can be six figures+.
  const totalBalanceDisplay = formatRawUsdcCompact(totalUsdcRaw);

  return (
    <div className="page">
      <div className="stack stack-24">
        <PageHead
          eyebrow="REGISTRY"
          title="Treasury accounts"
          desc="Each account holds one team of signers and one or more vaults. Your keys, your team — Decimal is just the surface."
          actions={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setCreateSquadsOpen(true)}
            >
              <Ico.plus w={15} />New treasury account
            </button>
          }
        />

        <div className="metrics" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="metric">
            <div className="m-label">Total balance</div>
            <div className="m-value">{totalBalanceDisplay}</div>
            <div className="m-sub">USDC across all vaults</div>
          </div>
          <div className="metric">
            <div className="m-label">Accounts</div>
            <div className="m-value">{accountCount}</div>
            <div className="m-sub">
              {accountCount === 0 ? '—' : activeAccountCount === accountCount ? 'all active' : `${activeAccountCount} active`}
            </div>
          </div>
          <div className="metric">
            <div className="m-label">Vaults</div>
            <div className="m-value">{vaultCount}</div>
            <div className="m-sub">
              {vaultCount === 0 ? '—' : accountCount === 1 ? 'across 1 account' : `across ${accountCount} accounts`}
            </div>
          </div>
        </div>

        <div className="tbl-card">
          {isInitialLoading ? (
            <div style={{ padding: 16 }}>
              <div className="skeleton" style={{ height: 48, marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 48, marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 48 }} />
            </div>
          ) : groupedRows.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Ico.treasury w={22} /></div>
              <h4>Set up your first treasury</h4>
              <p>Treasuries hold funds and define who can approve payments from them.</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCreateSquadsOpen(true)}
                style={{ marginTop: 6 }}
              >
                <Ico.plus w={15} />New treasury account
              </button>
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: '34%' }}>Account</th>
                  <th className="num" style={{ width: '18%' }}>Balance</th>
                  <th style={{ width: '14%' }}>Vaults</th>
                  <th style={{ width: '20%' }}>Signers</th>
                  <th>Status</th>
                  <th style={{ width: 28 }}></th>
                </tr>
              </thead>
              <tbody>
                {groupedRows.map((g) => (
                  <tr
                    key={g.key}
                    onClick={() => navigate(`/organizations/${organizationId}/wallets/${g.primaryTreasuryWalletId}`)}
                  >
                    <td>
                      <div className="treas-cell">
                        <span className="tc-icon"><Ico.treasury w={17} /></span>
                        <div className="col">
                          <span className="tc-name">{g.displayName}</span>
                          <span className="tc-sub" style={{ fontFamily: 'var(--font-body)' }}>
                            {g.isSquads ? 'Team-approved · multi-signer' : 'Single signer'}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="td-num">
                      {formatRawUsdcCompact(g.usdcRawSum)} <span style={{ color: 'var(--text-faint)' }}>USDC</span>
                    </td>
                    <td>
                      <span className="vault-count">
                        <span className="vk-icon"><Ico.vault w={15} /></span>
                        {g.vaultCount} {g.vaultCount === 1 ? 'vault' : 'vaults'}
                      </span>
                    </td>
                    <td>
                      <SignerStack treasuryWalletId={g.primaryTreasuryWalletId} />
                    </td>
                    <td>
                      <span className={`pill ${g.isActive ? 'pill-success' : 'pill-neutral'}`}>
                        <span className="dot" />{g.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td><span className="row-arrow"><Ico.chevRight w={16} /></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

      {addOpen ? (
        <AddWalletDialog
          pending={createMutation.isPending}
          onClose={() => setAddOpen(false)}
          onSubmit={(form) => createMutation.mutate(form)}
        />
      ) : null}

      {createSquadsOpen ? (
        <CreateSquadsTreasuryDialog
          organizationId={organizationId!}
          personalWallets={personalWallets}
          personalWalletsLoading={personalWalletsQuery.isLoading}
          onClose={() => setCreateSquadsOpen(false)}
          onError={(message) => toastError(message)}
          onConfirmed={async () => {
            success('Squads treasury created.');
            setCreateSquadsOpen(false);
            await queryClient.invalidateQueries({ queryKey: ['treasury-wallet-balances', organizationId] });
            await queryClient.invalidateQueries({ queryKey: ['treasury-wallets', organizationId] });
          }}
        />
      ) : null}
      </div>
    </div>
  );
}

function AddWalletDialog(props: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
}) {
  const { pending, onClose, onSubmit } = props;

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
      aria-labelledby="rd-add-wallet-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 480 }}>
        <h2 id="rd-add-wallet-title" className="rd-dialog-title">
          Add treasury account
        </h2>
        <p className="rd-dialog-body">
          Register an organization-owned Solana wallet. This can be a Squads multisig, an existing wallet, or any address the organization controls. Decimal will monitor balances and reconcile against it.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(new FormData(e.currentTarget));
          }}
        >
          <label className="field">
            Account name
            <input name="displayName" placeholder="Ops vault" autoComplete="off" autoFocus />
          </label>
          <label className="field">
            Solana address
            <input name="address" required placeholder="Wallet address" autoComplete="off" />
          </label>
          <label className="field">
            Notes
            <input name="notes" placeholder="Optional context" autoComplete="off" />
          </label>
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
              {pending ? 'Adding…' : 'Add treasury account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const ALL_SQUADS_PERMISSIONS: SquadsPermission[] = ['initiate', 'vote', 'execute'];

// CreateSquadsTreasuryDialog
//
// Flow:
//   no-personal-wallet -> empty-state CTA to /profile
//   config -> name, creator wallet, member selection (with permissions per
//             member), threshold. Creator's personal wallet is forced into
//             the member list (backend constraint).
//   review -> backend create-intent fetched; show multisig PDA, vault PDA,
//             required signer, members.
//   sign  -> backend signs with the creator's Privy wallet, submits to
//             chain, polls signature, persists treasury record.
function CreateSquadsTreasuryDialog(props: {
  organizationId: string;
  personalWallets: UserWallet[];
  personalWalletsLoading: boolean;
  onClose: () => void;
  onError: (message: string) => void;
  onConfirmed: () => Promise<void> | void;
}) {
  const { organizationId, personalWallets, personalWalletsLoading, onClose, onError, onConfirmed } = props;
  const navigate = useNavigate();
  const [name, setName] = useState('');
  // Per-member Squads permission map. Empty array = not a signer.
  // Non-empty array = signer with those exact roles. The checkbox at the
  // start of each row toggles between "not a signer" (empty) and "all
  // three roles" (default). The role pills toggle individual perms.
  // The creator's wallet is force-included with all roles so the backend's
  // "creator must be a voting member" rule always passes.
  const [memberPermissions, setMemberPermissions] = useState<Record<string, SquadsPermission[]>>({});
  const [threshold, setThreshold] = useState<number>(1);
  const [pendingIntent, setPendingIntent] = useState<CreateSquadsTreasuryIntentResponse | null>(null);

  const orgWalletsQuery = useQuery({
    queryKey: ['organization-personal-wallets', organizationId] as const,
    queryFn: () => api.listOrganizationPersonalWallets(organizationId),
    enabled: Boolean(organizationId),
  });
  const orgWallets = orgWalletsQuery.data?.items ?? [];

  // The creator wallet is the current user's first active personal wallet.
  // Backend signs the multisig-create tx with this wallet, so we lock it
  // into the member list automatically.
  const creatorWalletId = personalWallets[0]?.userWalletId ?? '';

  // Derived counts off the permission map.
  const selectedWalletIds = useMemo(
    () => Object.entries(memberPermissions).filter(([, p]) => p.length > 0).map(([id]) => id),
    [memberPermissions],
  );
  const selectedCount = selectedWalletIds.length;
  const voterCount = useMemo(
    () => Object.values(memberPermissions).filter((p) => p.includes('vote')).length,
    [memberPermissions],
  );

  // Force the creator wallet into the selection with all 3 roles.
  // The backend's "creator must be a voting member" check requires this.
  useEffect(() => {
    if (!creatorWalletId) return;
    setMemberPermissions((prev) => {
      if (prev[creatorWalletId] && prev[creatorWalletId].length > 0) return prev;
      return { ...prev, [creatorWalletId]: [...ALL_SQUADS_PERMISSIONS] };
    });
  }, [creatorWalletId]);

  // Default-select every org wallet with all 3 roles on first load.
  useEffect(() => {
    if (orgWallets.length === 0) return;
    setMemberPermissions((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, SquadsPermission[]> = {};
      for (const w of orgWallets) next[w.userWalletId] = [...ALL_SQUADS_PERMISSIONS];
      return next;
    });
  }, [orgWallets]);

  // Keep threshold within [1, voterCount] as roles change.
  useEffect(() => {
    if (voterCount === 0) {
      setThreshold(1);
      return;
    }
    setThreshold((current) => {
      if (current < 1) return 1;
      if (current > voterCount) return voterCount;
      return current;
    });
  }, [voterCount]);
  // Phase tracks the live progress of the sign-and-confirm pipeline.
  // 'submitted-pending-confirm' is the recoverable state: tx hit chain
  // but the backend confirm step failed — we keep the signature and
  // let the user retry just the confirm leg without re-signing.
  const [phase, setPhase] = useState<
    | 'idle'
    | 'signing'
    | 'submitting'
    | 'confirming-onchain'
    | 'persisting'
    | 'submitted-pending-confirm'
    | 'error'
  >('idle');
  const [submittedSignature, setSubmittedSignature] = useState<string | null>(null);
  const [phaseError, setPhaseError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Build members from the per-wallet permission map. Backend rules:
  //   * at least one signer
  //   * creator must be present + must have 'vote'
  //   * threshold ≤ count of members with 'vote'
  const intentMutation = useMutation({
    mutationFn: () => {
      if (!creatorWalletId) {
        throw new Error('Your signing wallet is still loading. Refresh and try again.');
      }
      const members: CreateSquadsTreasuryIntentRequest['members'] = Object.entries(memberPermissions)
        .filter(([, permissions]) => permissions.length > 0)
        .map(([personalWalletId, permissions]) => ({ personalWalletId, permissions }));
      if (members.length === 0) {
        throw new Error('Select at least one signer.');
      }
      const creatorMember = members.find((m) => m.personalWalletId === creatorWalletId);
      if (!creatorMember) {
        throw new Error('You must be one of the signers.');
      }
      if (!creatorMember.permissions.includes('vote')) {
        throw new Error('You must keep Approver on your own row — the creator must be a voting member.');
      }
      const voters = members.filter((m) => m.permissions.includes('vote'));
      if (voters.length === 0) {
        throw new Error('At least one signer must have the Approver role.');
      }
      if (threshold < 1 || threshold > voters.length) {
        throw new Error(`Required approvals must be between 1 and ${voters.length}.`);
      }
      return api.createSquadsTreasuryIntent(organizationId, {
        displayName: name.trim() || null,
        creatorPersonalWalletId: creatorWalletId,
        threshold,
        members,
      });
    },
    onSuccess: (response) => {
      setPendingIntent(response);
    },
    onError: (err) => onError(err instanceof Error ? err.message : 'Could not prepare the treasury.'),
  });

  // Run the full Sign + Submit + Confirm-on-chain + Confirm-with-backend
  // pipeline. Recoverable failure modes:
  //   - sign / submit fail before chain accepts -> no signature kept,
  //     user can retry from scratch
  //   - confirm-on-chain or confirm-with-backend fail AFTER chain
  //     accepted -> we keep the signature in state so the next click
  //     skips signing and resumes from confirmation
  async function runSignAndConfirm() {
    if (!pendingIntent) return;
    if (!creatorWalletId) {
      setPhase('error');
      setPhaseError('Creator wallet missing.');
      return;
    }
    setPhaseError(null);

    let signatureToConfirm = submittedSignature;

    try {
      const connection = new Connection(resolveSolanaRpcUrl(), 'confirmed');

      if (!signatureToConfirm) {
        // Step 1: backend signs with the user's Privy wallet.
        setPhase('signing');
        const signed = await api.signPersonalWalletVersionedTransaction(creatorWalletId, {
          serializedTransactionBase64: pendingIntent.transaction.serializedTransaction,
        });

        // Step 2: submit the now-fully-signed tx to chain.
        setPhase('submitting');
        const signedBytes = decodeBase64ToBytes(signed.signedTransactionBase64);
        // Validate it deserializes before we send (catches an obvious
        // malformed response cheaply).
        VersionedTransaction.deserialize(signedBytes);
        const sig = await connection.sendRawTransaction(signedBytes, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
        setSubmittedSignature(sig);
        signatureToConfirm = sig;

        // Step 3: wait for the signature to show up as confirmed via
        // direct getSignatureStatuses polling. We don't use
        // connection.confirmTransaction({blockhash, lastValidBlockHeight})
        // because by the time the user lands on this step, the
        // intent's blockhash is usually already past its lastValidBlockHeight
        // window (createIntent picked the blockhash, then sign + submit
        // ate most of the ~60s deadline). That makes confirmTransaction
        // return "block height exceeded" almost immediately even though
        // the tx actually landed. Signature-status polling doesn't care
        // about blockhash freshness.
        setPhase('confirming-onchain');
        const visible = await waitForSignatureVisible(connection, sig, { timeoutMs: 30_000 });
        // If we hit the timeout WITHOUT seeing the signature anywhere,
        // bail out — the tx probably never landed (or got dropped).
        // If we saw it but it didn't reach 'confirmed' yet, fall through
        // to backend persist anyway: the backend's loadMultisig will
        // either find the chain state and succeed, or surface its own
        // clear error.
        if (!visible.confirmed && !visible.seen) {
          throw new Error('Transaction never appeared on chain after submission. Try preparing again.');
        }
      }

      // Step 4: persist via backend.
      setPhase('persisting');
      await api.confirmSquadsTreasury(organizationId, {
        signature: signatureToConfirm!,
        displayName: pendingIntent.intent.displayName,
        createKey: pendingIntent.intent.createKey,
        multisigPda: pendingIntent.intent.multisigPda,
        vaultIndex: pendingIntent.intent.vaultIndex,
      });

      await onConfirmed();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Squads creation failed.';
      setPhaseError(message);
      // If we have a submitted signature already, surface a recoverable
      // state so the user can retry just the confirm leg. Otherwise it's
      // a hard error and we reset to allow re-signing.
      setPhase(signatureToConfirm ? 'submitted-pending-confirm' : 'error');
      onError(message);
    }
  }

  // Empty state: user has no personal wallet -> can't create a Squads
  // treasury at all (need at least one signer).
  if (!personalWalletsLoading && personalWallets.length === 0) {
    return (
      <DialogShell labelledBy="rd-squads-empty-title" onClose={onClose}>
        <h2 id="rd-squads-empty-title" className="rd-dialog-title">
          Your account needs a moment
        </h2>
        <p className="rd-dialog-body">
          We're still setting up your signing wallet. Refresh in a few seconds and try again.
        </p>
        <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => {
              onClose();
              navigate('/profile');
            }}
          >
            Go to profile →
          </button>
        </div>
      </DialogShell>
    );
  }

  // Render the design's single-form dialog. The multi-step intent → sign
  // → confirm pipeline runs invisibly behind the "Create account" button
  // — only the button label changes per phase. Errors surface as toasts
  // (parent onError) so they're visible without growing the dialog.

  function initialsForRow(displayName: string | null, fallback: string): string {
    if (displayName && displayName.trim()) {
      const parts = displayName.trim().split(/\s+/);
      if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
      return displayName.slice(0, 2).toUpperCase();
    }
    return fallback.slice(0, 2).toUpperCase();
  }

  function isSelected(walletId: string): boolean {
    return (memberPermissions[walletId]?.length ?? 0) > 0;
  }

  function hasPerm(walletId: string, perm: SquadsPermission): boolean {
    return memberPermissions[walletId]?.includes(perm) ?? false;
  }

  function toggleSelected(walletId: string) {
    // Creator must stay selected — backend rejects intents without them.
    if (walletId === creatorWalletId) return;
    setMemberPermissions((prev) => {
      const current = prev[walletId] ?? [];
      const next = { ...prev };
      if (current.length > 0) delete next[walletId];
      else next[walletId] = [...ALL_SQUADS_PERMISSIONS];
      return next;
    });
  }

  function togglePerm(walletId: string, perm: SquadsPermission) {
    // Block disabling the creator's 'vote' — backend rule.
    if (walletId === creatorWalletId && perm === 'vote') return;
    setMemberPermissions((prev) => {
      const current = prev[walletId] ?? [];
      if (current.length === 0) return prev; // can't toggle a role on someone who isn't a signer
      const has = current.includes(perm);
      const nextPerms = has ? current.filter((p) => p !== perm) : [...current, perm];
      // If the user disables every role, treat that as unchecking the row.
      if (nextPerms.length === 0) {
        if (walletId === creatorWalletId) return prev; // can't fully clear creator
        const { [walletId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [walletId]: nextPerms };
    });
  }

  const isWorking =
    intentMutation.isPending
    || phase === 'signing'
    || phase === 'submitting'
    || phase === 'confirming-onchain'
    || phase === 'persisting';

  const buttonLabel = (() => {
    if (intentMutation.isPending) return 'Preparing…';
    if (phase === 'signing') return 'Signing…';
    if (phase === 'submitting') return 'Sending…';
    if (phase === 'confirming-onchain') return 'Confirming…';
    if (phase === 'persisting') return 'Saving…';
    if (phase === 'submitted-pending-confirm') return 'Retry';
    return 'Create account';
  })();

  async function handleCreate() {
    if (pendingIntent) {
      await runSignAndConfirm();
      return;
    }
    try {
      const result = await intentMutation.mutateAsync();
      setPendingIntent(result);
      // Kick off the sign+confirm pipeline immediately — pendingIntent
      // gets set inside the same tick so runSignAndConfirm has it via
      // closure on the next render. Use a microtask to ensure state is
      // committed before reading pendingIntent.
      queueMicrotask(() => {
        void runSignAndConfirm();
      });
    } catch {
      // intentMutation.onError already surfaced the toast via parent.
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
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dec-new-treasury-title">
        <div className="dialog-head">
          <div>
            <h2 id="dec-new-treasury-title">New treasury account</h2>
            <p>Set the team of signers. You can add vaults once it's created.</p>
          </div>
          <button type="button" className="drawer-x" onClick={onClose} disabled={isWorking} aria-label="Close">
            ×
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!isWorking) void handleCreate();
          }}
        >
          <div className="dialog-body">
            <div className="field">
              <label className="field-label">Account name</label>
              <input
                className="input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Operating"
                autoComplete="off"
                autoFocus
                required
              />
            </div>

            <div className="field">
              <label className="field-label">Signers</label>
              <span className="input-help" style={{ marginBottom: 8 }}>
                These people (and the Decimal agent) govern every vault in this account.
              </span>
              {orgWalletsQuery.isLoading ? (
                <div className="skeleton" style={{ height: 48 }} />
              ) : orgWallets.length === 0 ? (
                <span className="input-help">No teammates have a signing wallet yet.</span>
              ) : (
                <div className="check-list">
                  {orgWallets.map((w) => {
                    const checked = isSelected(w.userWalletId);
                    const isCreator = w.userWalletId === creatorWalletId;
                    return (
                      <div
                        key={w.userWalletId}
                        className={`check-item${checked ? ' on' : ''}`}
                        role="group"
                        aria-label={`Signer ${w.user.displayName ?? w.user.email}`}
                      >
                        {/* Checkbox: clicking the box (not the rest of the row)
                            toggles whether this person is a signer at all. */}
                        <span
                          className="check-box"
                          role="checkbox"
                          aria-checked={checked}
                          aria-disabled={isCreator}
                          tabIndex={isCreator ? -1 : 0}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelected(w.userWalletId);
                          }}
                          onKeyDown={(e) => {
                            if (isCreator) return;
                            if (e.key === ' ' || e.key === 'Enter') {
                              e.preventDefault();
                              toggleSelected(w.userWalletId);
                            }
                          }}
                          style={{ cursor: isCreator ? 'default' : 'pointer' }}
                        >
                          {checked ? <Ico.checkSm w={12} /> : null}
                        </span>
                        <span className="ci-av">
                          {initialsForRow(w.user.displayName, w.user.email)}
                        </span>
                        <span className="ci-name">{w.user.displayName ?? w.user.email}</span>
                        {isCreator ? <span className="ci-sub" style={{ marginRight: 4 }}>you</span> : null}
                        {/* Per-row role pills. Only visible when the row is
                            checked — hiding them on unchecked rows keeps
                            the list scannable. */}
                        {checked ? (
                          <PermPills
                            initiator={hasPerm(w.userWalletId, 'initiate')}
                            approver={hasPerm(w.userWalletId, 'vote')}
                            executor={hasPerm(w.userWalletId, 'execute')}
                            disabledApprover={isCreator}
                            onToggle={(perm) => togglePerm(w.userWalletId, perm)}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                  {/* Decimal agent — always part of the team, shown for clarity */}
                  <div className="check-item on" style={{ cursor: 'default' }} aria-disabled>
                    <span className="check-box"><Ico.checkSm w={12} /></span>
                    <span className="ci-av agent">
                      <Ico.bolt w={13} fill="currentColor" sw={0} />
                    </span>
                    <span className="ci-name">Decimal agent</span>
                    <span className="ci-sub">agent</span>
                  </div>
                </div>
              )}
            </div>

            <div className="field">
              <label className="field-label">
                Required approvals
                {selectedCount > 0 ? (
                  <span style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 6 }}>
                    · of {selectedCount}
                  </span>
                ) : null}
              </label>
              <div className="seg-pick">
                {Array.from({ length: Math.max(selectedCount, 1) }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={threshold === n ? 'on' : ''}
                    onClick={() => setThreshold(n)}
                    disabled={isWorking || selectedCount === 0}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <span className="input-help">How many signers must approve before a payment sends.</span>
            </div>

            {phaseError ? (
              <div style={{ fontSize: 12, color: 'var(--danger)' }}>{phaseError}</div>
            ) : null}
          </div>

          <div className="dialog-foot">
            <button
              type="submit"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={
                isWorking
                || !creatorWalletId
                || selectedCount === 0
                || !name.trim()
              }
              aria-busy={isWorking}
            >
              {buttonLabel}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isWorking}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Legacy step renderers — kept as dead code below so we don't lose the
// original markup until we're sure the new dialog covers every case. The
// outer function returns before reaching this; everything from here to
// the closing brace is unreachable and will be stripped in a follow-up.

function DialogShell(props: {
  labelledBy: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={props.labelledBy}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="rd-dialog" style={{ maxWidth: 560 }}>
        {props.children}
      </div>
    </div>
  );
}

// SignerStack — avatar-stack of org members on a treasury row. Currently
// every org member is a signer on every treasury, so we just fetch the
// org member list once via React Query cache (re-used across rows). When
// per-treasury member sets land, swap this for a treasury-scoped query.
function SignerStack({ treasuryWalletId: _treasuryWalletId }: { treasuryWalletId: string }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const membersQuery = useQuery({
    queryKey: ['organization-members', organizationId] as const,
    queryFn: () => api.listOrganizationMembers(organizationId!),
    enabled: Boolean(organizationId),
  });
  const members = membersQuery.data?.items ?? [];
  const activeMembers = members.filter((m) => m.status === 'active');
  const total = activeMembers.length + 1; // +1 for the Decimal agent

  return (
    <div className="avatar-stack">
      {activeMembers.slice(0, 3).map((m) => (
        <span key={m.membershipId} className="as-dot">
          {initialsFromUser(m.user.displayName, m.user.email)}
        </span>
      ))}
      <span className="as-dot agent" title="Decimal agent">
        <Ico.bolt w={12} fill="currentColor" sw={0} />
      </span>
      <span className="as-more">{total}</span>
    </div>
  );
}

function initialsFromUser(name: string | null, email: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  const local = email.split('@')[0] ?? '?';
  return local.slice(0, 2).toUpperCase();
}

// Per-signer role pills — reuses the design's .perm pill style from the
// Treasury Detail members table so the visual language is consistent
// across "edit signer roles" surfaces. Three roles: Initiator (can start
// proposals), Approver (counts toward threshold), Executor (can broadcast).
function PermPills({
  initiator,
  approver,
  executor,
  disabledApprover,
  onToggle,
}: {
  initiator: boolean;
  approver: boolean;
  executor: boolean;
  disabledApprover: boolean;
  onToggle: (perm: SquadsPermission) => void;
}) {
  return (
    <div className="perm-pills" style={{ marginLeft: 'auto' }}>
      <PermPill on={initiator} label="Initiator" onClick={() => onToggle('initiate')} />
      <PermPill on={approver} label="Approver" onClick={() => onToggle('vote')} disabled={disabledApprover} title={disabledApprover ? 'You must keep Approver — the creator has to be a voting member.' : undefined} />
      <PermPill on={executor} label="Executor" onClick={() => onToggle('execute')} />
    </div>
  );
}

function PermPill({
  on,
  label,
  onClick,
  disabled,
  title,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`perm${on ? ' on' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      disabled={disabled}
      title={title}
      style={{ cursor: disabled ? 'default' : 'pointer' }}
    >
      {label}
    </button>
  );
}
