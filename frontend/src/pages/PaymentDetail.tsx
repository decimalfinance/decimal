import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  AuthenticatedSession,
  DecimalProposal,
  PaymentExecutionPacket,
  PaymentOrder,
  TreasuryWallet,
} from '../types';
import {
  assetSymbol,
  discoverSolanaWallets,
  downloadJson,
  formatRawUsdcCompact,
  formatRelativeTime,
  formatTimestamp,
  orbTransactionUrl,
  shortenAddress,
  signAndSubmitPreparedPayment,
  orbAccountUrl,
  subscribeSolanaWallets,
  walletLabel,
  type BrowserWalletOption,
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
import { DetailEntry, DetailPageSkeleton, DetailPageState, RdPageHeader, RdPrimaryCard } from '../ui-primitives';
import { LifecycleRail, type LifecycleStage, type StageState } from '../ui/LifecycleRail';
import { SettlementBanner } from '../ui/SettlementBanner';
import { useToast } from '../ui/Toast';
import type { UserWallet } from '../types';

type ActionVariant =
  | 'needs_submit'
  | 'ready_to_sign'
  | 'ready_to_propose'
  | 'proposal_in_progress'
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
  const blocked = s === 'exception' || s === 'partially_settled' || settlementVerification === 'mismatch';
  const settled = s === 'settled' || s === 'closed';
  const cancelled = s === 'cancelled';
  const squads = order.productLifecycle?.source === 'squads_v4';

  const executionDone = ['execution_recorded', 'executed', 'proposal_executed', 'partially_settled', 'settled', 'closed', 'exception'].includes(s);
  const proofDone = settled;

  const verifyingNow = executionDone && !settled && settlementVerification === 'pending';
  const verifyMismatch = settlementVerification === 'mismatch';

  if (squads) {
    return buildSquadsPaymentLifecycle({
      derivedState: s,
      settlementVerification,
      requestSub: formatRelativeTime(order.createdAt),
      settledSub: 'Matched',
    });
  }

  const approveDone = !['draft', 'pending_approval', 'cancelled'].includes(s);

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
      label: verifyMismatch ? 'Mismatch' : settled ? 'Settled' : 'Settle',
      sub: verifyMismatch
        ? 'Settlement deltas did not match'
        : blocked
          ? 'Needs review'
          : settled
            ? 'Matched'
            : verifyingNow
              ? 'Verifying on RPC…'
              : executionDone
                ? 'Verification pending'
                : 'Pending',
      state: verifyMismatch ? 'blocked' : blocked ? 'blocked' : settled ? 'complete' : executionDone ? 'current' : 'pending',
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
  const s = order.productLifecycle?.productState ?? order.derivedState;
  if (s === 'draft') return 'needs_submit';
  if (s === 'ready' || s === 'ready_for_execution') {
    // Squads-sourced payments need a multisig proposal, not a direct sign.
    return order.sourceTreasuryWallet?.source === 'squads_v4' && order.canCreateSquadsPaymentProposal !== false
      ? 'ready_to_propose'
      : 'ready_to_sign';
  }
  if (s === 'proposed' || s === 'approved' || s === 'proposal_prepared' || s === 'proposal_submitted' || s === 'proposal_approved') return 'proposal_in_progress';
  if (s === 'executed' || s === 'proposal_executed' || s === 'execution_recorded') return 'in_flight';
  if (s === 'settled' || s === 'closed') return 'settled';
  if (s === 'exception' || s === 'partially_settled') return 'exception';
  if (s === 'cancelled') return 'cancelled';
  return 'idle';
}

