import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  CounterpartyWallet,
  DecimalProposal,
  PaymentOrder,
  PaymentRun,
  PaymentRunDocumentExtractedRow,
  PaymentRunDocumentSkippedRow,
  TreasuryWallet,
  UserWallet,
} from '../types';
import { signAndSubmitIntent } from '../lib/squads-pipeline';
import {
  isRetryableConfirmationError,
  readSettlementVerificationStatus,
  useAutoRetryProposalVerification,
} from '../lib/settlement';
import {
  assetSymbol,
  downloadJson,
  formatRawUsdcCompact,
  formatRelativeTime,
  formatTimestamp,
  shortenAddress,
  walletLabel,
} from '../domain';
import { displayPaymentStatus, displayRunStatus, statusToneForPayment } from '../status-labels';
import { buildSquadsPaymentLifecycle } from '../lib/lifecycle';
import { ChainLink, DetailPageSkeleton, DetailPageState, RdPageHeader, RdPrimaryCard } from '../ui-primitives';
import { LifecycleRail, type LifecycleStage } from '../ui/LifecycleRail';
import { useToast } from '../ui/Toast';

type PrimaryActionVariant =
  | 'loading'
  // Drafts exist but at least one destination wallet is unreviewed.
  // Submitting would be rejected by the backend, so we don't offer it —
  // instead the user must approve each destination first (inline in the
  // payments table below).
  | 'needs_destination_review'
  | 'needs_submit'
  | 'needs_treasury_wallet'
  | 'ready_to_propose'
  | 'proposal_in_progress'
  | 'in_flight'
  | 'needs_routing_review'
  | 'exception'
  | 'settled'
  | 'cancelled'
  | 'empty';

type DocumentImportReview = {
  status: string;
  reason: string | null;
  skippedRows: PaymentRunDocumentSkippedRow[];
  extractedRows: PaymentRunDocumentExtractedRow[];
};

function buildLifecycle(
  run: PaymentRun,
  settlementVerification: ReturnType<typeof readSettlementVerificationStatus>,
): LifecycleStage[] {
  const t = run.totals;
  // Batch runs share the same Squads 5-stage rail as single payments
  // (Requested · Propose · Approve · Execute · Verify). The per-row trust
  // review for unreviewed destinations is handled by the Submit action
  // card, not a separate rail stage.
  return buildSquadsPaymentLifecycle({
    derivedState: run.derivedState,
    settlementVerification,
    requestSub: `${t.orderCount} payment${t.orderCount === 1 ? '' : 's'}`,
    settledSub: `${t.settledCount} of ${Math.max(t.actionableCount, 1)} matched`,
    // Runs can land in 'exception'/'partially_settled' even when the
    // settlement verification itself didn't mismatch. Surface that as
    // "Needs review" instead of falling through to verification states.
    showBlockedReviewState: true,
  });
}

function determinePrimaryVariant(
  run: PaymentRun,
  runOrders: PaymentOrder[],
  squadsTreasuryCount: number,
): PrimaryActionVariant {
  if (getRunDocumentImportReview(run)?.status === 'needs_routing') return 'needs_routing_review';
  if (!runOrders.length) return 'empty';
  if (run.derivedState === 'settled' || run.derivedState === 'closed') return 'settled';
  if (run.derivedState === 'exception' || run.derivedState === 'partially_settled') return 'exception';
  if (run.derivedState === 'cancelled') return 'cancelled';

  const hasDrafts = runOrders.some((o) => o.derivedState === 'draft');
  if (hasDrafts) {
    // Backend rejects submissions whose destinations aren't trusted yet,
    // so don't pretend Submit is the next step — surface the review work
    // instead. The per-row Approve buttons in the table handle the actual
    // trust changes.
    const hasUnreviewedDestination = runOrders.some(
      (o) =>
        o.derivedState === 'draft' &&
        o.counterpartyWallet?.trustState &&
        o.counterpartyWallet.trustState !== 'trusted',
    );
    if (hasUnreviewedDestination) return 'needs_destination_review';
    return 'needs_submit';
  }

  if (run.derivedState === 'proposed') return 'proposal_in_progress';
  if (run.derivedState === 'executed') return 'in_flight';
  if (runOrders.some((o) => o.derivedState === 'execution_recorded')) return 'in_flight';

  if (run.derivedState === 'ready' || run.derivedState === 'ready_for_execution') {
    return squadsTreasuryCount === 0 ? 'needs_treasury_wallet' : 'ready_to_propose';
  }

  return 'empty';
}

function getRunDocumentImportReview(run: PaymentRun): DocumentImportReview | null {
  const raw = run.metadataJson?.importReview;
  if (!isRecord(raw)) return null;
  return {
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    skippedRows: Array.isArray(raw.skippedRows)
      ? raw.skippedRows
        .map((row, index) => normalizeDocumentSkippedRow(row, index))
        .filter((row): row is PaymentRunDocumentSkippedRow => Boolean(row))
      : [],
    extractedRows: Array.isArray(raw.extractedRows) ? raw.extractedRows.filter(isDocumentExtractedRow) : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDocumentSkippedRow(value: unknown, fallbackRowIndex: number): PaymentRunDocumentSkippedRow | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.counterparty !== 'string'
    || typeof value.amount !== 'number'
    || typeof value.currency !== 'string'
    || !(typeof value.reference === 'string' || value.reference === null)
    || typeof value.reason !== 'string'
  ) {
    return null;
  }
  return {
    rowIndex: typeof value.rowIndex === 'number' ? value.rowIndex : fallbackRowIndex,
    counterparty: value.counterparty,
    amount: value.amount,
    currency: value.currency,
    reference: value.reference,
    walletAddress: typeof value.walletAddress === 'string' ? value.walletAddress : null,
    reason: value.reason as PaymentRunDocumentSkippedRow['reason'],
    message: typeof value.message === 'string' ? value.message : undefined,
  };
}

