import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  PaymentOrder,
  PaymentRun,
  PaymentRunExecutionPreparation,
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
import { displayPaymentStatus, displayRunStatus, statusToneForPayment } from '../status-labels';
import { useToast } from '../ui/Toast';

type StageState = 'complete' | 'current' | 'pending' | 'blocked';

type LifecycleStage = {
  id: 'imported' | 'reviewed' | 'approved' | 'executed' | 'settled' | 'proven';
  label: string;
  sub: string;
  state: StageState;
};

type PrimaryActionVariant =
  | 'loading'
  | 'needs_approval'
  | 'ready_to_sign'
  | 'signing'
  | 'in_flight'
  | 'exception'
  | 'settled'
  | 'cancelled'
  | 'empty';

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

function assetSymbol(asset: string | undefined): string {
  return (asset ?? 'usdc').toUpperCase();
}

function walletLabel(address: TreasuryWallet): string {
  if (address.displayName && address.displayName.trim().length) {
    return `${address.displayName} · ${shortenAddress(address.address, 4, 4)}`;
  }
  return shortenAddress(address.address, 4, 4);
}

function buildLifecycle(run: PaymentRun, orders: PaymentOrder[]): LifecycleStage[] {
  const t = run.totals;
  const state = run.derivedState;
  const blocked = state === 'exception' || state === 'partially_settled';
  const settled = state === 'settled' || state === 'closed';
  const anySubmitted = orders.some((o) => {
    if (['execution_recorded', 'partially_settled', 'settled', 'closed', 'exception'].includes(o.derivedState)) {
      return true;
    }
    return Boolean(o.reconciliationDetail?.latestExecution?.submittedSignature);
  });
  const submittedDone =
    ['execution_recorded', 'partially_settled', 'settled', 'closed', 'exception'].includes(state)
    || anySubmitted;
  const approvedDone =
    t.approvedCount > 0
    || settled
    || state === 'execution_recorded'
    || state === 'exception'
    || state === 'partially_settled'
    || anySubmitted;
  const pendingApproval = t.pendingApprovalCount;
  const draftCount = Math.max(t.actionableCount - pendingApproval - t.approvedCount, 0);

  const reviewedCurrent = !approvedDone && draftCount > 0;
  const reviewedState: StageState = reviewedCurrent ? 'current' : 'complete';

  const approvedState: StageState = approvedDone
    ? 'complete'
    : pendingApproval > 0
      ? 'current'
      : 'pending';

  const executedState: StageState = blocked
    ? 'blocked'
    : submittedDone
      ? 'complete'
      : approvedDone
        ? 'current'
        : 'pending';

  const settledState: StageState = blocked
    ? 'blocked'
    : settled
      ? 'complete'
      : submittedDone
        ? 'current'
        : 'pending';

  const provenState: StageState = settled ? 'complete' : 'pending';

  return [
    {
      id: 'imported',
      label: 'Imported',
      sub: `${t.orderCount} payment${t.orderCount === 1 ? '' : 's'}`,
      state: 'complete',
    },
    {
      id: 'reviewed',
      label: reviewedState === 'complete' ? 'Reviewed' : 'Reviewing',
      sub: draftCount > 0 ? `${draftCount} to review` : 'All reviewed',
      state: reviewedState,
    },
    {
      id: 'approved',
      label: approvedState === 'complete' ? 'Approved' : 'Approval',
      sub:
        pendingApproval > 0
          ? `${pendingApproval} awaiting`
          : t.approvedCount > 0
            ? `${t.approvedCount} of ${t.actionableCount}`
            : 'Pending',
      state: approvedState,
    },
    {
      id: 'executed',
      label: executedState === 'complete' ? 'Executed' : 'Execute',
      sub: blocked
        ? 'Blocked'
        : submittedDone
          ? 'On-chain'
          : approvedDone
            ? 'Ready to sign'
            : 'Pending',
      state: executedState,
    },
    {
      id: 'settled',
      label: settledState === 'complete' ? 'Settled' : 'Settle',
      sub: `${t.settledCount} of ${Math.max(t.actionableCount, 1)} matched`,
      state: settledState,
    },
    {
      id: 'proven',
      label: provenState === 'complete' ? 'Proven' : 'Prove',
      sub: provenState === 'complete' ? 'Ready to export' : 'Pending settlement',
      state: provenState,
    },
  ];
}

