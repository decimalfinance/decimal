import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  PaymentExecutionPacket,
  PaymentOrder,
  TreasuryWallet,
} from '../types';
import {
  discoverSolanaWallets,
  formatRawUsdcCompact,
  formatRelativeTime,
  formatTimestamp,
  orbTransactionUrl,
  shortenAddress,
  signAndSubmitPreparedPayment,
  orbAccountUrl,
  subscribeSolanaWallets,
  type BrowserWalletOption,
} from '../domain';
import { displayPaymentStatus, statusToneForPayment } from '../status-labels';
import { useToast } from '../ui/Toast';

type StageState = 'complete' | 'current' | 'pending' | 'blocked';

type LifecycleStage = {
  id: 'request' | 'approval' | 'execution' | 'settlement' | 'proof';
  label: string;
  sub: string;
  state: StageState;
};

type ActionVariant =
  | 'needs_submit'
  | 'needs_approval'
  | 'ready_to_sign'
  | 'in_flight'
  | 'settled'
  | 'exception'
  | 'cancelled'
  | 'idle';

function assetSymbol(asset: string | undefined): string {
  return (asset ?? 'usdc').toUpperCase();
}

function walletLabel(address: TreasuryWallet): string {
  if (address.displayName && address.displayName.trim().length) {
    return `${address.displayName} · ${shortenAddress(address.address, 4, 4)}`;
  }
  return shortenAddress(address.address, 4, 4);
}

function toneToPill(tone: 'success' | 'warning' | 'danger' | 'neutral'): 'success' | 'warning' | 'danger' | 'info' {
  return tone === 'success' ? 'success' : tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info';
}

function buildLifecycle(order: PaymentOrder): LifecycleStage[] {
  const s = order.derivedState;
  const blocked = s === 'exception' || s === 'partially_settled';
  const settled = s === 'settled' || s === 'closed';
  const cancelled = s === 'cancelled';

  const submitDone = s !== 'draft';
  const approveDone = !['draft', 'pending_approval', 'cancelled'].includes(s);
  const executionDone = ['execution_recorded', 'partially_settled', 'settled', 'closed', 'exception'].includes(s);
  const proofDone = settled;

  return [
    {
      id: 'request',
      label: 'Requested',
      sub: formatRelativeTime(order.createdAt),
      state: 'complete',
    },
    {
      id: 'approval',
      label: approveDone ? 'Approved' : 'Approval',
      sub: cancelled
        ? 'Cancelled'
        : approveDone
          ? 'Cleared'
          : s === 'pending_approval'
            ? 'Awaiting'
            : s === 'draft'
              ? 'Not submitted'
              : 'Pending',
      state: cancelled
        ? 'blocked'
        : approveDone
          ? 'complete'
          : s === 'pending_approval' || s === 'draft'
            ? 'current'
            : 'pending',
    },
    {
      id: 'execution',
      label: executionDone ? 'Executed' : 'Execute',
      sub: executionDone ? 'On-chain' : approveDone ? 'Ready to sign' : 'Pending',
      state: blocked
        ? 'blocked'
        : executionDone
          ? 'complete'
          : approveDone
            ? 'current'
            : 'pending',
    },
    {
      id: 'settlement',
      label: settled ? 'Settled' : 'Settle',
      sub: blocked ? 'Needs review' : settled ? 'Matched' : executionDone ? 'Watching' : 'Pending',
      state: blocked ? 'blocked' : settled ? 'complete' : executionDone ? 'current' : 'pending',
    },
    {
      id: 'proof',
      label: proofDone ? 'Proven' : 'Prove',
      sub: proofDone ? 'Ready to export' : 'Pending settlement',
      state: proofDone ? 'complete' : 'pending',
    },
  ];
}