function isDocumentExtractedRow(value: unknown): value is PaymentRunDocumentExtractedRow {
  return isRecord(value)
    && typeof value.counterparty === 'string'
    && typeof value.amount === 'number'
    && typeof value.currency === 'string'
    && (typeof value.reference === 'string' || value.reference === null)
    && (typeof value.due_date === 'string' || value.due_date === null)
    && (typeof value.wallet_address === 'string' || value.wallet_address === null)
    && (typeof value.notes === 'string' || value.notes === null);
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
  const { organizationId, paymentRunId } = useParams<{ organizationId: string; paymentRunId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { success, error: toastError, info } = useToast();
  const [selectedSourceTreasuryWalletId, setSelectedSourceTreasuryWalletId] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [routingWalletInputs, setRoutingWalletInputs] = useState<Record<number, string>>({});
  const [routingExistingWalletInputs, setRoutingExistingWalletInputs] = useState<Record<number, string>>({});

  const addressesQuery = useQuery({
    queryKey: ['addresses', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
  });

  const counterpartyWalletsQuery = useQuery({
    queryKey: ['counterparty-wallets', organizationId] as const,
    queryFn: () => api.listCounterpartyWallets(organizationId!),
    enabled: Boolean(organizationId),
  });

  const runQuery = useQuery({
    queryKey: ['payment-run', organizationId, paymentRunId] as const,
    queryFn: () => api.getPaymentRunDetail(organizationId!, paymentRunId!),
    enabled: Boolean(organizationId && paymentRunId),
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      const s = query.state.data?.derivedState;
      if (s === 'settled' || s === 'closed' || s === 'cancelled') return false;
      return 5_000;
    },
  });

  // Filter to Squads-source treasury wallets — direct-sign treasuries can no
  // longer execute batches; everything goes through the multisig proposal.
  const squadsTreasuryWallets = useMemo(
    () => (addressesQuery.data?.items ?? []).filter((w) => w.source === 'squads_v4' && w.isActive),
    [addressesQuery.data],
  );

  const effectiveSourceTreasuryWalletId =
    selectedSourceTreasuryWalletId
    || runQuery.data?.sourceTreasuryWalletId
    || squadsTreasuryWallets[0]?.treasuryWalletId
    || '';

  // Submit all draft orders so the run can advance to "ready" and the user
  // can create the Squads batch proposal. Backend rejects orders whose
  // destination isn't trusted yet, so we surface partial-failure detail
  // (which destinations need review) instead of routing to an inbox.
  const submitDraftsMutation = useMutation({
    mutationFn: async () => {
      const orders = runQuery.data?.paymentOrders ?? [];
      const drafts = orders.filter((o) => o.derivedState === 'draft');
      if (drafts.length === 0) return { submitted: 0, failures: [] as { paymentOrderId: string; reason: string }[] };
      const results = await Promise.allSettled(
        drafts.map((o) => api.submitPaymentOrder(organizationId!, o.paymentOrderId)),
      );
      const submitted = results.filter((r) => r.status === 'fulfilled').length;
      const failures = results
        .map((r, i) => ({ result: r, draft: drafts[i]! }))
        .filter((entry): entry is { result: PromiseRejectedResult; draft: PaymentOrder } => entry.result.status === 'rejected')
        .map(({ result, draft }) => ({
          paymentOrderId: draft.paymentOrderId,
          reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }));
      return { submitted, failures };
    },
    onSuccess: async ({ submitted, failures }) => {
      if (failures.length) {
        toastError(
          `${submitted} submitted. ${failures.length} blocked: ${failures[0]!.reason}${failures.length > 1 ? ` (and ${failures.length - 1} more)` : ''}`,
        );
      } else {
        success(`${submitted} payment${submitted === 1 ? '' : 's'} ready to propose.`);
      }
      await queryClient.invalidateQueries({ queryKey: ['payment-run', organizationId, paymentRunId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not submit payments.'),
  });

  // Per-row Approve flips the destination's trustState to 'trusted' so the
  // next Submit-all clears the trust gate for that row. Per-row Cancel is
  // straight cancellation of the payment order — that row drops out of the
  // batch's actionable count.
  const approveDestinationMutation = useMutation({
    mutationFn: ({ counterpartyWalletId }: { counterpartyWalletId: string; paymentOrderId: string }) =>
      api.updateCounterpartyWallet(organizationId!, counterpartyWalletId, { trustState: 'trusted' }),
    onSuccess: async () => {
      success('Destination approved.');
      await queryClient.invalidateQueries({ queryKey: ['payment-run', organizationId, paymentRunId] });
      await queryClient.invalidateQueries({ queryKey: ['counterparty-wallets', organizationId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not approve destination.'),
  });

  const cancelOrderMutation = useMutation({
    mutationFn: ({ paymentOrderId }: { paymentOrderId: string }) =>
      api.cancelPaymentOrder(organizationId!, paymentOrderId),
    onSuccess: async () => {
      success('Payment cancelled.');
      await queryClient.invalidateQueries({ queryKey: ['payment-run', organizationId, paymentRunId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not cancel payment.'),
  });

  const resolveDocumentRowMutation = useMutation({
    mutationFn: async ({ rowIndex }: { rowIndex: number }) => {
      const selectedWalletId = routingExistingWalletInputs[rowIndex] || null;
      const correctedWallet = (routingWalletInputs[rowIndex] ?? '').trim() || null;
      return api.resolvePaymentRunDocumentRow(organizationId!, paymentRunId!, {
        rowIndex,
        counterpartyWalletId: selectedWalletId,
        walletAddress: selectedWalletId ? null : correctedWallet,
        trustState: 'unreviewed',
      });
    },
    onSuccess: async () => {
      success('Payment row created. Review the destination below before submitting.');
      await queryClient.invalidateQueries({ queryKey: ['payment-run', organizationId, paymentRunId] });
      await queryClient.invalidateQueries({ queryKey: ['counterparty-wallets', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not resolve document row.'),
  });

  const proofMutation = useMutation({
    mutationFn: () => api.getPaymentRunProof(organizationId!, paymentRunId!),
    onSuccess: (proof) => {
      downloadJson(`payment-run-proof-${paymentRunId}.json`, proof);
      success('Proof packet downloaded.');
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not export proof.'),
  });

  // -- Squads batch proposal flow ---------------------------------------------
  const ownPersonalWalletsQuery = useQuery({
    queryKey: ['personal-wallets'] as const,
    queryFn: () => api.listPersonalWallets(),
    enabled: Boolean(organizationId),
  });
  const ownPersonalWallets: UserWallet[] = useMemo(
    () =>
      (ownPersonalWalletsQuery.data?.items ?? []).filter(
        (w) => w.status === 'active' && w.chain === 'solana',
      ),
    [ownPersonalWalletsQuery.data],
  );

  const [runProposalCreatorWalletId, setRunProposalCreatorWalletId] = useState('');
  useEffect(() => {
    if (!runProposalCreatorWalletId && ownPersonalWallets.length > 0) {
      setRunProposalCreatorWalletId(ownPersonalWallets[0]!.userWalletId);
    }
  }, [ownPersonalWallets, runProposalCreatorWalletId]);

  // Find the active Decimal proposal for this run (if any). Backend has no
  // paymentRunId filter on the proposals listing, so we fetch by treasury and
  // filter client-side. Only enabled once the run has a source treasury
  // committed (which happens as a side effect of proposal creation).
  const linkedProposalQuery = useQuery({
    queryKey: ['organization-proposals', organizationId, 'linked-run', paymentRunId] as const,
    queryFn: () =>
      api.listOrganizationProposals(organizationId!, {
        status: 'all',
        treasuryWalletId: runQuery.data!.sourceTreasuryWalletId!,
        limit: 50,
      }),
    enabled: Boolean(organizationId && paymentRunId && runQuery.data?.sourceTreasuryWalletId),
    refetchInterval: 15_000,
  });
  const linkedRunProposal: DecimalProposal | null = useMemo(() => {
    const items = linkedProposalQuery.data?.items ?? [];
    // Pick the most recent non-closed proposal whose paymentRunId matches.
    const candidates = items
      .filter((p) => p.paymentRunId === paymentRunId && p.semanticType === 'send_payment_run')
      .filter((p) => !['executed', 'cancelled', 'rejected'].includes(p.status));
    if (candidates.length > 0) return candidates[0]!;
    // Fall back to the most recent closed one (so executed runs still link to
    // their proposal).
    return items.find((p) => p.paymentRunId === paymentRunId && p.semanticType === 'send_payment_run') ?? null;
  }, [linkedProposalQuery.data, paymentRunId]);

  const [pendingRunProposalConfirmation, setPendingRunProposalConfirmation] = useState<
    { decimalProposalId: string; signature: string } | null
  >(null);

  const createRunProposalMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveSourceTreasuryWalletId) {
        throw new Error('Pick a Squads treasury to source this batch from.');
      }
      if (!runProposalCreatorWalletId) {
        throw new Error('Pick a personal wallet to initiate the proposal.');
      }
      const intent = await api.createSquadsPaymentRunProposalIntent(
        organizationId!,
        effectiveSourceTreasuryWalletId,
        {
          paymentRunId: paymentRunId!,
          creatorPersonalWalletId: runProposalCreatorWalletId,
        },
      );
      const signature = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: runProposalCreatorWalletId,
      });
      const decimalProposalId = intent.decimalProposal?.decimalProposalId ?? null;
      if (!decimalProposalId) {
        throw new Error('Backend did not return a decimal proposal id.');
      }
      setPendingRunProposalConfirmation({ decimalProposalId, signature });
      await api.confirmProposalSubmission(organizationId!, decimalProposalId, { signature });
      return { decimalProposalId, signature };
    },
    onSuccess: async (result) => {
      setPendingRunProposalConfirmation(null);
      success('Squads batch proposal created.');
      await queryClient.invalidateQueries({ queryKey: ['payment-run', organizationId, paymentRunId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
      navigate(`/organizations/${organizationId}/proposals/${result.decimalProposalId}`);
    },
    onError: (err) => {
      // 409 means a proposal already exists — refetch and let the
      // proposal_in_progress variant take over instead of toasting an error.
      if (err instanceof ApiError && err.status === 409) {
        queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
        queryClient.invalidateQueries({ queryKey: ['payment-run', organizationId, paymentRunId] });
        info('A proposal already exists for this run.');
        return;
      }
      if (isRetryableConfirmationError(err)) {
        info('Transaction submitted. Confirmation pending — retry in a moment.');
        return;
      }
      setPendingRunProposalConfirmation(null);
      toastError(err instanceof Error ? err.message : 'Could not create batch proposal.');
    },
  });

  const retryRunProposalConfirmationMutation = useMutation({
    mutationFn: async () => {
      if (!pendingRunProposalConfirmation) throw new Error('No pending confirmation.');
      await api.confirmProposalSubmission(organizationId!, pendingRunProposalConfirmation.decimalProposalId, {
        signature: pendingRunProposalConfirmation.signature,
      });
      return pendingRunProposalConfirmation;
    },
    onSuccess: async (result) => {
      setPendingRunProposalConfirmation(null);
      success('Proposal confirmed.');
      await queryClient.invalidateQueries({ queryKey: ['payment-run', organizationId, paymentRunId] });
      await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
      navigate(`/organizations/${organizationId}/proposals/${result.decimalProposalId}`);
    },
    onError: (err) => {
      if (isRetryableConfirmationError(err)) {
        info('Still pending. Try again in a few seconds.');
        return;
      }
      toastError(err instanceof Error ? err.message : 'Confirmation failed.');
    },
  });

  useAutoRetryProposalVerification({
    organizationId,
    proposal: linkedRunProposal,
    invalidationKeys: [
      ['payment-run', organizationId, paymentRunId],
      ['organization-proposals', organizationId, 'linked-run', paymentRunId],
    ],
  });
  const linkedRunVerificationStatus = readSettlementVerificationStatus(linkedRunProposal);
  // ----------------------------------------------------------------------------

  const deleteMutation = useMutation({
    mutationFn: () => api.deletePaymentRun(organizationId!, paymentRunId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['payment-runs', organizationId] });
      navigate(`/organizations/${organizationId}/runs`);
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not delete run.'),
  });

  const menuRef = useOutsideClick<HTMLDivElement>(() => setMenuOpen(false));

  if (!organizationId || !paymentRunId) {
    return (
      <DetailPageState
        title="Run unavailable"
        body="Open a payment run from the runs page."
        containerClassName="rd-container"
      />
    );
  }

  if (runQuery.isLoading) {
    return <DetailPageSkeleton containerClassName="rd-container" showMetaLine />;
  }

  if (runQuery.isError || !runQuery.data) {
    return (
      <DetailPageState
        title="Couldn't load this run"
        body={runQuery.error instanceof Error ? runQuery.error.message : 'Something went wrong.'}
        containerClassName="rd-container"
        back={
          <Link to={`/organizations/${organizationId}/runs`} className="rd-back">
            <span className="rd-back-arrow">←</span>
            <span>Payment runs</span>
          </Link>
        }
        action={
          <button className="rd-btn rd-btn-secondary" onClick={() => void runQuery.refetch()} type="button">
            Try again
          </button>
        }
      />
    );
  }

  const run = runQuery.data;
  const runOrders = run.paymentOrders ?? [];
  const documentImportReview = getRunDocumentImportReview(run);
  const counterpartyWallets = counterpartyWalletsQuery.data?.items ?? [];
  const lifecycle = buildLifecycle(run, linkedRunVerificationStatus);
  const variant = determinePrimaryVariant(run, runOrders, squadsTreasuryWallets.length);
  const totalAmount = `${formatRawUsdcCompact(run.totals.totalAmountRaw)} ${assetSymbol(runOrders[0]?.asset)}`;
  const statusTone = statusToneForPayment(run.derivedState);
  const statusTonePill: 'success' | 'warning' | 'danger' | 'info' =
    statusTone === 'success' ? 'success' : statusTone === 'danger' ? 'danger' : statusTone === 'warning' ? 'warning' : 'info';

  const pendingCount = runOrders.filter(
    (o) => o.derivedState === 'draft' || o.derivedState === 'pending_approval',
  ).length;
  const unreviewedDestinationCount = runOrders.filter(
    (o) =>
      o.derivedState === 'draft' &&
      o.counterpartyWallet?.trustState &&
      o.counterpartyWallet.trustState !== 'trusted',
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
        <Link to={`/organizations/${organizationId}/runs`} className="rd-back">
          <span className="rd-back-arrow" aria-hidden>
            ←
          </span>
          <span>Payment runs</span>
        </Link>

        <RdPageHeader
          eyebrow="Payment run"
          title={run.runName}
          meta={
            <>
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
            </>
          }
          side={
            <>
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
            </>
          }
        />

        <LifecycleRail stages={lifecycle} ariaLabel="Payment run lifecycle" />

        <PrimaryActionCard
          variant={variant}
          run={run}
          pendingCount={pendingCount}
          unreviewedDestinationCount={unreviewedDestinationCount}
          readyToSignCount={readyToSignCount}
          readyToSignAmount={`${formatRawUsdcCompact(readyToSignAmountRaw.toString())} USDC`}
          squadsTreasuryWallets={squadsTreasuryWallets}
          effectiveSourceTreasuryWalletId={effectiveSourceTreasuryWalletId}
          onSelectSourceTreasury={setSelectedSourceTreasuryWalletId}
          submittedSignatures={submittedSignatures}
          settledCount={settledCount}
          submittingDrafts={submitDraftsMutation.isPending}
          exporting={proofMutation.isPending}
          onSubmitDrafts={() => submitDraftsMutation.mutate()}
          onExportProof={() => proofMutation.mutate()}
          ownPersonalWallets={ownPersonalWallets}
          runProposalCreatorWalletId={runProposalCreatorWalletId}
          onSelectRunProposalCreator={setRunProposalCreatorWalletId}
          proposing={createRunProposalMutation.isPending}
          onCreateRunProposal={() => createRunProposalMutation.mutate()}
          pendingRunProposalConfirmation={pendingRunProposalConfirmation}
          retryingRunProposalConfirmation={retryRunProposalConfirmationMutation.isPending}
          onRetryRunProposalConfirmation={() => retryRunProposalConfirmationMutation.mutate()}
          linkedRunProposal={linkedRunProposal}
          organizationId={organizationId!}
          documentImportReview={documentImportReview}
          counterpartyWallets={counterpartyWallets}
          routingWalletInputs={routingWalletInputs}
          routingExistingWalletInputs={routingExistingWalletInputs}
          resolvingDocumentRowIndex={resolveDocumentRowMutation.isPending ? resolveDocumentRowMutation.variables?.rowIndex : undefined}
          onChangeRoutingWalletInput={(rowIndex, value) =>
            setRoutingWalletInputs((current) => ({ ...current, [rowIndex]: value }))
          }
          onChangeRoutingExistingWallet={(rowIndex, value) =>
            setRoutingExistingWalletInputs((current) => ({ ...current, [rowIndex]: value }))
          }
          onResolveDocumentRow={(rowIndex) => resolveDocumentRowMutation.mutate({ rowIndex })}
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
          <RecipientsTable
            organizationId={organizationId}
            orders={runOrders}
            onApproveDestination={(counterpartyWalletId, paymentOrderId) =>
              approveDestinationMutation.mutate({ counterpartyWalletId, paymentOrderId })
            }
            onCancelOrder={(paymentOrderId) => cancelOrderMutation.mutate({ paymentOrderId })}
            pendingApproveOrderId={
              approveDestinationMutation.isPending
                ? approveDestinationMutation.variables?.paymentOrderId
                : undefined
            }
            pendingCancelOrderId={
              cancelOrderMutation.isPending ? cancelOrderMutation.variables?.paymentOrderId : undefined
            }
          />
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

function PrimaryActionCard(props: {
  variant: PrimaryActionVariant;
  run: PaymentRun;
  pendingCount: number;
  unreviewedDestinationCount: number;
  readyToSignCount: number;
  readyToSignAmount: string;
  squadsTreasuryWallets: TreasuryWallet[];
  effectiveSourceTreasuryWalletId: string;
  onSelectSourceTreasury: (id: string) => void;
  submittedSignatures: string[];
  settledCount: number;
  submittingDrafts: boolean;
  exporting: boolean;
  onSubmitDrafts: () => void;
  onExportProof: () => void;
  ownPersonalWallets: UserWallet[];
  runProposalCreatorWalletId: string;
  onSelectRunProposalCreator: (id: string) => void;
  proposing: boolean;
  onCreateRunProposal: () => void;
  pendingRunProposalConfirmation: { decimalProposalId: string; signature: string } | null;
  retryingRunProposalConfirmation: boolean;
  onRetryRunProposalConfirmation: () => void;
  linkedRunProposal: DecimalProposal | null;
  organizationId: string;
  documentImportReview: DocumentImportReview | null;
  counterpartyWallets: CounterpartyWallet[];
  routingWalletInputs: Record<number, string>;
  routingExistingWalletInputs: Record<number, string>;
  resolvingDocumentRowIndex?: number;
  onChangeRoutingWalletInput: (rowIndex: number, value: string) => void;
  onChangeRoutingExistingWallet: (rowIndex: number, value: string) => void;
  onResolveDocumentRow: (rowIndex: number) => void;
}) {
  const {
    variant,
    run,
    pendingCount,
    unreviewedDestinationCount,
    readyToSignCount,
    readyToSignAmount,
    squadsTreasuryWallets,
    effectiveSourceTreasuryWalletId,
    onSelectSourceTreasury,
    submittedSignatures,
    settledCount,
    submittingDrafts,
    exporting,
    onSubmitDrafts,
    onExportProof,
    ownPersonalWallets,
    runProposalCreatorWalletId,
    onSelectRunProposalCreator,
    proposing,
    onCreateRunProposal,
    pendingRunProposalConfirmation,
    retryingRunProposalConfirmation,
    onRetryRunProposalConfirmation,
    linkedRunProposal,
    organizationId,
    documentImportReview,
    counterpartyWallets,
    routingWalletInputs,
    routingExistingWalletInputs,
    resolvingDocumentRowIndex,
    onChangeRoutingWalletInput,
    onChangeRoutingExistingWallet,
    onResolveDocumentRow,
  } = props;

  if (variant === 'needs_routing_review') {
    return (
      <DocumentRoutingReviewCard
        review={documentImportReview}
        counterpartyWallets={counterpartyWallets}
        walletInputs={routingWalletInputs}
        existingWalletInputs={routingExistingWalletInputs}
        resolvingRowIndex={resolvingDocumentRowIndex}
        onChangeWalletInput={onChangeRoutingWalletInput}
        onChangeExistingWallet={onChangeRoutingExistingWallet}
        onResolve={onResolveDocumentRow}
      />
    );
  }

  if (variant === 'needs_destination_review') {
    // Drafts exist but one or more destination wallets are unreviewed.
    // No Submit button — the user has to review each unreviewed destination
    // first (via the per-row Approve button in the payments table below).
    // Rendered as a thin inline banner; this is informational, not actionable.
    return (
      <div className="rd-inline-banner" role="note">
        <span className="rd-inline-banner-icon" aria-hidden>•</span>
        <span>
          <strong>
            {unreviewedDestinationCount} destination
            {unreviewedDestinationCount === 1 ? '' : 's'} to review.
          </strong>{' '}
          Approve each destination below to submit this run.
        </span>
      </div>
    );
  }

  if (variant === 'needs_submit') {
    return (
      <RdPrimaryCard
        emphasis="action"
        eyebrow="Submit"
        title={`${pendingCount} payment${pendingCount === 1 ? '' : 's'} ready`}
        body="Each destination wallet has been reviewed. Submit to advance to signing."
      >
        <div className="rd-actions">
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            onClick={onSubmitDrafts}
            disabled={submittingDrafts}
            aria-busy={submittingDrafts}
          >
            {submittingDrafts ? 'Submitting…' : `Submit all (${pendingCount})`}
          </button>
        </div>
      </RdPrimaryCard>
    );
  }

  if (variant === 'ready_to_propose') {
    if (pendingRunProposalConfirmation) {
      return (
        <RdPrimaryCard
          emphasis="action"
          eyebrow="Awaiting confirmation"
          title="Submitted on chain"
          body="Don't recreate — your signature is in flight. Retry confirmation in a few seconds."
        >
          <p className="rd-hint" data-mono="true" style={{ margin: '0 0 12px' }}>
            sig {shortenAddress(pendingRunProposalConfirmation.signature, 6, 6)}
          </p>
          <div className="rd-actions">
            <button
              type="button"
              className="rd-btn rd-btn-primary"
              onClick={onRetryRunProposalConfirmation}
              disabled={retryingRunProposalConfirmation}
              aria-busy={retryingRunProposalConfirmation}
            >
              {retryingRunProposalConfirmation ? 'Retrying confirmation…' : 'Retry confirmation'}
              {!retryingRunProposalConfirmation ? <span className="rd-btn-arrow" aria-hidden>→</span> : null}
            </button>
          </div>
        </RdPrimaryCard>
      );
    }

    const hasPersonalWallets = ownPersonalWallets.length > 0;
    const sourceLocked = Boolean(run.sourceTreasuryWalletId);
    return (
      <RdPrimaryCard
        emphasis="action"
        eyebrow="Create proposal"
        title={`${readyToSignCount} payment${readyToSignCount === 1 ? '' : 's'} ready · ${readyToSignAmount}`}
        body="Choose the treasury and the wallet that will initiate signing."
      >
        <div className="rd-primary-grid">
          <label className="rd-field">
            <span className="rd-field-label">Source treasury (Squads multisig)</span>
            <select
              className="rd-select"
              value={effectiveSourceTreasuryWalletId}
              onChange={(e) => onSelectSourceTreasury(e.target.value)}
              disabled={sourceLocked}
            >
              {squadsTreasuryWallets.map((w) => (
                <option key={w.treasuryWalletId} value={w.treasuryWalletId}>
                  {walletLabel(w)}
                </option>
              ))}
            </select>
          </label>
          <label className="rd-field">
            <span className="rd-field-label">Initiating wallet</span>
            {hasPersonalWallets ? (
              <select
                className="rd-select"
                value={runProposalCreatorWalletId}
                onChange={(e) => onSelectRunProposalCreator(e.target.value)}
              >
                {ownPersonalWallets.map((w) => (
                  <option key={w.userWalletId} value={w.userWalletId}>
                    {(w.label ?? 'Untitled')} · {shortenAddress(w.walletAddress, 4, 4)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="rd-field-label" style={{ color: 'var(--ax-warning)' }}>
                Create a personal wallet on /profile first.
              </span>
            )}
          </label>
        </div>
        <p className="rd-hint" style={{ margin: '0 0 12px' }}>
          Initiating wallet needs the Initiate permission. Max 8 payments per batch.
        </p>
        <div className="rd-actions">
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            onClick={onCreateRunProposal}
            disabled={
              proposing
                || !hasPersonalWallets
                || !runProposalCreatorWalletId
                || !effectiveSourceTreasuryWalletId
            }
            aria-busy={proposing}
          >
            {proposing ? 'Creating proposal…' : 'Create batch proposal'}
            {!proposing ? <span className="rd-btn-arrow" aria-hidden>→</span> : null}
          </button>
        </div>
      </RdPrimaryCard>
    );
  }

  if (variant === 'needs_treasury_wallet') {
    return (
      <div className="rd-inline-banner" role="note">
        <span className="rd-inline-banner-icon" aria-hidden>•</span>
        <span className="rd-inline-banner-text">
          <strong>No treasury connected.</strong>{' '}
          Set one up before this run can be sent.
        </span>
        <Link
          className="rd-btn rd-btn-sm rd-btn-primary rd-inline-banner-action"
          to={`/organizations/${organizationId}/wallets`}
        >
          Set up treasury
        </Link>
      </div>
    );
  }

  if (variant === 'proposal_in_progress') {
    const proposal = linkedRunProposal;
    const status = proposal?.status ?? 'active';
    const voting = proposal?.voting ?? null;
    const approvalCount = voting?.approvals.length ?? 0;
    const threshold = voting?.threshold ?? 0;
    const pendingVoters = voting?.pendingVoters.length ?? 0;
    const isApproved = status === 'approved';
    const detailHref = proposal
      ? `/organizations/${organizationId}/proposals/${proposal.decimalProposalId}`
      : `/organizations/${organizationId}/proposals`;
    return (
      <RdPrimaryCard
        emphasis={isApproved ? 'action' : undefined}
        eyebrow={isApproved ? 'Send' : 'Signing'}
        title={
          isApproved
            ? `Threshold met — ready to send`
            : `${approvalCount} of ${threshold} signed · ${pendingVoters} pending`
        }
      >
        <div className="rd-actions">
          <Link className="rd-btn rd-btn-primary" to={detailHref}>
            Open proposal
            <span className="rd-btn-arrow" aria-hidden>→</span>
          </Link>
        </div>
      </RdPrimaryCard>
    );
  }

  if (variant === 'in_flight') {
    return (
      <RdPrimaryCard
        eyebrow="Settling"
        title={
          <>
            <span className="rd-mono">{settledCount}</span> of{' '}
            <span className="rd-mono">{run.totals.actionableCount}</span> matched on chain
          </>
        }
        body="Verifying transfers landed. This page refreshes automatically."
      >
        {submittedSignatures.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {submittedSignatures.map((sig) => (
              <ChainLink key={sig} signature={sig} prefix={8} suffix={8} />
            ))}
          </div>
        ) : null}
      </RdPrimaryCard>
    );
  }

  if (variant === 'settled') {
    return (
      <RdPrimaryCard
        eyebrow="Settled"
        title={
          <>
            <span className="rd-mono">{settledCount}</span> of{' '}
            <span className="rd-mono">{run.totals.actionableCount}</span> settled · proof ready
          </>
        }
        body="All payments landed and reconciled."
      >
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
      </RdPrimaryCard>
    );
  }

  if (variant === 'exception') {
    return (
      <RdPrimaryCard
        emphasis="blocked"
        eyebrow="Attention needed"
        title={`${run.totals.exceptionCount} exception${run.totals.exceptionCount === 1 ? '' : 's'} in this run`}
        body="One or more payments did not match expected settlement. Inspect the rows below and resolve each exception before exporting proof."
      />
    );
  }

  if (variant === 'cancelled') {
    return (
      <RdPrimaryCard
        eyebrow="Run cancelled"
        title="This run is no longer active"
        body="It will not be executed. The rows below are kept for audit."
      />
    );
  }

  return (
    <RdPrimaryCard
      eyebrow="No action"
      title="Nothing to do right now"
      body="This run has no pending work. Check back once more payments are added or state changes."
    />
  );
}

function DocumentRoutingReviewCard(props: {
  review: DocumentImportReview | null;
  counterpartyWallets: CounterpartyWallet[];
  walletInputs: Record<number, string>;
  existingWalletInputs: Record<number, string>;
  resolvingRowIndex?: number;
  onChangeWalletInput: (rowIndex: number, value: string) => void;
  onChangeExistingWallet: (rowIndex: number, value: string) => void;
  onResolve: (rowIndex: number) => void;
}) {
  const rows = props.review?.skippedRows ?? [];
  return (
    <RdPrimaryCard
      emphasis="action"
      eyebrow="Routing review"
      title={`${rows.length} extracted row${rows.length === 1 ? '' : 's'} need a destination`}
      body="OCR found payable invoice data, but Decimal could not route it to a valid counterparty wallet. Correct or select the destination, then the normal approval and proposal flow continues."
    >
      <div className="rd-stack">
        {rows.length === 0 ? (
          <p className="rd-muted">No unresolved document rows remain.</p>
        ) : rows.map((row) => {
          const extracted = props.review?.extractedRows[row.rowIndex];
          const selectedWalletId = props.existingWalletInputs[row.rowIndex] ?? '';
          const correctedWallet = props.walletInputs[row.rowIndex] ?? '';
          const resolving = props.resolvingRowIndex === row.rowIndex;
          return (
            <div className="rd-review-row" key={`${row.rowIndex}-${row.reference ?? row.counterparty}`}>
              <div className="rd-review-row-head">
                <div>
                  <p className="rd-review-title">{row.counterparty}</p>
                  <p className="rd-muted">
                    {row.amount} {row.currency}
                    {row.reference ? ` · ${row.reference}` : ''}
                  </p>
                </div>
                <span className="rd-pill" data-tone="danger">
                  {row.reason === 'invalid_wallet_address' ? 'Invalid wallet' : 'Needs destination'}
                </span>
              </div>
              {row.walletAddress ? (
                <p className="rd-hint" data-mono="true">
                  OCR read: {row.walletAddress}
                </p>
              ) : null}
              {row.message ? <p className="rd-hint">{row.message}</p> : null}
              {extracted?.notes ? <p className="rd-hint">{extracted.notes}</p> : null}

              <div className="rd-primary-grid">
                <label className="rd-field">
                  <span className="rd-field-label">Use existing destination</span>
                  <select
                    className="rd-select"
                    value={selectedWalletId}
                    onChange={(e) => props.onChangeExistingWallet(row.rowIndex, e.target.value)}
                  >
                    <option value="">Create from corrected wallet</option>
                    {props.counterpartyWallets.map((wallet) => (
                      <option key={wallet.counterpartyWalletId} value={wallet.counterpartyWalletId}>
                        {wallet.label} · {shortenAddress(wallet.walletAddress)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="rd-field">
                  <span className="rd-field-label">Corrected Solana wallet</span>
                  <input
                    className="rd-input"
                    value={correctedWallet}
                    onChange={(e) => props.onChangeWalletInput(row.rowIndex, e.target.value)}
                    placeholder="Paste the corrected wallet address"
                    disabled={Boolean(selectedWalletId)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>

              <div className="rd-actions">
                <button
                  type="button"
                  className="rd-btn rd-btn-primary"
                  onClick={() => props.onResolve(row.rowIndex)}
                  disabled={resolving || (!selectedWalletId && correctedWallet.trim().length === 0)}
                  aria-busy={resolving}
                >
                  {resolving ? 'Creating payment row…' : 'Create payment row'}
                  {!resolving ? <span className="rd-btn-arrow" aria-hidden>→</span> : null}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </RdPrimaryCard>
  );
}

function RecipientsTable({
  organizationId,
  orders,
  onApproveDestination,
  onCancelOrder,
  pendingApproveOrderId,
  pendingCancelOrderId,
}: {
  organizationId: string;
  orders: PaymentOrder[];
  onApproveDestination: (counterpartyWalletId: string, paymentOrderId: string) => void;
  onCancelOrder: (paymentOrderId: string) => void;
  pendingApproveOrderId: string | undefined;
  pendingCancelOrderId: string | undefined;
}) {
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
            const tone = statusToneForPayment(order.derivedState);
            const pillTone: 'success' | 'warning' | 'danger' | 'info' =
              tone === 'success' ? 'success' : tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info';
            const isDraft = order.derivedState === 'draft';
            const trustState = order.counterpartyWallet.trustState;
            const trustTone: 'success' | 'warning' | 'danger' =
              trustState === 'trusted' ? 'success' : trustState === 'blocked' || trustState === 'restricted' ? 'danger' : 'warning';
            const approving = pendingApproveOrderId === order.paymentOrderId;
            const cancelling = pendingCancelOrderId === order.paymentOrderId;
            const rowBusy = approving || cancelling;
            return (
              <tr key={order.paymentOrderId}>
                <td>
                  <div className="rd-recipient-main">
                    <span className="rd-recipient-name">
                      {order.counterparty?.displayName ?? order.counterpartyWallet.label}
                    </span>
                    {order.externalReference || order.invoiceNumber || order.memo ? (
                      <span className="rd-recipient-ref">
                        {order.externalReference ?? order.invoiceNumber ?? order.memo}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <ChainLink address={order.counterpartyWallet.walletAddress} prefix={4} suffix={4} />
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
                    <ChainLink signature={signature} />
                  ) : (
                    <span className="rd-empty-mark" data-mono="true">
                      —
                    </span>
                  )}
                </td>
                <td>
                  <div className="rd-row-actions">
                    {isDraft && trustState !== 'trusted' ? (
                      <button
                        type="button"
                        className="rd-btn rd-btn-sm rd-btn-primary"
                        disabled={rowBusy}
                        aria-busy={approving}
                        onClick={() => onApproveDestination(order.counterpartyWallet.counterpartyWalletId, order.paymentOrderId)}
                      >
                        {approving ? 'Approving…' : 'Approve'}
                      </button>
                    ) : null}
                    {isDraft ? (
                      <button
                        type="button"
                        className="rd-btn rd-btn-sm rd-btn-secondary"
                        disabled={rowBusy}
                        aria-busy={cancelling}
                        onClick={() => onCancelOrder(order.paymentOrderId)}
                      >
                        {cancelling ? 'Rejecting…' : 'Reject'}
                      </button>
                    ) : null}
                  </div>
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
