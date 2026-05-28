export type PaymentRoutingContext = {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string | null;
  runId?: string;
};

export type PaymentRoutingPayment = {
  organizationId: string;
  paymentOrderId: string;
  state: string;
};

export type PaymentReviewReason = {
  code: string;
  message: string;
  details?: unknown;
};

export type PaymentReviewDecision =
  | {
      status: 'pass';
      reasons?: never;
    }
  | {
      status: 'needs_review';
      reasons: PaymentReviewReason[];
    };

export type SpendingLimitFitDecision =
  | {
      status: 'pass';
      reason?: never;
    }
  | {
      status: 'not_applicable' | 'does_not_fit';
      reason: PaymentReviewReason;
    };

export type ExistingPaymentRoute<TExistingRoute> =
  | {
      status: 'none';
    }
  | {
      status: 'exists';
      route: TExistingRoute;
    };

export type PaymentRoutingDependencies<
  TPayment extends PaymentRoutingPayment,
  TSpendingLimit,
  TExecution,
  TProposal,
  TExistingRoute = unknown,
  TReviewResult = unknown,
> = {
  loadPaymentOrder: (context: PaymentRoutingContext) => Promise<TPayment>;
  findExistingRoute?: (
    payment: TPayment,
    context: PaymentRoutingContext,
  ) => Promise<ExistingPaymentRoute<TExistingRoute>>;
  evaluateReviewGate: (
    payment: TPayment,
    context: PaymentRoutingContext,
  ) => Promise<PaymentReviewDecision>;
  markNeedsReview: (
    payment: TPayment,
    decision: Extract<PaymentReviewDecision, { status: 'needs_review' }>,
    context: PaymentRoutingContext,
  ) => Promise<TReviewResult>;
  findBestMatchingSpendingLimit: (
    payment: TPayment,
    context: PaymentRoutingContext,
  ) => Promise<TSpendingLimit | null>;
  canUseSpendingLimit: (
    payment: TPayment,
    spendingLimit: TSpendingLimit,
    context: PaymentRoutingContext,
  ) => Promise<SpendingLimitFitDecision>;
  executeWithSpendingLimit: (
    payment: TPayment,
    spendingLimit: TSpendingLimit,
    context: PaymentRoutingContext,
  ) => Promise<TExecution>;
  createSquadsProposal: (
    payment: TPayment,
    context: PaymentRoutingContext,
    fallback?: SquadsProposalFallbackReason,
  ) => Promise<TProposal>;
};

export type SquadsProposalFallbackReason = {
  code: 'no_spending_limit' | 'spending_limit_not_applicable' | 'spending_limit_does_not_fit';
  message: string;
  spendingLimitReason?: PaymentReviewReason;
};

export type PaymentRoutingDecision<
  TPayment extends PaymentRoutingPayment,
  TSpendingLimit,
  TExecution,
  TProposal,
  TExistingRoute = unknown,
  TReviewResult = unknown,
> =
  | {
      status: 'already_routed';
      route: 'existing';
      payment: TPayment;
      existingRoute: TExistingRoute;
    }
  | {
      status: 'skipped';
      route: 'none';
      payment: TPayment;
      reason: 'cancelled' | 'settled';
    }
  | {
      status: 'needs_review';
      route: 'human_review';
      payment: TPayment;
      reasons: PaymentReviewReason[];
      reviewResult: TReviewResult;
    }
  | {
      status: 'agent_executed';
      route: 'spending_limit';
      payment: TPayment;
      spendingLimit: TSpendingLimit;
      execution: TExecution;
    }
  | {
      status: 'proposal_created';
      route: 'squads_proposal';
      payment: TPayment;
      proposal: TProposal;
      fallback: SquadsProposalFallbackReason;
    };

export type RoutePaymentsBatchOptions = {
  concurrency?: number;
};

export type RoutePaymentsBatchResult<TDecision> = {
  paymentOrderId: string;
  status: 'fulfilled';
  decision: TDecision;
} | {
  paymentOrderId: string;
  status: 'rejected';
  error: Error;
};

export async function routePayment<
  TPayment extends PaymentRoutingPayment,
  TSpendingLimit,
  TExecution,
  TProposal,
  TExistingRoute = unknown,
  TReviewResult = unknown,
