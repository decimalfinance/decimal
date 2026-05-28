import assert from 'node:assert/strict';
import test from 'node:test';
import {
  routePayment,
  routePaymentsBatch,
  type PaymentRoutingContext,
  type PaymentRoutingDependencies,
  type PaymentRoutingPayment,
} from '../src/payments/algorithm.js';

type TestPayment = PaymentRoutingPayment & {
  trusted: boolean;
  policyPasses: boolean;
};

type TestLimit = {
  spendingLimitPolicyId: string;
  fits: boolean;
};

type TestExecution = {
  signature: string;
};

type TestProposal = {
  decimalProposalId: string;
  fallbackCode: string;
};

type TestReview = {
  marked: true;
};

type TestDeps = PaymentRoutingDependencies<TestPayment, TestLimit, TestExecution, TestProposal, string, TestReview>;

const context: PaymentRoutingContext = {
  organizationId: 'org_1',
  paymentOrderId: 'payment_1',
  actorUserId: 'user_1',
};

test('payment router sends unsafe payments to one review gate', async () => {
  const calls: string[] = [];
  const decision = await routePayment(context, buildDeps({
    payment: { organizationId: 'org_1', paymentOrderId: 'payment_1', state: 'draft', trusted: false, policyPasses: true },
    calls,
  }));

  assert.equal(decision.status, 'needs_review');
  assert.deepEqual(calls, ['load', 'existing', 'review', 'mark_review']);
  assert.equal(decision.reasons[0]?.code, 'counterparty_wallet_not_trusted');
});

test('payment router uses spending limit when it matches and fits', async () => {
  const calls: string[] = [];
  const decision = await routePayment(context, buildDeps({
    payment: { organizationId: 'org_1', paymentOrderId: 'payment_1', state: 'draft', trusted: true, policyPasses: true },
    limit: { spendingLimitPolicyId: 'limit_1', fits: true },
    calls,
  }));

  assert.equal(decision.status, 'agent_executed');
  assert.deepEqual(calls, ['load', 'existing', 'review', 'find_limit', 'fit_limit', 'execute_limit']);
  assert.equal(decision.execution.signature, 'sig_1');
});

test('payment router creates proposal when no spending limit exists', async () => {
  const decision = await routePayment(context, buildDeps({
    payment: { organizationId: 'org_1', paymentOrderId: 'payment_1', state: 'draft', trusted: true, policyPasses: true },
    limit: null,
  }));

  assert.equal(decision.status, 'proposal_created');
  assert.equal(decision.fallback.code, 'no_spending_limit');
  assert.equal(decision.proposal.fallbackCode, 'no_spending_limit');
});

test('payment router falls back to proposal when spending limit does not fit', async () => {
  const decision = await routePayment(context, buildDeps({
    payment: { organizationId: 'org_1', paymentOrderId: 'payment_1', state: 'draft', trusted: true, policyPasses: true },
    limit: { spendingLimitPolicyId: 'limit_1', fits: false },
  }));

  assert.equal(decision.status, 'proposal_created');
  assert.equal(decision.fallback.code, 'spending_limit_does_not_fit');
  assert.equal(decision.fallback.spendingLimitReason?.code, 'amount_exceeds_limit');
});

test('payment batch router preserves order and captures per-payment failures', async () => {
  const results = await routePaymentsBatch(
    [
      { ...context, paymentOrderId: 'payment_1' },
      { ...context, paymentOrderId: 'payment_2' },
    ],
    buildDeps({
      payment: { organizationId: 'org_1', paymentOrderId: 'payment_1', state: 'draft', trusted: true, policyPasses: true },
      loadPaymentOrder: async (nextContext) => {
        if (nextContext.paymentOrderId === 'payment_2') {
          throw new Error('boom');
        }
        return {
          organizationId: nextContext.organizationId,
          paymentOrderId: nextContext.paymentOrderId,
          state: 'draft',
          trusted: true,
          policyPasses: true,
        };
      },
    }),
    { concurrency: 2 },
  );

  assert.equal(results[0]?.paymentOrderId, 'payment_1');
  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal(results[1]?.paymentOrderId, 'payment_2');
  assert.equal(results[1]?.status, 'rejected');
});

function buildDeps(input: {
  payment: TestPayment;
  limit?: TestLimit | null;
  existingRoute?: string | null;
  calls?: string[];
  loadPaymentOrder?: TestDeps['loadPaymentOrder'];
}): TestDeps {
  const calls = input.calls ?? [];
  return {
    loadPaymentOrder: async (nextContext) => {
      calls.push('load');
      if (input.loadPaymentOrder) {
        return input.loadPaymentOrder(nextContext);
      }
      return input.payment;
    },
    findExistingRoute: async () => {
      calls.push('existing');
      return input.existingRoute
        ? { status: 'exists', route: input.existingRoute }
        : { status: 'none' };
    },
    evaluateReviewGate: async (payment) => {
      calls.push('review');
      if (!payment.trusted) {
        return {
          status: 'needs_review',
          reasons: [{ code: 'counterparty_wallet_not_trusted', message: 'Counterparty wallet is not trusted.' }],
        };
      }
      if (!payment.policyPasses) {
        return {
          status: 'needs_review',
          reasons: [{ code: 'payment_policy_failed', message: 'Payment policy failed.' }],
        };
      }
      return { status: 'pass' };
    },
    markNeedsReview: async () => {
      calls.push('mark_review');
      return { marked: true };
    },
    findBestMatchingSpendingLimit: async () => {
      calls.push('find_limit');
      return input.limit ?? null;
    },
    canUseSpendingLimit: async (_payment, limit) => {
      calls.push('fit_limit');
      return limit.fits
        ? { status: 'pass' }
        : {
            status: 'does_not_fit',
            reason: { code: 'amount_exceeds_limit', message: 'Amount exceeds limit.' },
          };
    },
    executeWithSpendingLimit: async () => {
      calls.push('execute_limit');
      return { signature: 'sig_1' };
    },
    createSquadsProposal: async (_payment, _context, fallback) => {
      calls.push('create_proposal');
      return {
        decimalProposalId: 'proposal_1',
        fallbackCode: fallback?.code ?? 'unknown',
      };
    },
  };
}
