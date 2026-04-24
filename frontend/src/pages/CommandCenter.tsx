import { useEffect, useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { AuthenticatedSession, PaymentOrder, PaymentRun, TreasuryWallet } from '../types';
import {
  computeWalletUsdValue,
  formatRawUsdcCompact,
  formatRelativeTime,
  formatUsd,
  shortenAddress,
} from '../domain';
import { displayPaymentStatus, displayRunStatus, statusToneForPayment } from '../status-labels';
import { useTour } from '../Tour';

function assetSymbol(asset: string | undefined): string {
  return (asset ?? 'usdc').toUpperCase();
}

function toneToPill(tone: 'success' | 'warning' | 'danger' | 'neutral'): 'success' | 'warning' | 'danger' | 'info' {
  return tone === 'success' ? 'success' : tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info';
}

function sourceLabel(wallet: TreasuryWallet | null): string {
  if (!wallet) return '—';
  if (wallet.displayName && wallet.displayName.trim().length) return wallet.displayName;
  return shortenAddress(wallet.address, 4, 4);
}

type RecentRow =
  | {
      kind: 'single';
      id: string;
      name: string;
      destination: string;
      source: string;
      amountLabel: string;
      state: string;
      tone: 'success' | 'warning' | 'danger' | 'neutral';
      origin: 'single';
      createdAt: string;
      to: string;
    }
  | {
      kind: 'run';
      id: string;
      name: string;
      destination: string;
      source: string;
      amountLabel: string;
      state: string;
      tone: 'success' | 'warning' | 'danger' | 'neutral';
      origin: 'run';
      originLabel: string;
      createdAt: string;
      to: string;
    };

export function CommandCenterPage({ session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const workspaceName = useMemo(() => {
    for (const org of session.organizations) {
      const ws = org.workspaces.find((w) => w.workspaceId === workspaceId);
      if (ws) return ws.workspaceName;
    }
    return 'Workspace';
  }, [session, workspaceId]);

  const ordersQuery = useQuery({
    queryKey: ['payment-orders', workspaceId] as const,
    queryFn: () => api.listPaymentOrders(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 10_000,
  });
  const runsQuery = useQuery({
    queryKey: ['payment-runs', workspaceId] as const,
    queryFn: () => api.listPaymentRuns(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 10_000,
  });
  const exceptionsQuery = useQuery({
    queryKey: ['exceptions', workspaceId] as const,
    queryFn: () => api.listExceptions(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 15_000,
  });
  const balancesQuery = useQuery({
    queryKey: ['treasury-wallet-balances', workspaceId] as const,
    queryFn: () => api.listTreasuryWalletBalances(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 15_000,
  });
  const destinationsQuery = useQuery({
    queryKey: ['destinations', workspaceId] as const,
    queryFn: () => api.listDestinations(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 30_000,
  });

  if (!workspaceId) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Workspace unavailable</h2>
          <p className="rd-state-body">Pick a workspace from the sidebar.</p>
        </div>
      </main>
    );
  }

  const orders = ordersQuery.data?.items ?? [];
  const runs = runsQuery.data?.items ?? [];
  const exceptions = exceptionsQuery.data?.items ?? [];

  const balances = balancesQuery.data?.items ?? [];
  const solUsdPrice = balancesQuery.data?.solUsdPrice ?? null;
  const treasuryTotalUsdcRaw = balances.reduce((sum, r) => {
    try {
      return sum + (r.usdcRaw === null ? 0n : BigInt(r.usdcRaw));
    } catch {
      return sum;
    }
  }, 0n).toString();
  const treasuryTotalLamports = balances.reduce((sum, r) => {
    try {
      return sum + BigInt(r.solLamports);
    } catch {
      return sum;
    }
  }, 0n);
  const treasuryTotalSol = (Number(treasuryTotalLamports) / 1_000_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
  const treasuryTotalUsd = balances.reduce(
    (acc, row) =>
      acc + computeWalletUsdValue({ usdcRaw: row.usdcRaw, solLamports: row.solLamports, solUsdPrice }),
    0,
  );

  const standaloneOrders = orders.filter((o) => !o.paymentRunId);
  const awaitingApproval = orders.filter((o) =>
    ['draft', 'pending_approval'].includes(o.derivedState),
  ).length;
  const readyToSign = orders.filter((o) =>
    ['approved', 'ready_for_execution'].includes(o.derivedState),
  ).length;
  const inFlight = orders.filter((o) => o.derivedState === 'execution_recorded').length;
  const settled = orders.filter((o) => ['settled', 'closed'].includes(o.derivedState)).length;
  const openExceptions = exceptions.filter((e) => e.status !== 'dismissed').length;

  const recent: RecentRow[] = useMemo(() => {
    const list: RecentRow[] = [
      ...standaloneOrders.map<RecentRow>((o) => ({
        kind: 'single',
        id: o.paymentOrderId,
        name: o.counterparty?.displayName ?? o.destination.label,
        destination: o.destination.walletAddress,
        source: sourceLabel(o.sourceTreasuryWallet),
        amountLabel: `${formatRawUsdcCompact(o.amountRaw)} ${assetSymbol(o.asset)}`,
        state: displayPaymentStatus(o.derivedState),
        tone: statusToneForPayment(o.derivedState),
        origin: 'single',
        createdAt: o.createdAt,
        to: `/workspaces/${workspaceId}/payments/${o.paymentOrderId}`,
      })),
      ...runs.map<RecentRow>((r) => ({
        kind: 'run',
        id: r.paymentRunId,
        name: r.runName,
        destination: `${r.totals.orderCount} destination${r.totals.orderCount === 1 ? '' : 's'}`,
        source: sourceLabel(r.sourceTreasuryWallet),
        amountLabel: `${formatRawUsdcCompact(r.totals.totalAmountRaw)} USDC`,
        state: displayRunStatus(r.derivedState),
        tone: statusToneForPayment(r.derivedState),
        origin: 'run',
        originLabel: `Batch · ${r.totals.orderCount} rows`,
        createdAt: r.createdAt,
        to: `/workspaces/${workspaceId}/runs/${r.paymentRunId}`,
      })),
    ];
    return list
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 8);
  }, [standaloneOrders, runs, workspaceId]);

  const hasData = orders.length > 0 || runs.length > 0;
  const destinationCount = destinationsQuery.data?.items.length ?? 0;
  const walletCount = balances.length;
  const isBrandNew =
    !balancesQuery.isLoading
    && !ordersQuery.isLoading
    && !runsQuery.isLoading
    && !destinationsQuery.isLoading
    && walletCount === 0
    && destinationCount === 0
    && !hasData;

  const tour = useTour();
  useEffect(() => {
    if (isBrandNew && !tour.isDismissed && !tour.isOpen) {
      tour.start();
    }
  }, [isBrandNew, tour]);

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>{workspaceName}</h1>
          <p>Deterministic financial workflow for crypto payments.</p>
        </div>
      </header>


        <div className="rd-section-head" style={{ marginBottom: 14 }}>
          <div>
            <h2 className="rd-section-title">Treasury</h2>
            <p className="rd-section-sub">
              {balances.length === 0
                ? 'Add a wallet to start tracking balance.'
                : solUsdPrice === null
                  ? 'SOL price unavailable — total value reflects USDC only.'
                  : `Live Solana balances · SOL @ $${formatUsd(solUsdPrice)}`}
            </p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => balancesQuery.refetch()}
            disabled={balancesQuery.isFetching}
            aria-busy={balancesQuery.isFetching}
            style={{ minHeight: 32, padding: '6px 12px', fontSize: 12 }}
          >
            <RefreshIcon spinning={balancesQuery.isFetching} />
            {balancesQuery.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="rd-metrics" style={{ marginBottom: 32 }}>
          <div className="rd-metric" style={{ gridColumn: 'span 2' }}>
            <span className="rd-metric-label">Total value</span>
            <span className="rd-metric-value" style={{ fontSize: 36, letterSpacing: '-0.02em' }}>
              ${formatUsd(treasuryTotalUsd)}
            </span>
          </div>
          <div className="rd-metric">
            <span className="rd-metric-label">Total USDC</span>
            <span className="rd-metric-value">{formatRawUsdcCompact(treasuryTotalUsdcRaw)}</span>
          </div>
          <div className="rd-metric">
            <span className="rd-metric-label">Total SOL</span>
            <span className="rd-metric-value">{treasuryTotalSol}</span>
          </div>
        </div>

        <div className="rd-section-head" style={{ marginBottom: 14 }}>
          <div>
            <h2 className="rd-section-title">Operations</h2>
            <p className="rd-section-sub">Payments in flight across the approval and execution lifecycle.</p>
          </div>
        </div>

        <div className="rd-metrics">
          <div className="rd-metric">
            <span className="rd-metric-label">Awaiting approval</span>
            <span className="rd-metric-value" data-tone={awaitingApproval > 0 ? 'warning' : undefined}>
              {awaitingApproval}
            </span>
          </div>
          <div className="rd-metric">
            <span className="rd-metric-label">Ready to sign</span>
            <span className="rd-metric-value" data-tone={readyToSign > 0 ? 'warning' : undefined}>
              {readyToSign}
            </span>
          </div>
          <div className="rd-metric">
            <span className="rd-metric-label">In flight</span>
            <span className="rd-metric-value">{inFlight}</span>
          </div>
          <div className="rd-metric">
            <span className="rd-metric-label">Settled</span>
            <span className="rd-metric-value" data-tone="success">
              {settled}
            </span>
          </div>
        </div>

        {openExceptions > 0 ? (
          <div className="rd-notice" data-tone="danger" style={{ marginBottom: 32 }}>
            <strong style={{ fontWeight: 600 }}>{openExceptions}</strong> open exception
            {openExceptions === 1 ? '' : 's'} — payments that didn't match expected settlement.{' '}
            <Link
              to={`/workspaces/${workspaceId}/exceptions`}
              style={{ color: 'inherit', textDecoration: 'underline' }}
            >
              Review
            </Link>
            .
          </div>
        ) : null}

        <section className="rd-section" style={{ marginTop: 8 }}>
          <div className="rd-section-head">
            <div>
              <h2 className="rd-section-title">Recent activity</h2>
              <p className="rd-section-sub">Latest payments and batches across this workspace.</p>
            </div>
            <Link to={`/workspaces/${workspaceId}/payments`} className="rd-btn rd-btn-ghost" style={{ minHeight: 32, padding: '6px 10px', fontSize: 12 }}>
              View all
              <span className="rd-btn-arrow" aria-hidden>→</span>
            </Link>
          </div>
          <div className="rd-table-shell">
            {ordersQuery.isLoading || runsQuery.isLoading ? (
              <div style={{ padding: 16 }}>
                <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
                <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
                <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
              </div>
            ) : !hasData ? (
              <div className="rd-empty-cell" style={{ padding: '64px 24px' }}>
                <strong>No payments yet</strong>
                <p style={{ margin: '0 0 16px' }}>
                  Create a single payment or import a CSV to begin a workflow.
                </p>
                <Link to={`/workspaces/${workspaceId}/payments`} className="rd-btn rd-btn-primary">
                  New payment
                </Link>
              </div>
            ) : (
              <table className="rd-table">
                <thead>
                  <tr>
                    <th style={{ width: '22%' }}>Recipient / Run</th>
                    <th style={{ width: '18%' }}>Destination</th>
                    <th style={{ width: '16%' }}>Source</th>
                    <th className="rd-num" style={{ width: '14%' }}>
                      Amount
                    </th>
                    <th style={{ width: '12%' }}>Origin</th>
                    <th style={{ width: '12%' }}>Status</th>
                    <th aria-label="Actions" style={{ width: '6%' }} />
                  </tr>
                </thead>
                <tbody>
                  {recent.map((row) => (
                    <tr
                      key={`${row.kind}:${row.id}`}
                      onClick={() => navigate(row.to)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <div className="rd-recipient-main">
                          <span className="rd-recipient-name">{row.name}</span>
                          <span className="rd-recipient-ref">{formatRelativeTime(row.createdAt)}</span>
                        </div>
                      </td>
                      <td>
                        {row.kind === 'single' ? (
                          <span className="rd-addr">{shortenAddress(row.destination, 4, 4)}</span>
                        ) : (
                          <span style={{ color: 'var(--ax-text-muted)', fontSize: 12 }}>{row.destination}</span>
                        )}
                      </td>
                      <td>
                        {row.source === '—' ? (
                          <span style={{ color: 'var(--ax-text-faint)' }}>—</span>
                        ) : (
                          <span style={{ fontSize: 13, color: 'var(--ax-text-secondary)' }}>{row.source}</span>
                        )}
                      </td>
                      <td className="rd-num">{row.amountLabel}</td>
                      <td>
                        <span className="rd-origin" data-kind={row.kind === 'run' ? 'run' : undefined}>
                          {row.kind === 'run' ? row.originLabel : 'Single'}
                        </span>
                      </td>
                      <td>
                        <span className="rd-pill" data-tone={toneToPill(row.tone)}>
                          <span className="rd-pill-dot" aria-hidden />
                          {row.state}
                        </span>
                      </td>
                      <td>
                        <span className="rd-btn-arrow" style={{ color: 'var(--ax-text-muted)' }} aria-hidden>
                          →
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

    </main>
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
