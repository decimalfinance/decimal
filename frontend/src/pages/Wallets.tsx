import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { AuthenticatedSession } from '../types';
import {
  computeWalletUsdValue,
  formatRawUsdcCompact,
  formatUsd,
  shortenAddress,
  orbAccountUrl,
} from '../domain';
import { useToast } from '../ui/Toast';

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

export function WalletsPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [addOpen, setAddOpen] = useState(false);

  const balancesQuery = useQuery({
    queryKey: ['treasury-wallet-balances', organizationId] as const,
    queryFn: () => api.listTreasuryWalletBalances(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 15_000,
  });

  const createMutation = useMutation({
    // Two-step: create a Privy-managed signing wallet, then register its
    // address as a treasury wallet for this organization. Manual address
    // entry is intentionally not exposed for now — re-add when external
    // wallet imports are needed.
    mutationFn: async (form: FormData) => {
      const displayName = String(form.get('displayName') ?? '').trim();
      const notes = String(form.get('notes') ?? '').trim();
      if (!displayName) {
        throw new Error('Wallet name is required.');
      }
      const managed = await api.createManagedWallet({
        provider: 'privy',
        label: displayName,
      });
      return api.createTreasuryWallet(organizationId!, {
        address: managed.walletAddress,
        displayName,
        notes: notes || undefined,
      });
    },
    onSuccess: async () => {
      success('Wallet created.');
      setAddOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['treasury-wallet-balances', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['addresses', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['user-wallets'] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to create wallet.'),
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
          <p className="eyebrow">Treasury</p>
          <h1>Your wallets</h1>
          <p>
            {solUsdPrice === null
              ? 'Every Solana wallet you control in this organization. Balances refresh every 15 seconds.'
              : `Every Solana wallet you control in this organization · SOL @ $${formatUsd(solUsdPrice)} · refreshes every 15s.`}
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
          <button type="button" className="button button-primary" onClick={() => setAddOpen(true)}>
            + Add wallet
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
              <strong>No wallets yet</strong>
              <p style={{ margin: '0 0 16px' }}>
                Add a Solana wallet to start receiving balances and making payments.
              </p>
              <button type="button" className="button button-primary" onClick={() => setAddOpen(true)}>
                + Add wallet
              </button>
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
                {rows.map((row) => (
                  <tr key={row.treasuryWalletId}>
                    <td>
                      <div className="rd-payee-main">
                        <span className="rd-payee-name">{row.displayName ?? 'Untitled wallet'}</span>
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
                ))}
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
    <div className="rd-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="rd-add-wallet-title">
      <div className="rd-dialog" style={{ maxWidth: 480 }}>
        <h2 id="rd-add-wallet-title" className="rd-dialog-title">
          Create wallet
        </h2>
        <p className="rd-dialog-body">
          Decimal will create a Privy-managed Solana wallet and register it as a treasury wallet for this organization. Keys never leave the browser.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(new FormData(e.currentTarget));
          }}
        >
          <label className="field">
            Wallet name
            <input name="displayName" required placeholder="Ops vault" autoComplete="off" />
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
              {pending ? 'Creating…' : 'Create via Privy'}
            </button>
          </div>
        </form>
      </div>
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