function determineVariant(order: PaymentOrder): ActionVariant {
  const s = order.derivedState;
  if (s === 'draft') return 'needs_submit';
  if (s === 'pending_approval') return 'needs_approval';
  if (s === 'approved' || s === 'ready_for_execution') return 'ready_to_sign';
  if (s === 'execution_recorded') return 'in_flight';
  if (s === 'settled' || s === 'closed') return 'settled';
  if (s === 'exception' || s === 'partially_settled') return 'exception';
  if (s === 'cancelled') return 'cancelled';
  return 'idle';
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

export function PaymentDetailPage() {
  const { workspaceId, paymentOrderId } = useParams<{ workspaceId: string; paymentOrderId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { success, error: toastError, info } = useToast();
  const [prepared, setPrepared] = useState<PaymentExecutionPacket | null>(null);
  const [selectedSourceAddressId, setSelectedSourceAddressId] = useState('');
  const [selectedWalletId, setSelectedWalletId] = useState<string | undefined>();
  const [wallets, setWallets] = useState<BrowserWalletOption[]>(() => discoverSolanaWallets());

  useEffect(() => subscribeSolanaWallets(setWallets), []);
  useEffect(() => setPrepared(null), [selectedSourceAddressId]);

  const orderQuery = useQuery({
    queryKey: ['payment-order', workspaceId, paymentOrderId] as const,
    queryFn: () => api.getPaymentOrderDetail(workspaceId!, paymentOrderId!),
    enabled: Boolean(workspaceId && paymentOrderId),
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      const s = query.state.data?.derivedState;
      if (s === 'settled' || s === 'closed' || s === 'cancelled') return false;
      return 5_000;
    },
  });

  const addressesQuery = useQuery({
    queryKey: ['addresses', workspaceId] as const,
    queryFn: () => api.listTreasuryWallets(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 30_000,
  });

  const sourceAddresses = addressesQuery.data?.items ?? [];
  const effectiveSourceAddressId =
    selectedSourceAddressId
    || orderQuery.data?.sourceTreasuryWalletId
    || sourceAddresses[0]?.treasuryWalletId
    || '';

  const submitMutation = useMutation({
    mutationFn: () => api.submitPaymentOrder(workspaceId!, paymentOrderId!),
    onSuccess: async () => {
      success('Submitted for approval.');
      await queryClient.invalidateQueries({ queryKey: ['payment-order', workspaceId, paymentOrderId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not submit.'),
  });

  const approveMutation = useMutation({
    mutationFn: () => {
      const transferRequestId = orderQuery.data?.transferRequestId;
      if (!transferRequestId) throw new Error('Approval request not ready yet — try again in a moment.');
      return api.createApprovalDecision(workspaceId!, transferRequestId, { action: 'approve' });
    },
    onSuccess: async () => {
      success('Approved. Ready to sign.');
      await queryClient.invalidateQueries({ queryKey: ['payment-order', workspaceId, paymentOrderId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not approve.'),
  });

  const signMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveSourceAddressId) throw new Error('Select a source wallet before signing.');
      const sourceAddressRow = sourceAddresses.find((r) => r.treasuryWalletId === effectiveSourceAddressId);
      if (!sourceAddressRow?.address) throw new Error('Source wallet is still loading.');
      let packet = prepared;
      if (!packet || packet.signerWallet !== sourceAddressRow.address) {
        const preparation = await api.preparePaymentOrderExecution(workspaceId!, paymentOrderId!, {
          sourceTreasuryWalletId: effectiveSourceAddressId,
        });
        packet = preparation.executionPacket;
        setPrepared(packet);
      }
      const signature = await signAndSubmitPreparedPayment(packet!, selectedWalletId);
      await api.attachPaymentOrderSignature(workspaceId!, paymentOrderId!, {
        submittedSignature: signature,
        submittedAt: new Date().toISOString(),
      });
      return signature;
    },
    onSuccess: async (signature) => {
      success(`Signed · ${shortenAddress(signature, 8, 8)}`);
      await queryClient.invalidateQueries({ queryKey: ['payment-order', workspaceId, paymentOrderId] });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Could not sign payment.';
      if (/user|reject|cancel/i.test(message)) {
        info('Signing cancelled. Ready to retry.');
      } else {
        toastError(message);
      }
    },
  });

  const proofMutation = useMutation({
    mutationFn: () => api.getPaymentOrderProof(workspaceId!, paymentOrderId!),
    onSuccess: (proof) => {
      downloadJson(`payment-proof-${paymentOrderId}.json`, proof);
      success('Proof packet downloaded.');
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not export proof.'),
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelPaymentOrder(workspaceId!, paymentOrderId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', workspaceId] });
      navigate(`/workspaces/${workspaceId}/payments`);
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not cancel.'),
  });

  if (!workspaceId || !paymentOrderId) {
    return (
      <main className="page-frame" data-layout="rd">
        <div className="rd-page-container">
          <div className="rd-state">
            <h2 className="rd-state-title">Payment unavailable</h2>
            <p className="rd-state-body">Pick a payment from the list.</p>
          </div>
        </div>
      </main>
    );
  }

  if (orderQuery.isLoading) {
    return (
      <main className="page-frame" data-layout="rd">
        <div className="rd-page-container">
          <div className="rd-skeleton rd-skeleton-line" style={{ width: 120 }} />
          <div className="rd-skeleton rd-skeleton-line" style={{ width: 280, height: 28, marginBottom: 8 }} />
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 120, marginTop: 24 }} />
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 200, marginTop: 32 }} />
        </div>
      </main>
    );
  }

  if (orderQuery.isError || !orderQuery.data) {
    return (
      <main className="page-frame" data-layout="rd">
        <div className="rd-page-container">
          <Link to={`/workspaces/${workspaceId}/payments`} className="rd-back">
            <span className="rd-back-arrow">←</span>
            <span>Payments</span>
          </Link>
          <div className="rd-state">
            <h2 className="rd-state-title">Couldn't load this payment</h2>
            <p className="rd-state-body">
              {orderQuery.error instanceof Error ? orderQuery.error.message : 'Something went wrong.'}
            </p>
            <button className="rd-btn rd-btn-secondary" type="button" onClick={() => void orderQuery.refetch()}>
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

  const order = orderQuery.data;
  const recipientName = order.counterparty?.displayName ?? order.destination.label;
  const amountLabel = `${formatRawUsdcCompact(order.amountRaw)} ${assetSymbol(order.asset)}`;
  const lifecycle = buildLifecycle(order);
  const variant = determineVariant(order);
  const statusTone = statusToneForPayment(order.derivedState);
  const latestExec = order.reconciliationDetail?.latestExecution ?? null;
  const match = order.reconciliationDetail?.match ?? null;
  const approvalDecisions = order.reconciliationDetail?.approvalDecisions ?? [];

  return (
    <main className="page-frame" data-layout="rd">
      <div className="rd-page-container">
        <Link to={`/workspaces/${workspaceId}/payments`} className="rd-back">
          <span className="rd-back-arrow" aria-hidden>
            ←
          </span>
          <span>Payments</span>
        </Link>

        <header className="rd-header">
          <div>
            <p className="rd-eyebrow">Payment</p>
            <h1 className="rd-title">{recipientName}</h1>
            <p className="rd-meta">
              <span className="rd-mono">{amountLabel}</span>
              <span className="rd-meta-sep">·</span>
              <a
                href={orbAccountUrl(order.destination.walletAddress)}
                target="_blank"
                rel="noreferrer"
                className="rd-addr-link"
              >
                <span>{shortenAddress(order.destination.walletAddress, 4, 4)}</span>
              </a>
              {order.externalReference || order.invoiceNumber ? (
                <>
                  <span className="rd-meta-sep">·</span>
                  <span className="rd-mono">{order.externalReference ?? order.invoiceNumber}</span>
                </>
              ) : null}
              <span className="rd-meta-sep">·</span>
              <span>Created {formatRelativeTime(order.createdAt)}</span>
            </p>
          </div>
          <div className="rd-header-side">
            <span className="rd-pill" data-tone={toneToPill(statusTone)}>
              <span className="rd-pill-dot" aria-hidden />
              {displayPaymentStatus(order.derivedState)}
            </span>
          </div>
        </header>

        <LifecycleRail stages={lifecycle} />

        <PrimaryAction
          variant={variant}
          order={order}
          amountLabel={amountLabel}
          submittedSignature={latestExec?.submittedSignature ?? null}
          matchedAt={match?.matchedAt ?? null}
          sourceAddresses={sourceAddresses}
          effectiveSourceAddressId={effectiveSourceAddressId}
          onSelectSource={setSelectedSourceAddressId}
          wallets={wallets}
          selectedWalletId={selectedWalletId}
          onSelectWallet={setSelectedWalletId}
          submitting={submitMutation.isPending}
          approving={approveMutation.isPending}
          signing={signMutation.isPending}
          exporting={proofMutation.isPending}
          cancelling={cancelMutation.isPending}
          onSubmit={() => submitMutation.mutate()}
          onApprove={() => approveMutation.mutate()}
          onSign={() => signMutation.mutate()}
          onExportProof={() => proofMutation.mutate()}
          onCancel={() => cancelMutation.mutate()}
        />

        <section className="rd-section">
          <div className="rd-section-head">
            <div>
              <h2 className="rd-section-title">Details</h2>
              <p className="rd-section-sub">Source, destination, references.</p>
            </div>
          </div>
          <div className="rd-card">
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 20,
                margin: 0,
              }}
            >
              <DetailEntry label="From">
                {order.sourceTreasuryWallet?.address ? (
                  <a
                    href={orbAccountUrl(order.sourceTreasuryWallet.address)}
                    target="_blank"
                    rel="noreferrer"
                    className="rd-addr-link"
                  >
                    <span>
                      {order.sourceTreasuryWallet.displayName
                        ? `${order.sourceTreasuryWallet.displayName} · ${shortenAddress(order.sourceTreasuryWallet.address, 4, 4)}`
                        : shortenAddress(order.sourceTreasuryWallet.address, 4, 4)}
                    </span>
                  </a>
                ) : (
                  <span style={{ color: 'var(--ax-text-muted)' }}>Not set</span>
                )}
              </DetailEntry>
              <DetailEntry label="To">
                <a
                  href={orbAccountUrl(order.destination.walletAddress)}
                  target="_blank"
                  rel="noreferrer"
                  className="rd-addr-link"
                >
                  <span>
                    {order.destination.label} · {shortenAddress(order.destination.walletAddress, 4, 4)}
                  </span>
                </a>
              </DetailEntry>
              <DetailEntry label="Trust">
                <span
                  style={{
                    fontSize: 12,
                    color:
                      order.destination.trustState === 'trusted'
                        ? 'var(--ax-accent)'
                        : order.destination.trustState === 'restricted' || order.destination.trustState === 'blocked'
                          ? 'var(--ax-danger)'
                          : 'var(--ax-warning)',
                  }}
                >
                  {order.destination.trustState}
                </span>
              </DetailEntry>
              <DetailEntry label="Signature">
                {latestExec?.submittedSignature ? (
                  <a
                    href={orbTransactionUrl(latestExec.submittedSignature)}
                    target="_blank"
                    rel="noreferrer"
                    className="rd-tx-link"
                  >
                    <span>{shortenAddress(latestExec.submittedSignature, 6, 6)}</span>
                  </a>
                ) : (
                  <span style={{ color: 'var(--ax-text-muted)' }}>Not signed</span>
                )}
              </DetailEntry>
              {order.memo ? (
                <DetailEntry label="Memo">
                  <span>{order.memo}</span>
                </DetailEntry>
              ) : null}
              {order.dueAt ? (
                <DetailEntry label="Due">
                  <span>{formatTimestamp(order.dueAt)}</span>
                </DetailEntry>
              ) : null}
            </dl>
          </div>
        </section>

        <section className="rd-section">
          <div className="rd-section-head">
            <div>
              <h2 className="rd-section-title">Timeline</h2>
              <p className="rd-section-sub">Every recorded event for this payment.</p>
            </div>
          </div>
          <div className="rd-card">
            <div className="rd-timeline-shared">
              <TimelineRow
                title="Payment requested"
                meta={formatTimestamp(order.createdAt)}
                body={`Created by ${order.createdByUser?.email ?? 'System'}.`}
                state="complete"
              />
              {approvalDecisions.length > 0
                ? approvalDecisions
                    .slice()
                    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                    .map((d) => (
                      <TimelineRow
                        key={d.approvalDecisionId}
                        title={`Approval · ${d.action.replaceAll('_', ' ')}`}
                        meta={formatTimestamp(d.createdAt)}
                        body={d.actorUser?.email ?? d.actorType}
                        state="complete"
                      />
                    ))
                : null}
              {latestExec?.submittedSignature ? (
                <TimelineRow
                  title="Executed on-chain"
                  meta={formatTimestamp(latestExec.submittedAt ?? latestExec.createdAt)}
                  body={
                    <a
                      href={orbTransactionUrl(latestExec.submittedSignature)}
                      target="_blank"
                      rel="noreferrer"
                      className="rd-tx-link"
                    >
                      <span>{shortenAddress(latestExec.submittedSignature, 8, 8)}</span>
                    </a>
                  }
                  state="complete"
                />
              ) : null}
              {match?.matchedAt ? (
                <TimelineRow
                  title={`Settlement · ${match.matchStatus.replaceAll('_', ' ')}`}
                  meta={formatTimestamp(match.matchedAt)}
                  body={match.explanation || 'Observed and matched on-chain.'}
                  state={['settled', 'closed'].includes(order.derivedState) ? 'complete' : 'pending'}
                />
              ) : null}
              {['settled', 'closed'].includes(order.derivedState) ? (
                <TimelineRow
                  title="Proof ready"
                  meta={formatTimestamp(order.updatedAt)}
                  body="Canonical proof packet can be exported."
                  state="complete"
                />
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function LifecycleRail({ stages }: { stages: LifecycleStage[] }) {
  return (
    <div
      className="rd-rail"
      role="list"
      aria-label="Payment lifecycle"
      style={{ gridTemplateColumns: `repeat(${stages.length}, 1fr)` }}
    >
      {stages.map((stage) => (
        <div key={stage.id} className="rd-rail-step" data-state={stage.state} role="listitem">
          <div className="rd-rail-marker-row">
            <span className="rd-rail-dot" aria-hidden />
            <span className="rd-rail-line" aria-hidden />
          </div>
          <span className="rd-rail-label">{stage.label}</span>
          <span className="rd-rail-sub">{stage.sub}</span>
        </div>
      ))}
    </div>
  );
}

function DetailEntry({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="rd-metric-label" style={{ marginBottom: 6 }}>
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: 13, color: 'var(--ax-text)' }}>{children}</dd>
    </div>
  );
}

function TimelineRow({
  title,
  meta,
  body,
  state,
}: {
  title: string;
  meta: string;
  body: React.ReactNode;
  state: StageState;
}) {
  return (
    <div className="rd-timeline-row" data-state={state}>
      <div className="rd-timeline-head-row">
        <strong>{title}</strong>
        <span className="rd-timeline-meta">{meta}</span>
      </div>
      <p className="rd-timeline-sub">{body}</p>
    </div>
  );
}

function PrimaryAction(props: {
  variant: ActionVariant;
  order: PaymentOrder;
  amountLabel: string;
  submittedSignature: string | null;
  matchedAt: string | null;
  sourceAddresses: TreasuryWallet[];
  effectiveSourceAddressId: string;
  onSelectSource: (id: string) => void;
  wallets: BrowserWalletOption[];
  selectedWalletId: string | undefined;
  onSelectWallet: (id: string | undefined) => void;
  submitting: boolean;
  approving: boolean;
  signing: boolean;
  exporting: boolean;
  cancelling: boolean;
  onSubmit: () => void;
  onApprove: () => void;
  onSign: () => void;
  onExportProof: () => void;
  onCancel: () => void;
}) {
  const {
    variant,
    amountLabel,
    submittedSignature,
    sourceAddresses,
    effectiveSourceAddressId,
    onSelectSource,
    wallets,
    selectedWalletId,
    onSelectWallet,
    submitting,
    approving,
    signing,
    exporting,
    onSubmit,
    onApprove,
    onSign,
    onExportProof,
  } = props;

  if (variant === 'needs_submit') {
    return (
      <div className="rd-primary" data-emphasis="action">
        <p className="rd-primary-eyebrow">Next step · Submit</p>
        <h2 className="rd-primary-title">Ready to route through policy</h2>
        <p className="rd-primary-body">
          Submit this payment for policy evaluation. If approval is required, it will route to reviewers.
        </p>
        <div className="rd-actions">
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            onClick={onSubmit}
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? 'Submitting…' : 'Submit for approval'}
          </button>
        </div>
      </div>
    );
  }

  if (variant === 'needs_approval') {
    return (
      <div className="rd-primary" data-emphasis="action">
        <p className="rd-primary-eyebrow">Next step · Approval</p>
        <h2 className="rd-primary-title">Awaiting approval</h2>
        <p className="rd-primary-body">
          Policy routed this payment for review. Approve to unlock signing.
        </p>
        <div className="rd-actions">
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            onClick={onApprove}
            disabled={approving}
            aria-busy={approving}
          >
            {approving ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
    );
  }

  if (variant === 'ready_to_sign') {
    const hasWallets = wallets.length > 0;
    return (
      <div className="rd-primary" data-emphasis="action">
        <p className="rd-primary-eyebrow">Next step · Sign and execute</p>
        <h2 className="rd-primary-title">
          <span className="rd-mono">{amountLabel}</span> ready to sign
        </h2>
        <p className="rd-primary-body">One signature submits this payment on-chain.</p>
        <div className="rd-primary-grid">
          <label className="rd-field">
            <span className="rd-field-label">Source wallet</span>
            {sourceAddresses.length ? (
              <select
                className="rd-select"
                value={effectiveSourceAddressId}
                onChange={(e) => onSelectSource(e.target.value)}
              >
                {sourceAddresses.map((a) => (
                  <option key={a.treasuryWalletId} value={a.treasuryWalletId}>
                    {walletLabel(a)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="rd-field-label" style={{ color: 'var(--ax-warning)' }}>
                Add a wallet in Address book first.
              </span>
            )}
          </label>
          <label className="rd-field">
            <span className="rd-field-label">Signing wallet</span>
            <select
              className="rd-select"
              value={selectedWalletId ?? ''}
              onChange={(e) => onSelectWallet(e.target.value || undefined)}
              disabled={!hasWallets}
            >
              <option value="">{hasWallets ? 'Auto-detect' : 'No wallet detected'}</option>
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="rd-actions">
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            onClick={onSign}
            disabled={signing || !effectiveSourceAddressId}
            aria-busy={signing}
          >
            {signing ? 'Waiting for signature…' : 'Sign and submit'}
            {!signing ? <span className="rd-btn-arrow" aria-hidden>→</span> : null}
          </button>
        </div>
      </div>
    );
  }

  if (variant === 'in_flight') {
    return (
      <div className="rd-primary">
        <p className="rd-primary-eyebrow">Watching · Settlement</p>
        <h2 className="rd-primary-title">Signed, watching on-chain match</h2>
        <p className="rd-primary-body">
          The worker is reconstructing USDC transfers and matching this signature to the expected
          settlement.
        </p>
        {submittedSignature ? (
          <a
            href={orbTransactionUrl(submittedSignature)}
            target="_blank"
            rel="noreferrer"
            className="rd-tx-link"
          >
            <span>{shortenAddress(submittedSignature, 8, 8)}</span>
          </a>
        ) : null}
      </div>
    );
  }

  if (variant === 'settled') {
    return (
      <div className="rd-primary">
        <p className="rd-primary-eyebrow">Complete · Settled</p>
        <h2 className="rd-primary-title">Matched on-chain · proof ready</h2>
        <p className="rd-primary-body">
          This payment was requested, approved, signed, observed, and matched against intent.
        </p>
        <div className="rd-actions">
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            onClick={onExportProof}
            disabled={exporting}
            aria-busy={exporting}
          >
            {exporting ? 'Exporting…' : 'Download proof (JSON)'}
          </button>
        </div>
      </div>
    );
  }

  if (variant === 'exception') {
    return (
      <div className="rd-primary" data-emphasis="blocked">
        <p className="rd-primary-eyebrow">Attention needed</p>
        <h2 className="rd-primary-title">Settlement didn't match expected</h2>
        <p className="rd-primary-body">
          The observed transfer did not fully match this payment. Check the timeline for the exception
          detail.
        </p>
      </div>
    );
  }

  if (variant === 'cancelled') {
    return (
      <div className="rd-primary">
        <p className="rd-primary-eyebrow">Cancelled</p>
        <h2 className="rd-primary-title">This payment was cancelled</h2>
        <p className="rd-primary-body">It will not be executed. Kept here for audit.</p>
      </div>
    );
  }

  return (
    <div className="rd-primary">
      <p className="rd-primary-eyebrow">No action</p>
      <h2 className="rd-primary-title">Nothing to do right now</h2>
      <p className="rd-primary-body">Check back as state changes.</p>
    </div>
  );
}
