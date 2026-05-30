import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  CreateSquadsTreasuryIntentRequest,
  CreateSquadsTreasuryIntentResponse,
  OrganizationPersonalWallet,
  SquadsPermission,
  UserWallet,
} from '../types';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import {
  computeWalletUsdValue,
  formatRawUsdcCompact,
  formatUsd,
  shortenAddress,
} from '../domain';
import { resolveSolanaRpcUrl, waitForSignatureVisible } from '../lib/solana-wallet';
import { useToast } from '../ui/Toast';
import { ChainLink, CopyButton, EmptyIcon, RdEmptyState } from '../ui-primitives';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

function formatSolFromLamports(lamports: string): string {
  let value: bigint;
  try {
    value = BigInt(lamports);
  } catch {
    return '0.0000';
  }
  const whole = value / LAMPORTS_PER_SOL;
  const fractional = value % LAMPORTS_PER_SOL;
  const fractionalPadded = fractional.toString().padStart(9, '0');
  const fourDecimal = fractionalPadded.slice(0, 4);
  return `${whole.toString()}.${fourDecimal}`;
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

function sumSol(values: string[]): string {
  let total = 0n;
  for (const v of values) {
    try {
      total += BigInt(v);
    } catch {
      // skip
    }
  }
  return formatSolFromLamports(total.toString());
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
  const totalSol = useMemo(() => sumSol(rows.map((r) => r.solLamports)), [rows]);
  const totalUsdValue = useMemo(
    () => rows.reduce((acc, row) => acc + computeWalletUsdValue({ usdcRaw: row.usdcRaw }), 0),
    [rows],
  );
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
  const [step, setStep] = useState<'config' | 'review' | 'sign'>('config');
  const [name, setName] = useState('');
  const [creatorWalletId, setCreatorWalletId] = useState('');
  const [memberPermissions, setMemberPermissions] = useState<Record<string, SquadsPermission[]>>({});
  const [threshold, setThreshold] = useState<number>(1);
  const [pendingIntent, setPendingIntent] = useState<CreateSquadsTreasuryIntentResponse | null>(null);

  const orgWalletsQuery = useQuery({
    queryKey: ['organization-personal-wallets', organizationId] as const,
    queryFn: () => api.listOrganizationPersonalWallets(organizationId),
    enabled: Boolean(organizationId),
  });
  const orgWallets = orgWalletsQuery.data?.items ?? [];

  const voterCount = useMemo(
    () =>
      Object.values(memberPermissions).filter((perms) => perms.includes('vote')).length,
    [memberPermissions],
  );

  // Force the creator's personal wallet into the member list with all
  // permissions. Backend rejects intents where the creator isn't a member.
  useEffect(() => {
    if (!creatorWalletId) return;
    setMemberPermissions((prev) => {
      if (prev[creatorWalletId]) return prev;
      return { ...prev, [creatorWalletId]: [...ALL_SQUADS_PERMISSIONS] };
    });
  }, [creatorWalletId]);

  // Keep threshold within the valid range as voterCount changes.
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

  // Auto-select the only wallet if exactly one exists.
  useEffect(() => {
    if (!creatorWalletId && personalWallets.length === 1) {
      setCreatorWalletId(personalWallets[0].userWalletId);
    }
  }, [personalWallets, creatorWalletId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const intentMutation = useMutation({
    mutationFn: () => {
      if (!creatorWalletId) {
        throw new Error('Pick a personal wallet to act as the Squads creator.');
      }
      const members: CreateSquadsTreasuryIntentRequest['members'] = Object.entries(memberPermissions)
        .filter(([, permissions]) => permissions.length > 0)
        .map(([personalWalletId, permissions]) => ({ personalWalletId, permissions }));
      if (members.length === 0) {
        throw new Error('Select at least one member.');
      }
      if (!members.some((m) => m.personalWalletId === creatorWalletId)) {
        throw new Error('Creator wallet must be in the member list.');
      }
      const voterCount = members.filter((m) => m.permissions.includes('vote')).length;
      if (voterCount === 0) {
        throw new Error('At least one member must have the vote permission.');
      }
      if (threshold < 1 || threshold > voterCount) {
        throw new Error(`Threshold must be between 1 and ${voterCount}.`);
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
      setStep('review');
    },
    onError: (err) => onError(err instanceof Error ? err.message : 'Could not prepare Squads transaction.'),
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

  const intent = pendingIntent?.intent;
  const tx = pendingIntent?.transaction;

  return (
    <DialogShell labelledBy="rd-squads-title" onClose={onClose}>
      {step === 'config' ? (
        <>
          <h2 id="rd-squads-title" className="rd-dialog-title">
            Create treasury
          </h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              intentMutation.mutate();
            }}
          >
            <label className="field" style={{ marginBottom: 24 }}>
              Treasury name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ops treasury"
                autoComplete="off"
                autoFocus
                required
              />
            </label>

            {/* Show signing wallet picker only if the user has more than one
                personal wallet. The common case is exactly one (auto-provisioned
                Privy wallet) and exposing it just adds blockchain noise. */}
            {personalWallets.length > 1 ? (
              <label className="field" style={{ marginBottom: 24 }}>
                Sign as
                <select
                  value={creatorWalletId}
                  onChange={(e) => setCreatorWalletId(e.target.value)}
                  required
                >
                  {personalWallets.map((w) => (
                    <option key={w.userWalletId} value={w.userWalletId}>
                      {w.label ?? 'Personal wallet'}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <SquadsConfigSection title="Members">
              {orgWalletsQuery.isLoading ? (
                <div className="rd-skeleton rd-skeleton-block" style={{ height: 120 }} />
              ) : orgWallets.length === 0 ? (
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
                  No teammates are ready to approve yet. Invite them first — they'll need to set up their account before they can be added here.
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    border: '1px solid var(--ax-border)',
                    borderRadius: 8,
                    overflow: 'hidden',
                    maxHeight: 320,
                    overflowY: 'auto',
                  }}
                >
                  {orgWallets.map((wallet, idx) => {
                    const isCreator = wallet.userWalletId === creatorWalletId;
                    const permissions = memberPermissions[wallet.userWalletId] ?? [];
                    const selected = permissions.length > 0;
                    return (
                      <SquadsMemberRow
                        key={wallet.userWalletId}
                        wallet={wallet}
                        permissions={permissions}
                        selected={selected}
                        isCreator={isCreator}
                        first={idx === 0}
                        onToggleSelected={() => {
                          if (isCreator) return;
                          setMemberPermissions((prev) => {
                            if (prev[wallet.userWalletId]) {
                              const { [wallet.userWalletId]: _omit, ...rest } = prev;
                              return rest;
                            }
                            return {
                              ...prev,
                              [wallet.userWalletId]: [...ALL_SQUADS_PERMISSIONS],
                            };
                          });
                        }}
                        onTogglePermission={(perm) => {
                          setMemberPermissions((prev) => {
                            const current = prev[wallet.userWalletId] ?? [];
                            const next = current.includes(perm)
                              ? current.filter((p) => p !== perm)
                              : [...current, perm];
                            // Removing the last permission deselects the
                            // member entirely (except for the creator, who
                            // must keep at least one).
                            if (next.length === 0) {
                              if (isCreator) return prev;
                              const { [wallet.userWalletId]: _omit, ...rest } = prev;
                              return rest;
                            }
                            return { ...prev, [wallet.userWalletId]: next };
                          });
                        }}
                      />
                    );
                  })}

                  {/* AI agent at the end — backend auto-includes it with
                      initiate-only. Locked, can't be toggled. */}
                  <AgentApproverRow />
                </div>
              )}
            </SquadsConfigSection>

            <SquadsConfigSection title="Approvals required">
              <ThresholdSelector
                value={threshold}
                max={voterCount}
                onChange={setThreshold}
              />
              <p style={{ fontSize: 13, color: 'var(--ax-text-muted)', margin: '10px 0 0' }}>
                {voterCount === 0
                  ? 'Pick at least one approver above.'
                  : `${threshold} of ${voterCount} approver${voterCount === 1 ? '' : 's'} needed to send a payment.`}
              </p>
            </SquadsConfigSection>

            <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
              <button type="button" className="button button-secondary" onClick={onClose} disabled={intentMutation.isPending}>
                Cancel
              </button>
              <button
                type="submit"
                className="button button-primary"
                disabled={
                  !creatorWalletId
                  || !name.trim()
                  || intentMutation.isPending
                  || voterCount === 0
                  || threshold < 1
                  || threshold > voterCount
                }
                aria-busy={intentMutation.isPending}
              >
                {intentMutation.isPending ? 'Loading…' : 'Continue'}
              </button>
            </div>
          </form>
        </>
      ) : step === 'review' && intent && tx ? (
        <>
          <h2 id="rd-squads-title" className="rd-dialog-title">
            Review treasury
          </h2>
          <p className="rd-dialog-body">
            Looks good? Confirm to create it.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SquadsReviewRow label="Name" value={intent.displayName} />
            <SquadsReviewRow
              label="Approvals required"
              value={(() => {
                // Threshold denominator counts only members who can actually
                // vote. The Decimal agent has initiate-only permission, so it
                // wouldn't be eligible to satisfy the threshold even if it
                // were on the multisig.
                const votingCount = intent.members.filter((m) =>
                  m.permissions.includes('vote'),
                ).length;
                return `${intent.threshold} of ${votingCount}`;
              })()}
            />
            <SquadsReviewRow
              label="Members"
              value={
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {intent.members.map((m) => {
                    const wallet = orgWallets.find((w) => w.userWalletId === m.personalWalletId);
                    const isAgent = !wallet && m.permissions.length === 1 && m.permissions[0] === 'initiate';
                    const name = isAgent
                      ? 'Decimal agent'
                      : (wallet?.user.displayName || wallet?.user.email || 'Team member');
                    return (
                      <li
                        key={m.personalWalletId}
                        style={{
                          fontSize: 13,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                        }}
                      >
                        <span>{name}</span>
                        <span className="approver-perms">
                          {(['Initiate', 'Vote', 'Execute'] as const).map((label) => (
                            <PermissionPill
                              key={label}
                              label={label}
                              active={m.permissions.includes(label.toLowerCase() as 'initiate' | 'vote' | 'execute')}
                            />
                          ))}
                        </span>
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
            <button type="button" className="button button-primary" onClick={() => setStep('sign')}>
              Create treasury
            </button>
          </div>
        </>
      ) : step === 'sign' && intent && tx ? (
        <>
          <h2 id="rd-squads-title" className="rd-dialog-title">
            Creating your treasury
          </h2>
          <p className="rd-dialog-body">
            This takes a few seconds. Don't close this window.
          </p>

          <div style={{ marginBottom: 12 }}>
            <SquadsPhaseList phase={phase} />
          </div>

          {phaseError ? (
            <div
              style={{
                padding: 12,
                border: '1px solid var(--ax-danger)',
                borderRadius: 6,
                background: 'var(--ax-surface-1)',
                fontSize: 13,
                lineHeight: 1.5,
                marginBottom: 12,
              }}
            >
              <strong style={{ display: 'block', marginBottom: 4, color: 'var(--ax-danger)' }}>
                {phase === 'submitted-pending-confirm' ? 'Almost there — confirmation pending' : 'Something went wrong'}
              </strong>
              <span style={{ color: 'var(--ax-text-muted)' }}>{phaseError}</span>
            </div>
          ) : null}

          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setStep('review')}
              disabled={phase === 'signing' || phase === 'submitting' || phase === 'confirming-onchain' || phase === 'persisting'}
            >
              Back
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={() => runSignAndConfirm()}
              disabled={phase === 'signing' || phase === 'submitting' || phase === 'confirming-onchain' || phase === 'persisting'}
              aria-busy={phase === 'signing' || phase === 'submitting' || phase === 'confirming-onchain' || phase === 'persisting'}
            >
              {phase === 'idle' || phase === 'error'
                ? 'Create treasury'
                : phase === 'submitted-pending-confirm'
                  ? 'Retry'
                  : 'Working…'}
            </button>
          </div>
        </>
      ) : null}
    </DialogShell>
  );
}

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

type SquadsPhase =
  | 'idle'
  | 'signing'
  | 'submitting'
  | 'confirming-onchain'
  | 'persisting'
  | 'submitted-pending-confirm'
  | 'error';

function SquadsPhaseList({ phase }: { phase: SquadsPhase }) {
  const steps: Array<{ key: SquadsPhase; label: string }> = [
    { key: 'signing', label: 'Signing' },
    { key: 'submitting', label: 'Sending' },
    { key: 'confirming-onchain', label: 'Confirming' },
    { key: 'persisting', label: 'Saving treasury' },
  ];
  const order: SquadsPhase[] = ['idle', 'signing', 'submitting', 'confirming-onchain', 'persisting'];
  const currentIndex = order.indexOf(phase);

  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
      {steps.map((step, i) => {
        const stepIndex = order.indexOf(step.key);
        const isActive = phase === step.key;
        const isDone =
          phase === 'submitted-pending-confirm'
            ? // After a submitted tx, signing + submitting are done; the
              // current step in flight is confirm-on-chain or persisting
              i < 2
            : currentIndex > stepIndex;
        return (
          <li
            key={step.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 13,
              color: isActive
                ? 'var(--ax-text)'
                : isDone
                  ? 'var(--ax-text-muted)'
                  : 'var(--ax-text-faint)',
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
                background: isDone ? 'var(--ax-accent-dim)' : 'var(--ax-surface-2)',
                color: isDone ? 'var(--ax-accent)' : 'var(--ax-text-muted)',
                border: isActive ? '1px solid var(--ax-accent)' : '1px solid transparent',
              }}
            >
              {isDone ? '✓' : i + 1}
            </span>
            {step.label}
            {isActive ? (
              <span style={{ color: 'var(--ax-text-muted)', fontSize: 12 }}>· in progress…</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function SquadsConfigSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--ax-text-muted)',
          fontWeight: 600,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {hint ? (
        <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--ax-text-muted)', lineHeight: 1.5 }}>
          {hint}
        </p>
      ) : null}
      {children}
    </section>
  );
}

function SquadsMemberRow({
  wallet,
  permissions,
  selected,
  isCreator,
  first,
  onToggleSelected,
  onTogglePermission,
}: {
  wallet: OrganizationPersonalWallet;
  permissions: SquadsPermission[];
  selected: boolean;
  isCreator: boolean;
  first: boolean;
  onToggleSelected: () => void;
  onTogglePermission: (perm: SquadsPermission) => void;
}) {
  const displayName = wallet.user.displayName || wallet.user.email;
  const subtle = wallet.user.displayName ? wallet.user.email : null;

  return (
    <div
      className="approver-row"
      style={{
        borderTop: first ? 'none' : '1px solid var(--ax-border)',
        background: selected ? 'var(--ax-surface-1)' : 'transparent',
      }}
    >
      <CustomCheckbox
        checked={selected}
        disabled={isCreator}
        onChange={onToggleSelected}
        title={isCreator ? "You're always a member as the creator." : undefined}
      />
      <div className="approver-row-body">
        <div className="approver-row-name">
          <span>{displayName}</span>
          {isCreator ? <span className="rd-pill rd-pill-info approver-row-tag">You</span> : null}
        </div>
        {subtle ? <div className="approver-row-sub">{subtle}</div> : null}
      </div>
      <div className="approver-perms">
        {(['initiate', 'vote', 'execute'] as const).map((perm) => (
          <PermissionPill
            key={perm}
            label={perm[0]!.toUpperCase() + perm.slice(1)}
            active={permissions.includes(perm)}
            onClick={selected ? () => onTogglePermission(perm) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function AgentApproverRow() {
  return (
    <div
      className="approver-row approver-row-agent"
      style={{ borderTop: '1px solid var(--ax-border)' }}
    >
      {/* Empty checkbox slot — keeps the row aligned with the human rows
          above but communicates "you can't toggle this off". */}
      <span aria-hidden style={{ width: 18 }} />
      <div className="approver-row-body">
        <div className="approver-row-name">
          <span>Decimal agent</span>
        </div>
      </div>
      <div className="approver-perms">
        <PermissionPill label="Initiate" active />
      </div>
    </div>
  );
}

function PermissionPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick?: () => void;
}) {
  const className = `permission-pill${active ? ' permission-pill-active' : ''}${onClick ? ' permission-pill-clickable' : ''}`;
  if (!onClick) {
    return <span className={className}>{label}</span>;
  }
  return (
    <button type="button" className={className} onClick={onClick}>
      {label}
    </button>
  );
}

function CustomCheckbox({
  checked,
  disabled,
  onChange,
  title,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      title={title}
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

function ThresholdSelector({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const safeMax = Math.max(1, max);
  const options = Array.from({ length: safeMax }, (_, i) => i + 1);
  return (
    <div className="threshold-segmented" role="radiogroup" aria-label="Approvals required">
      {options.map((n) => {
        const selected = n === value;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`threshold-btn${selected ? ' threshold-btn-selected' : ''}`}
            onClick={() => onChange(n)}
            disabled={max === 0}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

function SquadsReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '160px 1fr',
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

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{
        display: 'inline-block',
        marginRight: 4,
        animation: spinning ? 'rd-spin 900ms linear infinite' : undefined,
      }}
    >
      <path d="M3 10a7 7 0 0 1 12-5l2.5 2.5" />
      <path d="M17 3v4.5h-4.5" />
      <path d="M17 10a7 7 0 0 1-12 5L2.5 12.5" />
      <path d="M3 17v-4.5h4.5" />
    </svg>
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
