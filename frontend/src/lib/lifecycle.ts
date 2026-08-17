import type { LifecycleStage } from '../ui/LifecycleRail';
import type { SettlementVerificationStatus } from './settlement';

// Forward-progress state sets — the union of payment-order and payment-run
// derivedState values that mean "this stage has been reached." Members not
// in a given product will simply never appear, so it's safe to list them
// all here.
const PROPOSED_DONE_STATES = new Set([
  'proposed',
  'approved',
  'executed',
  'proposal_executed',
  'submitted_onchain',
  'partially_settled',
  'settled',
  'closed',
  'exception',
]);

const APPROVAL_DONE_STATES = new Set([
  'approved',
  'executed',
  'proposal_executed',
  'submitted_onchain',
  'partially_settled',
  'settled',
  'closed',
  'exception',
]);

const EXECUTION_DONE_STATES = new Set([
  'execution_recorded',
  'executed',
  'proposal_executed',
  'submitted_onchain',
  'partially_settled',
  'settled',
  'closed',
  'exception',
]);

const READY_TO_PROPOSE_STATES = new Set(['ready', 'ready_for_execution']);
// Matched against either a payment-order state or a transfer-request state, so
// both vocabularies live here. `draft` is a bill being prepared and `submitted`
// is one handed to approval — both sit before any proposal exists.
const PRE_PROPOSAL_STATES = new Set(['draft', 'submitted', 'pending_approval']);
// A bill in draft is covered above; what is left here is the agent's own flag.
const AGENT_FLAGGED_STATES = new Set(['agent_flagged']);

/**
 * 5-stage payment lifecycle. Shared by single-payment detail and payment-run
 * detail so the rail labels stay in lockstep.
 *
 * The five stages map to user-facing language, not backend mechanics:
 *
 *   Received   — agent extracted the payment from an invoice
 *   Submitted  — a person finished the draft and sent it onward (or policy
 *                did). Proposal creation lives inside this stage; the user
 *                doesn't care that there's a separate "propose" step.
 *   Signing    — multisig members are signing
 *   Sent       — executed on chain
 *   Settled    — reconciliation confirms the transfer landed
 *
 * The Settled stage stitches together backend-derived `derivedState` with
 * frontend-visible RPC settlement verification status: a `'pending'`
 * settlement renders as "Verifying…", `'mismatch'` flips the stage to
 * blocked, and `'settled'` is the success terminal.
 */
export function buildSquadsPaymentLifecycle(args: {
  derivedState: string;
  settlementVerification: SettlementVerificationStatus | null;
  requestSub: string;
  settledSub: string;
  /**
   * If true, when the product is in a non-mismatch blocked state (e.g.
   * `exception`/`partially_settled` on a payment run) the Settled sub-text
   * surfaces "Needs attention" instead of falling through to the regular
   * verifying state. Defaults to false.
   */
  showBlockedDraftState?: boolean;
  /**
   * The Squads proposal has reached its approval threshold (ready to execute) while the
   * product state is still `proposed`. Threshold-met lives on the proposal, not the
   * product state, so pass it in to advance the lifecycle from Signing to Send.
   */
  approvalThresholdMet?: boolean;
}): LifecycleStage[] {
  const s = args.derivedState;
  const settlementVerification = args.settlementVerification;
  const verifyMismatch = settlementVerification === 'mismatch';
  const settled = s === 'settled' || s === 'closed';
  const cancelled = s === 'cancelled';
  const blocked =
    s === 'exception' || s === 'partially_settled' || verifyMismatch;

  const proposedDone = PROPOSED_DONE_STATES.has(s);
  const executionDone = EXECUTION_DONE_STATES.has(s);
  // A threshold-met proposal is still in `proposed` state, so the signing step is
  // "done" by the proposal's approval, not by the product state — fold that in so the
  // stepper shows Signing complete + Send current the moment the threshold is met.
  const approvalDone = APPROVAL_DONE_STATES.has(s) || (proposedDone && !executionDone && args.approvalThresholdMet === true);

  const agentFlagged = AGENT_FLAGGED_STATES.has(s);
  const isReadyToPropose = READY_TO_PROPOSE_STATES.has(s);
  const draftStillPending = agentFlagged || PRE_PROPOSAL_STATES.has(s);

  const verifyingNow = executionDone && !settled && settlementVerification === 'pending';
  const showBlockedDraft = !verifyMismatch && blocked && Boolean(args.showBlockedDraftState);

  return [
    {
      id: 'received',
      label: 'Received',
      sub: args.requestSub,
      state: 'complete',
    },
    {
      id: 'submitted',
      label: proposedDone || isReadyToPropose ? 'Submitted' : agentFlagged ? 'Draft' : 'Preparing',
      sub: cancelled
        ? 'Cancelled'
        : proposedDone
          ? 'Approved'
          : isReadyToPropose
            ? 'Ready to sign'
            : agentFlagged
              ? 'Needs your eyes'
              : draftStillPending
                ? 'Auto-checking'
                : 'Pending',
      state: cancelled
        ? 'blocked'
        : proposedDone || isReadyToPropose
          ? 'complete'
          : agentFlagged || draftStillPending
            ? 'current'
            : 'pending',
    },
    {
      id: 'signing',
      label: approvalDone ? 'Signed' : 'Signing',
      sub: approvalDone
        ? 'Threshold met'
        : proposedDone
          ? 'Awaiting signatures'
          : 'Pending',
      state: cancelled || blocked
        ? 'blocked'
        : approvalDone
          ? 'complete'
          : proposedDone
            ? 'current'
            : 'pending',
    },
    {
      id: 'sent',
      label: executionDone ? 'Sent' : 'Send',
      sub: showBlockedDraft
        ? 'Blocked'
        : executionDone
          ? 'On chain'
          : approvalDone
            ? 'Ready'
            : 'Pending',
      state: showBlockedDraft
        ? 'blocked'
        : executionDone
          ? 'complete'
          : approvalDone
            ? 'current'
            : 'pending',
    },
    {
      id: 'settled',
      label: verifyMismatch ? 'Mismatch' : settled ? 'Settled' : 'Settle',
      sub: verifyMismatch
        ? 'Amounts did not match'
        : showBlockedDraft
          ? 'Needs attention'
          : settled
            ? args.settledSub
            : verifyingNow
              ? 'Verifying…'
              : executionDone
                ? 'Pending'
                : 'Pending',
      state: verifyMismatch || showBlockedDraft
        ? 'blocked'
        : settled
          ? 'complete'
          : executionDone
            ? 'current'
            : 'pending',
    },
  ];
}
