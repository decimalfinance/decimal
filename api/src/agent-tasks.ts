import { listApprovalInbox, listWorkspaceExceptions } from './reconciliation.js';
import { listPaymentOrders } from './payment-orders.js';

export async function listAgentTasks(args: {
  workspaceId: string;
  limit?: number;
}) {
  const limit = args.limit ?? 50;
  const [approvalInbox, paymentOrders, exceptions] = await Promise.all([
    listApprovalInbox({
      workspaceId: args.workspaceId,
      limit: Math.min(limit, 50),
      statuses: ['pending_approval', 'escalated'],
    }),
    listPaymentOrders(args.workspaceId, { limit: Math.min(limit, 100) }),
    listWorkspaceExceptions({
      workspaceId: args.workspaceId,
      limit: Math.min(limit, 50),
      status: 'open',
    }),
  ]);

  const tasks = [
    ...approvalInbox.items.map((item) => ({
      taskId: `approval:${item.transferRequestId}`,
      kind: 'approval_review',
      priority: item.status === 'escalated' ? 'high' : 'medium',
      title: `Review ${formatUsdc(item.amountRaw)} USDC request`,
      status: item.status,
      resource: {
        type: 'transfer_request',
        id: item.transferRequestId,
        href: `/workspaces/${args.workspaceId}/transfer-requests/${item.transferRequestId}`,
      },
      recommendedAction: item.status === 'escalated' ? 'approve_or_reject_escalated_request' : 'approve_or_escalate_request',
      availableActions: [
        {
          id: 'approve',
          method: 'POST',
          href: `/workspaces/${args.workspaceId}/transfer-requests/${item.transferRequestId}/approval-decisions`,
          body: { action: 'approve', comment: 'Approved by operator agent.' },
        },
        {
          id: 'reject',
          method: 'POST',
          href: `/workspaces/${args.workspaceId}/transfer-requests/${item.transferRequestId}/approval-decisions`,
          body: { action: 'reject', comment: 'Rejected by operator agent.' },
        },
      ],
      context: {
        amountRaw: item.amountRaw,
        destination: item.destination?.label ?? item.destinationWorkspaceAddress?.displayName ?? null,
        counterparty: item.destination?.counterparty?.displayName ?? null,
        requestedAt: item.requestedAt,
      },
    })),
    ...paymentOrders.items
      .filter((order) => ['approved', 'ready_for_execution', 'execution_recorded', 'partially_settled', 'exception'].includes(order.derivedState))
      .map((order) => {
        const isExecutionReady = order.derivedState === 'approved' || order.derivedState === 'ready_for_execution';
        const isExecutionRecorded = order.derivedState === 'execution_recorded';
        return {
          taskId: `payment_order:${order.paymentOrderId}:${order.derivedState}`,
          kind: isExecutionReady
            ? 'prepare_execution'
            : isExecutionRecorded
              ? 'watch_settlement'
              : 'reconciliation_review',
          priority: order.derivedState === 'exception' ? 'high' : order.derivedState === 'partially_settled' ? 'medium' : 'normal',
          title: `${order.destination.label} ${formatUsdc(order.amountRaw)} USDC`,
          status: order.derivedState,
          resource: {
            type: 'payment_order',
            id: order.paymentOrderId,
            href: `/workspaces/${args.workspaceId}/payment-orders/${order.paymentOrderId}`,
          },
          recommendedAction: isExecutionReady
            ? 'prepare_execution_packet'
            : isExecutionRecorded
              ? 'wait_for_observed_settlement_or_attach_signature'
              : 'inspect_reconciliation_detail',
          availableActions: buildPaymentOrderActions(args.workspaceId, order.paymentOrderId, order.derivedState),
          context: {
            amountRaw: order.amountRaw,
            sourceWallet: order.sourceWorkspaceAddress?.displayName ?? order.sourceWorkspaceAddress?.address ?? null,
            destination: order.destination.label,
            payee: order.payee?.name ?? null,
            externalReference: order.externalReference ?? order.invoiceNumber ?? null,
            dueAt: order.dueAt ?? null,
            transferRequestId: order.transferRequestId,
          },
        };
      }),
    ...exceptions.map((exception) => ({
      taskId: `exception:${exception.exceptionId}`,
      kind: 'exception_review',
      priority: exception.severity === 'critical' || exception.severity === 'error' ? 'high' : 'medium',
      title: `${exception.reasonCode} on ${exception.transferRequestId ?? exception.signature ?? exception.exceptionId}`,
      status: exception.status,
      resource: {
        type: 'exception',
        id: exception.exceptionId,
        href: `/workspaces/${args.workspaceId}/exceptions/${exception.exceptionId}`,
      },
      recommendedAction: 'review_exception_and_apply_resolution',
      availableActions: [
        {
          id: 'mark_reviewed',
          method: 'POST',
          href: `/workspaces/${args.workspaceId}/exceptions/${exception.exceptionId}/actions`,
          body: { action: 'reviewed' },
        },
        {
          id: 'dismiss',
          method: 'POST',
          href: `/workspaces/${args.workspaceId}/exceptions/${exception.exceptionId}/actions`,
          body: { action: 'dismissed' },
        },
      ],
      context: {
        reasonCode: exception.reasonCode,
        severity: exception.severity,
        transferRequestId: exception.transferRequestId,
        signature: exception.signature,
        explanation: exception.explanation,
      },
    })),
  ];

  return {
    servedAt: new Date().toISOString(),
    workspaceId: args.workspaceId,
    items: tasks.slice(0, limit),
  };
}

function buildPaymentOrderActions(workspaceId: string, paymentOrderId: string, state: string) {
  if (state === 'approved' || state === 'ready_for_execution') {
    return [
      {
        id: 'prepare_execution',
        method: 'POST',
        href: `/workspaces/${workspaceId}/payment-orders/${paymentOrderId}/prepare-execution`,
        body: {},
      },
    ];
  }

  if (state === 'execution_recorded') {
    return [
      {
        id: 'attach_signature',
        method: 'POST',
        href: `/workspaces/${workspaceId}/payment-orders/${paymentOrderId}/attach-signature`,
        body: { submittedSignature: '<solana_signature>' },
      },
      {
        id: 'proof',
        method: 'GET',
        href: `/workspaces/${workspaceId}/payment-orders/${paymentOrderId}/proof`,
      },
    ];
  }

  return [
    {
      id: 'inspect',
      method: 'GET',
      href: `/workspaces/${workspaceId}/payment-orders/${paymentOrderId}`,
    },
  ];
}

function formatUsdc(amountRaw: string) {
  const raw = BigInt(amountRaw);
  const whole = raw / 1_000_000n;
  const fractional = (raw % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fractional ? `${whole}.${fractional}` : whole.toString();
}
