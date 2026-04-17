import { prisma } from './prisma.js';

export type WorkspaceAuditEntityType =
  | 'payment_order'
  | 'transfer_request'
  | 'approval'
  | 'execution'
  | 'exception'
  | 'export';

type AuditItem = {
  auditId: string;
  workspaceId: string;
  entityType: WorkspaceAuditEntityType;
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

export async function listWorkspaceAuditLog(args: {
  workspaceId: string;
  limit?: number;
  entityType?: WorkspaceAuditEntityType;
}) {
  const limit = args.limit ?? 100;
  const [
    paymentOrderEvents,
    transferRequestEvents,
    approvalDecisions,
    executionRecords,
    exceptionNotes,
    exportJobs,
  ] = await Promise.all([
    !args.entityType || args.entityType === 'payment_order'
      ? prisma.paymentOrderEvent.findMany({
          where: { workspaceId: args.workspaceId },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
      : [],
    !args.entityType || args.entityType === 'transfer_request'
      ? prisma.transferRequestEvent.findMany({
          where: { workspaceId: args.workspaceId },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
      : [],
    !args.entityType || args.entityType === 'approval'
      ? prisma.approvalDecision.findMany({
          where: { workspaceId: args.workspaceId },
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
          where: { workspaceId: args.workspaceId },
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
    !args.entityType || args.entityType === 'exception'
      ? prisma.exceptionNote.findMany({
          where: { workspaceId: args.workspaceId },
          include: {
            authorUser: {
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
    !args.entityType || args.entityType === 'export'
      ? prisma.exportJob.findMany({
          where: { workspaceId: args.workspaceId },
          include: {
            requestedByUser: {
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
      workspaceId: event.workspaceId,
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
      workspaceId: event.workspaceId,
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
      workspaceId: decision.workspaceId,
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
      workspaceId: record.workspaceId,
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
    ...exceptionNotes.map((note) => ({
      auditId: `exception_note:${note.exceptionNoteId}`,
      workspaceId: note.workspaceId,
      entityType: 'exception' as const,
      entityId: note.exceptionId,
      eventType: 'exception_note_created',
      actorType: note.authorUserId ? 'user' : 'system',
      actorId: note.authorUserId,
      actorUser: note.authorUser,
      beforeState: null,
      afterState: null,
      linkedSignature: null,
      payloadJson: {
        body: note.body,
      },
      createdAt: note.createdAt,
    })),
    ...exportJobs.map((job) => ({
      auditId: `export_job:${job.exportJobId}`,
      workspaceId: job.workspaceId,
      entityType: 'export' as const,
      entityId: job.exportJobId,
      eventType: `export_${job.exportKind}`,
      actorType: job.requestedByUserId ? 'user' : 'system',
      actorId: job.requestedByUserId,
      actorUser: job.requestedByUser,
      beforeState: null,
      afterState: job.status,
      linkedSignature: null,
      payloadJson: {
        exportKind: job.exportKind,
        format: job.format,
        rowCount: job.rowCount,
        filterJson: job.filterJson,
        completedAt: job.completedAt,
      },
      createdAt: job.createdAt,
    })),
  ];

  return {
    servedAt: new Date().toISOString(),
    workspaceId: args.workspaceId,
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
