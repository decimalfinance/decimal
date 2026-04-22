import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { CollectionRequest, CollectionRunSummary } from '../types';
import { formatRawUsdcCompact, formatRelativeTime, shortenAddress } from '../domain';
import {
  collectionRunProgressLine,
  displayCollectionStatus,
  statusToneForCollection,
} from '../status-labels';
import { useToast } from '../ui/Toast';

function toneToPill(
  tone: 'success' | 'warning' | 'danger' | 'neutral',
): 'success' | 'warning' | 'danger' | 'info' {
  return tone === 'success'
    ? 'success'
    : tone === 'danger'
      ? 'danger'
      : tone === 'warning'
        ? 'warning'
        : 'info';
}

function assetSymbol(asset: string | undefined): string {
  return (asset ?? 'usdc').toUpperCase();
}

function payerLabel(collection: CollectionRequest): string {
  if (collection.counterparty?.displayName) return collection.counterparty.displayName;
  if (collection.payerWalletAddress) return shortenAddress(collection.payerWalletAddress, 4, 4);
  return 'Any payer';
}

export function CollectionRunDetailPage() {
  const { workspaceId, collectionRunId } = useParams<{
    workspaceId: string;
    collectionRunId: string;
  }>();
  const navigate = useNavigate();
  const { error: toastError } = useToast();

  const runQuery = useQuery({
    queryKey: ['collection-run', workspaceId, collectionRunId] as const,
    queryFn: () => api.getCollectionRun(workspaceId!, collectionRunId!),
    enabled: Boolean(workspaceId && collectionRunId),
    refetchInterval: 10_000,
  });

  const proofQuery = useQuery({
    queryKey: ['collection-run-proof', workspaceId, collectionRunId] as const,
    queryFn: () => api.getCollectionRunProof(workspaceId!, collectionRunId!),
    enabled: Boolean(workspaceId && collectionRunId),
    refetchInterval: 15_000,
  });

  const proofDownloadMutation = useMutation({
    mutationFn: () => api.downloadCollectionRunProofJson(workspaceId!, collectionRunId!),
    onError: (err) =>
      toastError(err instanceof Error ? err.message : 'Could not export collection run proof.'),
  });

  if (!workspaceId || !collectionRunId) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Not found</h2>
          <p className="rd-state-body">This collection run does not exist.</p>
        </div>
      </main>
    );
  }

  if (runQuery.isLoading) {
    return (
      <main className="page-frame">
        <div className="rd-skeleton rd-skeleton-block" style={{ height: 200 }} />
      </main>
    );
  }

  const run: CollectionRunSummary | undefined = runQuery.data;
  if (!run) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Not found</h2>
          <p className="rd-state-body">This collection run does not exist.</p>
          <Link to={`/workspaces/${workspaceId}/collections`} className="button button-secondary">
            Back to collections
          </Link>
        </div>
      </main>
    );
  }

  const requests = run.collectionRequests ?? [];
  const tone = statusToneForCollection(run.derivedState);
  const isSettled = run.derivedState === 'collected' || run.derivedState === 'closed';

  return (
    <main className="page-frame">
      <div style={{ marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => navigate(`/workspaces/${workspaceId}/collections`)}
          className="rd-btn rd-btn-secondary"
        >
          ← Back to collections
        </button>
      </div>

      <header className="page-header">
        <div>
          <p className="eyebrow">Collection run</p>
          <h1 style={{ fontSize: 26, margin: '4px 0 2px' }}>{run.runName}</h1>
          <p style={{ margin: 0, color: 'var(--ax-text-muted)' }}>
            {collectionRunProgressLine(run)}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="rd-pill" data-tone={toneToPill(tone)}>
            <span className="rd-pill-dot" aria-hidden />
            {displayCollectionStatus(run.derivedState)}
          </span>
          <button
            type="button"
            className="rd-btn rd-btn-secondary"
            onClick={() => proofDownloadMutation.mutate()}
            disabled={!isSettled || proofDownloadMutation.isPending}
            aria-busy={proofDownloadMutation.isPending}
            title={
              isSettled
                ? undefined
                : 'Proof is available once every collection in the run has settled on-chain.'
            }
          >
            {proofDownloadMutation.isPending ? 'Exporting…' : 'Export proof'}
          </button>
        </div>
      </header>

      <section className="rd-metrics" style={{ marginTop: 12 }}>
        <div className="rd-metric">
          <span className="rd-metric-label">Total</span>
          <span className="rd-metric-value">{run.summary.total}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Awaiting</span>
          <span
            className="rd-metric-value"
            data-tone={run.summary.open > 0 ? 'warning' : undefined}
          >
            {run.summary.open}
          </span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Partial</span>
          <span
            className="rd-metric-value"
            data-tone={run.summary.partiallyCollected > 0 ? 'warning' : undefined}
          >
            {run.summary.partiallyCollected}
          </span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Collected</span>
          <span className="rd-metric-value" data-tone="success">
            {run.summary.collected}
          </span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Needs review</span>
          <span
            className="rd-metric-value"
            data-tone={run.summary.exception > 0 ? 'danger' : undefined}
          >
            {run.summary.exception}
          </span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Total amount</span>
          <span className="rd-metric-value rd-num">
            {formatRawUsdcCompact(run.summary.totalAmountRaw)} USDC
          </span>
        </div>
      </section>

      {proofQuery.data ? (
        <section className="rd-card" style={{ marginTop: 16 }}>
          <div className="rd-section-head" style={{ marginBottom: 0 }}>
            <div>
              <h2 className="rd-section-title">Run proof</h2>
              <p className="rd-section-sub">
                {proofQuery.data.readiness.status} · digest{' '}
                <span className="rd-mono">{shortenAddress(proofQuery.data.canonicalDigest, 10, 10)}</span>
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 500, color: 'var(--ax-text-secondary)', margin: '0 0 12px' }}>
          Collections in this batch
        </h2>
        <div className="rd-table-shell">
          <table className="rd-table">
            <thead>
              <tr>
                <th style={{ width: '28%' }}>Payer</th>
                <th style={{ width: '20%' }}>Reference</th>
                <th className="rd-num" style={{ width: '18%' }}>
                  Amount
                </th>
                <th style={{ width: '16%' }}>Created</th>
                <th style={{ width: '18%' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={5} className="rd-empty-cell">
                    <strong>No collections in this batch</strong>
                  </td>
                </tr>
              ) : (
                requests.map((c) => (
                  <tr
                    key={c.collectionRequestId}
                    onClick={() =>
                      navigate(`/workspaces/${workspaceId}/collections/${c.collectionRequestId}`)
                    }
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <div className="rd-recipient-main">
                        <span className="rd-recipient-name">{payerLabel(c)}</span>
                        <span className="rd-recipient-ref">{c.reason || '—'}</span>
                      </div>
                    </td>
                    <td>
                      <span className="rd-mono" style={{ fontSize: 12 }}>
                        {c.externalReference ?? '—'}
                      </span>
                    </td>
                    <td className="rd-num">
                      {formatRawUsdcCompact(c.amountRaw)} {assetSymbol(c.asset)}
                    </td>
                    <td>
                      <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                        {formatRelativeTime(c.createdAt)}
                      </span>
                    </td>
                    <td>
                      <span
                        className="rd-pill"
                        data-tone={toneToPill(statusToneForCollection(c.derivedState))}
                      >
                        <span className="rd-pill-dot" aria-hidden />
                        {displayCollectionStatus(c.derivedState)}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