function determinePrimaryVariant(run: PaymentRun, runOrders: PaymentOrder[]): PrimaryActionVariant {
  if (!runOrders.length) return 'empty';
  if (run.derivedState === 'settled' || run.derivedState === 'closed') return 'settled';
  if (run.derivedState === 'exception' || run.derivedState === 'partially_settled') return 'exception';
  if (run.derivedState === 'cancelled') return 'cancelled';

  const needsApproval = runOrders.some(
    (o) => o.derivedState === 'draft' || o.derivedState === 'pending_approval',
  );
  if (needsApproval) return 'needs_approval';

  const inFlight = runOrders.some((o) => o.derivedState === 'execution_recorded');
  if (inFlight) return 'in_flight';

  const readyToSign = runOrders.some((o) =>
    ['approved', 'ready_for_execution'].includes(o.derivedState),
  );
  if (readyToSign) return 'ready_to_sign';

  return 'empty';
}

function rid(value?: string) {
  return value ? value : 'unknown';
}

function useOutsideClick<T extends HTMLElement>(handler: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      if (!ref.current) return;
      if (event.target instanceof Node && ref.current.contains(event.target)) return;
      handler();
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [handler]);
  return ref;
}

export function PaymentRunDetailPage() {
  const { workspaceId, paymentRunId } = useParams<{ workspaceId: string; paymentRunId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { success, error: toastError, info } = useToast();
  const [prepared, setPrepared] = useState<PaymentRunExecutionPreparation | null>(null);
  const [selectedSourceAddressId, setSelectedSourceAddressId] = useState('');
  const [selectedWalletId, setSelectedWalletId] = useState<string | undefined>();
  const [wallets, setWallets] = useState<BrowserWalletOption[]>(() => discoverSolanaWallets());
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => subscribeSolanaWallets(setWallets), []);
  useEffect(() => setPrepared(null), [selectedSourceAddressId]);

  const addressesQuery = useQuery({
    queryKey: ['addresses', workspaceId] as const,
    queryFn: () => api.listTreasuryWallets(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 30_000,
  });

  const runQuery = useQuery({
    queryKey: ['payment-run', workspaceId, paymentRunId] as const,
    queryFn: () => api.getPaymentRunDetail(workspaceId!, paymentRunId!),
    enabled: Boolean(workspaceId && paymentRunId),
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      const s = query.state.data?.derivedState;
      if (s === 'settled' || s === 'closed' || s === 'cancelled') return false;
      return 5_000;
    },
  });

  const sourceAddresses = addressesQuery.data?.items ?? [];
  const effectiveSourceAddressId =
    selectedSourceAddressId
    || runQuery.data?.sourceTreasuryWalletId
    || sourceAddresses[0]?.treasuryWalletId
    || '';

  const routeForReviewMutation = useMutation({
    mutationFn: async () => {
      const orders = runQuery.data?.paymentOrders ?? [];
      const drafts = orders.filter((o) => o.derivedState === 'draft');
      if (drafts.length === 0) return { routed: 0, failed: 0 };
      const results = await Promise.allSettled(
        drafts.map((o) => api.submitPaymentOrder(workspaceId!, o.paymentOrderId)),
      );
      const routed = results.filter((r) => r.status === 'fulfilled').length;
      const failed = drafts.length - routed;
      return { routed, failed };
    },
    onSuccess: async ({ routed, failed }) => {
      if (failed) {
        toastError(
          `Routed ${routed} payment${routed === 1 ? '' : 's'} for approval. ${failed} failed to route.`,
        );
      }
      await queryClient.invalidateQueries({ queryKey: ['payment-run', workspaceId, paymentRunId] });
      navigate(`/workspaces/${workspaceId}/approvals?runId=${paymentRunId}`);
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not route payments for approval.'),
  });

  const approveMutation = useMutation({
    mutationFn: async () => {
      const orders = runQuery.data?.paymentOrders ?? [];
      const drafts = orders.filter((o) => o.derivedState === 'draft');
      const submitResults = await Promise.allSettled(
        drafts.map((o) => api.submitPaymentOrder(workspaceId!, o.paymentOrderId)),
      );
      const routedDrafts = submitResults.filter((r) => r.status === 'fulfilled').length;
      const draftFailures = drafts.length - routedDrafts;
      const refreshedRun = await api.getPaymentRunDetail(workspaceId!, paymentRunId!);
      const pending = (refreshedRun.paymentOrders ?? []).filter(
        (o) => o.derivedState === 'pending_approval' && Boolean(o.transferRequestId),
      );
      const approveResults = await Promise.allSettled(
        pending.map((o) =>
          api.createApprovalDecision(workspaceId!, o.transferRequestId!, { action: 'approve' }),
        ),
      );
      const approved = approveResults.filter((r) => r.status === 'fulfilled').length;
      const failed = draftFailures + (pending.length - approved);
      return { routedDrafts, approved, failed };
    },
    onSuccess: async ({ routedDrafts, approved, failed }) => {
      const advanced = routedDrafts + approved;
      if (failed) {
        toastError(
          `Advanced ${advanced} payment${advanced === 1 ? '' : 's'}. ${failed} failed — retry or inspect below.`,
        );
      } else {
        success(`Approved ${advanced} payment${advanced === 1 ? '' : 's'}.`);
      }
      await queryClient.invalidateQueries({ queryKey: ['payment-run', workspaceId, paymentRunId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not approve payments.'),
  });

  const signMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveSourceAddressId) throw new Error('Choose a source wallet before signing.');
      const sourceAddressRow = sourceAddresses.find((r) => r.treasuryWalletId === effectiveSourceAddressId);
      if (!sourceAddressRow?.address) {
        throw new Error('Source wallet is still loading. Wait a moment and retry.');
      }
      let preparation = prepared;
      const sourceMismatch =
        !preparation
        || preparation.paymentRun.sourceTreasuryWalletId !== effectiveSourceAddressId
        || preparation.executionPacket.signerWallet !== sourceAddressRow.address;
      if (sourceMismatch) {
        preparation = await api.preparePaymentRunExecution(workspaceId!, paymentRunId!, {
          sourceTreasuryWalletId: effectiveSourceAddressId,
        });
        setPrepared(preparation);
      }
      if (!preparation) throw new Error('Could not prepare the execution packet. Try again.');
      const signature = await signAndSubmitPreparedPayment(preparation.executionPacket, selectedWalletId);
      await api.attachPaymentRunSignature(workspaceId!, paymentRunId!, {
        submittedSignature: signature,
        submittedAt: new Date().toISOString(),
      });
      return signature;
    },
    onSuccess: async (signature) => {
      success(`Signed and submitted · ${shortenAddress(signature, 8, 8)}`);
      await queryClient.invalidateQueries({ queryKey: ['payment-run', workspaceId, paymentRunId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', workspaceId] });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Could not sign the batch.';
      if (/user|reject|cancel/i.test(message)) {
        info('Signing cancelled. Ready to retry.');
      } else {
        toastError(message);
      }
    },
  });

  const proofMutation = useMutation({
    mutationFn: () => api.getPaymentRunProof(workspaceId!, paymentRunId!),
    onSuccess: (proof) => {
      downloadJson(`payment-run-proof-${paymentRunId}.json`, proof);
      success('Proof packet downloaded.');
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not export proof.'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deletePaymentRun(workspaceId!, paymentRunId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['payment-runs', workspaceId] });
      navigate(`/workspaces/${workspaceId}/runs`);
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not delete run.'),
  });

  const menuRef = useOutsideClick<HTMLDivElement>(() => setMenuOpen(false));

  if (!workspaceId || !paymentRunId) {
    return (
      <main className="page-frame" data-layout="rd">
        <div className="rd-container">
          <div className="rd-state">
            <h2 className="rd-state-title">Run unavailable</h2>
            <p className="rd-state-body">Open a payment run from the runs page.</p>
          </div>
        </div>
      </main>
    );
  }

  if (runQuery.isLoading) {
    return (
      <main className="page-frame" data-layout="rd">
        <div className="rd-container">
          <div className="rd-skeleton rd-skeleton-line" style={{ width: 120 }} />
          <div className="rd-skeleton rd-skeleton-line" style={{ width: 280, height: 28, marginBottom: 8 }} />
          <div className="rd-skeleton rd-skeleton-line" style={{ width: 360 }} />
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 120, marginTop: 32 }} />
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 200, marginTop: 32 }} />
        </div>
      </main>
    );
  }

  if (runQuery.isError || !runQuery.data) {
    return (
      <main className="page-frame" data-layout="rd">
        <div className="rd-container">
          <Link to={`/workspaces/${workspaceId}/runs`} className="rd-back">
            <span className="rd-back-arrow">←</span>
            <span>Payment runs</span>
          </Link>
          <div className="rd-state">
            <h2 className="rd-state-title">Couldn't load this run</h2>
            <p className="rd-state-body">
              {runQuery.error instanceof Error ? runQuery.error.message : 'Something went wrong.'}
            </p>
            <button className="rd-btn rd-btn-secondary" onClick={() => void runQuery.refetch()} type="button">
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

  const run = runQuery.data;
  const runOrders = run.paymentOrders ?? [];
  const lifecycle = buildLifecycle(run, runOrders);
  const variant = determinePrimaryVariant(run, runOrders);
  const totalAmount = `${formatRawUsdcCompact(run.totals.totalAmountRaw)} ${assetSymbol(runOrders[0]?.asset)}`;
  const statusTone = statusToneForPayment(run.derivedState);
  const statusTonePill: 'success' | 'warning' | 'danger' | 'info' =
    statusTone === 'success' ? 'success' : statusTone === 'danger' ? 'danger' : statusTone === 'warning' ? 'warning' : 'info';

  const pendingCount = runOrders.filter(
    (o) => o.derivedState === 'draft' || o.derivedState === 'pending_approval',
  ).length;
  const readyToSignCount = runOrders.filter((o) =>
    ['approved', 'ready_for_execution'].includes(o.derivedState),
  ).length;
  const readyToSignAmountRaw = runOrders
    .filter((o) => ['approved', 'ready_for_execution'].includes(o.derivedState))
    .reduce((sum, o) => sum + BigInt(o.amountRaw || '0'), 0n);
  const submittedSignatures = Array.from(
    new Set(
      runOrders
        .map((o) => o.reconciliationDetail?.latestExecution?.submittedSignature)
        .filter((s): s is string => Boolean(s)),
    ),
  );
  const settledCount = run.totals.settledCount;

  return (
    <main className="page-frame" data-layout="rd">
      <div className="rd-container">
        <Link to={`/workspaces/${workspaceId}/runs`} className="rd-back">
          <span className="rd-back-arrow" aria-hidden>
            ←
          </span>
          <span>Payment runs</span>
        </Link>

        <header className="rd-header">
          <div>
            <p className="rd-eyebrow">Payment run</p>
            <h1 className="rd-title">{run.runName}</h1>
            <p className="rd-meta">
              <span className="rd-mono">{totalAmount}</span>
              <span className="rd-meta-sep">·</span>
              <span>
                {run.totals.orderCount} payment{run.totals.orderCount === 1 ? '' : 's'}
              </span>
              <span className="rd-meta-sep">·</span>
              <span>Created {formatRelativeTime(run.createdAt)}</span>
              {run.createdByUser?.email ? (
                <>
                  <span className="rd-meta-sep">·</span>
                  <span>{run.createdByUser.email}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="rd-header-side">
            <span className="rd-pill" data-tone={statusTonePill}>
              <span className="rd-pill-dot" aria-hidden />
              {displayRunStatus(run.derivedState)}
            </span>
            <div className="rd-menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="rd-overflow"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <span aria-hidden>⋯</span>
              </button>
              {menuOpen ? (
                <div className="rd-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="rd-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      proofMutation.mutate();
                    }}
                    disabled={proofMutation.isPending}
                  >
                    Export proof (JSON)
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="rd-menu-item"
                    data-tone="danger"
                    onClick={() => {
                      setMenuOpen(false);
                      setDeleteOpen(true);
                    }}
                  >
                    Delete run
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <LifecycleRail stages={lifecycle} />

        <PrimaryActionCard
          variant={variant}
          run={run}
          pendingCount={pendingCount}
          readyToSignCount={readyToSignCount}
          readyToSignAmount={`${formatRawUsdcCompact(readyToSignAmountRaw.toString())} USDC`}
          sourceAddresses={sourceAddresses}
          effectiveSourceAddressId={effectiveSourceAddressId}
          onSelectSource={setSelectedSourceAddressId}
          wallets={wallets}
          selectedWalletId={selectedWalletId}
          onSelectWallet={setSelectedWalletId}
          submittedSignatures={submittedSignatures}
          settledCount={settledCount}
          approving={approveMutation.isPending}
          routing={routeForReviewMutation.isPending}
          signing={signMutation.isPending}
          exporting={proofMutation.isPending}
          onApprove={() => approveMutation.mutate()}
          onReviewIndividually={() => routeForReviewMutation.mutate()}
          onSign={() => signMutation.mutate()}
          onExportProof={() => proofMutation.mutate()}
        />

        <section className="rd-section">
          <div className="rd-section-head">
            <div>
              <h2 className="rd-section-title">Payments in this run</h2>
              <p className="rd-section-sub">
                Each row reconciles independently even when signed as one batch.
              </p>
            </div>
            <span className="rd-section-meta">
              {runOrders.length} row{runOrders.length === 1 ? '' : 's'}
            </span>
          </div>
          <RecipientsTable workspaceId={workspaceId} orders={runOrders} />
        </section>
      </div>

      {deleteOpen ? (
        <ConfirmDialog
          title="Delete this payment run?"
          body={`"${run.runName}" will be removed permanently. Linked payment orders keep their history but lose the run grouping.`}
          confirmLabel={deleteMutation.isPending ? 'Deleting…' : 'Delete run'}
          confirmTone="danger"
          pending={deleteMutation.isPending}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => deleteMutation.mutate()}
        />
      ) : null}
    </main>
  );
}

function LifecycleRail({ stages }: { stages: LifecycleStage[] }) {
  return (
    <div
      className="rd-rail"
      role="list"
      aria-label="Payment run lifecycle"
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

function PrimaryActionCard(props: {
  variant: PrimaryActionVariant;
  run: PaymentRun;
  pendingCount: number;
  readyToSignCount: number;
  readyToSignAmount: string;
  sourceAddresses: TreasuryWallet[];
  effectiveSourceAddressId: string;
  onSelectSource: (id: string) => void;
  wallets: BrowserWalletOption[];
  selectedWalletId: string | undefined;
  onSelectWallet: (id: string | undefined) => void;
  submittedSignatures: string[];
  settledCount: number;
  approving: boolean;
  routing: boolean;
  signing: boolean;
  exporting: boolean;
  onApprove: () => void;
  onReviewIndividually: () => void;
  onSign: () => void;
  onExportProof: () => void;
}) {
  const {
    variant,
    run,
    pendingCount,
    readyToSignCount,
    readyToSignAmount,
    sourceAddresses,
    effectiveSourceAddressId,
    onSelectSource,
    wallets,
    selectedWalletId,
    onSelectWallet,
    submittedSignatures,
    settledCount,
    approving,
    routing,
    signing,
    exporting,
    onApprove,
    onReviewIndividually,
    onSign,
    onExportProof,
  } = props;

  if (variant === 'needs_approval') {
    return (
      <div className="rd-primary" data-emphasis="action">
        <p className="rd-primary-eyebrow">Next step · Approvals</p>
        <h2 className="rd-primary-title">
          {pendingCount} payment{pendingCount === 1 ? '' : 's'} need{pendingCount === 1 ? 's' : ''} approval
        </h2>
        <p className="rd-primary-body">
          Policy routed these because the destinations are not in your trusted set. Approve the whole
          batch at once, or review individually to approve some and reject others.
        </p>
        <div className="rd-actions">
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            onClick={onApprove}
            disabled={approving || routing}
            aria-busy={approving}
          >
            {approving ? 'Approving…' : `Approve all (${pendingCount})`}
          </button>
          <button
            type="button"
            className="rd-btn rd-btn-secondary"
            onClick={onReviewIndividually}
            disabled={approving || routing}
            aria-busy={routing}
          >
            {routing ? 'Preparing…' : 'Review individually'}
            {!routing ? <span className="rd-btn-arrow" aria-hidden>→</span> : null}
          </button>
        </div>
      </div>
    );
  }

  if (variant === 'ready_to_sign') {
    const selectedWallet = wallets.find((w) => w.id === selectedWalletId);
    const hasWallets = wallets.length > 0;
    return (
      <div className="rd-primary" data-emphasis="action">
        <p className="rd-primary-eyebrow">Next step · Sign and execute</p>
        <h2 className="rd-primary-title">
          <span className="rd-mono">{readyToSignAmount}</span> across {readyToSignCount} payment
          {readyToSignCount === 1 ? '' : 's'}
        </h2>
        <p className="rd-primary-body">
          One signature submits the full batch. Each payment reconciles independently on-chain.
        </p>
        <div className="rd-primary-grid">
          <label className="rd-field">
            <span className="rd-field-label">Source wallet</span>
            {sourceAddresses.length ? (
              <select
                className="rd-select"
                value={effectiveSourceAddressId}
                onChange={(e) => onSelectSource(e.target.value)}
              >
                {sourceAddresses.map((address) => (
                  <option key={address.treasuryWalletId} value={address.treasuryWalletId}>
                    {walletLabel(address)}
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
            disabled={signing || !effectiveSourceAddressId || readyToSignCount === 0}
            aria-busy={signing}
          >
            {signing ? 'Waiting for signature…' : `Sign and submit (${readyToSignCount})`}
            {!signing ? <span className="rd-btn-arrow" aria-hidden>→</span> : null}
          </button>
          {selectedWallet ? (
            <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
              Using {selectedWallet.name}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (variant === 'in_flight') {
    return (
      <div className="rd-primary">
        <p className="rd-primary-eyebrow">Watching · Settlement in flight</p>
        <h2 className="rd-primary-title">
          <span className="rd-mono">{settledCount}</span> of{' '}
          <span className="rd-mono">{run.totals.actionableCount}</span> matched on-chain
        </h2>
        <p className="rd-primary-body">
          The worker is reconstructing USDC transfers and matching them to this run's signatures. This page
          refreshes every few seconds.
        </p>
        {submittedSignatures.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {submittedSignatures.map((sig) => (
              <a
                key={sig}
                href={orbTransactionUrl(sig)}
                target="_blank"
                rel="noreferrer"
                className="rd-tx-link"
              >
                <span>{shortenAddress(sig, 8, 8)}</span>
                <ExternalIcon />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (variant === 'settled') {
    return (
      <div className="rd-primary">
        <p className="rd-primary-eyebrow">Complete · All settled</p>
        <h2 className="rd-primary-title">
          <span className="rd-mono">{settledCount}</span> of{' '}
          <span className="rd-mono">{run.totals.actionableCount}</span> matched · proof ready
        </h2>
        <p className="rd-primary-body">
          Every payment in this run was approved, signed, observed on-chain, and matched against intent.
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
        <h2 className="rd-primary-title">
          {run.totals.exceptionCount} exception{run.totals.exceptionCount === 1 ? '' : 's'} in this run
        </h2>
        <p className="rd-primary-body">
          One or more payments did not match expected settlement. Inspect the rows below and resolve each
          exception before exporting proof.
        </p>
      </div>
    );
  }

  if (variant === 'cancelled') {
    return (
      <div className="rd-primary">
        <p className="rd-primary-eyebrow">Run cancelled</p>
        <h2 className="rd-primary-title">This run is no longer active</h2>
        <p className="rd-primary-body">It will not be executed. The rows below are kept for audit.</p>
      </div>
    );
  }

  return (
    <div className="rd-primary">
      <p className="rd-primary-eyebrow">No action</p>
      <h2 className="rd-primary-title">Nothing to do right now</h2>
      <p className="rd-primary-body">
        This run has no pending work. Check back once more payments are added or state changes.
      </p>
    </div>
  );
}

function RecipientsTable({ workspaceId, orders }: { workspaceId: string; orders: PaymentOrder[] }) {
  if (!orders.length) {
    return (
      <div className="rd-table-shell">
        <div className="rd-state" style={{ margin: 0, padding: '56px 24px' }}>
          <h3 className="rd-state-title">No payments in this run</h3>
          <p className="rd-state-body">Payments imported into this run will appear here.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="rd-table-shell">
      <table className="rd-table">
        <thead>
          <tr>
            <th>Recipient</th>
            <th>Destination</th>
            <th className="rd-num">Amount</th>
            <th>Status</th>
            <th>Signature</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const latestExec = order.reconciliationDetail?.latestExecution;
            const signature = latestExec?.submittedSignature ?? null;
            const match = order.reconciliationDetail?.match;
            const tone = statusToneForPayment(order.derivedState);
            const pillTone: 'success' | 'warning' | 'danger' | 'info' =
              tone === 'success' ? 'success' : tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info';
            return (
              <tr key={order.paymentOrderId}>
                <td>
                  <div className="rd-recipient-main">
                    <span className="rd-recipient-name">
                      {order.counterparty?.displayName ?? order.destination.label}
                    </span>
                    {order.externalReference || order.invoiceNumber || order.memo ? (
                      <span className="rd-recipient-ref">
                        {order.externalReference ?? order.invoiceNumber ?? order.memo}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <a
                    className="rd-addr-link"
                    href={orbAccountUrl(order.destination.walletAddress)}
                    target="_blank"
                    rel="noreferrer"
                    title={order.destination.walletAddress}
                  >
                    <span className="rd-addr">{shortenAddress(order.destination.walletAddress, 4, 4)}</span>
                    <ExternalIcon />
                  </a>
                </td>
                <td className="rd-num">
                  <span>
                    {formatRawUsdcCompact(order.amountRaw)} {assetSymbol(order.asset)}
                  </span>
                </td>
                <td>
                  <span className="rd-pill" data-tone={pillTone}>
                    <span className="rd-pill-dot" aria-hidden />
                    {displayPaymentStatus(order.derivedState)}
                  </span>
                </td>
                <td>
                  {signature ? (
                    <a
                      className="rd-tx-link"
                      href={orbTransactionUrl(signature)}
                      target="_blank"
                      rel="noreferrer"
                      title={signature}
                    >
                      <span>{shortenAddress(signature, 6, 6)}</span>
                      <ExternalIcon />
                    </a>
                  ) : (
                    <span style={{ color: 'var(--ax-text-faint)', fontFamily: 'var(--ax-font-mono)', fontSize: 12 }}>
                      —
                    </span>
                  )}
                </td>
                <td>
                  <Link
                    to={`/workspaces/${workspaceId}/payments/${rid(order.paymentOrderId)}`}
                    className="rd-btn rd-btn-ghost"
                    style={{ minHeight: 32, padding: '6px 10px', fontSize: 12 }}
                  >
                    Details
                    <span className="rd-btn-arrow" aria-hidden>
                      →
                    </span>
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {orders.some((o) => o.reconciliationDetail?.match?.matchedAt) ? (
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--ax-border)',
            color: 'var(--ax-text-muted)',
            fontSize: 12,
          }}
        >
          Last match observed {formatTimestamp(
            orders
              .flatMap((o) => (o.reconciliationDetail?.match?.matchedAt ? [o.reconciliationDetail.match.matchedAt] : []))
              .sort()
              .pop() ?? '',
          )}
        </div>
      ) : null}
    </div>
  );
}

function ConfirmDialog(props: {
  title: string;
  body: string;
  confirmLabel: string;
  confirmTone?: 'primary' | 'danger';
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { title, body, confirmLabel, confirmTone = 'primary', pending, onCancel, onConfirm } = props;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="rd-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="rd-confirm-title">
      <div className="rd-dialog">
        <h2 id="rd-confirm-title" className="rd-dialog-title">
          {title}
        </h2>
        <p className="rd-dialog-body">{body}</p>
        <div className="rd-dialog-actions">
          <button type="button" className="rd-btn rd-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`rd-btn ${confirmTone === 'danger' ? 'rd-btn-danger' : 'rd-btn-primary'}`}
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg
      className="rd-icon-ext"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path
        d="M6 3h7v7M13 3 6 10M3 5v8h8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
