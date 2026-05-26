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
const PRE_PROPOSAL_STATES = new Set(['draft', 'pending_approval']);
const AGENT_FLAGGED_STATES = new Set(['needs_review', 'agent_flagged']);

/**
 * 5-stage payment lifecycle. Shared by single-payment detail and payment-run
 * detail so the rail labels stay in lockstep.
 *
 * The five stages map to user-facing language, not backend mechanics:
 *
 *   Received   — agent extracted the payment from an invoice
 *   Reviewed   — human cleared it (or policy auto-cleared it). Proposal
 *                creation lives inside this stage; the user doesn't care
 *                that there's a separate "propose" step.
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
   * surfaces "Needs review" instead of falling through to the regular
   * verifying state. Defaults to false.
   */
  showBlockedReviewState?: boolean;
}): LifecycleStage[] {
  const s = args.derivedState;
  const settlementVerification = args.settlementVerification;
  const verifyMismatch = settlementVerification === 'mismatch';
  const settled = s === 'settled' || s === 'closed';
  const cancelled = s === 'cancelled';
  const blocked =
    s === 'exception' || s === 'partially_settled' || verifyMismatch;

  const proposedDone = PROPOSED_DONE_STATES.has(s);
  const approvalDone = APPROVAL_DONE_STATES.has(s);
  const executionDone = EXECUTION_DONE_STATES.has(s);

  const agentFlagged = AGENT_FLAGGED_STATES.has(s);
  const isReadyToPropose = READY_TO_PROPOSE_STATES.has(s);
  const reviewStillPending = agentFlagged || PRE_PROPOSAL_STATES.has(s);

  const verifyingNow = executionDone && !settled && settlementVerification === 'pending';
  const showBlockedReview = !verifyMismatch && blocked && Boolean(args.showBlockedReviewState);

  return [
    {
      id: 'received',
      label: 'Received',
      sub: args.requestSub,
      state: 'complete',
    },
    {
      id: 'reviewed',
      label: proposedDone || isReadyToPropose ? 'Reviewed' : agentFlagged ? 'Review' : 'Reviewing',
      sub: cancelled
        ? 'Cancelled'
        : proposedDone
          ? 'Approved'
          : isReadyToPropose
            ? 'Ready to sign'
            : agentFlagged
              ? 'Needs your eyes'
              : reviewStillPending
                ? 'Auto-checking'
                : 'Pending',
      state: cancelled
        ? 'blocked'
        : proposedDone || isReadyToPropose
          ? 'complete'
          : agentFlagged || reviewStillPending
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
      sub: showBlockedReview
        ? 'Blocked'
        : executionDone
          ? 'On chain'
          : approvalDone
            ? 'Ready'
            : 'Pending',
      state: showBlockedReview
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
        : showBlockedReview
          ? 'Needs review'
          : settled
            ? args.settledSub
            : verifyingNow
              ? 'Verifying…'
              : executionDone
                ? 'Pending'
                : 'Pending',
      state: verifyMismatch || showBlockedReview
        ? 'blocked'
        : settled
          ? 'complete'
          : executionDone
            ? 'current'
            : 'pending',
    },
  ];
}
