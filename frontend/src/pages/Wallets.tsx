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
  orbAccountUrl,
} from '../domain';
import { resolveSolanaRpcUrl, waitForSignatureVisible } from '../lib/solana-wallet';
import { useToast } from '../ui/Toast';

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
    const map = new Map<string, { source: string; sourceRef: string | null }>();
    for (const w of treasuryWalletsQuery.data?.items ?? []) {
      map.set(w.treasuryWalletId, { source: w.source, sourceRef: w.sourceRef });
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
  const solUsdPrice = balancesQuery.data?.solUsdPrice ?? null;
  const totalUsdcRaw = useMemo(() => sumUsdc(rows.map((r) => r.usdcRaw)), [rows]);
  const totalSol = useMemo(() => sumSol(rows.map((r) => r.solLamports)), [rows]);
  const totalUsdValue = useMemo(
    () =>
      rows.reduce(
        (acc, row) =>
          acc
          + computeWalletUsdValue({
            usdcRaw: row.usdcRaw,
            solLamports: row.solLamports,
            solUsdPrice,
          }),
        0,
      ),
    [rows, solUsdPrice],
  );
  const fetchedAt = balancesQuery.data?.fetchedAt;
  const isInitialLoading = balancesQuery.isLoading && rows.length === 0;

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

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Registry</p>
          <h1>Treasury accounts</h1>
          <p>
            {solUsdPrice === null
              ? 'Organization-owned Solana wallets that Decimal monitors and reconciles. Balances refresh every 15 seconds.'
              : `Organization-owned Solana wallets that Decimal monitors and reconciles · SOL @ $${formatUsd(solUsdPrice)} · refreshes every 15s.`}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => balancesQuery.refetch()}
            disabled={balancesQuery.isFetching}
            aria-busy={balancesQuery.isFetching}
          >
            <RefreshIcon spinning={balancesQuery.isFetching} />
            {balancesQuery.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="button button-secondary" onClick={() => setAddOpen(true)}>
            + Add existing address
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => setCreateSquadsOpen(true)}
          >
            + Create Squads treasury
          </button>
        </div>
      </header>

      <div className="rd-metrics">
        <div className="rd-metric">
          <span className="rd-metric-label">Total value</span>
          <span className="rd-metric-value">${formatUsd(totalUsdValue)}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Total USDC</span>
          <span className="rd-metric-value">{formatRawUsdcCompact(totalUsdcRaw)}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Total SOL</span>
          <span className="rd-metric-value">{totalSol}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Wallets</span>
          <span className="rd-metric-value">{rows.length}</span>
        </div>
      </div>

      <section className="rd-section" style={{ marginTop: 8 }}>
        <div className="rd-table-shell">
          {isInitialLoading ? (
            <div style={{ padding: 16 }}>
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
            </div>
          ) : rows.length === 0 ? (
            <div className="rd-empty-cell" style={{ padding: '64px 24px' }}>
              <strong>Add an organization treasury account</strong>
              <p style={{ margin: '0 0 16px' }}>
                This is the wallet Decimal monitors and reconciles. Personal signing wallets live on your profile.
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setCreateSquadsOpen(true)}
                >
                  + Create Squads treasury
                </button>
                <button type="button" className="button button-secondary" onClick={() => setAddOpen(true)}>
                  + Add existing address
                </button>
              </div>
            </div>
          ) : (
            <table className="rd-table">
              <thead>
                <tr>
                  <th style={{ width: '20%' }}>Name</th>
                  <th style={{ width: '20%' }}>Address</th>
                  <th className="rd-num" style={{ width: '16%' }}>
                    USDC
                  </th>
                  <th className="rd-num" style={{ width: '14%' }}>
                    SOL
                  </th>
                  <th className="rd-num" style={{ width: '18%' }}>
                    Total value
                  </th>
                  <th style={{ width: '12%' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const meta = treasuryWalletMetaById.get(row.treasuryWalletId);
                  const isSquads = meta?.source === 'squads_v4';
                  const multisigPda = isSquads ? meta?.sourceRef : null;
                  return (
                  <tr key={row.treasuryWalletId}>
                    <td>
                      <div className="rd-payee-main">
                        <span className="rd-payee-name" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {isSquads ? (
                            <Link
                              to={`/organizations/${organizationId}/wallets/${row.treasuryWalletId}`}
                              style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 3, textDecorationColor: 'rgba(255,255,255,0.25)' }}
                            >
                              {row.displayName ?? 'Untitled wallet'}
                            </Link>
                          ) : (
                            <span>{row.displayName ?? 'Untitled wallet'}</span>
                          )}
                          {isSquads ? (
                            <span
                              className="rd-pill rd-pill-info"
                              style={{ fontSize: 10, padding: '2px 8px' }}
                              title="Backed by a Squads v4 multisig"
                            >
                              Squads
                            </span>
                          ) : null}
                        </span>
                        {row.rpcError ? (
                          <span className="rd-payee-ref" style={{ color: 'var(--ax-warning)' }}>
                            {row.rpcError}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <a
                        href={orbAccountUrl(row.address)}
                        target="_blank"
                        rel="noreferrer"
                        className="rd-addr-link"
                        title={row.address}
                      >
                        <span>{shortenAddress(row.address, 4, 4)}</span>
                        <ExternalIcon />
                      </a>
                      {multisigPda ? (
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--ax-text-muted)',
                            marginTop: 2,
                            fontFamily: 'monospace',
                          }}
                          title={`Multisig PDA: ${multisigPda}`}
                        >
                          multisig {shortenAddress(multisigPda, 4, 4)}
                        </div>
                      ) : null}
                    </td>
                    <td className="rd-num">
                      {row.usdcRaw === null ? (
                        <span style={{ color: 'var(--ax-text-faint)' }}>—</span>
                      ) : (
                        <span>{formatRawUsdcCompact(row.usdcRaw)} USDC</span>
                      )}
                    </td>
                    <td className="rd-num">{formatSolFromLamports(row.solLamports)} SOL</td>
                    <td className="rd-num">
                      <span>
                        $
                        {formatUsd(
                          computeWalletUsdValue({
                            usdcRaw: row.usdcRaw,
                            solLamports: row.solLamports,
                            solUsdPrice,
                          }),
                        )}
                      </span>
                    </td>
                    <td>
                      <span className="rd-pill" data-tone={row.isActive ? 'success' : undefined}>
                        <span className="rd-pill-dot" aria-hidden />
                        {row.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

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
    </main>
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
const SQUADS_PERMISSION_LABEL: Record<SquadsPermission, string> = {
  initiate: 'Initiate',
  vote: 'Vote',
  execute: 'Execute',
};

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
          Create your signing wallet first
        </h2>
        <p className="rd-dialog-body">
          A Squads treasury needs at least one personal wallet as a member. Create a Privy signing wallet on your profile, then come back here.
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
  const requiredSignerWallet =
    tx && personalWallets.find((w) => w.walletAddress === tx.requiredSigner);

  return (
    <DialogShell labelledBy="rd-squads-title" onClose={onClose}>
      {step === 'config' ? (
        <>
          <h2 id="rd-squads-title" className="rd-dialog-title">
            Create Squads treasury
          </h2>
          <p className="rd-dialog-body">
            An organization treasury controlled by a Squads multisig. Pick the signers, their permissions, and how many votes are needed to execute payments.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              intentMutation.mutate();
            }}
          >
            <SquadsConfigSection title="Basics">
              <label className="field">
                Treasury name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ops treasury"
                  autoComplete="off"
                  autoFocus
                />
              </label>
              <label className="field">
                Your signing wallet
                <select
                  value={creatorWalletId}
                  onChange={(e) => setCreatorWalletId(e.target.value)}
                  required
                  disabled={personalWallets.length <= 1}
                >
                  {personalWallets.length === 0 ? <option value="">Loading…</option> : null}
                  {personalWallets.map((w) => (
                    <option key={w.userWalletId} value={w.userWalletId}>
                      {(w.label ?? 'Untitled')} · {shortenAddress(w.walletAddress, 4, 4)}
                    </option>
                  ))}
                </select>
                <p
                  style={{
                    fontSize: 12,
                    color: 'var(--ax-text-muted)',
                    margin: '4px 0 0',
                  }}
                >
                  Signs the create transaction on chain. Auto-included as a member.
                </p>
              </label>
            </SquadsConfigSection>

            <SquadsConfigSection
              title="Members"
              hint="Personal wallets that will sign Squads proposals. Toggle each permission per member."
            >
              {orgWalletsQuery.isLoading ? (
                <div className="rd-skeleton rd-skeleton-block" style={{ height: 120 }} />
              ) : orgWallets.length === 0 ? (
                <div
                  style={{
                    padding: 12,
                    border: '1px dashed var(--ax-border)',
                    borderRadius: 6,
                    fontSize: 13,
                    color: 'var(--ax-text-muted)',
                  }}
                >
                  No active personal wallets among org members. Ask teammates to create a personal wallet on /profile.
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    border: '1px solid var(--ax-border)',
                    borderRadius: 8,
                    overflow: 'hidden',
                    maxHeight: 280,
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
                </div>
              )}
            </SquadsConfigSection>

            <SquadsConfigSection title="Approval threshold">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, voterCount)}
                  value={threshold}
                  onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
                  style={{ width: 80 }}
                />
                <span style={{ fontSize: 13, color: 'var(--ax-text-muted)' }}>
                  of {voterCount} voting member{voterCount === 1 ? '' : 's'} must approve before a proposal can execute.
                </span>
              </div>
              {voterCount === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--ax-warning)', margin: '8px 0 0' }}>
                  At least one member needs the Vote permission.
                </p>
              ) : null}
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
                  || intentMutation.isPending
                  || voterCount === 0
                  || threshold < 1
                  || threshold > voterCount
                }
                aria-busy={intentMutation.isPending}
              >
                {intentMutation.isPending ? 'Preparing…' : 'Prepare transaction'}
              </button>
            </div>
          </form>
        </>
      ) : step === 'review' && intent && tx ? (
        <>
          <h2 id="rd-squads-title" className="rd-dialog-title">
            Review Squads treasury
          </h2>
          <p className="rd-dialog-body">
            Verify the prepared multisig before signing. Decimal will persist the vault PDA as the treasury address and the multisig PDA as the source reference.
          </p>
          <div className="rd-form-grid" style={{ gap: 12 }}>
            <SquadsReviewRow label="Treasury name" value={intent.displayName || '(unnamed)'} />
            <SquadsReviewRow
              label="Threshold"
              value={`${intent.threshold} of ${intent.members.length}`}
            />
            <SquadsReviewRow
              label="Required signer"
              value={
                <span style={{ fontFamily: 'monospace' }}>
                  {shortenAddress(tx.requiredSigner, 6, 6)}
                  {requiredSignerWallet ? (
                    <span style={{ color: 'var(--ax-text-muted)', marginLeft: 8 }}>
                      ({requiredSignerWallet.label ?? 'this wallet'})
                    </span>
                  ) : null}
                </span>
              }
            />
            <SquadsReviewRow
              label="Multisig address"
              value={<span style={{ fontFamily: 'monospace' }}>{shortenAddress(intent.multisigPda, 6, 6)}</span>}
            />
            <SquadsReviewRow
              label="Treasury vault"
              value={<span style={{ fontFamily: 'monospace' }}>{shortenAddress(intent.vaultPda, 6, 6)}</span>}
            />
            <SquadsReviewRow
              label="Members"
              value={
                <ul style={{ margin: 0, paddingLeft: 16, lineHeight: 1.6 }}>
                  {intent.members.map((m) => (
                    <li key={m.personalWalletId} style={{ fontSize: 13 }}>
                      <span style={{ fontFamily: 'monospace' }}>{shortenAddress(m.walletAddress, 4, 4)}</span>
                      <span style={{ color: 'var(--ax-text-muted)', marginLeft: 8 }}>
                        {m.permissions.join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              }
            />
          </div>
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button type="button" className="button button-secondary" onClick={() => setStep('config')}>
              Back
            </button>
            <button type="button" className="button button-primary" onClick={() => setStep('sign')}>
              Sign and create
            </button>
          </div>
        </>
      ) : step === 'sign' && intent && tx ? (
        <>
          <h2 id="rd-squads-title" className="rd-dialog-title">
            Sign and confirm
          </h2>
          <p className="rd-dialog-body">
            Decimal will sign with your Privy-backed personal wallet, submit to chain, and persist the new treasury record. Don't close this window.
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
                {phase === 'submitted-pending-confirm' ? 'Transaction landed but confirmation failed' : 'Squads creation failed'}
              </strong>
              <span style={{ color: 'var(--ax-text-muted)' }}>{phaseError}</span>
              {phase === 'submitted-pending-confirm' && submittedSignature ? (
                <div style={{ marginTop: 8, fontSize: 12, fontFamily: 'monospace', color: 'var(--ax-text-muted)' }}>
                  signature: {shortenAddress(submittedSignature, 8, 8)}
                </div>
              ) : null}
            </div>
          ) : null}

          <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', fontFamily: 'monospace' }}>
            createKey: {shortenAddress(intent.createKey, 6, 6)} · multisig:{' '}
            {shortenAddress(intent.multisigPda, 6, 6)} · vault: {shortenAddress(intent.vaultPda, 6, 6)}
          </div>

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
                ? 'Sign and create'
                : phase === 'submitted-pending-confirm'
                  ? 'Retry confirmation'
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
    { key: 'signing', label: 'Sign with Privy wallet' },
    { key: 'submitting', label: 'Submit to Solana' },
    { key: 'confirming-onchain', label: 'Confirm on-chain' },
    { key: 'persisting', label: 'Persist treasury record' },
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
  const role = wallet.membership?.role ?? 'member';

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        borderTop: first ? 'none' : '1px solid var(--ax-border)',
        background: selected ? 'var(--ax-surface-1)' : 'transparent',
        opacity: selected ? 1 : 0.78,
      }}
    >
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          cursor: isCreator ? 'not-allowed' : 'pointer',
        }}
        title={isCreator ? 'Creator wallet is required as a member.' : 'Include as Squads member'}
      >
        <input
          type="checkbox"
          checked={selected}
          disabled={isCreator}
          onChange={onToggleSelected}
        />
      </label>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 500 }}>{displayName}</span>
          {isCreator ? (
            <span className="rd-pill rd-pill-info" style={{ fontSize: 10 }}>
              You · creator
            </span>
          ) : null}
          <span className="rd-pill rd-pill-info" style={{ fontSize: 10 }}>{role}</span>
        </div>
        {subtle ? (
          <div style={{ fontSize: 11, color: 'var(--ax-text-muted)' }}>{subtle}</div>
        ) : null}
        <div style={{ fontSize: 11, color: 'var(--ax-text-muted)', fontFamily: 'monospace', marginTop: 2 }}>
          {wallet.label ? `${wallet.label} · ` : ''}{shortenAddress(wallet.walletAddress, 4, 4)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {ALL_SQUADS_PERMISSIONS.map((perm) => {
          const active = permissions.includes(perm);
          const disabled = !selected;
          return (
            <button
              key={perm}
              type="button"
              onClick={() => onTogglePermission(perm)}
              disabled={disabled}
              title={`Toggle ${SQUADS_PERMISSION_LABEL[perm]} permission`}
              style={{
                fontSize: 11,
                padding: '3px 9px',
                borderRadius: 999,
                border: '1px solid var(--ax-border)',
                background: active ? 'var(--ax-accent-dim)' : 'transparent',
                color: active ? 'var(--ax-accent)' : 'var(--ax-text-muted)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.5 : 1,
              }}
            >
              {SQUADS_PERMISSION_LABEL[perm]}
            </button>
          );
        })}
      </div>
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

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h7v7M13 3 6 10M3 5v8h8" />
    </svg>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}