>(
  context: PaymentRoutingContext,
  dependencies: PaymentRoutingDependencies<TPayment, TSpendingLimit, TExecution, TProposal, TExistingRoute, TReviewResult>,
): Promise<PaymentRoutingDecision<TPayment, TSpendingLimit, TExecution, TProposal, TExistingRoute, TReviewResult>> {
  const payment = await dependencies.loadPaymentOrder(context);

  if (payment.state === 'cancelled' || payment.state === 'settled') {
    return {
      status: 'skipped',
      route: 'none',
      payment,
      reason: payment.state,
    };
  }

  const existingRoute = dependencies.findExistingRoute
    ? await dependencies.findExistingRoute(payment, context)
    : { status: 'none' as const };
  if (existingRoute.status === 'exists') {
    return {
      status: 'already_routed',
      route: 'existing',
      payment,
      existingRoute: existingRoute.route,
    };
  }

  const reviewDecision = await dependencies.evaluateReviewGate(payment, context);
  if (reviewDecision.status === 'needs_review') {
    const reviewResult = await dependencies.markNeedsReview(payment, reviewDecision, context);
    return {
      status: 'needs_review',
      route: 'human_review',
      payment,
      reasons: reviewDecision.reasons,
      reviewResult,
    };
  }

  const spendingLimit = await dependencies.findBestMatchingSpendingLimit(payment, context);
  if (!spendingLimit) {
    const fallback = buildNoSpendingLimitFallback();
    return {
      status: 'proposal_created',
      route: 'squads_proposal',
      payment,
      proposal: await dependencies.createSquadsProposal(payment, context, fallback),
      fallback,
    };
  }

  const fit = await dependencies.canUseSpendingLimit(payment, spendingLimit, context);
  if (fit.status === 'pass') {
    return {
      status: 'agent_executed',
      route: 'spending_limit',
      payment,
      spendingLimit,
      execution: await dependencies.executeWithSpendingLimit(payment, spendingLimit, context),
    };
  }

  const fallback = buildSpendingLimitFallback(fit);
  return {
    status: 'proposal_created',
    route: 'squads_proposal',
    payment,
    proposal: await dependencies.createSquadsProposal(payment, context, fallback),
    fallback,
  };
}

export async function routePaymentsBatch<
  TPayment extends PaymentRoutingPayment,
  TSpendingLimit,
  TExecution,
  TProposal,
  TExistingRoute = unknown,
  TReviewResult = unknown,
>(
  contexts: PaymentRoutingContext[],
  dependencies: PaymentRoutingDependencies<TPayment, TSpendingLimit, TExecution, TProposal, TExistingRoute, TReviewResult>,
  options: RoutePaymentsBatchOptions = {},
): Promise<Array<RoutePaymentsBatchResult<
  PaymentRoutingDecision<TPayment, TSpendingLimit, TExecution, TProposal, TExistingRoute, TReviewResult>
>>> {
  const concurrency = normalizeConcurrency(options.concurrency ?? contexts.length);
  const results: Array<RoutePaymentsBatchResult<
    PaymentRoutingDecision<TPayment, TSpendingLimit, TExecution, TProposal, TExistingRoute, TReviewResult>
  >> = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < contexts.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const context = contexts[currentIndex]!;
      try {
        results[currentIndex] = {
          paymentOrderId: context.paymentOrderId,
          status: 'fulfilled',
          decision: await routePayment(context, dependencies),
        };
      } catch (error) {
        results[currentIndex] = {
          paymentOrderId: context.paymentOrderId,
          status: 'rejected',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, contexts.length) }, () => worker()));
  return results;
}

function buildNoSpendingLimitFallback(): SquadsProposalFallbackReason {
  return {
    code: 'no_spending_limit',
    message: 'No active spending limit matched this payment, so it must enter Squads voting.',
  };
}

function buildSpendingLimitFallback(fit: Exclude<SpendingLimitFitDecision, { status: 'pass' }>): SquadsProposalFallbackReason {
  return {
    code: fit.status === 'not_applicable' ? 'spending_limit_not_applicable' : 'spending_limit_does_not_fit',
    message: 'A spending limit was found, but this payment cannot use it safely. Routing to Squads voting.',
    spendingLimitReason: fit.reason,
  };
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.floor(value);
}
