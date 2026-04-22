import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  CollectionRequest,
  CollectionRunSummary,
  PaymentOrder,
  PaymentRun,
} from '../types';
import { formatRawUsdcCompact, shortenAddress } from '../domain';
import {
  displayCollectionSourceName,
  displayCollectionStatus,
  displayPaymentStatus,
  displayRunStatus,
  statusToneForCollection,
  statusToneForPayment,
} from '../status-labels';
import { useToast } from '../ui/Toast';
import { ProofJsonView } from '../proof-json-view';

type ProofGroup =
  | { kind: 'run'; key: string; run: PaymentRun; orders: PaymentOrder[] }
  | { kind: 'single'; key: string; order: PaymentOrder };

type CollectionProofGroup =
  | {
      kind: 'collection-run';
      key: string;
      run: CollectionRunSummary;
      requests: CollectionRequest[];
    }
  | { kind: 'collection'; key: string; collection: CollectionRequest };

function assetSymbol(asset: string | undefined): string {
  return (asset ?? 'usdc').toUpperCase();
}

function toneToPill(tone: 'success' | 'warning' | 'danger' | 'neutral'): 'success' | 'warning' | 'danger' | 'info' {
  return tone === 'success' ? 'success' : tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info';
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function hasExecutionRecorded(order: PaymentOrder): boolean {
  if (order.reconciliationDetail?.latestExecution?.submittedSignature) return true;
  if (order.reconciliationDetail?.latestExecution?.submittedAt) return true;
  return (
    order.derivedState === 'execution_recorded'
    || order.derivedState === 'partially_settled'
    || order.derivedState === 'settled'
    || order.derivedState === 'closed'
  );
}

function proofReadinessLine(order: PaymentOrder): string {
  const hasDecision = Boolean(order.reconciliationDetail?.approvalDecisions?.length);
  const hasExecution = hasExecutionRecorded(order);
  const hasMatch = Boolean(order.reconciliationDetail?.match?.signature);
  const hasException = Boolean(order.reconciliationDetail?.exceptions?.length);
  return [
    hasDecision ? 'approval ok' : 'approval pending',
    hasExecution ? 'execution present' : 'execution missing',
    hasMatch ? 'settlement matched' : 'match pending',
    hasException ? 'has exceptions' : 'no exceptions',
  ].join(' · ');
}

function runReadinessLine(run: PaymentRun): string {
  const t = run.totals;
  return `${t.settledCount}/${t.actionableCount} matched · ${t.exceptionCount} exception${t.exceptionCount === 1 ? '' : 's'}`;
}

function collectionIsSettled(c: CollectionRequest): boolean {
  return c.derivedState === 'collected' || c.derivedState === 'closed';
}

function collectionRunIsSettled(r: CollectionRunSummary): boolean {
  return r.derivedState === 'collected' || r.derivedState === 'closed';
}

function collectionReadinessLine(c: CollectionRequest): string {
  const hasSource = Boolean(c.collectionSource);
  const hasMatch = Boolean(c.reconciliationDetail?.match?.signature);
  const hasException = Boolean(c.reconciliationDetail?.exceptions?.length);
  return [
    hasSource ? 'source linked' : 'source pending',
    hasMatch ? 'settlement matched' : 'match pending',
    hasException ? 'has exceptions' : 'no exceptions',
  ].join(' · ');
}

function collectionRunReadinessLine(r: CollectionRunSummary): string {
  const s = r.summary;
  return `${s.collected}/${s.total} collected · ${s.exception} exception${s.exception === 1 ? '' : 's'}`;
}

function collectionPayerLabel(c: CollectionRequest): string {
  if (c.collectionSource) {
    return displayCollectionSourceName(c.collectionSource.label, c.collectionSource.walletAddress);
  }
  if (c.payerWalletAddress) return shortenAddress(c.payerWalletAddress, 4, 4);
  return 'Any payer';
}

export function ProofsPage({ session: _session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { error: toastError } = useToast();
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedCollectionRunId, setExpandedCollectionRunId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; data: Record<string, unknown> } | null>(null);

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
  const collectionsQuery = useQuery({
    queryKey: ['collections', workspaceId] as const,
    queryFn: () => api.listCollections(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 10_000,
  });
  const collectionRunsQuery = useQuery({
    queryKey: ['collection-runs', workspaceId] as const,
    queryFn: () => api.listCollectionRuns(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 10_000,
  });

  const exportOrderMutation = useMutation({
    mutationFn: (id: string) => api.getPaymentOrderProof(workspaceId!, id),
    onSuccess: (proof, id) => downloadJson(`payment-proof-${id}.json`, proof),
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to export proof.'),
  });
  const exportRunMutation = useMutation({
    mutationFn: (id: string) => api.getPaymentRunProof(workspaceId!, id),
    onSuccess: (proof, id) => downloadJson(`payment-run-proof-${id}.json`, proof),
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to export run proof.'),
  });
  const previewOrderMutation = useMutation({
    mutationFn: async (order: PaymentOrder) => {
      const packet = await api.getPaymentOrderProof(workspaceId!, order.paymentOrderId);
      return {
        title: `Payment proof · ${order.destination.label}`,
        data: JSON.parse(JSON.stringify(packet)) as Record<string, unknown>,
      };
    },
    onSuccess: setPreview,
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to load preview.'),
  });
  const previewRunMutation = useMutation({
    mutationFn: async (run: PaymentRun) => {
      const packet = await api.getPaymentRunProof(workspaceId!, run.paymentRunId);
      return {
        title: `Run proof · ${run.runName}`,
        data: JSON.parse(JSON.stringify(packet)) as Record<string, unknown>,
      };
    },
    onSuccess: setPreview,
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to load preview.'),
  });
  const exportCollectionMutation = useMutation({
    mutationFn: (id: string) => api.getCollectionProof(workspaceId!, id),
    onSuccess: (proof, id) => downloadJson(`collection-proof-${id}.json`, proof),
    onError: (err) =>
      toastError(err instanceof Error ? err.message : 'Unable to export collection proof.'),
  });
  const exportCollectionRunMutation = useMutation({
    mutationFn: (id: string) => api.getCollectionRunProof(workspaceId!, id),
    onSuccess: (proof, id) => downloadJson(`collection-run-proof-${id}.json`, proof),
    onError: (err) =>
      toastError(err instanceof Error ? err.message : 'Unable to export collection run proof.'),
  });
  const previewCollectionMutation = useMutation({
    mutationFn: async (c: CollectionRequest) => {
      const packet = await api.getCollectionProof(workspaceId!, c.collectionRequestId);
      return {
        title: `Collection proof · ${collectionPayerLabel(c)}`,
        data: JSON.parse(JSON.stringify(packet)) as Record<string, unknown>,
      };
    },
    onSuccess: setPreview,
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to load preview.'),
  });
  const previewCollectionRunMutation = useMutation({
    mutationFn: async (r: CollectionRunSummary) => {
      const packet = await api.getCollectionRunProof(workspaceId!, r.collectionRunId);
      return {
        title: `Collection run proof · ${r.runName}`,
        data: JSON.parse(JSON.stringify(packet)) as Record<string, unknown>,
      };
    },
    onSuccess: setPreview,
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to load preview.'),
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
  const standaloneOrders = orders.filter((o) => !o.paymentRunId);

  const ordersByRun = useMemo(() => {
    const map = new Map<string, PaymentOrder[]>();
    for (const o of orders) {
      if (!o.paymentRunId) continue;
      const list = map.get(o.paymentRunId) ?? [];
      list.push(o);
      map.set(o.paymentRunId, list);
    }
    return map;
  }, [orders]);

  const groups: ProofGroup[] = [
    ...runs.map<ProofGroup>((r) => ({
      kind: 'run' as const,
      key: `run:${r.paymentRunId}`,
      run: r,
      orders: ordersByRun.get(r.paymentRunId) ?? [],
    })),
    ...standaloneOrders.map<ProofGroup>((o) => ({
      kind: 'single' as const,
      key: `single:${o.paymentOrderId}`,
      order: o,
    })),
  ];

  const collections = collectionsQuery.data?.items ?? [];
  const collectionRuns = collectionRunsQuery.data?.items ?? [];
  const standaloneCollections = collections.filter((c) => !c.collectionRunId);

  const collectionsByRun = useMemo(() => {
    const map = new Map<string, CollectionRequest[]>();
    for (const c of collections) {
      if (!c.collectionRunId) continue;
      const list = map.get(c.collectionRunId) ?? [];
      list.push(c);
      map.set(c.collectionRunId, list);
    }
    return map;
  }, [collections]);

  const collectionGroups: CollectionProofGroup[] = [
    ...collectionRuns.map<CollectionProofGroup>((r) => ({
      kind: 'collection-run' as const,
      key: `collection-run:${r.collectionRunId}`,
      run: r,
      requests: collectionsByRun.get(r.collectionRunId) ?? [],
    })),
    ...standaloneCollections.map<CollectionProofGroup>((c) => ({
      kind: 'collection' as const,
      key: `collection:${c.collectionRequestId}`,
      collection: c,
    })),
  ];

  const isLoading = ordersQuery.isLoading || runsQuery.isLoading;
  const collectionsLoading = collectionsQuery.isLoading || collectionRunsQuery.isLoading;

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Proofs</p>
          <h1>Proof packets</h1>
          <p>
            Every payment and collection has a proof packet. Preview in-app or export the JSON for
            audit hand-off — available forever. Batches expand to reveal the items inside.
          </p>
        </div>
      </header>

      <section className="rd-section" style={{ marginTop: 0 }}>
        <div className="rd-section-head">
          <div>
            <h2 className="rd-section-title">Payments</h2>
            <p className="rd-section-sub">Outbound — USDC you sent.</p>
          </div>
        </div>
        <div className="rd-table-shell">
          {isLoading ? (
            <div style={{ padding: 16 }}>
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
            </div>
          ) : groups.length === 0 ? (
            <div className="rd-empty-cell" style={{ padding: '64px 24px' }}>
              <strong>No proof packets yet</strong>
              <p style={{ margin: 0 }}>
                Once a payment or batch has on-chain activity, its proof packet is generated and shows up here.
              </p>
            </div>
          ) : (
            <table className="rd-table">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>Batch / Payment</th>
                  <th style={{ width: '10%' }}>Items</th>
                  <th className="rd-num" style={{ width: '14%' }}>
                    Total
                  </th>
                  <th style={{ width: '22%' }}>Readiness</th>
                  <th style={{ width: '12%' }}>Status</th>
                  <th style={{ width: '12%' }} aria-label="Proof actions" />
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  if (group.kind === 'run') {
                    const expanded = expandedRunId === group.run.paymentRunId;
                    const runTone = statusToneForPayment(group.run.derivedState);
                    return (
                      <RunGroupRows
                        key={group.key}
                        workspaceId={workspaceId}
                        group={group}
                        expanded={expanded}
                        onToggle={() =>
                          setExpandedRunId((curr) => (curr === group.run.paymentRunId ? null : group.run.paymentRunId))
                        }
                        runTone={toneToPill(runTone)}
                        onPreviewRun={(r) => previewRunMutation.mutate(r)}
                        onExportRun={(r) => exportRunMutation.mutate(r.paymentRunId)}
                        previewingRun={previewRunMutation.isPending}
                        exportingRun={exportRunMutation.isPending}
                        onPreviewOrder={(o) => previewOrderMutation.mutate(o)}
                        onExportOrder={(o) => exportOrderMutation.mutate(o.paymentOrderId)}
                        previewingOrder={previewOrderMutation.isPending}
                        exportingOrder={exportOrderMutation.isPending}
                      />
                    );
                  }
                  const order = group.order;
                  const orderTone = statusToneForPayment(order.derivedState);
                  return (
                    <tr key={group.key}>
                      <td>
                        <div className="rd-recipient-main">
                          <span className="rd-recipient-name">
                            {order.counterparty?.displayName ?? order.destination.label}
                          </span>
                          <span className="rd-recipient-ref">
                            Single · {shortenAddress(order.paymentOrderId, 6, 4)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span style={{ color: 'var(--ax-text-faint)', fontSize: 12 }}>1</span>
                      </td>
                      <td className="rd-num">
                        {formatRawUsdcCompact(order.amountRaw)} {assetSymbol(order.asset)}
                      </td>
                      <td>
                        <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                          {proofReadinessLine(order)}
                        </span>
                      </td>
                      <td>
                        <span className="rd-pill" data-tone={toneToPill(orderTone)}>
                          <span className="rd-pill-dot" aria-hidden />
                          {displayPaymentStatus(order.derivedState)}
                        </span>
                      </td>
                      <td>
                        <ProofActionButtons
                          onPreview={() => previewOrderMutation.mutate(order)}
                          onExport={() => exportOrderMutation.mutate(order.paymentOrderId)}
                          previewing={previewOrderMutation.isPending}
                          exporting={exportOrderMutation.isPending}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="rd-section">
        <div className="rd-section-head">
          <div>
            <h2 className="rd-section-title">Collections</h2>
            <p className="rd-section-sub">Inbound — USDC you received.</p>
          </div>
        </div>
        <div className="rd-table-shell">
          {collectionsLoading ? (
            <div style={{ padding: 16 }}>
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
            </div>
          ) : collectionGroups.length === 0 ? (
            <div className="rd-empty-cell" style={{ padding: '64px 24px' }}>
              <strong>No collection proofs yet</strong>
              <p style={{ margin: 0 }}>
                Once a collection is created, its proof packet is generated and shows up here.
                Export becomes available once the collection is settled on-chain.
              </p>
            </div>
          ) : (
            <table className="rd-table">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>Batch / Collection</th>
                  <th style={{ width: '10%' }}>Items</th>
                  <th className="rd-num" style={{ width: '14%' }}>
                    Total
                  </th>
                  <th style={{ width: '22%' }}>Readiness</th>
                  <th style={{ width: '12%' }}>Status</th>
                  <th style={{ width: '12%' }} aria-label="Proof actions" />
                </tr>
              </thead>
              <tbody>
                {collectionGroups.map((group) => {
                  if (group.kind === 'collection-run') {
                    const expanded = expandedCollectionRunId === group.run.collectionRunId;
                    const runTone = statusToneForCollection(group.run.derivedState);
                    return (
                      <CollectionRunGroupRows
                        key={group.key}
                        workspaceId={workspaceId}
                        group={group}
                        expanded={expanded}
                        onToggle={() =>
                          setExpandedCollectionRunId((curr) =>
                            curr === group.run.collectionRunId ? null : group.run.collectionRunId,
                          )
                        }
                        runTone={toneToPill(runTone)}
                        onPreviewRun={(r) => previewCollectionRunMutation.mutate(r)}
                        onExportRun={(r) => exportCollectionRunMutation.mutate(r.collectionRunId)}
                        previewingRun={previewCollectionRunMutation.isPending}
                        exportingRun={exportCollectionRunMutation.isPending}
                        onPreviewRequest={(c) => previewCollectionMutation.mutate(c)}
                        onExportRequest={(c) =>
                          exportCollectionMutation.mutate(c.collectionRequestId)
                        }
                        previewingRequest={previewCollectionMutation.isPending}
                        exportingRequest={exportCollectionMutation.isPending}
                      />
                    );
                  }
                  const c = group.collection;
                  const cTone = statusToneForCollection(c.derivedState);
                  const settled = collectionIsSettled(c);
                  return (
                    <tr key={group.key}>
                      <td>
                        <div className="rd-recipient-main">
                          <span className="rd-recipient-name">{collectionPayerLabel(c)}</span>
                          <span className="rd-recipient-ref">
                            Single · {shortenAddress(c.collectionRequestId, 6, 4)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span style={{ color: 'var(--ax-text-faint)', fontSize: 12 }}>1</span>
                      </td>
                      <td className="rd-num">
                        {formatRawUsdcCompact(c.amountRaw)} {assetSymbol(c.asset)}
                      </td>
                      <td>
                        <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                          {collectionReadinessLine(c)}
                        </span>
                      </td>
                      <td>
                        <span className="rd-pill" data-tone={toneToPill(cTone)}>
                          <span className="rd-pill-dot" aria-hidden />
                          {displayCollectionStatus(c.derivedState)}
                        </span>
                      </td>
                      <td>
                        <ProofActionButtons
                          onPreview={() => previewCollectionMutation.mutate(c)}
                          onExport={() => exportCollectionMutation.mutate(c.collectionRequestId)}
                          previewing={previewCollectionMutation.isPending}
                          exporting={exportCollectionMutation.isPending}
                          exportDisabled={!settled}
                          exportDisabledReason="Proof is available once the collection is settled on-chain."
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {preview ? (
        <PreviewDialog title={preview.title} data={preview.data} onClose={() => setPreview(null)} />
      ) : null}
    </main>
  );
}

function RunGroupRows(props: {
  workspaceId: string;
  group: Extract<ProofGroup, { kind: 'run' }>;
  expanded: boolean;
  onToggle: () => void;
  runTone: 'success' | 'warning' | 'danger' | 'info';
  onPreviewRun: (r: PaymentRun) => void;
  onExportRun: (r: PaymentRun) => void;
  previewingRun: boolean;
  exportingRun: boolean;
  onPreviewOrder: (o: PaymentOrder) => void;
  onExportOrder: (o: PaymentOrder) => void;
  previewingOrder: boolean;
  exportingOrder: boolean;
}) {
  const {
    workspaceId,
    group,
    expanded,
    onToggle,
    runTone,
    onPreviewRun,
    onExportRun,
    previewingRun,
    exportingRun,
    onPreviewOrder,
    onExportOrder,
    previewingOrder,
    exportingOrder,
  } = props;
  const { run, orders } = group;
  return (
    <>
      <tr
        style={{ cursor: 'pointer', background: expanded ? 'var(--ax-surface-2)' : undefined }}
        onClick={onToggle}
      >
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Chevron expanded={expanded} />
            <div className="rd-recipient-main">
              <span className="rd-recipient-name">{run.runName}</span>
              <span className="rd-recipient-ref">
                Batch · {shortenAddress(run.paymentRunId, 6, 4)}
              </span>
            </div>
          </div>
        </td>
        <td>
          <span style={{ fontSize: 13, color: 'var(--ax-text-secondary)' }}>{run.totals.orderCount}</span>
        </td>
        <td className="rd-num">
          {formatRawUsdcCompact(run.totals.totalAmountRaw)} USDC
        </td>
        <td>
          <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>{runReadinessLine(run)}</span>
        </td>
        <td>
          <span className="rd-pill" data-tone={runTone}>
            <span className="rd-pill-dot" aria-hidden />
            {displayRunStatus(run.derivedState)}
          </span>
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <ProofActionButtons
            onPreview={() => onPreviewRun(run)}
            onExport={() => onExportRun(run)}
            previewing={previewingRun}
            exporting={exportingRun}
          />
        </td>
      </tr>
      {expanded
        ? orders.map((order) => (
            <tr key={`child:${order.paymentOrderId}`} style={{ background: 'var(--ax-surface)' }}>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 28 }}>
                  <span
                    aria-hidden
                    style={{
                      color: 'var(--ax-text-faint)',
                      fontFamily: 'var(--ax-font-mono)',
                      fontSize: 11,
                    }}
                  >
                    ↳
                  </span>
                  <div className="rd-recipient-main">
                    <Link
                      to={`/workspaces/${workspaceId}/payments/${order.paymentOrderId}`}
                      style={{ color: 'var(--ax-text)', textDecoration: 'none', fontWeight: 500 }}
                    >
                      {order.counterparty?.displayName ?? order.destination.label}
                    </Link>
                    <span className="rd-recipient-ref">
                      {order.externalReference ?? order.invoiceNumber ?? shortenAddress(order.paymentOrderId, 6, 4)}
                    </span>
                  </div>
                </div>
              </td>
              <td>
                <span style={{ fontSize: 12, color: 'var(--ax-text-faint)' }}>—</span>
              </td>
              <td className="rd-num">
                {formatRawUsdcCompact(order.amountRaw)} {assetSymbol(order.asset)}
              </td>
              <td>
                <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                  {proofReadinessLine(order)}
                </span>
              </td>
              <td>
                <span
                  className="rd-pill"
                  data-tone={toneToPill(statusToneForPayment(order.derivedState))}
                >
                  <span className="rd-pill-dot" aria-hidden />
                  {displayPaymentStatus(order.derivedState)}
                </span>
              </td>
              <td>
                <ProofActionButtons
                  onPreview={() => onPreviewOrder(order)}
                  onExport={() => onExportOrder(order)}
                  previewing={previewingOrder}
                  exporting={exportingOrder}
                />
              </td>
            </tr>
          ))
        : null}
    </>
  );
}

function ProofActionButtons(props: {
  onPreview: () => void;
  onExport: () => void;
  previewing: boolean;
  exporting: boolean;
  exportDisabled?: boolean;
  exportDisabledReason?: string;
}) {
  const { onPreview, onExport, previewing, exporting, exportDisabled, exportDisabledReason } =
    props;
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-start' }}>
      <button
        type="button"
        className="rd-btn rd-btn-ghost"
        style={{ minHeight: 28, padding: '4px 10px', fontSize: 12 }}
        onClick={onPreview}
        disabled={previewing}
        aria-busy={previewing}
      >
        Preview
      </button>
      <button
        type="button"
        className="rd-btn rd-btn-secondary"
        style={{ minHeight: 28, padding: '4px 10px', fontSize: 12 }}
        onClick={onExport}
        disabled={exporting || exportDisabled}
        aria-busy={exporting}
        title={exportDisabled ? exportDisabledReason : undefined}
      >
        Export
      </button>
    </div>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--ax-text-muted)',
        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 150ms ease',
      }}
    >
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3l5 5-5 5" />
      </svg>
    </span>
  );
}

function CollectionRunGroupRows(props: {
  workspaceId: string;
  group: Extract<CollectionProofGroup, { kind: 'collection-run' }>;
  expanded: boolean;
  onToggle: () => void;
  runTone: 'success' | 'warning' | 'danger' | 'info';
  onPreviewRun: (r: CollectionRunSummary) => void;
  onExportRun: (r: CollectionRunSummary) => void;
  previewingRun: boolean;
  exportingRun: boolean;
  onPreviewRequest: (c: CollectionRequest) => void;
  onExportRequest: (c: CollectionRequest) => void;
  previewingRequest: boolean;
  exportingRequest: boolean;
}) {
  const {
    workspaceId,
    group,
    expanded,
    onToggle,
    runTone,
    onPreviewRun,
    onExportRun,
    previewingRun,
    exportingRun,
    onPreviewRequest,
    onExportRequest,
    previewingRequest,
    exportingRequest,
  } = props;
  const { run, requests } = group;
  const runSettled = collectionRunIsSettled(run);
  return (
    <>
      <tr
        style={{ cursor: 'pointer', background: expanded ? 'var(--ax-surface-2)' : undefined }}
        onClick={onToggle}
      >
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Chevron expanded={expanded} />
            <div className="rd-recipient-main">
              <span className="rd-recipient-name">{run.runName}</span>
              <span className="rd-recipient-ref">
                Batch · {shortenAddress(run.collectionRunId, 6, 4)}
              </span>
            </div>
          </div>
        </td>
        <td>
          <span style={{ fontSize: 13, color: 'var(--ax-text-secondary)' }}>
            {run.summary.total}
          </span>
        </td>
        <td className="rd-num">
          {formatRawUsdcCompact(run.summary.totalAmountRaw)} USDC
        </td>
        <td>
          <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
            {collectionRunReadinessLine(run)}
          </span>
        </td>
        <td>
          <span className="rd-pill" data-tone={runTone}>
            <span className="rd-pill-dot" aria-hidden />
            {displayCollectionStatus(run.derivedState)}
          </span>
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <ProofActionButtons
            onPreview={() => onPreviewRun(run)}
            onExport={() => onExportRun(run)}
            previewing={previewingRun}
            exporting={exportingRun}
            exportDisabled={!runSettled}
            exportDisabledReason="Proof is available once every collection in the run has settled on-chain."
          />
        </td>
      </tr>
      {expanded
        ? requests.map((c) => {
            const settled = collectionIsSettled(c);
            return (
              <tr key={`child:${c.collectionRequestId}`} style={{ background: 'var(--ax-surface)' }}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 28 }}>
                    <span
                      aria-hidden
                      style={{
                        color: 'var(--ax-text-faint)',
                        fontFamily: 'var(--ax-font-mono)',
                        fontSize: 11,
                      }}
                    >
                      ↳
                    </span>
                    <div className="rd-recipient-main">
                      <Link
                        to={`/workspaces/${workspaceId}/collections/${c.collectionRequestId}`}
                        style={{ color: 'var(--ax-text)', textDecoration: 'none', fontWeight: 500 }}
                      >
                        {collectionPayerLabel(c)}
                      </Link>
                      <span className="rd-recipient-ref">
                        {c.externalReference ?? shortenAddress(c.collectionRequestId, 6, 4)}
                      </span>
                    </div>
                  </div>
                </td>
                <td>
                  <span style={{ fontSize: 12, color: 'var(--ax-text-faint)' }}>—</span>
                </td>
                <td className="rd-num">
                  {formatRawUsdcCompact(c.amountRaw)} {assetSymbol(c.asset)}
                </td>
                <td>
                  <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                    {collectionReadinessLine(c)}
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
                <td>
                  <ProofActionButtons
                    onPreview={() => onPreviewRequest(c)}
                    onExport={() => onExportRequest(c)}
                    previewing={previewingRequest}
                    exporting={exportingRequest}
                    exportDisabled={!settled}
                    exportDisabledReason="Proof is available once this collection is settled on-chain."
                  />
                </td>
              </tr>
            );
          })
        : null}
    </>
  );
}

function PreviewDialog(props: { title: string; data: Record<string, unknown>; onClose: () => void }) {
  const { title, data, onClose } = props;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="rd-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="rd-proof-preview-title">
      <div
        className="rd-dialog"
        style={{ maxWidth: 'min(960px, 96vw)', width: 'min(960px, 96vw)' }}
      >
        <h2 id="rd-proof-preview-title" className="rd-dialog-title">
          {title}
        </h2>
        <p className="rd-dialog-body">
          Structured view of the proof packet. Export to JSON for hand-off.
        </p>
        <div style={{ maxHeight: 520, overflowY: 'auto' }}>
          <ProofJsonView data={data} />
        </div>
        <div className="rd-dialog-actions" style={{ marginTop: 16 }}>
          <button type="button" className="rd-btn rd-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
