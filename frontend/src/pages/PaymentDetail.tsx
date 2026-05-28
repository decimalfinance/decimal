import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  DecimalProposal,
  PaymentOrder,
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
import { ChainLink, DetailEntry, DetailPageSkeleton, DetailPageState, RdPageHeader, RdPrimaryCard } from '../ui-primitives';
import { LifecycleRail, type LifecycleStage, type StageState } from '../ui/LifecycleRail';
import { useToast } from '../ui/Toast';
import type { UserWallet } from '../types';

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
  return buildSquadsPaymentLifecycle({
    derivedState: s,
    settlementVerification,
    requestSub: formatRelativeTime(order.createdAt),
    settledSub: 'Matched',
  });
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
      const s = query.state.data?.derivedState;
      if (s === 'settled' || s === 'cancelled') return false;
      return 5_000;
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
        success('Approved. Agent executed the payment through a spending limit.');
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
      <DetailPageState
        title="Payment unavailable"
        body="Pick a payment from the list."
      />
    );
  }

  if (orderQuery.isLoading) {
    return <DetailPageSkeleton />;
  }

  if (orderQuery.isError || !orderQuery.data) {
    return (
      <DetailPageState
        title="Couldn't load this payment"
        body={orderQuery.error instanceof Error ? orderQuery.error.message : 'Something went wrong.'}
        back={
          <Link to={`/organizations/${organizationId}/payments`} className="rd-back">
            <span className="rd-back-arrow">←</span>
            <span>Payments</span>
          </Link>
        }
        action={
          <button className="rd-btn rd-btn-secondary" type="button" onClick={() => void orderQuery.refetch()}>
            Try again
          </button>
        }
      />
    );
  }

  const order = orderQuery.data;
  const recipientName = order.counterparty?.displayName ?? order.counterpartyWallet.label;
  const amountLabel = `${formatRawUsdcCompact(order.amountRaw)} ${assetSymbol(order.asset)}`;
  const lifecycle = buildLifecycle(order, verificationStatus);
  const variant = determineVariant(order);
  const statusTone = statusToneForPayment(order.derivedState);
  const latestExec = order.reconciliationDetail?.latestExecution ?? null;
  const match = order.reconciliationDetail?.match ?? null;

  return (
    <main className="page-frame" data-layout="rd">
      <div className="rd-page-container">
        <Link to={`/organizations/${organizationId}/payments`} className="rd-back">
          <span className="rd-back-arrow" aria-hidden>
            ←
          </span>
          <span>Payments</span>
        </Link>

        <RdPageHeader
          eyebrow="Payment"
          title={recipientName}
          meta={
            <>
              <span className="rd-mono">{amountLabel}</span>
              <span className="rd-meta-sep">·</span>
              <ChainLink address={order.counterpartyWallet.walletAddress} prefix={4} suffix={4} />
              {order.externalReference || order.invoiceNumber ? (
                <>
                  <span className="rd-meta-sep">·</span>
                  <span className="rd-mono">{order.externalReference ?? order.invoiceNumber}</span>
                </>
              ) : null}
              <span className="rd-meta-sep">·</span>
              <span>Created {formatRelativeTime(order.createdAt)}</span>
            </>
          }
          side={
            <span className="rd-pill" data-tone={toneToPill(statusTone)}>
              <span className="rd-pill-dot" aria-hidden />
              {displayPaymentStatus(order.derivedState)}
            </span>
          }
        />

        <LifecycleRail stages={lifecycle} ariaLabel="Payment lifecycle" />

        <PrimaryAction
          variant={variant}
          order={order}
          amountLabel={amountLabel}
          submittedSignature={latestExec?.submittedSignature ?? order.squadsLifecycle?.executedSignature ?? order.squadsLifecycle?.submittedSignature ?? null}
          matchedAt={match?.matchedAt ?? null}
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
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {order.sourceTreasuryWallet.displayName ? (
                      <>
                        <span>{order.sourceTreasuryWallet.displayName}</span>
                        <span className="rd-meta-sep">·</span>
                      </>
                    ) : null}
                    <ChainLink address={order.sourceTreasuryWallet.address} prefix={4} suffix={4} />
                  </span>
                ) : (
                  <span style={{ color: 'var(--ax-text-muted)' }}>Not set</span>
                )}
              </DetailEntry>
              <DetailEntry label="To">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>{order.counterpartyWallet.label}</span>
                  <span className="rd-meta-sep">·</span>
                  <ChainLink address={order.counterpartyWallet.walletAddress} prefix={4} suffix={4} />
                </span>
              </DetailEntry>
              <DetailEntry label="Trust">
                <span
                  style={{
                    fontSize: 12,
                    color:
                      order.counterpartyWallet.trustState === 'trusted'
                        ? 'var(--ax-accent)'
                        : order.counterpartyWallet.trustState === 'restricted' || order.counterpartyWallet.trustState === 'blocked'
                          ? 'var(--ax-danger)'
                          : 'var(--ax-warning)',
                  }}
                >
                  {order.counterpartyWallet.trustState}
                </span>
              </DetailEntry>
              <DetailEntry label="Signature">
                {latestExec?.submittedSignature ? (
                  <ChainLink signature={latestExec.submittedSignature} />
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
              {latestExec?.submittedSignature ? (
                <TimelineRow
                  title="Executed on-chain"
                  meta={formatTimestamp(latestExec.submittedAt ?? latestExec.createdAt)}
                  body={<ChainLink signature={latestExec.submittedSignature} prefix={8} suffix={8} />}
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
    // Agent flagged this invoice during AP intake. The user decides whether to
    // proceed (which creates the on-chain proposal) or reject (which closes
    // the payment without any chain activity). No multisig signing yet — that
    // happens after Approve advances the payment to `ready_to_propose`.
    return (
      <RdPrimaryCard
        emphasis="action"
        eyebrow="Needs your review"
        title="Decide whether to proceed"
        body="Agent flagged this invoice. Approve to send it on chain, or reject to close it."
      >
        <div className="rd-actions">
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            onClick={onApproveReview}
            disabled={approvingReview}
            aria-busy={approvingReview}
          >
            {approvingReview ? 'Approving…' : 'Approve & continue'}
          </button>
          <button
            type="button"
            className="rd-btn rd-btn-secondary"
            onClick={props.onCancel}
            disabled={props.cancelling}
          >
            {props.cancelling ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </RdPrimaryCard>
    );
  }

  if (variant === 'needs_route') {
    return (
      <RdPrimaryCard
        emphasis="action"
        eyebrow="Route"
        title="Ready for agent routing"
        body="Ask the Decimal agent to use an active spending limit or create a Squads proposal."
      >
        <div className="rd-actions">
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            onClick={onRoute}
            disabled={routing}
            aria-busy={routing}
          >
            {routing ? 'Routing…' : 'Route payment'}
          </button>
        </div>
      </RdPrimaryCard>
    );
  }

  if (variant === 'ready_to_propose') {
    // If the create-proposal tx was signed and submitted but RPC hasn't seen
    // the signature yet, show a retry-confirmation banner instead of the
    // create form. Recreating the proposal would either land a duplicate or
    // fail backend's 409 guard — neither is what the user wants.
    if (pendingProposalConfirmation) {
      return (
        <RdPrimaryCard
          emphasis="action"
          eyebrow="Awaiting confirmation"
          title="Submitted on chain"
          body="Don't recreate — your signature is in flight. Retry confirmation in a few seconds."
        >
          <p style={{ fontSize: 12, color: 'var(--ax-text-muted)', margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'monospace' }}>sig</span>
            <ChainLink signature={pendingProposalConfirmation.signature} />
          </p>
          <div className="rd-actions">
            <button
              type="button"
              className="rd-btn rd-btn-primary"
              onClick={onRetryProposalConfirmation}
              disabled={retryingProposalConfirmation}
              aria-busy={retryingProposalConfirmation}
            >
              {retryingProposalConfirmation ? 'Retrying confirmation…' : 'Retry confirmation'}
              {!retryingProposalConfirmation ? <span className="rd-btn-arrow" aria-hidden>→</span> : null}
            </button>
          </div>
        </RdPrimaryCard>
      );
    }

    const hasPersonalWallets = ownPersonalWallets.length > 0;
    return (
      <RdPrimaryCard
        emphasis="action"
        eyebrow="Create proposal"
        title={
          <>
            <span className="rd-mono">{amountLabel}</span> ready for multisig
          </>
        }
        body="Pick the wallet that will initiate signing."
      >
        <div className="rd-primary-grid">
          <label className="rd-field">
            <span className="rd-field-label">Initiating wallet</span>
            {hasPersonalWallets ? (
              <select
                className="rd-select"
                value={proposalCreatorWalletId}
                onChange={(e) => onSelectProposalCreator(e.target.value)}
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
        <p style={{ fontSize: 12, color: 'var(--ax-text-muted)', margin: '0 0 12px' }}>
          Must be one of your personal wallets that's an on-chain Squads member with the <strong>Initiate</strong> permission. Your signature counts as the first approval.
        </p>
        <div className="rd-actions">
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            onClick={onCreateSquadsProposal}
            disabled={proposing || !hasPersonalWallets || !proposalCreatorWalletId}
            aria-busy={proposing}
          >
            {proposing ? 'Creating proposal…' : 'Create Squads proposal'}
            {!proposing ? <span className="rd-btn-arrow" aria-hidden>→</span> : null}
          </button>
        </div>
      </RdPrimaryCard>
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
        ? 'Send'
        : proposalPendingVoterWalletId
          ? 'Your turn to sign'
          : 'Signing';
    const title = isExecuted
      ? 'Sent on chain — verifying'
      : isApproved
        ? `Threshold met — ready to send`
        : `${approvalCount} of ${threshold} signed · ${pendingCount} pending`;
    return (
      <RdPrimaryCard
        emphasis={isApproved && proposalExecuteWalletId ? 'action' : undefined}
        eyebrow={eyebrow}
        title={title}
        body={
          isExecuted
            ? 'Verifying the transfer landed.'
            : isApproved
              ? 'A member with execute permission needs to send it.'
              : 'Voters sign on their own time.'
        }
      >
        {voting ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0' }}>
            {voting.approvals.map((d) => (
              <span
                key={`a-${d.walletAddress}`}
                title={d.walletAddress}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', fontSize: 12, borderRadius: 999,
                  background: 'rgba(60, 180, 110, 0.18)', color: 'rgb(120, 220, 160)',
                }}
              >
                <span aria-hidden>✓</span>
                {d.organizationMembership?.user.displayName
                  ?? d.organizationMembership?.user.email
                  ?? shortenAddress(d.walletAddress, 4, 4)}
              </span>
            ))}
            {voting.pendingVoters.map((v) => (
              <span
                key={`p-${v.walletAddress}`}
                title={v.walletAddress}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', fontSize: 12, borderRadius: 999,
                  background: 'transparent', color: 'var(--ax-text-muted)',
                  border: '1px dashed var(--ax-border)',
                }}
              >
                <span aria-hidden>○</span>
                {v.organizationMembership?.user.displayName
                  ?? v.organizationMembership?.user.email
                  ?? shortenAddress(v.walletAddress, 4, 4)}
              </span>
            ))}
          </div>
        ) : null}

        {order.squadsLifecycle?.transactionIndex || order.squadsLifecycle?.executedSignature ? (
          <p style={{ fontSize: 12, color: 'var(--ax-text-muted)', margin: '4px 0 12px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {order.squadsLifecycle.transactionIndex ? (
              <span style={{ fontFamily: 'monospace' }}>Tx index #{order.squadsLifecycle.transactionIndex}</span>
            ) : null}
            {order.squadsLifecycle.transactionIndex && order.squadsLifecycle.executedSignature ? <span>·</span> : null}
            {order.squadsLifecycle.executedSignature ? (
              <>
                <span style={{ fontFamily: 'monospace' }}>exec</span>
                <ChainLink signature={order.squadsLifecycle.executedSignature} />
              </>
            ) : null}
          </p>
        ) : null}

        <div className="rd-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {proposalPendingVoterWalletId && !isApproved && !isExecuted ? (
            <button
              type="button"
              className="rd-btn rd-btn-primary"
              onClick={() => onApproveProposal(proposalPendingVoterWalletId)}
              disabled={proposalApproving || proposalExecuting}
              aria-busy={proposalApproving}
            >
              {proposalApproving ? 'Approving…' : 'Approve proposal'}
              {!proposalApproving ? <span className="rd-btn-arrow" aria-hidden>→</span> : null}
            </button>
          ) : null}
          {isApproved && proposalExecuteWalletId ? (
            <button
              type="button"
              className="rd-btn rd-btn-primary"
              onClick={() => onExecuteProposal(proposalExecuteWalletId)}
              disabled={proposalApproving || proposalExecuting}
              aria-busy={proposalExecuting}
            >
              {proposalExecuting ? 'Executing…' : 'Execute proposal'}
              {!proposalExecuting ? <span className="rd-btn-arrow" aria-hidden>→</span> : null}
            </button>
          ) : null}
        </div>
      </RdPrimaryCard>
    );
  }

  if (variant === 'spending_limit_in_flight') {
    const exec = order.spendingLimitExecution;
    const policyName = exec?.spendingLimitPolicy?.policyName ?? 'spending limit policy';
    const execSignature = exec?.signature ?? submittedSignature;
    return (
      <RdPrimaryCard
        eyebrow="Auto-paid by agent"
        title={`Paid via ${policyName}`}
        body="The agent executed this payment directly under an active spending limit. Verifying settlement."
      >
        {execSignature ? (
          <div style={{ marginTop: 8 }}>
            <ChainLink signature={execSignature} prefix={8} suffix={8} />
          </div>
        ) : null}
      </RdPrimaryCard>
    );
  }

  if (variant === 'spending_limit_settled') {
    const exec = order.spendingLimitExecution;
    const policyName = exec?.spendingLimitPolicy?.policyName ?? 'spending limit policy';
    const execSignature = exec?.signature ?? submittedSignature;
    return (
      <RdPrimaryCard
        eyebrow="Settled · auto-paid"
        title={`Paid via ${policyName}`}
        body="The agent settled this payment under an active spending limit. Proof packet is ready."
      >
        {execSignature ? (
          <div style={{ marginBottom: 12 }}>
            <ChainLink signature={execSignature} prefix={8} suffix={8} />
          </div>
        ) : null}
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

  if (variant === 'in_flight') {
    return (
      <RdPrimaryCard
        eyebrow="Settling"
        title="Sent on chain — verifying"
        body="Confirming the transfer landed. This refreshes automatically."
      >
        {submittedSignature ? (
          <ChainLink signature={submittedSignature} prefix={8} suffix={8} />
        ) : null}
      </RdPrimaryCard>
    );
  }

  if (variant === 'settled') {
    return (
      <RdPrimaryCard
        eyebrow="Settled"
        title="Settled · proof ready"
        body="The payment landed and matched intent."
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
        title="Settlement didn't match expected"
        body="The observed transfer did not fully match this payment. Check the timeline for the exception detail."
      />
    );
  }

  if (variant === 'cancelled') {
    return (
      <RdPrimaryCard
        eyebrow="Cancelled"
        title="This payment was cancelled"
        body="It will not be executed. Kept here for audit."
      />
    );
  }

  return (
    <RdPrimaryCard
      eyebrow="No action"
      title="Nothing to do right now"
      body="Check back as state changes."
    />
  );
}
