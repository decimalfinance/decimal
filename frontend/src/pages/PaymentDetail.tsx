import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  DecimalProposal,
  PaymentOrder,
  PaymentOrderEvent,
} from '../types';
import {
  assetSymbol,
  downloadJson,
  formatRawUsdcCompact,
  formatRelativeTime,
  formatTimestamp,
  shortenAddress,
} from '../domain';
import { displayPaymentStatus, statusToneForPayment, toneToPill } from '../status-labels';
import { signAndSubmitIntent } from '../lib/squads-pipeline';
import {
  isRetryableConfirmationError,
  readSettlementVerificationStatus,
  useAutoRetryProposalVerification,
} from '../lib/settlement';
import { useSquadsProposalActions } from '../lib/squads-actions';
import { buildSquadsPaymentLifecycle } from '../lib/lifecycle';
import { type LifecycleStage, type StageState } from '../ui/LifecycleRail';
import { useToast } from '../ui/Toast';
import type { UserWallet } from '../types';
import { Ico } from '../dec/icons';
import { Pill, SLPill, OriginPill, type PillTone } from '../dec/primitives';
import { orbTransactionUrl } from '../lib/app';

type ActionVariant =
  | 'needs_review'
  | 'needs_route'
  | 'ready_to_propose'
  | 'proposal_in_progress'
  | 'spending_limit_in_flight'
  | 'spending_limit_settled'
  | 'in_flight'
  | 'settled'
  | 'exception'
  | 'cancelled'
  | 'idle';

function buildLifecycle(
  order: PaymentOrder,
  settlementVerification: ReturnType<typeof readSettlementVerificationStatus>,
): LifecycleStage[] {
  const s = order.productLifecycle?.productState ?? order.derivedState;
  const stages = buildSquadsPaymentLifecycle({
    derivedState: s,
    settlementVerification,
    requestSub: formatRelativeTime(order.createdAt),
    settledSub: 'Matched',
  });
  // Once a settled payment has a QuickBooks sync, the books step belongs in the
  // lifecycle — append it so it reads as the natural stage after Settled.
  const a = order.accountingSync;
  if (a) {
    stages.push({
      id: 'accounting',
      label: a.status === 'synced' ? 'Synced' : a.status === 'error' ? 'Sync failed' : 'Syncing',
      sub: 'QuickBooks',
      state: a.status === 'synced' ? 'complete' : a.status === 'error' ? 'blocked' : 'current',
    });
  }
  return stages;
}

// Surface the QuickBooks sync as a timeline entry too (synthesised from the
// sync record so it shows for every already-synced payment, no backfill).
function withAccountingEvent(order: PaymentOrder): PaymentOrderEvent[] {
  const base = order.events ?? [];
  const a = order.accountingSync;
  if (a?.status === 'synced' && a.syncedAt) {
    return [
      ...base,
      {
        paymentOrderEventId: `accounting-${a.billId ?? 'synced'}`,
        paymentOrderId: order.paymentOrderId,
        organizationId: order.organizationId,
        eventType: 'accounting_synced',
        actorType: 'system',
        actorId: null,
        beforeState: null,
        afterState: null,
        linkedTransferRequestId: null,
        linkedExecutionRecordId: null,
        linkedSignature: null,
        payloadJson: { billId: a.billId, billPaymentId: a.billPaymentId },
        createdAt: a.syncedAt,
      },
    ];
  }
  return base;
}

function determineVariant(order: PaymentOrder): ActionVariant {
  const s = order.productLifecycle?.productState ?? order.derivedState;
  // needs_review: agent flagged the invoice; a human must clear it first.
  // draft: clear payment intent with no execution route yet. It can be routed
  //   through an agent spending limit or a Squads proposal.
  // proposed: a Squads proposal exists; the substate (collecting votes /
  //   executing) is tracked on the proposal, not the order.
  // executed: on-chain transfer landed, settlement verification in flight.
  // settled: counterparty wallet confirmed receipt.
  if (s === 'needs_review') return 'needs_review';
  if (s === 'draft') {
    return order.sourceTreasuryWallet?.source === 'squads_v4' && order.canCreateSquadsPaymentProposal !== false
      ? 'ready_to_propose'
      : 'needs_route';
  }
  if (s === 'proposed') return 'proposal_in_progress';
  // Spending-limit route: an SL execution exists on the order, so the agent
  // took the auto path instead of opening a multisig proposal. Show a
  // dedicated card so the user can see WHICH policy ran.
  if (order.spendingLimitExecution) {
    if (s === 'executed') return 'spending_limit_in_flight';
    if (s === 'settled') return 'spending_limit_settled';
  }
  if (s === 'executed') return 'in_flight';
  if (s === 'settled') return 'settled';
  if (s === 'cancelled') return 'cancelled';
  return 'idle';
}

