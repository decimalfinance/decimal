import type {
  Counterparty,
  Destination,
  ExecutionRecord,
  Prisma,
  TransferRequest,
  TransferRequestEvent,
  TransferRequestNote,
  User,
  TreasuryWallet,
} from '@prisma/client';
import { serializeExecutionRecord } from './execution-records.js';
import { prisma } from '../infra/prisma.js';
import {
  deriveApprovalState,
  deriveExecutionState,
  deriveRequestDisplayState,
  getAvailableOperatorTransitions,
  type RequestDisplayState,
  type RequestStatus,
} from './lifecycle.js';

type TransferRequestWithRelations = TransferRequest & {
  sourceTreasuryWallet: TreasuryWallet | null;
  destination: (Destination & { counterparty: Counterparty | null }) | null;
  requestedByUser: User | null;
  events?: TransferRequestEvent[];
  notes?: (TransferRequestNote & {
    authorUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  })[];
  executionRecords?: (ExecutionRecord & {
    executorUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  })[];
};

type ExecutionRecordWithUser = ExecutionRecord & {
  executorUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
};

type SyntheticSettlementMatch = {
  signature: string | null;
  observedTransferId: string | null;
  matchStatus: 'rpc_verified';
  confidenceScore: number;
  confidenceBand: 'high';
  matchedAmountRaw: string;
  amountVarianceRaw: string;
  destinationMatchType: 'token_account_delta';
  timeDeltaSeconds: number | null;
  matchRule: 'rpc_usdc_delta_verification';
  candidateCount: number;
  explanation: string;
  observedEventTime: Date | string | null;
  matchedAt: Date | string | null;
  updatedAt: Date | string;
  chainToMatchMs: number | null;
};

type SyntheticSettlementException = {
  exceptionId: string;
  transferRequestId: string;
  signature: string | null;
  observedTransferId: string | null;
  exceptionType: 'rpc_settlement_mismatch';
  reasonCode: 'rpc_settlement_mismatch';
  severity: 'high';
  status: 'open';
  resolutionCode: null;
  assignedToUserId: null;
  assignedToUser: null;
  explanation: string;
  propertiesJson: Prisma.JsonValue | null;
  observedEventTime: Date | string | null;
  processedAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  notes: [];
  availableActions: [];
};

export async function getReconciliationDetail(organizationId: string, transferRequestId: string) {
  const requestWithTimeline = await prisma.transferRequest.findFirstOrThrow({
    where: { organizationId, transferRequestId },
    include: baseTransferRequestInclude({ includeNotes: true }),
  });
  const request = requestWithTimeline as unknown as TransferRequestWithRelations;
  const queueItem = buildSettlementQueueItem(request);
  const events = (requestWithTimeline.events ?? []).map((event) =>
    serializeTransferRequestEvent(parseTransferRequestEvent(event)),
  );
  const notes = (request.notes ?? []).map(serializeTransferRequestNote);
  const timelineEvents = (requestWithTimeline.events ?? []).map((event) => parseTransferRequestEvent(event));

  return {
    ...serializeTransferRequest(request),
    approvalState: queueItem.approvalState,
    executionState: queueItem.executionState,
    latestExecution: queueItem.latestExecution,
    executionRecords: queueItem.executionRecords,
    observedExecutionTransaction: null,
    requestDisplayState: queueItem.requestDisplayState,
    availableTransitions: queueItem.availableTransitions,
    linkedSignature: queueItem.linkedSignature,
    linkedPaymentId: extractLinkedPaymentId(requestWithTimeline.events ?? []),
    linkedTransferIds: [],
    linkedObservedTransfers: [],
    linkedObservedPayment: null,
    relatedObservedPayments: [],
    match: queueItem.match,
    matchExplanation: queueItem.matchExplanation,
    exceptions: queueItem.exceptions,
    exceptionExplanation: queueItem.exceptionExplanation,
    events,
    notes,
    timeline: buildTimeline({
      events: timelineEvents,
      notes,
      executionRecords: queueItem.executionRecords,
      match: queueItem.match,
      exceptions: queueItem.exceptions,
    }),
  };
}

