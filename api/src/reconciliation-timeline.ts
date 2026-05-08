import type { TransferRequestEvent, TransferRequestNote, User } from '@prisma/client';

type UserRef = Pick<User, 'userId' | 'email' | 'displayName'>;

export function parseTransferRequestEvent(event: TransferRequestEvent) {
  const linkedTransferIds = Array.isArray(event.linkedTransferIds)
    ? event.linkedTransferIds.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    ...event,
    linkedTransferIds,
  };
}

export function serializeTransferRequestEvent(event: ReturnType<typeof parseTransferRequestEvent>) {
  return {
    transferRequestEventId: event.transferRequestEventId,
    transferRequestId: event.transferRequestId,
    organizationId: event.organizationId,
    eventType: event.eventType,
    actorType: event.actorType,
    actorId: event.actorId,
    eventSource: event.eventSource,
    beforeState: event.beforeState,
    afterState: event.afterState,
    linkedSignature: event.linkedSignature,
    linkedPaymentId: event.linkedPaymentId,
    linkedTransferIds: event.linkedTransferIds,
    payloadJson: event.payloadJson,
    createdAt: event.createdAt,
  };
}

export function serializeTransferRequestNote(
  note: TransferRequestNote & {
    authorUser: UserRef | null;
  },
) {
  return {
    transferRequestNoteId: note.transferRequestNoteId,
    transferRequestId: note.transferRequestId,
    organizationId: note.organizationId,
    body: note.body,
    createdAt: note.createdAt,
    authorUser: serializeUserRef(note.authorUser),
  };
}

type TimelineApprovalDecision = {
  createdAt: Date | string;
  action: string;
  comment: string | null;
  actorUser: ReturnType<typeof serializeUserRef>;
  payloadJson: unknown;
};

type TimelineExecutionRecord = {
  updatedAt: Date | string;
  state: string;
  executionSource: string;
  submittedSignature: string | null;
  executorUser: ReturnType<typeof serializeUserRef>;
};

type TimelineObservedTransaction = {
  createdAt: Date | string;
  signature: string;
  slot: number;
  status: string;
};

type TimelineMatch = {
  matchedAt: Date | string | null;
  updatedAt: Date | string;
  matchStatus: string;
  explanation: string | null;
  signature: string | null;
  observedTransferId: string | null;
};

type TimelineException = {
  updatedAt: Date | string;
  exceptionId: string;
  reasonCode: string;
  severity: string;
  status: string;
  explanation: string;
  signature: string | null;
  observedTransferId: string | null;
};

export function buildTimeline(args: {
  events: ReturnType<typeof parseTransferRequestEvent>[];
  notes: ReturnType<typeof serializeTransferRequestNote>[];
  approvalDecisions: TimelineApprovalDecision[];
  executionRecords: TimelineExecutionRecord[];
  observedExecutionTransaction: TimelineObservedTransaction | null;
  match: TimelineMatch | null;
  exceptions: TimelineException[];
}) {
  const items = [
    ...args.events.map((event) => ({
      timelineType: 'request_event' as const,
      createdAt: event.createdAt,
      eventType: event.eventType,
      actorType: event.actorType,
      actorId: event.actorId,
      eventSource: event.eventSource,
      beforeState: event.beforeState,
      afterState: event.afterState,
      linkedSignature: event.linkedSignature,
      linkedPaymentId: event.linkedPaymentId,
      linkedTransferIds: event.linkedTransferIds,
      payloadJson: event.payloadJson,
    })),
    ...args.notes.map((note) => ({
      timelineType: 'request_note' as const,
      createdAt: note.createdAt,
      body: note.body,
      authorUser: note.authorUser,
    })),
    ...args.approvalDecisions.map((decision) => ({
      timelineType: 'approval_decision' as const,
      createdAt: decision.createdAt,
      action: decision.action,
      comment: decision.comment,
      actorUser: decision.actorUser,
      payloadJson: decision.payloadJson,
    })),
    ...args.executionRecords.map((record) => ({
      timelineType: 'execution_record' as const,
      createdAt: record.updatedAt,
      state: record.state,
      executionSource: record.executionSource,
      submittedSignature: record.submittedSignature,
      executorUser: record.executorUser,
    })),
    ...(args.observedExecutionTransaction
      ? [
          {
            timelineType: 'observed_execution' as const,
            createdAt: args.observedExecutionTransaction.createdAt,
            signature: args.observedExecutionTransaction.signature,
            slot: args.observedExecutionTransaction.slot,
            status: args.observedExecutionTransaction.status,
          },
        ]
      : []),
    ...(args.match
      ? [
          {
            timelineType: 'match_result' as const,
            createdAt: args.match.matchedAt ?? args.match.updatedAt,
            matchStatus: args.match.matchStatus,
            explanation: args.match.explanation,
            linkedSignature: args.match.signature,
            linkedTransferIds: args.match.observedTransferId ? [args.match.observedTransferId] : [],
          },
        ]
      : []),
    ...args.exceptions.map((exception) => ({
      timelineType: 'exception' as const,
      createdAt: exception.updatedAt,
      exceptionId: exception.exceptionId,
      reasonCode: exception.reasonCode,
      severity: exception.severity,
      status: exception.status,
      explanation: exception.explanation,
      linkedSignature: exception.signature,
      linkedTransferIds: exception.observedTransferId ? [exception.observedTransferId] : [],
    })),
  ];

  return items.sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime();
    const rightTime = new Date(right.createdAt).getTime();
    return leftTime - rightTime;
  });
}

function serializeUserRef(user: UserRef | null | undefined) {
  return user
    ? {
        userId: user.userId,
        email: user.email,
        displayName: user.displayName,
      }
    : null;
}
