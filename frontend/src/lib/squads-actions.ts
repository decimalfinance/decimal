import { useMemo } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type { DecimalProposal, UserWallet } from '../types';
import { signAndSubmitIntent } from './squads-pipeline';
import { isRetryableConfirmationError } from './settlement';

type ToastFn = (message: string) => void;

export type SquadsProposalActionTarget = {
  pendingVoterWallet: UserWallet | null;
  executeWallet: UserWallet | null;
  approve: (signerWalletId: string) => void;
  reject: (signerWalletId: string) => void;
  execute: (signerWalletId: string) => void;
  // True while *any* of the three mutations is running.
  busy: boolean;
  // Per-action busy flags for fine-grained UI states (button labels, etc.).
  approving: boolean;
  rejecting: boolean;
  executing: boolean;
};

export type SquadsProposalActionsArgs = {
  organizationId: string | undefined;
  proposal: DecimalProposal | null | undefined;
  ownPersonalWallets: UserWallet[];
  currentUserId: string | null;
  invalidationKeys: ReadonlyArray<QueryKey>;
  toast: {
    success: ToastFn;
    error: ToastFn;
    info: ToastFn;
  };
  // For config-transaction proposals, callers may want a Squads member sync
  // after execution lands. Defaults to true on OrganizationProposalDetail
  // and false elsewhere — payment-detail surfaces don't show config
  // proposals. Caller-controlled to keep the hook agnostic.
  syncTreasuryMembersOnConfigExecute?: boolean;
};

/**
 * Shared mutations + voter selection for Squads proposal actions
 * (approve / reject / execute). Used by OrganizationProposalDetail (full
 * action card) and PaymentDetail (inline buttons inside the payment
 * primary-action card). Both consume identical chain semantics — only the
 * surrounding UI differs, so we expose primitives instead of a component.
 *
 * Notes:
 *   - `pendingVoterWallet` is the caller's *own* personal wallet that's
 *     listed as a pending voter on this proposal. Null when the user can't
 *     vote (already voted, not a member, proposal closed, etc.).
 *   - `executeWallet` is similarly the caller's own wallet that has the
 *     execute permission for this proposal.
 *   - `execute()` calls confirm-execution after signing. Retryable
 *     "verification pending" errors are routed to an info toast; the
 *     backend stores the signature regardless, so the verification
 *     auto-retry effect on the page picks up from there.
 */
export function useSquadsProposalActions(args: SquadsProposalActionsArgs): SquadsProposalActionTarget {
  const queryClient = useQueryClient();
  const { proposal, ownPersonalWallets, currentUserId, organizationId, toast } = args;
  const syncMembersOnConfigExecute = args.syncTreasuryMembersOnConfigExecute ?? false;

  const pendingVoterWallet = useMemo<UserWallet | null>(() => {
    if (!proposal?.voting) return null;
    if (!currentUserId) return null;
    const ownAddresses = new Set(ownPersonalWallets.map((w) => w.walletAddress));
    const match = proposal.voting.pendingVoters.find(
      (v) => v.personalWallet?.userId === currentUserId && ownAddresses.has(v.walletAddress),
    );
    if (!match) return null;
    return ownPersonalWallets.find((w) => w.walletAddress === match.walletAddress) ?? null;
  }, [proposal, ownPersonalWallets, currentUserId]);

  const executeWallet = useMemo<UserWallet | null>(() => {
    if (!proposal?.voting) return null;
    const executable = new Set(proposal.voting.canExecuteWalletAddresses);
    return ownPersonalWallets.find((w) => executable.has(w.walletAddress)) ?? null;
  }, [proposal, ownPersonalWallets]);

  async function invalidateAll() {
    for (const key of args.invalidationKeys) {
      await queryClient.invalidateQueries({ queryKey: key });
    }
  }

  const approveMutation = useMutation({
    mutationFn: async (signerWalletId: string) => {
      if (!proposal) throw new Error('No proposal.');
      const intent = await api.createProposalApprovalIntent(
        organizationId!,
        proposal.decimalProposalId,
        { memberPersonalWalletId: signerWalletId },
      );
      return signAndSubmitIntent({ intent, signerPersonalWalletId: signerWalletId });
    },
    onSuccess: async () => {
      toast.success('Approval submitted.');
      await invalidateAll();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError || err instanceof Error ? err.message : 'Approve failed.');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (signerWalletId: string) => {
      if (!proposal) throw new Error('No proposal.');
      const intent = await api.createProposalRejectIntent(
        organizationId!,
        proposal.decimalProposalId,
        { memberPersonalWalletId: signerWalletId },
      );
      return signAndSubmitIntent({ intent, signerPersonalWalletId: signerWalletId });
    },
    onSuccess: async () => {
      toast.success('Rejection submitted.');
      await invalidateAll();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError || err instanceof Error ? err.message : 'Reject failed.');
    },
  });

  const executeMutation = useMutation({
    mutationFn: async (signerWalletId: string) => {
      if (!proposal) throw new Error('No proposal.');
      const intent = await api.createProposalExecuteIntent(
        organizationId!,
        proposal.decimalProposalId,
        { memberPersonalWalletId: signerWalletId },
      );
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: signerWalletId,
      });
      await api.confirmProposalExecution(organizationId!, proposal.decimalProposalId, { signature: sig });
      if (
        syncMembersOnConfigExecute
        && proposal.proposalType === 'config_transaction'
        && proposal.treasuryWalletId
      ) {
        try {
          await api.syncSquadsTreasuryMembers(organizationId!, proposal.treasuryWalletId);
        } catch {
          // sync is best-effort — surfacing this to the user adds noise
        }
      }
      return sig;
    },
    onSuccess: async () => {
      toast.success('Proposal executed.');
      await invalidateAll();
    },
    onError: async (err) => {
      if (isRetryableConfirmationError(err)) {
        toast.info('Execution submitted. Verification pending — will retry automatically.');
        await invalidateAll();
        return;
      }
      toast.error(err instanceof ApiError || err instanceof Error ? err.message : 'Execute failed.');
    },
  });

  return {
    pendingVoterWallet,
    executeWallet,
    approve: (signerWalletId: string) => approveMutation.mutate(signerWalletId),
    reject: (signerWalletId: string) => rejectMutation.mutate(signerWalletId),
    execute: (signerWalletId: string) => executeMutation.mutate(signerWalletId),
    busy: approveMutation.isPending || rejectMutation.isPending || executeMutation.isPending,
    approving: approveMutation.isPending,
    rejecting: rejectMutation.isPending,
    executing: executeMutation.isPending,
  };
}