export async function getReconciliationExplanation(organizationId: string, transferRequestId: string) {
  const detail = await getReconciliationDetail(organizationId, transferRequestId);
  const outcome = deriveSettlementOutcome(detail);
  const submittedSignature = detail.latestExecution?.submittedSignature ?? null;

  return {
    servedAt: new Date().toISOString(),
    organizationId,
    transferRequestId,
    outcome,
    summary: buildSettlementSummary(detail, outcome),
    confidence: {
      score: detail.match?.confidenceScore ?? null,
      band: detail.match?.confidenceBand ?? (detail.exceptions.length ? 'needs_review' : 'unknown'),
      rule: detail.match?.matchRule ?? null,
      candidateCount: detail.match?.candidateCount ?? 0,
    },
    amount: {
      requestedRaw: detail.amountRaw,
      requestedUsdc: formatRawUsdc(detail.amountRaw),
      matchedRaw: detail.match?.matchedAmountRaw ?? '0',
      matchedUsdc: detail.match?.matchedAmountRaw ? formatRawUsdc(detail.match.matchedAmountRaw) : '0.000000',
      varianceRaw: detail.match?.amountVarianceRaw ?? detail.amountRaw,
      varianceUsdc: detail.match?.amountVarianceRaw ? formatRawUsdc(detail.match.amountVarianceRaw) : formatRawUsdc(detail.amountRaw),
    },
    states: {
      requestStatus: detail.status,
      displayState: detail.requestDisplayState,
      approval: detail.approvalState,
      execution: detail.executionState,
    },
    matching: detail.match
      ? {
          signature: detail.match.signature,
          observedTransferId: detail.match.observedTransferId,
          status: detail.match.matchStatus,
          destinationMatchType: detail.match.destinationMatchType,
          timeDeltaSeconds: detail.match.timeDeltaSeconds,
          chainToMatchMs: detail.match.chainToMatchMs,
          explanation: detail.matchExplanation ?? detail.match.explanation,
        }
      : null,
    execution: {
      latestExecution: detail.latestExecution,
      submittedSignature,
      observedExecutionTransaction: null,
      signatureObserved: Boolean(submittedSignature),
      signatureMatched: Boolean(detail.match && submittedSignature && detail.match.signature === submittedSignature),
    },
    edgeCases: detail.exceptions.map((exception) => ({
      id: exception.reasonCode,
      severity: exception.severity,
      message: exception.explanation,
    })),
    evidence: {
      linkedSignature: detail.linkedSignature,
      linkedPaymentId: detail.linkedPaymentId,
      linkedTransferIds: detail.linkedTransferIds,
      observedTransfers: [],
      observedPayment: null,
      relatedPaymentCount: 0,
      exceptionIds: detail.exceptions.map((exception) => exception.exceptionId),
    },
    recommendedAction: deriveRecommendedAction(detail, outcome),
  };
}

function baseTransferRequestInclude(options: { includeNotes?: boolean } = {}) {
  return {
    sourceTreasuryWallet: true,
    destination: { include: { counterparty: true } },
    requestedByUser: true,
    events: { orderBy: { createdAt: 'asc' as const } },
    ...(options.includeNotes
      ? {
          notes: {
            include: {
              authorUser: {
                select: { userId: true, email: true, displayName: true },
              },
            },
            orderBy: { createdAt: 'asc' as const },
          },
        }
      : {}),
    executionRecords: {
      include: {
        executorUser: {
          select: { userId: true, email: true, displayName: true },
        },
      },
      orderBy: { createdAt: 'desc' as const },
    },
  };
}

function buildSettlementQueueItem(request: TransferRequestWithRelations) {
  const latestExecutionRecord = request.executionRecords?.[0] ?? null;
  const executionRecords = (request.executionRecords ?? []).map((record) => serializeExecutionRecord(record));
  const mismatchException = buildRpcMismatchException(request, latestExecutionRecord);
  const exceptions = mismatchException ? [mismatchException] : [];
  const match = buildRpcSettlementMatch(request, latestExecutionRecord);
  const requestDisplayState = deriveRequestDisplayState({
    requestStatus: request.status,
    matchStatus: match?.matchStatus ?? null,
    exceptionStatuses: exceptions.map((exception) => exception.status),
  });

  return {
    ...serializeTransferRequest(request),
    approvalState: deriveApprovalState(request.status),
    executionState: deriveExecutionState({
      requestStatus: request.status,
      executionState: latestExecutionRecord?.state ?? null,
      submittedSignature: latestExecutionRecord?.submittedSignature ?? null,
      hasObservedTransaction: Boolean(latestExecutionRecord?.submittedSignature),
      matchStatus: match?.matchStatus ?? null,
      exceptionStatuses: exceptions.map((exception) => exception.status),
    }),
    latestExecution: latestExecutionRecord ? serializeExecutionRecord(latestExecutionRecord) : null,
    executionRecords,
    requestDisplayState,
    availableTransitions: getAvailableOperatorTransitions({
      requestStatus: request.status as RequestStatus,
      requestDisplayState: requestDisplayState as RequestDisplayState,
    }),
    linkedSignature: match?.signature ?? latestExecutionRecord?.submittedSignature ?? null,
    linkedPaymentId: extractLinkedPaymentId(request.events ?? []),
    linkedTransferIds: [],
    match,
    matchExplanation: match?.explanation ?? null,
    exceptionExplanation: exceptions[0]?.explanation ?? null,
    exceptions,
  };
}