export function PaymentDetailPage() {
  const { organizationId, paymentOrderId } = useParams<{ organizationId: string; paymentOrderId: string }>();
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
    queryKey: ['payment-order', organizationId, paymentOrderId] as const,
    queryFn: () => api.getPaymentOrderDetail(organizationId!, paymentOrderId!),
    enabled: Boolean(organizationId && paymentOrderId),
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      const s = query.state.data?.derivedState;
      if (s === 'settled' || s === 'closed' || s === 'cancelled') return false;
      return 5_000;
    },
  });

  const addressesQuery = useQuery({
    queryKey: ['addresses', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
  });

  const sourceAddresses = addressesQuery.data?.items ?? [];
  const effectiveSourceAddressId =
    selectedSourceAddressId
    || orderQuery.data?.sourceTreasuryWalletId
    || sourceAddresses[0]?.treasuryWalletId
    || '';

  const submitMutation = useMutation({
    mutationFn: () => api.submitPaymentOrder(organizationId!, paymentOrderId!),
    onSuccess: async () => {
      success('Submitted for approval.');
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not submit.'),
  });

  const signMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveSourceAddressId) throw new Error('Select a source wallet before signing.');
      const sourceAddressRow = sourceAddresses.find((r) => r.treasuryWalletId === effectiveSourceAddressId);
      if (!sourceAddressRow?.address) throw new Error('Source wallet is still loading.');
      let packet = prepared;
      if (!packet || packet.signerWallet !== sourceAddressRow.address) {
        const preparation = await api.preparePaymentOrderExecution(organizationId!, paymentOrderId!, {
          sourceTreasuryWalletId: effectiveSourceAddressId,
        });
        packet = preparation.executionPacket;
        setPrepared(packet);
      }
      const signature = await signAndSubmitPreparedPayment(packet!, selectedWalletId);
      await api.attachPaymentOrderSignature(organizationId!, paymentOrderId!, {
        submittedSignature: signature,
        submittedAt: new Date().toISOString(),
      });
      return signature;
    },
    onSuccess: async (signature) => {
      success(`Signed · ${shortenAddress(signature, 8, 8)}`);
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
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
  const recipientName = order.counterparty?.displayName ?? order.destination.label;
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
          sourceAddresses={sourceAddresses}
          effectiveSourceAddressId={effectiveSourceAddressId}
          onSelectSource={setSelectedSourceAddressId}
          wallets={wallets}
          selectedWalletId={selectedWalletId}
          onSelectWallet={setSelectedWalletId}
          submitting={submitMutation.isPending}
          signing={signMutation.isPending}
          exporting={proofMutation.isPending}
          cancelling={cancelMutation.isPending}
          onSubmit={() => submitMutation.mutate()}
          onSign={() => signMutation.mutate()}
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
  signing: boolean;
  exporting: boolean;
  cancelling: boolean;
  onSubmit: () => void;
  onSign: () => void;
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
    sourceAddresses,
    effectiveSourceAddressId,
    onSelectSource,
    wallets,
    selectedWalletId,
    onSelectWallet,
    submitting,
    signing,
    exporting,
    onSubmit,
    onSign,
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

  if (variant === 'needs_submit') {
    return (
      <RdPrimaryCard
        emphasis="action"
        eyebrow="Next step · Submit"
        title="Ready to submit"
        body="Submit this payment to advance it to execution. The Squads multisig flow handles the on-chain approval."
      >
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
          eyebrow="Awaiting · On-chain confirmation"
          title="Transaction submitted — confirmation pending"
          body="Your signature went through and the proposal transaction was submitted. Solana RPC hasn't reported it confirmed yet. Retry confirmation in a few seconds; do not recreate the proposal — it may already be on chain."
        >
          <p style={{ fontSize: 12, color: 'var(--ax-text-muted)', margin: '0 0 12px', fontFamily: 'monospace' }}>
            sig {shortenAddress(pendingProposalConfirmation.signature, 6, 6)}
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
        eyebrow="Next step · Squads proposal"
        title={
          <>
            <span className="rd-mono">{amountLabel}</span> ready for multisig
          </>
        }
        body="The source treasury is a Squads multisig. Create a payment proposal that other signers can approve before the vault releases funds."
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
      ? 'Executed · Verify settlement'
      : isApproved
        ? 'Next step · Execute proposal'
        : proposalPendingVoterWalletId
          ? 'Next step · Your approval'
          : 'Next step · Awaiting voters';
    const title = isExecuted
      ? 'Proposal executed — settlement verification pending'
      : isApproved
        ? `Threshold met (${approvalCount} of ${threshold}) — ready to execute`
        : `${approvalCount} of ${threshold} approvals · ${pendingCount} awaiting`;
    const detailHref = proposal
      ? `/organizations/${order.organizationId}/proposals/${proposal.decimalProposalId}`
      : `/organizations/${order.organizationId}/proposals`;

    return (
      <RdPrimaryCard
        emphasis={isApproved && proposalExecuteWalletId ? 'action' : undefined}
        eyebrow={eyebrow}
        title={title}
        body={
          isExecuted
            ? 'The on-chain execution landed. Decimal marks this payment settled after RPC verifies the expected USDC destination delta.'
            : isApproved
              ? 'A Squads member with execute permission needs to submit the execute transaction.'
              : 'Each voter signs independently — no shared blockhash, no rush.'
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
          <p style={{ fontSize: 12, color: 'var(--ax-text-muted)', margin: '4px 0 12px', fontFamily: 'monospace' }}>
            {order.squadsLifecycle.transactionIndex ? `Tx index #${order.squadsLifecycle.transactionIndex}` : null}
            {order.squadsLifecycle.transactionIndex && order.squadsLifecycle.executedSignature ? ' · ' : null}
            {order.squadsLifecycle.executedSignature ? `exec ${shortenAddress(order.squadsLifecycle.executedSignature, 6, 6)}` : null}
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
          <Link className="rd-btn rd-btn-secondary" to={detailHref}>
            Open proposal
            <span className="rd-btn-arrow" aria-hidden>→</span>
          </Link>
        </div>
      </RdPrimaryCard>
    );
  }

  if (variant === 'ready_to_sign') {
    const hasWallets = wallets.length > 0;
    return (
      <RdPrimaryCard
        emphasis="action"
        eyebrow="Next step · Sign and execute"
        title={
          <>
            <span className="rd-mono">{amountLabel}</span> ready to sign
          </>
        }
        body="One signature submits this payment on-chain."
      >
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
      </RdPrimaryCard>
    );
  }

  if (variant === 'in_flight') {
    return (
      <RdPrimaryCard
        eyebrow="Executed · Verify settlement"
        title="Signed, watching on-chain match"
        body="The worker is reconstructing USDC transfers and matching this signature to the expected settlement."
      >
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
      </RdPrimaryCard>
    );
  }

  if (variant === 'settled') {
    return (
      <RdPrimaryCard
        eyebrow="Complete · Settled"
        title="Matched on-chain · proof ready"
        body="This payment was requested, approved, signed, observed, and matched against intent."
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
