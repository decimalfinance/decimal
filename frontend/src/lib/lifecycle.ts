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

/**
 * Build the Squads-source 5-stage payment lifecycle (Requested · Propose ·
 * Approve · Execute · Verify). Used by both single-payment detail and
 * payment-run detail pages so the rail labels stay in lockstep.
 *
 * The Verify stage stitches together backend-derived `derivedState` with
 * frontend-visible RPC settlement verification status: a `'pending'`
 * settlement renders as "Verifying on RPC…", `'mismatch'` flips the stage
 * to a blocked alarm, and `'settled'` is the success terminal.
 */
export function buildSquadsPaymentLifecycle(args: {
  derivedState: string;
  settlementVerification: SettlementVerificationStatus | null;
  requestSub: string;
  settledSub: string;
  /**
   * If true, when the product is in a non-mismatch blocked state (e.g.
   * `exception`/`partially_settled` on a payment run) the Verify sub-text
   * surfaces "Needs review" instead of falling through to the regular
   * pending/verifying states. Defaults to false.
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

  const isReadyToPropose = READY_TO_PROPOSE_STATES.has(s);
  const stillNeedsDecimalApproval = PRE_PROPOSAL_STATES.has(s);

  const verifyingNow = executionDone && !settled && settlementVerification === 'pending';
  const showBlockedReview = !verifyMismatch && blocked && Boolean(args.showBlockedReviewState);

  return [
    {
      id: 'request',
      label: 'Requested',
      sub: args.requestSub,
      state: 'complete',
    },
    {
      id: 'proposal',
      label: proposedDone ? 'Proposed' : 'Propose',
      sub: cancelled
        ? 'Cancelled'
        : proposedDone
          ? 'On-chain'
          : isReadyToPropose
            ? 'Ready'
            : stillNeedsDecimalApproval
              ? 'Pending approval'
              : 'Pending',
      state: cancelled
        ? 'blocked'
        : proposedDone
          ? 'complete'
          : isReadyToPropose
            ? 'current'
            : 'pending',
    },
    {
      id: 'approval',
      label: approvalDone ? 'Approved' : 'Approve',
      sub: approvalDone
        ? 'Threshold met'
        : proposedDone
          ? 'Voting'
          : 'Pending proposal',
      state: cancelled || blocked
        ? 'blocked'
        : approvalDone
          ? 'complete'
          : proposedDone
            ? 'current'
            : 'pending',
    },
    {
      id: 'execution',
      label: executionDone ? 'Executed' : 'Execute',
      sub: showBlockedReview
        ? 'Blocked'
        : executionDone
          ? 'On-chain'
          : approvalDone
            ? 'Ready'
            : 'Pending approval',
      state: showBlockedReview
        ? 'blocked'
        : executionDone
          ? 'complete'
          : approvalDone
            ? 'current'
            : 'pending',
    },
    {
      id: 'settlement',
      label: verifyMismatch ? 'Mismatch' : settled ? 'Settled' : 'Verify',
      sub: verifyMismatch
        ? 'Settlement deltas did not match'
        : showBlockedReview
          ? 'Needs review'
          : settled
            ? args.settledSub
            : verifyingNow
              ? 'Verifying on RPC…'
              : executionDone
                ? 'Verification pending'
                : 'Pending execution',
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