function buildRpcSettlementMatch(
  request: TransferRequestWithRelations,
  latestExecutionRecord: ExecutionRecordWithUser | null,
): SyntheticSettlementMatch | null {
  if (!latestExecutionRecord?.submittedSignature) {
    return null;
  }
  if (latestExecutionRecord.state !== 'settled' && request.status !== 'matched') {
    return null;
  }

  return {
    signature: latestExecutionRecord.submittedSignature,
    observedTransferId: null,
    matchStatus: 'rpc_verified',
    confidenceScore: 1,
    confidenceBand: 'high',
    matchedAmountRaw: request.amountRaw.toString(),
    amountVarianceRaw: '0',
    destinationMatchType: 'token_account_delta',
    timeDeltaSeconds: null,
    matchRule: 'rpc_usdc_delta_verification',
    candidateCount: 1,
    explanation: 'RPC verification confirmed that the execution transaction settled the expected USDC token-account delta.',
    observedEventTime: latestExecutionRecord.submittedAt,
    matchedAt: latestExecutionRecord.updatedAt,
    updatedAt: latestExecutionRecord.updatedAt,
    chainToMatchMs: null,
  };
}

function buildRpcMismatchException(
  request: TransferRequestWithRelations,
  latestExecutionRecord: ExecutionRecordWithUser | null,
): SyntheticSettlementException | null {
  const verification = readRpcSettlementVerification(latestExecutionRecord?.metadataJson);
  if (verification?.status !== 'mismatch') {
    return null;
  }

  return {
    exceptionId: `rpc_mismatch_${request.transferRequestId}`,
    transferRequestId: request.transferRequestId,
    signature: latestExecutionRecord?.submittedSignature ?? null,
    observedTransferId: null,
    exceptionType: 'rpc_settlement_mismatch',
    reasonCode: 'rpc_settlement_mismatch',
    severity: 'high',
    status: 'open',
    resolutionCode: null,
    assignedToUserId: null,
    assignedToUser: null,
    explanation: 'RPC verification found that the execution transaction did not produce the expected USDC settlement deltas.',
    propertiesJson: verification as Prisma.JsonValue,
    observedEventTime: latestExecutionRecord?.submittedAt ?? null,
    processedAt: latestExecutionRecord?.updatedAt ?? request.updatedAt,
    createdAt: latestExecutionRecord?.createdAt ?? request.createdAt,
    updatedAt: latestExecutionRecord?.updatedAt ?? request.updatedAt,
    notes: [],
    availableActions: [],
  };
}

function readRpcSettlementVerification(value: unknown): { status?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>).rpcSettlementVerification;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  return candidate as { status?: string };
}

function deriveSettlementOutcome(detail: Awaited<ReturnType<typeof getReconciliationDetail>>) {
  if (detail.requestDisplayState === 'exception') {
    return 'exception';
  }
  if (detail.requestDisplayState === 'partial') {
    return 'partial_settlement';
  }
  if (detail.match?.matchStatus === 'rpc_verified' || detail.requestDisplayState === 'matched') {
    return 'matched_exact';
  }
  if (detail.executionState === 'submitted_onchain') {
    return 'submitted_onchain';
  }
  if (detail.executionState === 'ready_for_execution') {
    return 'ready_for_execution';
  }
  if (detail.status === 'closed') {
    return 'closed';
  }
  return 'pending';
}

function buildSettlementSummary(
  detail: Awaited<ReturnType<typeof getReconciliationDetail>>,
  outcome: ReturnType<typeof deriveSettlementOutcome>,
) {
  switch (outcome) {
    case 'matched_exact':
      return `RPC verification confirmed ${formatRawUsdc(detail.amountRaw)} USDC settled for this request.`;
    case 'exception':
      return detail.exceptionExplanation ?? 'Settlement verification needs review.';
    case 'submitted_onchain':
      return 'Execution signature is recorded and waiting for RPC settlement verification.';
    case 'ready_for_execution':
      return 'Request is approved and ready to become a Squads proposal or execution handoff.';
    case 'closed':
      return 'Request is closed.';
    case 'partial_settlement':
      return 'Settlement is partial and needs review.';
    case 'pending':
    default:
      return 'Request is waiting for the next workflow step.';
  }
}

function deriveRecommendedAction(
  detail: Awaited<ReturnType<typeof getReconciliationDetail>>,
  outcome: ReturnType<typeof deriveSettlementOutcome>,
) {
  switch (outcome) {
    case 'matched_exact':
    case 'closed':
      return 'export_proof';
    case 'exception':
    case 'partial_settlement':
      return 'review_exception';
    case 'submitted_onchain':
      return 'wait_for_settlement';
    case 'ready_for_execution':
      return 'prepare_execution';
    case 'pending':
    default:
      return detail.status === 'pending_approval' || detail.status === 'escalated'
        ? 'review_approval'
        : 'continue_payment_workflow';
  }
}

