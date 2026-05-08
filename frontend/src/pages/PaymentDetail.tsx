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
import { signAndSubmitIntent } from '../lib/squads-pipeline';
import { readSettlementVerificationStatus } from '../lib/settlement';
import { useToast } from '../ui/Toast';
import type { UserWallet } from '../types';

type StageState = 'complete' | 'current' | 'pending' | 'blocked';

type LifecycleStage = {
  id: 'request' | 'proposal' | 'approval' | 'execution' | 'settlement' | 'proof';
  label: string;
  sub: string;
  state: StageState;
};

type ActionVariant =
  | 'needs_submit'
  | 'needs_approval'
  | 'ready_to_sign'
  | 'ready_to_propose'
  | 'proposal_in_progress'
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

function buildLifecycle(
  order: PaymentOrder,
  settlementVerification: ReturnType<typeof readSettlementVerificationStatus>,
): LifecycleStage[] {
  const s = order.productLifecycle?.productState ?? order.derivedState;
  const blocked = s === 'exception' || s === 'partially_settled' || settlementVerification === 'mismatch';
  const settled = s === 'settled' || s === 'closed';
  const cancelled = s === 'cancelled';
  const squads = order.productLifecycle?.source === 'squads_v4';

  const readyDone = s !== 'draft' && s !== 'cancelled';
  const proposedDone = ['proposed', 'approved', 'executed', 'partially_settled', 'settled', 'closed', 'exception'].includes(s);
  const approvalDone = ['approved', 'executed', 'partially_settled', 'settled', 'closed', 'exception'].includes(s);
  const executionDone = ['execution_recorded', 'executed', 'proposal_executed', 'partially_settled', 'settled', 'closed', 'exception'].includes(s);
  const proofDone = settled;

  const verifyingNow = executionDone && !settled && settlementVerification === 'pending';
  const verifyMismatch = settlementVerification === 'mismatch';

  if (squads) {
    return [
      {
        id: 'request',
        label: 'Requested',
        sub: formatRelativeTime(order.createdAt),
        state: 'complete',
      },
      {
        id: 'proposal',
        label: proposedDone ? 'Proposed' : 'Propose',
        sub: cancelled ? 'Cancelled' : proposedDone ? 'On-chain' : readyDone ? 'Ready' : 'Not ready',
        state: cancelled ? 'blocked' : proposedDone ? 'complete' : readyDone ? 'current' : 'pending',
      },
      {
        id: 'approval',
        label: approvalDone ? 'Approved' : 'Approve',
        sub: approvalDone ? 'Threshold met' : proposedDone ? 'Voting' : 'Pending proposal',
        state: cancelled || blocked ? 'blocked' : approvalDone ? 'complete' : proposedDone ? 'current' : 'pending',
      },
      {
        id: 'execution',
        label: executionDone ? 'Executed' : 'Execute',
        sub: executionDone ? 'On-chain' : approvalDone ? 'Ready' : 'Pending approval',
        state: blocked && !verifyMismatch ? 'blocked' : executionDone ? 'complete' : approvalDone ? 'current' : 'pending',
      },
      {
        id: 'settlement',
        label: verifyMismatch ? 'Mismatch' : settled ? 'Settled' : 'Verify',
        sub: verifyMismatch
          ? 'Settlement deltas did not match'
          : settled
            ? 'Matched'
            : verifyingNow
              ? 'Verifying on RPC…'
              : executionDone
                ? 'Verification pending'
                : 'Pending execution',
        state: verifyMismatch
          ? 'blocked'
          : settled
            ? 'complete'
            : executionDone
              ? 'current'
              : 'pending',
      },
    ];
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
  if (s === 'pending_approval') return 'needs_approval';
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

// Detects the backend's retryable confirmation errors:
//   - "Transaction signature is not confirmed yet." (verifyRpcSignatureConfirmed)
//   - "Execution transaction was confirmed, but USDC settlement could not be
//      verified from RPC yet." (verifySquadsProposalSettlement, transient)
// Both cases mean the on-chain side may already have happened — the user
// should stay on a retry banner rather than recreate the proposal.
function isUnconfirmedSignatureError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 400) return false;
  return /(not confirmed yet|could not be verified from RPC yet)/i.test(err.message);
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

  const approveMutation = useMutation({
    mutationFn: () => {
      const transferRequestId = orderQuery.data?.transferRequestId;
      if (!transferRequestId) throw new Error('Approval request not ready yet — try again in a moment.');
      return api.createApprovalDecision(organizationId!, transferRequestId, { action: 'approve' });
    },
    onSuccess: async () => {
      success('Approved. Ready to sign.');
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['organization-summary', organizationId] });
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
  // Squads proposal (if any), and the wallet they can execute with.
  const linkedProposal: DecimalProposal | null = orderQuery.data?.squadsPaymentProposal ?? null;
  const proposalPendingVoterWalletId = useMemo(() => {
    if (!linkedProposal?.voting || !currentUserId) return null;
    const ownAddresses = new Set(ownPersonalWallets.map((w) => w.walletAddress));
    const match = linkedProposal.voting.pendingVoters.find(
      (v) => v.personalWallet?.userId === currentUserId && ownAddresses.has(v.walletAddress),
    );
    if (!match) return null;
    return ownPersonalWallets.find((w) => w.walletAddress === match.walletAddress)?.userWalletId ?? null;
  }, [linkedProposal, ownPersonalWallets, currentUserId]);

  const proposalExecuteWalletId = useMemo(() => {
    if (!linkedProposal?.voting) return null;
    const executable = new Set(linkedProposal.voting.canExecuteWalletAddresses);
    return ownPersonalWallets.find((w) => executable.has(w.walletAddress))?.userWalletId ?? null;
  }, [linkedProposal, ownPersonalWallets]);

  const proposalApproveMutation = useMutation({
    mutationFn: async (signerWalletId: string) => {
      if (!linkedProposal) throw new Error('No linked proposal.');
      const intent = await api.createProposalApprovalIntent(
        organizationId!,
        linkedProposal.decimalProposalId,
        { memberPersonalWalletId: signerWalletId },
      );
      return signAndSubmitIntent({ intent, signerPersonalWalletId: signerWalletId });
    },
    onSuccess: async () => {
      success('Approval submitted.');
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Approve failed.');
    },
  });

  const proposalExecuteMutation = useMutation({
    mutationFn: async (signerWalletId: string) => {
      if (!linkedProposal) throw new Error('No linked proposal.');
      const intent = await api.createProposalExecuteIntent(
        organizationId!,
        linkedProposal.decimalProposalId,
        { memberPersonalWalletId: signerWalletId },
      );
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: signerWalletId,
      });
      // confirm-execution may throw a retryable 400 ("not confirmed yet" or
      // "could not be verified from RPC yet") — surface that to the user as
      // a "verification pending" notice rather than swallowing. The backend
      // stores the signature on the proposal regardless, so the auto-retry
      // effect below will re-run verification once RPC catches up.
      await api.confirmProposalExecution(organizationId!, linkedProposal.decimalProposalId, { signature: sig });
      return sig;
    },
    onSuccess: async () => {
      success('Proposal executed.');
      await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
      await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
      await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
    },
    onError: async (err) => {
      if (isUnconfirmedSignatureError(err)) {
        info('Execution submitted. Verification pending — will retry automatically.');
        // Refetch so the proposal's executedSignature shows up and the
        // pending-verification effect can take over.
        await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
        await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
        return;
      }
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Execute failed.');
    },
  });

  // Auto-retry settlement verification while the proposal is executed but
  // the backend hasn't yet been able to verify USDC settlement (RPC lag on
  // getParsedTransaction). confirm-execution is idempotent for the same
  // signature: it only re-runs verification and upgrades downstream state if
  // verification now passes.
  const verificationStatus = readSettlementVerificationStatus(linkedProposal);
  useEffect(() => {
    if (!organizationId) return;
    if (!linkedProposal?.decimalProposalId) return;
    if (!linkedProposal.executedSignature) return;
    if (verificationStatus !== 'pending') return;
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      if (cancelled) return;
      try {
        await api.confirmProposalExecution(organizationId, linkedProposal.decimalProposalId, {
          signature: linkedProposal.executedSignature!,
        });
        await queryClient.invalidateQueries({ queryKey: ['payment-order', organizationId, paymentOrderId] });
        await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
      } catch {
        // Stay on pending; the next render schedules another retry.
      }
    }, 6_000);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [
    organizationId,
    paymentOrderId,
    linkedProposal?.decimalProposalId,
    linkedProposal?.executedSignature,
    verificationStatus,
    queryClient,
  ]);

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
      if (isUnconfirmedSignatureError(err)) {
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
      if (isUnconfirmedSignatureError(err)) {
        info('Still pending. Try again in a few seconds.');
        return;
      }
      toastError(err instanceof Error ? err.message : 'Confirmation failed.');
    },
  });

  if (!organizationId || !paymentOrderId) {
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
          <Link to={`/organizations/${organizationId}/payments`} className="rd-back">
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
  const lifecycle = buildLifecycle(order, verificationStatus);
  const variant = determineVariant(order);
  const statusTone = statusToneForPayment(order.derivedState);
  const latestExec = order.reconciliationDetail?.latestExecution ?? null;
  const match = order.reconciliationDetail?.match ?? null;
  const approvalDecisions = order.reconciliationDetail?.approvalDecisions ?? [];

  return (
    <main className="page-frame" data-layout="rd">
      <div className="rd-page-container">
        <Link to={`/organizations/${organizationId}/payments`} className="rd-back">
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
          submittedSignature={latestExec?.submittedSignature ?? order.squadsLifecycle?.executedSignature ?? order.squadsLifecycle?.submittedSignature ?? null}
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
          proposalApproving={proposalApproveMutation.isPending}
          proposalExecuting={proposalExecuteMutation.isPending}
          onApproveProposal={(signerWalletId) => proposalApproveMutation.mutate(signerWalletId)}
          onExecuteProposal={(signerWalletId) => proposalExecuteMutation.mutate(signerWalletId)}
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
    approving,
    signing,
    exporting,
    onSubmit,
    onApprove,
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

  if (variant === 'ready_to_propose') {
    // If the create-proposal tx was signed and submitted but RPC hasn't seen
    // the signature yet, show a retry-confirmation banner instead of the
    // create form. Recreating the proposal would either land a duplicate or
    // fail backend's 409 guard — neither is what the user wants.
    if (pendingProposalConfirmation) {
      return (
        <div className="rd-primary" data-emphasis="action">
          <p className="rd-primary-eyebrow">Awaiting · On-chain confirmation</p>
          <h2 className="rd-primary-title">Transaction submitted — confirmation pending</h2>
          <p className="rd-primary-body">
            Your signature went through and the proposal transaction was submitted. Solana RPC hasn't reported it confirmed yet. Retry confirmation in a few seconds; do not recreate the proposal — it may already be on chain.
          </p>
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
        </div>
      );
    }

    const hasPersonalWallets = ownPersonalWallets.length > 0;
    return (
      <div className="rd-primary" data-emphasis="action">
        <p className="rd-primary-eyebrow">Next step · Squads proposal</p>
        <h2 className="rd-primary-title">
          <span className="rd-mono">{amountLabel}</span> ready for multisig
        </h2>
        <p className="rd-primary-body">
          The source treasury is a Squads multisig. Create a payment proposal that other signers can approve before the vault releases funds.
        </p>
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
      </div>
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
      <div className="rd-primary" data-emphasis={isApproved && proposalExecuteWalletId ? 'action' : undefined}>
        <p className="rd-primary-eyebrow">{eyebrow}</p>
        <h2 className="rd-primary-title">{title}</h2>
        <p className="rd-primary-body">
          {isExecuted
            ? 'The on-chain execution landed. Decimal marks this payment settled after RPC verifies the expected USDC destination delta.'
            : isApproved
              ? 'A Squads member with execute permission needs to submit the execute transaction.'
              : 'Each voter signs independently — no shared blockhash, no rush.'}
        </p>

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
        <p className="rd-primary-eyebrow">Executed · Verify settlement</p>
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
