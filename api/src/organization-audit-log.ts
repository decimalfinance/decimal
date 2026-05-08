import { prisma } from './prisma.js';

export type OrganizationAuditEntityType =
  | 'payment_order'
  | 'transfer_request'
  | 'approval'
  | 'execution';

type AuditItem = {
  auditId: string;
  organizationId: string;
  entityType: OrganizationAuditEntityType;
  entityId: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  actorUser: { userId: string; email: string; displayName: string } | null;
  beforeState: string | null;
  afterState: string | null;
  linkedSignature: string | null;
  payloadJson: unknown;
  createdAt: Date;
};

export async function listOrganizationAuditLog(args: {
  organizationId: string;
  limit?: number;
  entityType?: OrganizationAuditEntityType;
}) {
  const limit = args.limit ?? 100;
  const [
    paymentOrderEvents,
    transferRequestEvents,
    approvalDecisions,
    executionRecords,
  ] = await Promise.all([
    !args.entityType || args.entityType === 'payment_order'
      ? prisma.paymentOrderEvent.findMany({
          where: { organizationId: args.organizationId },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
      : [],
    !args.entityType || args.entityType === 'transfer_request'
      ? prisma.transferRequestEvent.findMany({
          where: { organizationId: args.organizationId },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
      : [],
    !args.entityType || args.entityType === 'approval'
      ? prisma.approvalDecision.findMany({
          where: { organizationId: args.organizationId },
          include: {
            actorUser: {
              select: {
                userId: true,
                email: true,
                displayName: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
      : [],
    !args.entityType || args.entityType === 'execution'
      ? prisma.executionRecord.findMany({
          where: { organizationId: args.organizationId },
          include: {
            executorUser: {
              select: {
                userId: true,
                email: true,
                displayName: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
      : [],
  ]);

  const items: AuditItem[] = [
    ...paymentOrderEvents.map((event) => ({
      auditId: `payment_order_event:${event.paymentOrderEventId}`,
      organizationId: event.organizationId,
      entityType: 'payment_order' as const,
      entityId: event.paymentOrderId,
      eventType: event.eventType,
      actorType: event.actorType,
      actorId: event.actorId,
      actorUser: null,
      beforeState: event.beforeState,
      afterState: event.afterState,
      linkedSignature: event.linkedSignature,
      payloadJson: {
        ...asRecord(event.payloadJson),
        linkedTransferRequestId: event.linkedTransferRequestId,
        linkedExecutionRecordId: event.linkedExecutionRecordId,
      },
      createdAt: event.createdAt,
    })),
    ...transferRequestEvents.map((event) => ({
      auditId: `transfer_request_event:${event.transferRequestEventId}`,
      organizationId: event.organizationId,
      entityType: 'transfer_request' as const,
      entityId: event.transferRequestId,
      eventType: event.eventType,
      actorType: event.actorType,
      actorId: event.actorId,
      actorUser: null,
      beforeState: event.beforeState,
      afterState: event.afterState,
      linkedSignature: event.linkedSignature,
      payloadJson: {
        ...asRecord(event.payloadJson),
        eventSource: event.eventSource,
        linkedPaymentId: event.linkedPaymentId,
        linkedTransferIds: event.linkedTransferIds,
      },
      createdAt: event.createdAt,
    })),
    ...approvalDecisions.map((decision) => ({
      auditId: `approval_decision:${decision.approvalDecisionId}`,
      organizationId: decision.organizationId,
      entityType: 'approval' as const,
      entityId: decision.transferRequestId,
      eventType: `approval_${decision.action}`,
      actorType: decision.actorType,
      actorId: decision.actorUserId,
      actorUser: decision.actorUser,
      beforeState: null,
      afterState: decision.action,
      linkedSignature: null,
      payloadJson: {
        comment: decision.comment,
        approvalPolicyId: decision.approvalPolicyId,
        payloadJson: decision.payloadJson,
      },
      createdAt: decision.createdAt,
    })),
    ...executionRecords.map((record) => ({
      auditId: `execution_record:${record.executionRecordId}`,
      organizationId: record.organizationId,
      entityType: 'execution' as const,
      entityId: record.transferRequestId,
      eventType: `execution_${record.state}`,
      actorType: record.executorUserId ? 'user' : 'system',
      actorId: record.executorUserId,
      actorUser: record.executorUser,
      beforeState: null,
      afterState: record.state,
      linkedSignature: record.submittedSignature,
      payloadJson: {
        executionRecordId: record.executionRecordId,
        executionSource: record.executionSource,
        submittedAt: record.submittedAt,
        metadataJson: record.metadataJson,
      },
      createdAt: record.createdAt,
    })),
  ];

  return {
    servedAt: new Date().toISOString(),
    organizationId: args.organizationId,
    items: items
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit),
  };
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