export function PaymentDetailPage() {
  const { organizationId, paymentOrderId } = useParams<{ organizationId: string; paymentOrderId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { success, error: toastError, info } = useToast();
  const orderQuery = useQuery({
    queryKey: ['payment-order', organizationId, paymentOrderId] as const,
    queryFn: () => api.getPaymentOrderDetail(organizationId!, paymentOrderId!),
    enabled: Boolean(organizationId && paymentOrderId),
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      const d = query.state.data;
      const s = d?.derivedState;
      if (s !== 'settled' && s !== 'cancelled') return 5_000;
      if (s === 'cancelled') return false;
      // Settled: keep polling briefly so a freshly-landed QuickBooks sync shows
      // up live (the sync fires just after settlement). Stop once it resolves,
      // or after a short window so orgs without accounting don't poll forever.
      const acct = d?.accountingSync;
      if (acct && acct.status !== 'pending') return false;
      const settledRecently = d?.updatedAt ? Date.now() - new Date(d.updatedAt).getTime() < 90_000 : false;
      return settledRecently ? 5_000 : false;
    },
  });

  const routeMutation = useMutation({
    mutationFn: () => api.advancePaymentOrder(organizationId!, paymentOrderId!),
    onSuccess: async () => {
      success('Agent routing started.');
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not route payment.'),
  });

  const proofMutation = useMutation({
    mutationFn: () => api.getPaymentOrderProof(organizationId!, paymentOrderId!),
    onSuccess: (proof) => {
      downloadJson(`payment-proof-${paymentOrderId}.json`, proof);
      success('Proof packet downloaded.');
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not export proof.'),
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelPaymentOrder(organizationId!, paymentOrderId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
      navigate(`/organizations/${organizationId}/payments`);
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not cancel.'),
  });

  // Manual sync — reconcile the payment's proposal from chain. The backend
  // finds the real on-chain execution signature (even one the app never
  // recorded), stores it, and verifies USDC settlement across clusters. This
  // replaces the old client-side RPC poll + confirm against whatever signature
  // we happened to have — which fell back to the proposal-creation tx (no
  // transfer) and could never settle. If the order is still a draft with no
  // proposal yet, nudge the agent router instead.
  const syncMutation = useMutation({
    mutationFn: async () => {
      const fresh = orderQuery.data;
      const proposal = fresh?.squadsPaymentProposal ?? null;
      if (proposal) {
        await api.reconcileProposalFromChain(organizationId!, proposal.decimalProposalId);
      }
      if (fresh?.derivedState === 'draft') {
        try {
          await api.advancePaymentOrder(organizationId!, paymentOrderId!);
        } catch {
          // ignore — agent may be blocked; refresh anyway
        }
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
      success('Synced from chain.');
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Sync failed.'),
  });

  const accountingRetryMutation = useMutation({
    mutationFn: () => api.syncPaymentOrderAccounting(organizationId!, paymentOrderId!),
    onSuccess: async () => {
      success('Retrying QuickBooks sync…');
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not retry the sync.'),
  });

  // "Approve & continue" on a needs_review order. Clears the AP-intake
  // flag, trusts the counterparty wallet, and asks the agent router to either
  // use a spending limit or create a Squads proposal in the same call.
  const clearReviewMutation = useMutation({
    mutationFn: () =>
      api.clearPaymentOrderReview(organizationId!, paymentOrderId!, {
        autoAdvance: true,
        trustCounterpartyWallet: true,
      }),
    onSuccess: async (result) => {
      const automation = result.automation;
      if (automation?.status === 'proposal_submitted') {
        success('Approved. Agent created the proposal on chain.');
      } else if (automation?.status === 'spending_limit_executed') {
        success('Approved. Agent paid it under an auto-pay rule.');
      } else if (automation?.status === 'already_has_proposal') {
        success('Approved. Proposal was already on chain.');
      } else if (automation?.status === 'already_has_spending_limit_execution') {
        success('Approved. Spending-limit execution was already recorded.');
      } else if (automation?.status === 'needs_source_treasury' || automation?.status === 'unsupported_source_treasury') {
        info('Approved. Pick a treasury to fund this payment from.');
      } else if (automation?.status === 'failed' || automation?.status === 'blocked') {
        toastError(`Approved internally, but agent couldn't route it: ${automation.reason}`);
      } else {
        success('Approved.');
      }
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not approve.'),
  });

  // Personal wallets needed when the source is a Squads vault — we use one
  // of the user's wallets that's an on-chain Squads voter (with `initiate`)
  // to sign the proposal-create transaction.
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

  const [proposalCreatorWalletId, setProposalCreatorWalletId] = useState('');
  useEffect(() => {
    if (!proposalCreatorWalletId && ownPersonalWallets.length > 0) {
      setProposalCreatorWalletId(ownPersonalWallets[0]!.userWalletId);
    }
  }, [ownPersonalWallets, proposalCreatorWalletId]);

  const sessionQuery = useQuery<AuthenticatedSession>({
    queryKey: ['session'] as const,
    queryFn: () => api.getSession(),
    enabled: api.hasSessionToken(),
  });
  const currentUserId = sessionQuery.data?.user.userId ?? null;

  // Find the user's personal wallet that's a pending voter on the linked
  // Squads proposal (if any), and the wallet they can execute with. The
  // shared hook owns the wallet selection + approve/execute mutations so
  // PaymentDetail and OrganizationProposalDetail stay in lockstep.
  const linkedProposal: DecimalProposal | null = orderQuery.data?.squadsPaymentProposal ?? null;
  const proposalActions = useSquadsProposalActions({
    organizationId,
    proposal: linkedProposal,
    ownPersonalWallets,
    currentUserId,
    invalidationKeys: [
      ['payment-order', organizationId, paymentOrderId],
      ['payment-orders', organizationId],
      ['organization-proposals', organizationId],
    ],
    toast: { success, error: toastError, info },
  });
  const proposalPendingVoterWalletId = proposalActions.pendingVoterWallet?.userWalletId ?? null;
  const proposalExecuteWalletId = proposalActions.executeWallet?.userWalletId ?? null;

  useAutoRetryProposalVerification({
    organizationId,
    proposal: linkedProposal,
    invalidationKeys: [
      ['payment-order', organizationId, paymentOrderId],
      ['organization-proposals', organizationId],
    ],
  });
  const verificationStatus = readSettlementVerificationStatus(linkedProposal);

  // When the proposal-creation tx is signed and submitted but the backend
  // confirm-submission times out (RPC slow / not yet visible), we keep the
  // signature + decimalProposalId in state so the user can retry just the
  // confirm step instead of recreating the proposal.
  const [pendingProposalConfirmation, setPendingProposalConfirmation] = useState<
    { decimalProposalId: string; signature: string } | null
  >(null);

  const createProposalMutation = useMutation({
    mutationFn: async () => {
      const order = orderQuery.data;
      if (!order?.sourceTreasuryWallet?.treasuryWalletId) {
        throw new Error('No source treasury wallet on this payment order.');
      }
      if (!proposalCreatorWalletId) {
        throw new Error('Pick a personal wallet to initiate the proposal.');
      }
      const intent = await api.createSquadsPaymentProposalIntent(
        organizationId!,
        order.sourceTreasuryWallet.treasuryWalletId,
        {
          paymentOrderId: order.paymentOrderId,
          creatorPersonalWalletId: proposalCreatorWalletId,
        },
      );
      const signature = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: proposalCreatorWalletId,
      });
      const decimalProposalId = intent.decimalProposal?.decimalProposalId ?? null;
      if (!decimalProposalId) {
        throw new Error('Backend did not return a decimal proposal id.');
      }
      // Track sig + id BEFORE attempting confirm so retry-confirm has them
      // available regardless of how confirm fails.
      setPendingProposalConfirmation({ decimalProposalId, signature });
      await api.confirmProposalSubmission(organizationId!, decimalProposalId, { signature });
      return { decimalProposalId, signature };
    },
    onSuccess: async (result) => {
      setPendingProposalConfirmation(null);
      success('Squads proposal created.');
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
      navigate(`/organizations/${organizationId}/proposals/${result.decimalProposalId}`);
    },
    onError: (err) => {
      // RPC confirm timed out but the tx may still be propagating — keep the
      // pending state and surface a retry banner instead of a hard error.
      if (isRetryableConfirmationError(err)) {
        info('Transaction submitted. Confirmation pending — retry in a moment.');
        return;
      }
      // Real failure — clear pending state so the create CTA returns.
      setPendingProposalConfirmation(null);
      toastError(err instanceof Error ? err.message : 'Could not create Squads proposal.');
    },
  });

  const retryProposalConfirmationMutation = useMutation({
    mutationFn: async () => {
      if (!pendingProposalConfirmation) throw new Error('No pending confirmation.');
      await api.confirmProposalSubmission(organizationId!, pendingProposalConfirmation.decimalProposalId, {
        signature: pendingProposalConfirmation.signature,
      });
      return pendingProposalConfirmation;
    },
    onSuccess: async (result) => {
      setPendingProposalConfirmation(null);
      success('Proposal confirmed.');
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
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

  if (!organizationId || !paymentOrderId) {
    return (
      <div className="page">
        <div className="empty">
          <h4>Payment unavailable</h4>
          <p>Pick a payment from the list.</p>
        </div>
      </div>
    );
  }

  if (orderQuery.isLoading) {
    return (
      <div className="page">
        <div className="detail-col">
          <div className="stack stack-16">
            <div className="skeleton" style={{ height: 80, borderRadius: 12 }} />
            <div className="skeleton" style={{ height: 60, borderRadius: 12 }} />
            <div className="skeleton" style={{ height: 120, borderRadius: 12 }} />
            <div className="skeleton" style={{ height: 280, borderRadius: 12 }} />
          </div>
        </div>
      </div>
    );
  }

  if (orderQuery.isError || !orderQuery.data) {
    return (
      <div className="page">
        <div className="detail-col">
          <div
            className="crumb"
            onClick={() => navigate(`/organizations/${organizationId}/payments`)}
            role="button"
            tabIndex={0}
          >
            <Ico.chevRight w={15} style={{ transform: 'rotate(180deg)' }} />All payments
          </div>
          <div className="empty" style={{ marginTop: 24 }}>
            <h4>Couldn't load this payment</h4>
            <p>{orderQuery.error instanceof Error ? orderQuery.error.message : 'Something went wrong.'}</p>
            <button className="btn btn-secondary" type="button" onClick={() => void orderQuery.refetch()}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const order = orderQuery.data;
  const recipientName = order.counterparty?.displayName ?? order.counterpartyWallet.label;
  const amountLabel = `${formatRawUsdcCompact(order.amountRaw)} ${assetSymbol(order.asset)}`;
  const lifecycle = buildLifecycle(order, verificationStatus);
  const variant = determineVariant(order);
  const statusTone = statusToneForPayment(order.derivedState);
  const mismatchRaw = order.metadataJson?.settlementMismatch;
  const settlementMismatch =
    mismatchRaw && typeof mismatchRaw === 'object' && !Array.isArray(mismatchRaw)
      ? (mismatchRaw as { signature?: string; source?: string; at?: string })
      : null;
  const latestExec = order.reconciliationDetail?.latestExecution ?? null;
  const submittedSig =
    latestExec?.submittedSignature ??
    order.squadsLifecycle?.executedSignature ??
    order.squadsLifecycle?.submittedSignature ??
    null;
  const sourceBadge = order.spendingLimitExecution ? 'Auto-paid' : 'Single payment';

  return (
    <div className="page">
      <div className="detail-col">
        <div
          className="crumb"
          onClick={() => navigate(`/organizations/${organizationId}/payments`)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ')
              navigate(`/organizations/${organizationId}/payments`);
          }}
        >
          <Ico.chevRight w={15} style={{ transform: 'rotate(180deg)' }} />All payments
        </div>

        <div className="stack stack-16">
          <div>
            <div className="eyebrow" style={{ marginBottom: 10 }}>PAYMENT</div>
            <div className="pagehead" style={{ paddingBottom: 16 }}>
              <div className="ph-titles">
                <h1>{recipientName}</h1>
                <p className="ph-desc">
                  {order.invoiceNumber || order.externalReference ? (
                    <>
                      {order.invoiceNumber ?? order.externalReference}
                      &nbsp;<span style={{ color: 'var(--text-faint)' }}>·</span>&nbsp;
                    </>
                  ) : null}
                  {order.memo ? (
                    <>
                      {order.memo}
                      &nbsp;<span style={{ color: 'var(--text-faint)' }}>·</span>&nbsp;
                    </>
                  ) : null}
                  Created {formatRelativeTime(order.createdAt)}
                </p>
              </div>
              <div className="ph-actions" style={{ alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending}
                  aria-busy={syncMutation.isPending}
                  title="Reconcile on-chain state"
                >
                  <Ico.download w={13} style={{ transform: 'rotate(180deg)' }} />
                  {syncMutation.isPending ? 'Syncing…' : 'Sync'}
                </button>
                <div className="head-status">
                  <Pill tone={toneToPill(statusTone) as PillTone}>
                    {displayPaymentStatus(order.derivedState)}
                  </Pill>
                  {order.spendingLimitExecution ? <SLPill /> : null}
                </div>
              </div>
            </div>
          </div>

          {settlementMismatch ? (
            <div
              role="alert"
              style={{
                margin: '0 0 16px',
                padding: '12px 14px',
                borderRadius: 8,
                border: '1px solid var(--danger)',
                background: 'var(--ax-danger-dim, rgba(185, 28, 28, 0.08))',
                color: 'var(--danger)',
                fontSize: 13,
                lineHeight: 1.5,
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
              }}
            >
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                <path d="M10 2.5 18 16H2L10 2.5Z" />
                <path d="M10 8v3" />
                <circle cx="10" cy="13.5" r="0.7" fill="currentColor" />
              </svg>
              <div>
                <strong>Settlement mismatch.</strong> The payment transaction landed on-chain but
                moved a different USDC amount than expected. Verify the on-chain transfer before
                treating this as paid.
                {settlementMismatch.signature ? (
                  <>
                    {' '}Signature{' '}
                    <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                      {`${settlementMismatch.signature.slice(0, 8)}…${settlementMismatch.signature.slice(-8)}`}
                    </code>.
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          {order.accountingSync ? (
            <div
              style={{
                margin: '0 0 16px',
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid var(--ax-border, #e5e7eb)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              {order.accountingSync.status === 'synced' ? (
                <>
                  <Pill tone="success">QuickBooks</Pill>
                  <span>
                    Synced as <strong>Bill {order.accountingSync.billId}</strong>
                    {order.accountingSync.billPaymentId ? <> · payment {order.accountingSync.billPaymentId}</> : null}.
                  </span>
                </>
              ) : order.accountingSync.status === 'error' ? (
                <>
                  <Pill tone="danger">QuickBooks</Pill>
                  <span>
                    Sync failed{order.accountingSync.error ? `: ${order.accountingSync.error}` : ''}. Retrying automatically.
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => accountingRetryMutation.mutate()}
                    disabled={accountingRetryMutation.isPending}
                  >
                    {accountingRetryMutation.isPending ? 'Retrying…' : 'Retry now'}
                  </button>
                </>
              ) : (
                <>
                  <Pill tone="warning">QuickBooks</Pill>
                  <span>Sync pending.</span>
                </>
              )}
            </div>
          ) : null}

          <Rail stages={lifecycle} />

          <ActionBar
            variant={variant}
            order={order}
            amountLabel={amountLabel}
            submittedSignature={submittedSig}
            routing={routeMutation.isPending}
            approvingReview={clearReviewMutation.isPending}
            exporting={proofMutation.isPending}
            cancelling={cancelMutation.isPending}
            onRoute={() => routeMutation.mutate()}
            onApproveReview={() => clearReviewMutation.mutate()}
            onExportProof={() => proofMutation.mutate()}
            onCancel={() => cancelMutation.mutate()}
            ownPersonalWallets={ownPersonalWallets}
            proposalCreatorWalletId={proposalCreatorWalletId}
            onSelectProposalCreator={setProposalCreatorWalletId}
            proposing={createProposalMutation.isPending}
            onCreateSquadsProposal={() => createProposalMutation.mutate()}
            pendingProposalConfirmation={pendingProposalConfirmation}
            retryingProposalConfirmation={retryProposalConfirmationMutation.isPending}
            onRetryProposalConfirmation={() => retryProposalConfirmationMutation.mutate()}
            linkedProposal={linkedProposal}
            proposalPendingVoterWalletId={proposalPendingVoterWalletId}
            proposalExecuteWalletId={proposalExecuteWalletId}
            proposalApproving={proposalActions.approving}
            proposalExecuting={proposalActions.executing}
            onApproveProposal={(signerWalletId) => proposalActions.approve(signerWalletId)}
            onExecuteProposal={(signerWalletId) => proposalActions.execute(signerWalletId)}
          />

          <PaySummary order={order} sourceBadge={sourceBadge} submittedSignature={submittedSig} />

          <ActivityAcc events={withAccountingEvent(order)} createdByEmail={order.createdByUser?.email ?? null} />
        </div>
      </div>
    </div>
  );
}

// ─── Rail (.rail) ────────────────────────────────────────────────────────
// Renders the lifecycle as a 5-node horizontal progress rail. Maps our
// internal StageState onto the design's .done / .current / amber classes.

function Rail({ stages }: { stages: LifecycleStage[] }) {
  return (
    <div className="rail">
      {stages.map((s, i) => {
        const isDone = s.state === 'complete';
        const isCurrent = s.state === 'current';
        const isBlocked = s.state === 'blocked';
        const cls = [
          'rail-stage',
          isDone ? 'done' : '',
          isCurrent ? 'current' : '',
          isBlocked ? 'amber' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div className={cls} key={s.id ?? i}>
            <div className="rs-top">
              <span className="rs-node">{isDone ? <Ico.checkSm w={12} /> : i + 1}</span>
              <span className="rs-line" />
            </div>
            <span className="rs-label">{s.label}</span>
            <span className="rs-sub">{s.sub}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── PaySummary (.pay-summary) ──────────────────────────────────────────
// Record sheet: big amount on top, From → To route, then a defs grid
// (trust / signature / invoice / due / memo). Mirrors the design's
// PaySummary 1:1.

function PaySummary({
  order,
  sourceBadge,
  submittedSignature,
}: {
  order: PaymentOrder;
  sourceBadge: string;
  submittedSignature: string | null;
}) {
  const amountWhole = formatRawUsdcCompact(order.amountRaw);
  const trustState = order.counterpartyWallet.trustState;
  const trustLabel =
    trustState === 'trusted'
      ? 'Trusted'
      : trustState.charAt(0).toUpperCase() + trustState.slice(1);
  const trustTone: PillTone =
    trustState === 'trusted'
      ? 'success'
      : trustState === 'restricted' || trustState === 'blocked'
        ? 'danger'
        : 'warning';

  const isAutoPaid = Boolean(order.spendingLimitExecution);
  const sigLabel = isAutoPaid ? 'Auto-paid' : submittedSignature ? 'Signed' : 'Not signed';
  const sigTone: PillTone = isAutoPaid || submittedSignature ? 'info' : 'neutral';

  const sourceName = order.sourceTreasuryWallet?.displayName ?? '—';
  const sourceSub = order.sourceTreasuryWallet?.address
    ? shortenAddress(order.sourceTreasuryWallet.address, 4, 4)
    : 'No source set';
  const recipientName = order.counterpartyWallet.label;
  const recipientSub = order.invoiceNumber
    ? `Invoice ${order.invoiceNumber}`
    : order.externalReference ?? shortenAddress(order.counterpartyWallet.walletAddress, 4, 4);

  return (
    <div className="pay-summary">
      <div className="ps-amount-row">
        <div>
          <div className="ps-lab">Amount</div>
          <div className="ps-amount">
            {amountWhole}
            <small>{assetSymbol(order.asset)}</small>
          </div>
        </div>
        <OriginPill>{sourceBadge}</OriginPill>
      </div>

      <div className="ps-route">
        <div className="ps-endpoint">
          <span className="pe-lab">From</span>
          <span className="pe-name">{sourceName}</span>
          <span className="pe-sub">{sourceSub}</span>
        </div>
        <Ico.arrowRight w={18} />
        <div className="ps-endpoint">
          <span className="pe-lab">To</span>
          <span className="pe-name">{recipientName}</span>
          <span className="pe-sub">{recipientSub}</span>
        </div>
      </div>

      <div className="ps-defs">
        <div className="ps-def">
          <span className="pd-lab">Trust</span>
          <span style={{ width: 'fit-content' }}>
            <Pill tone={trustTone}>{trustLabel}</Pill>
          </span>
        </div>
        <div className="ps-def">
          <span className="pd-lab">Signature</span>
          <span style={{ width: 'fit-content' }}>
            <Pill tone={sigTone}>{sigLabel}</Pill>
          </span>
        </div>
        {order.invoiceNumber || order.externalReference ? (
          <div className="ps-def">
            <span className="pd-lab">Invoice</span>
            <span className="pd-val mono">{order.invoiceNumber ?? order.externalReference}</span>
          </div>
        ) : null}
        {order.dueAt ? (
          <div className="ps-def">
            <span className="pd-lab">Due date</span>
            <span className="pd-val mono">{formatTimestamp(order.dueAt)}</span>
          </div>
        ) : null}
        {order.memo ? (
          <div className="ps-def full">
            <span className="pd-lab">Memo</span>
            <span className="pd-val" style={{ fontWeight: 400 }}>{order.memo}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── ActivityAcc (.activity-acc) ────────────────────────────────────────
// Collapsed accordion of payment events. Opens to show a vertical
// timeline. Event labels lifted from eventType strings — humanised
// inline to avoid a lookup table.

function ActivityAcc({
  events,
  createdByEmail,
}: {
  events: PaymentOrderEvent[];
  createdByEmail: string | null;
}) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(
    () =>
      [...events].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [events],
  );
  const count = sorted.length;
  return (
    <div className="activity-acc">
      <div
        className="aa-head"
        onClick={() => setOpen((o) => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        style={{ cursor: 'pointer' }}
      >
        <span className="aa-title">
          <Ico.proposals w={15} />Activity
        </span>
        <span className="aa-right">
          <span className="aa-meta">
            {count} {count === 1 ? 'event' : 'events'}
          </span>
          <span className="aa-chev" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
            <Ico.chevDown w={16} />
          </span>
        </span>
      </div>
      {open ? (
        <div className="aa-body">
          <div className="timeline" style={{ marginTop: 14 }}>
            {sorted.length === 0 ? (
              <div style={{ padding: 12, fontSize: 13, color: 'var(--text-muted)' }}>
                No recorded events yet.
              </div>
            ) : (
              sorted.map((e) => {
                const title = humanizeEventType(e.eventType);
                const actor = describeActor(e, createdByEmail);
                const time = formatRelativeTime(e.createdAt);
                return (
                  <div className="tl-event done" key={e.paymentOrderEventId}>
                    <div className="tl-rail">
                      <span className="tl-dot" />
                      <span className="tl-line" />
                    </div>
                    <div className="tl-body">
                      <span className="tl-title">{title}</span>
                      <span className="tl-meta">
                        <span className="tl-actor">{actor}</span> · {time}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function humanizeEventType(type: string): string {
  const map: Record<string, string> = {
    payment_created: 'Payment created',
    payment_reviewed: 'Reviewed',
    payment_review_cleared: 'Reviewed',
    payment_proposed: 'Proposed for approval',
    proposal_approved: 'Approved',
    proposal_executed: 'Executed',
    payment_settled: 'Settled',
    payment_cancelled: 'Cancelled',
    spending_limit_executed: 'Auto-paid by agent',
    accounting_synced: 'Synced to QuickBooks',
  };
  if (map[type]) return map[type]!;
  return type
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function describeActor(e: PaymentOrderEvent, createdByEmail: string | null): string {
  if (e.actorType === 'agent') return 'Decimal agent';
  if (e.actorType === 'user' && createdByEmail) return createdByEmail;
  if (e.actorType === 'system') return 'System';
  return e.actorType ?? 'System';
}

// ─── ActionBar (.action-bar) ────────────────────────────────────────────
// Compact horizontal action bar driven by the payment's variant. Each
// variant has its own tone (amber for needs_review, neutral for ready /
// signing, success for autopaid / settled) and an inline control set.

function ActionBarShell({
  tone,
  eyebrow,
  title,
  body,
  controls,
}: {
  tone: 'amber' | 'neutral' | 'success' | 'danger';
  eyebrow: string;
  title: React.ReactNode;
  body?: React.ReactNode;
  controls: React.ReactNode;
}) {
  return (
    <div className={`action-bar tone-${tone}`}>
      <div className="ab-text">
        <span className="ab-eyebrow">{eyebrow}</span>
        <h3 className="ab-title">{title}</h3>
        {body ? <p className="ab-body">{body}</p> : null}
      </div>
      <div className="ab-controls">{controls}</div>
    </div>
  );
}

function ChainSig({ signature }: { signature: string }) {
  const short = `${signature.slice(0, 4)}…${signature.slice(-4)}`;
  return (
    <a
      href={orbTransactionUrl(signature)}
      target="_blank"
      rel="noreferrer"
      className="chainlink"
      style={{ textDecoration: 'none' }}
    >
      <Ico.link w={14} />
      <span className="sig">{short}</span>
      <Ico.external w={13} />
    </a>
  );
}

function Approver({
  init,
  done,
  title,
  avatarUrl,
}: {
  init: string;
  done: boolean;
  title?: string;
  avatarUrl?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(avatarUrl) && !failed;
  return (
    <span
      className={`ab-appr${done ? '' : ' pending'}`}
      title={title}
      style={showImage ? { padding: 0, background: 'transparent' } : undefined}
    >
      {/* Inner span clips the photo to the chip circle; the chip itself
          must keep overflow visible so the badge can stick out the
          bottom-right per the design. */}
      {showImage ? (
        <span
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            overflow: 'hidden',
            display: 'block',
          }}
        >
          <img
            src={avatarUrl!}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </span>
      ) : (
        init
      )}
      {done ? (
        <span className="ab-badge">
          <Ico.checkSm w={9} />
        </span>
      ) : null}
    </span>
  );
}

function ActionBar(props: {
  variant: ActionVariant;
  order: PaymentOrder;
  amountLabel: string;
  submittedSignature: string | null;
  routing: boolean;
  approvingReview: boolean;
  exporting: boolean;
  cancelling: boolean;
  onRoute: () => void;
  onApproveReview: () => void;
  onExportProof: () => void;
  onCancel: () => void;
  ownPersonalWallets: UserWallet[];
  proposalCreatorWalletId: string;
  onSelectProposalCreator: (id: string) => void;
  proposing: boolean;
  onCreateSquadsProposal: () => void;
  pendingProposalConfirmation: { decimalProposalId: string; signature: string } | null;
  retryingProposalConfirmation: boolean;
  onRetryProposalConfirmation: () => void;
  linkedProposal: DecimalProposal | null;
  proposalPendingVoterWalletId: string | null;
  proposalExecuteWalletId: string | null;
  proposalApproving: boolean;
  proposalExecuting: boolean;
  onApproveProposal: (signerWalletId: string) => void;
  onExecuteProposal: (signerWalletId: string) => void;
}) {
  const {
    variant,
    order,
    amountLabel,
    submittedSignature,
    routing,
    approvingReview,
    exporting,
    onRoute,
    onApproveReview,
    onExportProof,
    ownPersonalWallets,
    proposalCreatorWalletId,
    onSelectProposalCreator,
    proposing,
    onCreateSquadsProposal,
    pendingProposalConfirmation,
    retryingProposalConfirmation,
    onRetryProposalConfirmation,
    linkedProposal,
    proposalPendingVoterWalletId,
    proposalExecuteWalletId,
    proposalApproving,
    proposalExecuting,
    onApproveProposal,
    onExecuteProposal,
  } = props;


  if (variant === 'needs_review') {
    return (
      <ActionBarShell
        tone="amber"
        eyebrow="Needs your review"
        title="Decide whether to proceed"
        body="The agent flagged this invoice — counterparty wallet isn't trusted yet."
        controls={
          <>
            <button
              type="button"
              className="btn btn-danger-ghost"
              onClick={props.onCancel}
              disabled={props.cancelling}
              aria-busy={props.cancelling}
            >
              {props.cancelling ? 'Rejecting…' : 'Reject'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onApproveReview}
              disabled={approvingReview}
              aria-busy={approvingReview}
            >
              {approvingReview ? 'Approving…' : (
                <>Approve &amp; continue<Ico.arrowRight w={14} /></>
              )}
            </button>
          </>
        }
      />
    );
  }

  if (variant === 'needs_route') {
    return (
      <ActionBarShell
        tone="neutral"
        eyebrow="Route"
        title="Ready for agent routing"
        body="Ask the Decimal agent to use an active auto-pay rule or open a Squads proposal."
        controls={
          <button
            type="button"
            className="btn btn-primary"
            onClick={onRoute}
            disabled={routing}
            aria-busy={routing}
          >
            {routing ? 'Routing…' : (
              <>Route payment<Ico.arrowRight w={14} /></>
            )}
          </button>
        }
      />
    );
  }

  if (variant === 'ready_to_propose') {
    // Agent owns proposal creation — we don't ask the user to pick a
    // signing key or hit "Send for approval" anymore. The page polls
    // every few seconds; once the agent posts the proposal the variant
    // flips to proposal_in_progress. If the agent's first attempt
    // returned a retryable confirm error, the existing pendingProposal-
    // Confirmation state lets the user retry just the confirm leg.
    if (pendingProposalConfirmation) {
      return (
        <ActionBarShell
          tone="neutral"
          eyebrow="Awaiting confirmation"
          title="Submitted on chain"
          body="Your signature is in flight. Retry confirmation in a few seconds."
          controls={
            <>
              <ChainSig signature={pendingProposalConfirmation.signature} />
              <button
                type="button"
                className="btn btn-primary"
                onClick={onRetryProposalConfirmation}
                disabled={retryingProposalConfirmation}
                aria-busy={retryingProposalConfirmation}
              >
                {retryingProposalConfirmation ? 'Retrying…' : (
                  <>Retry confirmation<Ico.arrowRight w={14} /></>
                )}
              </button>
            </>
          }
        />
      );
    }
    return (
      <ActionBarShell
        tone="neutral"
        eyebrow="Routing"
        title="Agent is creating the proposal"
        body="This refreshes automatically. The proposal will appear here once it's on chain."
        controls={<span />}
      />
    );
  }

  if (variant === 'proposal_in_progress') {
    const proposal = linkedProposal ?? order.squadsPaymentProposal;
    const status = order.squadsLifecycle?.proposalStatus ?? proposal?.status ?? 'active';
    const voting = proposal?.voting ?? null;
    const approvalCount = voting?.approvals.length ?? 0;
    const threshold = voting?.threshold ?? 0;
    const pendingCount = voting?.pendingVoters.length ?? 0;
    const isApproved = status === 'approved';
    const isExecuted = status === 'executed';
    const eyebrow = isExecuted
      ? 'Settling'
      : isApproved
        ? 'Ready to send'
        : 'Awaiting approvals';
    const title = isExecuted
      ? 'Sent on chain — verifying'
      : isApproved
        ? 'Threshold met — execute when ready'
        : `${approvalCount} of ${threshold} approved`;
    const body = isExecuted
      ? 'Verifying the transfer landed.'
      : isApproved
        ? 'A member with execute permission needs to send it.'
        : `Team members approve on their own time. ${pendingCount} pending.`;

    const approverChips = voting ? (
      <div className="ab-approvers">
        {voting.approvals.map((d) => (
          <Approver
            key={`a-${d.walletAddress}`}
            init={initialsFromMember(d.organizationMembership?.user) ?? shortenAddress(d.walletAddress, 2, 0).slice(0, 2).toUpperCase()}
            done
            title={d.organizationMembership?.user.displayName ?? d.walletAddress}
            avatarUrl={d.organizationMembership?.user.avatarUrl ?? null}
          />
        ))}
        {voting.pendingVoters.map((v) => (
          <Approver
            key={`p-${v.walletAddress}`}
            init={initialsFromMember(v.organizationMembership?.user) ?? shortenAddress(v.walletAddress, 2, 0).slice(0, 2).toUpperCase()}
            done={false}
            title={v.organizationMembership?.user.displayName ?? v.walletAddress}
            avatarUrl={v.organizationMembership?.user.avatarUrl ?? null}
          />
        ))}
      </div>
    ) : null;

    return (
      <ActionBarShell
        tone="neutral"
        eyebrow={eyebrow}
        title={title}
        body={body}
        controls={
          <>
            {approverChips}
            {proposalPendingVoterWalletId && !isApproved && !isExecuted ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onApproveProposal(proposalPendingVoterWalletId)}
                disabled={proposalApproving || proposalExecuting}
                aria-busy={proposalApproving}
              >
                {proposalApproving ? 'Approving…' : 'Approve'}
              </button>
            ) : null}
            {isApproved && proposalExecuteWalletId ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onExecuteProposal(proposalExecuteWalletId)}
                disabled={proposalApproving || proposalExecuting}
                aria-busy={proposalExecuting}
              >
                {proposalExecuting ? 'Executing…' : 'Execute payment'}
              </button>
            ) : null}
          </>
        }
      />
    );
  }

  if (variant === 'spending_limit_in_flight' || variant === 'spending_limit_settled') {
    const exec = order.spendingLimitExecution;
    const policyName = exec?.spendingLimitPolicy?.policyName ?? 'auto-pay rule';
    const execSignature = exec?.signature ?? submittedSignature;
    const isSettled = variant === 'spending_limit_settled';
    return (
      <ActionBarShell
        tone="success"
        eyebrow={isSettled ? 'Settled · auto-paid' : 'Auto-paid by agent'}
        title={
          <>
            Paid via <span className="serif" style={{ fontStyle: 'italic' }}>{policyName}</span>
          </>
        }
        body={
          isSettled
            ? 'The agent settled this payment under an active auto-pay rule. Proof packet is ready.'
            : 'Paid automatically under an active auto-pay rule — no team vote needed.'
        }
        controls={
          <>
            {execSignature ? <ChainSig signature={execSignature} /> : null}
            {isSettled ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={onExportProof}
                disabled={exporting}
                aria-busy={exporting}
              >
                <Ico.download w={15} />
                {exporting ? 'Exporting…' : 'Download proof'}
              </button>
            ) : null}
          </>
        }
      />
    );
  }

  if (variant === 'in_flight') {
    return (
      <ActionBarShell
        tone="neutral"
        eyebrow="Settling"
        title="Sent on chain — verifying"
        body="Confirming the transfer landed. This refreshes automatically."
        controls={submittedSignature ? <ChainSig signature={submittedSignature} /> : <span />}
      />
    );
  }

  if (variant === 'settled') {
    return (
      <ActionBarShell
        tone="success"
        eyebrow="Settled"
        title="Settled · proof ready"
        body="The payment landed and matched intent."
        controls={
          <>
            {submittedSignature ? <ChainSig signature={submittedSignature} /> : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={onExportProof}
              disabled={exporting}
              aria-busy={exporting}
            >
              <Ico.download w={15} />
              {exporting ? 'Exporting…' : 'Download proof'}
            </button>
          </>
        }
      />
    );
  }

  if (variant === 'exception') {
    return (
      <ActionBarShell
        tone="danger"
        eyebrow="Attention needed"
        title="Settlement didn't match expected"
        body="The observed transfer did not fully match this payment. Check the timeline for the exception detail."
        controls={<span />}
      />
    );
  }

  if (variant === 'cancelled') {
    return (
      <ActionBarShell
        tone="neutral"
        eyebrow="Cancelled"
        title="This payment was cancelled"
        body="It will not be executed. Kept here for audit."
        controls={<span />}
      />
    );
  }

  return (
    <ActionBarShell
      tone="neutral"
      eyebrow="No action"
      title="Nothing to do right now"
      body="Check back as state changes."
      controls={<span />}
    />
  );
}

function initialsFromMember(user: { displayName?: string; email?: string } | undefined): string | null {
  if (!user) return null;
  const name = user.displayName?.trim();
  if (name) {
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  if (user.email) return user.email.slice(0, 2).toUpperCase();
  return null;
}