export function serializeTransferRequest(request: TransferRequestWithRelations) {
  return {
    transferRequestId: request.transferRequestId,
    organizationId: request.organizationId,
    paymentOrderId: request.paymentOrderId,
    sourceTreasuryWalletId: request.sourceTreasuryWalletId,
    destinationId: request.destinationId,
    requestType: request.requestType,
    asset: request.asset,
    amountRaw: request.amountRaw.toString(),
    requestedByUserId: request.requestedByUserId,
    reason: request.reason,
    externalReference: request.externalReference,
    status: request.status,
    requestedAt: request.requestedAt,
    dueAt: request.dueAt,
    propertiesJson: request.propertiesJson,
    sourceTreasuryWallet: request.sourceTreasuryWallet
      ? serializeTreasuryWallet(request.sourceTreasuryWallet)
      : null,
    destination: request.destination ? serializeDestination(request.destination) : null,
    requestedByUser: serializeUserRef(request.requestedByUser),
  };
}

function serializeUserRef(user: Pick<User, 'userId' | 'email' | 'displayName'> | null | undefined) {
  return user
    ? {
        userId: user.userId,
        email: user.email,
        displayName: user.displayName,
      }
    : null;
}

function serializeTreasuryWallet(address: TreasuryWallet) {
  return {
    treasuryWalletId: address.treasuryWalletId,
    address: address.address,
    usdcAtaAddress: address.usdcAtaAddress,
    displayName: address.displayName,
    notes: address.notes,
  };
}

function serializeDestination(destination: Destination & { counterparty: Counterparty | null }) {
  return {
    destinationId: destination.destinationId,
    organizationId: destination.organizationId,
    counterpartyId: destination.counterpartyId,
    chain: destination.chain,
    asset: destination.asset,
    walletAddress: destination.walletAddress,
    tokenAccountAddress: destination.tokenAccountAddress,
    destinationType: destination.destinationType,
    trustState: destination.trustState,
    label: destination.label,
    notes: destination.notes,
    isInternal: destination.isInternal,
    isActive: destination.isActive,
    metadataJson: destination.metadataJson,
    createdAt: destination.createdAt,
    updatedAt: destination.updatedAt,
    counterparty: destination.counterparty ? serializeCounterparty(destination.counterparty) : null,
  };
}

function serializeCounterparty(counterparty: Counterparty) {
  return {
    counterpartyId: counterparty.counterpartyId,
    organizationId: counterparty.organizationId,
    displayName: counterparty.displayName,
    category: counterparty.category,
    externalReference: counterparty.externalReference,
    status: counterparty.status,
    metadataJson: counterparty.metadataJson,
    createdAt: counterparty.createdAt,
    updatedAt: counterparty.updatedAt,
  };
}

function extractLinkedPaymentId(events: TransferRequestEvent[]) {
  const event = [...events].reverse().find((candidate) => candidate.linkedPaymentId);
  return event?.linkedPaymentId ?? null;
}

function formatRawUsdc(amountRaw: string) {
  const negative = amountRaw.startsWith('-');
  const digits = negative ? amountRaw.slice(1) : amountRaw;
  const padded = digits.padStart(7, '0');
  const whole = padded.slice(0, -6) || '0';
  const fraction = padded.slice(-6);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Reconciliation timeline. Inlined from the former reconciliation-timeline.ts
// module since settlement-read-model is the only consumer. The proof builders
// read the rendered timeline through detail.timeline / reconciliation.timeline
// and serialize it as auditTrail.

function parseTransferRequestEvent(event: TransferRequestEvent) {
  const linkedTransferIds = Array.isArray(event.linkedTransferIds)
    ? event.linkedTransferIds.filter((value): value is string => typeof value === 'string')
    : [];
  return { ...event, linkedTransferIds };
}

function serializeTransferRequestEvent(event: ReturnType<typeof parseTransferRequestEvent>) {
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

function serializeTransferRequestNote(
  note: TransferRequestNote & {
    authorUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
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

type TimelineExecutionRecord = {
  updatedAt: Date | string;
  state: string;
  executionSource: string;
  submittedSignature: string | null;
  executorUser: ReturnType<typeof serializeUserRef>;
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

function buildTimeline(args: {
  events: ReturnType<typeof parseTransferRequestEvent>[];
  notes: ReturnType<typeof serializeTransferRequestNote>[];
  executionRecords: TimelineExecutionRecord[];
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
    ...args.executionRecords.map((record) => ({
      timelineType: 'execution_record' as const,
      createdAt: record.updatedAt,
      state: record.state,
      executionSource: record.executionSource,
      submittedSignature: record.submittedSignature,
      executorUser: record.executorUser,
    })),
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
