import type {
  AddressLabel,
  ApprovalDecision,
  ApprovalPolicy,
  Counterparty,
  Destination,
  Prisma,
  TransferRequest,
  TransferRequestEvent,
  TransferRequestNote,
  User,
  WorkspaceAddress,
} from '@prisma/client';
import {
  buildApprovalEvaluationSummary,
  getOrCreateWorkspaceApprovalPolicy,
  serializeApprovalPolicy,
} from './approval-policy.js';
import { normalizeClickHouseDateTime, queryClickHouse } from './clickhouse.js';
import { config } from './config.js';
import { getOrResolveAddressLabels } from './address-label-registry.js';
import { prisma } from './prisma.js';
import { createTransferRequestEvent } from './transfer-request-events.js';
import {
  deriveApprovalState,
  deriveExecutionState,
  deriveRequestDisplayState,
  getAvailableOperatorTransitions,
  getTargetExceptionStatusForAction,
  isExceptionActionAllowed,
  type ExceptionAction,
  type RequestStatus,
} from './transfer-request-lifecycle.js';

type TransferRequestWithRelations = TransferRequest & {
  sourceWorkspaceAddress: WorkspaceAddress | null;
  destinationWorkspaceAddress: WorkspaceAddress | null;
  destination: (Destination & {
    counterparty: Counterparty | null;
  }) | null;
  requestedByUser: User | null;
  events?: TransferRequestEvent[];
  notes?: (TransferRequestNote & {
    authorUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  })[];
  approvalDecisions?: (ApprovalDecision & {
    actorUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
    approvalPolicy: ApprovalPolicy | null;
  })[];
};

export type SettlementMatchRow = {
  transfer_request_id: string;
  signature: string | null;
  observed_transfer_id: string | null;
  match_status: string;
  confidence_score: number | string;
  confidence_band: string;
  matched_amount_raw: string;
  amount_variance_raw: string;
  destination_match_type: string;
  time_delta_seconds: string | number;
  match_rule: string;
  candidate_count: number | string;
  explanation: string;
  observed_event_time: string | null;
  matched_at: string | null;
  updated_at: string;
  chain_to_match_ms?: string | number | null;
};

export type ExceptionRow = {
  exception_id: string;
  transfer_request_id: string | null;
  signature: string | null;
  observed_transfer_id: string | null;
  exception_type: string;
  severity: string;
  status: string;
  explanation: string;
  properties_json: string | null;
  observed_event_time: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
  chain_to_process_ms?: string | number | null;
};

type ObservedTransferRow = {
  transfer_id: string;
  signature: string;
  slot: string | number;
  event_time: string;
  asset: string;
  source_token_account: string | null;
  source_wallet: string | null;
  destination_token_account: string;
  destination_wallet: string | null;
  amount_raw: string;
  amount_decimal: string;
  transfer_kind: string;
  instruction_index: number | string | null;
  inner_instruction_index: number | string | null;
  route_group: string;
  leg_role: string;
  properties_json: string | null;
  created_at: string;
};

type ObservedPaymentRow = {
  payment_id: string;
  signature: string;
  slot: string | number;
  event_time: string;
  asset: string;
  source_wallet: string | null;
  destination_wallet: string | null;
  gross_amount_raw: string;
  gross_amount_decimal: string;
  net_destination_amount_raw: string;
  net_destination_amount_decimal: string;
  fee_amount_raw: string;
  fee_amount_decimal: string;
  route_count: number | string;
  payment_kind: string;
  reconstruction_rule: string;
  confidence_band: string;
  properties_json: string | null;
  created_at: string;
};

type RelatedPaymentRole = 'expected_destination' | 'known_fee_recipient' | 'other_destination';

type QueueBuildOptions = {
  limit?: number;
  displayState?: string;
  requestStatus?: string;
};

export async function listReconciliationQueue(workspaceId: string, options: QueueBuildOptions = {}) {
  const transferRequests = await prisma.transferRequest.findMany({
    where: {
      workspaceId,
      asset: 'usdc',
    },
    include: {
      destinationWorkspaceAddress: true,
      sourceWorkspaceAddress: true,
      destination: {
        include: {
          counterparty: true,
        },
      },
      requestedByUser: true,
      events: {
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { requestedAt: 'desc' },
    take: options.limit,
  });

  const requestIds = transferRequests.map((request) => request.transferRequestId);
  const [matches, exceptions] = await Promise.all([
    querySettlementMatches(workspaceId, requestIds),
    queryExceptions(workspaceId, requestIds),
  ]);

  const items = buildQueueItems({
    transferRequests,
    matches,
    exceptions,
  });

  await hydrateAddressLabelsForQueueItems(items);

  return options.displayState
    ? items
        .filter((item) => item.requestDisplayState === options.displayState)
        .filter((item) => (options.requestStatus ? item.status === options.requestStatus : true))
    : items.filter((item) => (options.requestStatus ? item.status === options.requestStatus : true));
}

export async function listApprovalInbox(args: {
  workspaceId: string;
  limit?: number;
  statuses?: Array<'pending_approval' | 'escalated'>;
}) {
  const statuses = args.statuses?.length ? args.statuses : ['pending_approval', 'escalated'];
  const [transferRequests, approvalPolicy] = await Promise.all([
    prisma.transferRequest.findMany({
      where: {
        workspaceId: args.workspaceId,
        asset: 'usdc',
        status: {
          in: statuses,
        },
      },
      include: {
        destinationWorkspaceAddress: true,
        sourceWorkspaceAddress: true,
        destination: {
          include: {
            counterparty: true,
          },
        },
        requestedByUser: true,
        events: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { requestedAt: 'desc' },
      take: args.limit ?? 100,
    }),
    getOrCreateWorkspaceApprovalPolicy(args.workspaceId),
  ]);

  const requestIds = transferRequests.map((request) => request.transferRequestId);
  const [matches, exceptions] = await Promise.all([
    querySettlementMatches(args.workspaceId, requestIds),
    queryExceptions(args.workspaceId, requestIds),
  ]);
  const items = buildQueueItems({
    transferRequests,
    matches,
    exceptions,
  });

  await hydrateAddressLabelsForQueueItems(items);

  return {
    approvalPolicy: serializeApprovalPolicy(approvalPolicy),
    items: items.map((item) => ({
      ...item,
      approvalEvaluation: buildApprovalEvaluationSummary({
        policy: approvalPolicy,
        amountRaw: item.amountRaw,
        destination: item.destination
          ? {
              label: item.destination.label,
              trustState: item.destination.trustState,
              isInternal: item.destination.isInternal,
            }
          : {
              label: item.destinationWorkspaceAddress?.displayName ?? item.destinationWorkspaceAddress?.address ?? 'unnamed destination',
              trustState: 'unreviewed',
              isInternal: false,
            },
      }),
    })),
  };
}

export async function getReconciliationDetail(workspaceId: string, transferRequestId: string) {
  const requestWithTimeline = await prisma.transferRequest.findFirstOrThrow({
    where: { workspaceId, transferRequestId },
    include: {
      sourceWorkspaceAddress: true,
      destinationWorkspaceAddress: true,
      destination: {
        include: {
          counterparty: true,
        },
      },
      requestedByUser: true,
      events: {
        orderBy: { createdAt: 'asc' },
      },
      notes: {
        include: {
          authorUser: {
            select: {
              userId: true,
              email: true,
              displayName: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      approvalDecisions: {
        include: {
          actorUser: {
            select: {
              userId: true,
              email: true,
              displayName: true,
            },
          },
          approvalPolicy: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  const [matches, exceptions] = await Promise.all([
    querySettlementMatches(workspaceId, [transferRequestId]),
    queryExceptions(workspaceId, [transferRequestId]),
  ]);

  const queueItems = buildQueueItems({
    transferRequests: [requestWithTimeline],
    matches,
    exceptions,
  });
  const queueItem = queueItems[0];

  await hydrateAddressLabelsForQueueItems([queueItem]);

  const exceptionIds = queueItem.exceptions.map((item) => item.exceptionId);
  const exceptionNotes = exceptionIds.length
    ? await prisma.exceptionNote.findMany({
        where: {
          workspaceId,
          exceptionId: {
            in: exceptionIds,
          },
        },
        include: {
          authorUser: {
            select: {
              userId: true,
              email: true,
              displayName: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      })
    : [];

  const exceptionNotesById = new Map<string, ReturnType<typeof serializeExceptionNote>[]>();
  for (const note of exceptionNotes) {
    const bucket = exceptionNotesById.get(note.exceptionId) ?? [];
    bucket.push(serializeExceptionNote(note));
    exceptionNotesById.set(note.exceptionId, bucket);
  }

  const enrichedExceptions = queueItem.exceptions.map((exception) => ({
    ...exception,
    notes: exceptionNotesById.get(exception.exceptionId) ?? [],
    availableActions: getAvailableExceptionActions(exception.status),
  }));

  const [linkedObservedTransfers, linkedObservedPayment, relatedObservedPayments] = await Promise.all([
    queryObservedTransfersByIds(queueItem.linkedTransferIds),
    queueItem.linkedPaymentId ? queryObservedPaymentById(queueItem.linkedPaymentId) : null,
    queueItem.linkedSignature ? queryObservedPaymentsBySignature(queueItem.linkedSignature) : [],
  ]);

  const expectedDestinationWallet =
    requestWithTimeline.destination?.walletAddress
    ?? requestWithTimeline.destinationWorkspaceAddress?.address
    ?? null;
  const addressLabels = await getOrResolveAddressLabels(
    'solana',
    relatedObservedPayments
      .map((payment) => payment.destinationWallet)
      .filter((value): value is string => Boolean(value)),
  );
  const annotatedObservedPayments = relatedObservedPayments.map((payment) =>
    annotateObservedPayment(payment, expectedDestinationWallet, addressLabels),
  );
  const detailedMatchExplanation = buildDetailedMatchExplanation({
    requestAmountRaw: requestWithTimeline.amountRaw.toString(),
    expectedDestinationWallet,
    defaultExplanation: queueItem.matchExplanation,
    match: queueItem.match,
    relatedObservedPayments: annotatedObservedPayments,
  });

  const approvalPolicy = await getOrCreateWorkspaceApprovalPolicy(workspaceId);
  const approvalEvaluation = buildApprovalEvaluationSummary({
    policy: approvalPolicy,
    amountRaw: requestWithTimeline.amountRaw,
    destination: requestWithTimeline.destination
      ? {
          label: requestWithTimeline.destination.label,
          trustState: requestWithTimeline.destination.trustState,
          isInternal: requestWithTimeline.destination.isInternal,
        }
      : {
          label:
            requestWithTimeline.destinationWorkspaceAddress?.displayName
            ?? requestWithTimeline.destinationWorkspaceAddress?.address
            ?? 'unnamed destination',
          trustState: 'unreviewed',
          isInternal: false,
        },
  });

  return {
    ...serializeTransferRequest(requestWithTimeline),
    approvalState: queueItem.approvalState,
    executionState: queueItem.executionState,
    requestDisplayState: queueItem.requestDisplayState,
    availableTransitions: queueItem.availableTransitions,
    linkedSignature: queueItem.linkedSignature,
    linkedPaymentId: queueItem.linkedPaymentId,
    linkedTransferIds: queueItem.linkedTransferIds,
    linkedObservedTransfers,
    linkedObservedPayment,
    relatedObservedPayments: annotatedObservedPayments,
    match: queueItem.match,
    matchExplanation: detailedMatchExplanation,
    exceptions: enrichedExceptions,
    exceptionExplanation: queueItem.exceptionExplanation,
    approvalPolicy: serializeApprovalPolicy(approvalPolicy),
    approvalEvaluation,
    approvalDecisions: (requestWithTimeline.approvalDecisions ?? []).map(serializeApprovalDecision),
    events: (requestWithTimeline.events ?? []).map((event) =>
      serializeTransferRequestEvent(parseTransferRequestEvent(event)),
    ),
    notes: (requestWithTimeline.notes ?? []).map(serializeTransferRequestNote),
    timeline: buildTimeline({
      events: (requestWithTimeline.events ?? []).map((event) => parseTransferRequestEvent(event)),
      notes: (requestWithTimeline.notes ?? []).map(serializeTransferRequestNote),
      match: queueItem.match,
      exceptions: enrichedExceptions,
    }),
  };
}

export async function applyExceptionAction(args: {
  workspaceId: string;
  exceptionId: string;
  action: ExceptionAction;
  actorUserId: string;
  note?: string;
}) {
  const { workspaceId, exceptionId, action, actorUserId, note } = args;
  const exception = await queryExceptionById(workspaceId, exceptionId);

  if (!exception) {
    throw new Error('Exception not found');
  }

  if (!isExceptionActionAllowed(exception.status, action)) {
    throw new Error(`Invalid exception action ${action} for status ${exception.status}`);
  }

  const nextStatus = getTargetExceptionStatusForAction(action);
  const updatedExceptionState = await prisma.$transaction(async (tx) => {
    const state = await tx.exceptionState.upsert({
      where: {
        workspaceId_exceptionId: {
          workspaceId,
          exceptionId,
        },
      },
      update: {
        status: nextStatus,
        updatedByUserId: actorUserId,
      },
      create: {
        workspaceId,
        exceptionId,
        status: nextStatus,
        updatedByUserId: actorUserId,
      },
    });

    if (note?.trim()) {
      await tx.exceptionNote.create({
        data: {
          workspaceId,
          exceptionId,
          authorUserId: actorUserId,
          body: note.trim(),
        },
      });
    }

    if (exception.transfer_request_id) {
      const request = await tx.transferRequest.findUnique({
        where: { transferRequestId: exception.transfer_request_id },
        select: { transferRequestId: true, status: true },
      });

      if (request) {
        await createTransferRequestEvent(tx, {
          transferRequestId: request.transferRequestId,
          workspaceId,
          eventType: 'exception_status_updated',
          actorType: 'user',
          actorId: actorUserId,
          eventSource: 'user',
          beforeState: request.status,
          afterState: request.status,
          linkedSignature: exception.signature,
          linkedTransferIds: exception.observed_transfer_id ? [exception.observed_transfer_id] : [],
          payloadJson: {
            exceptionId,
            exceptionAction: action,
            exceptionStatus: nextStatus,
          },
        });
      }
    }

    return state;
  });

  return serializeException(applyExceptionStateOverlay(exception, updatedExceptionState));
}

export async function addExceptionNote(args: {
  workspaceId: string;
  exceptionId: string;
  actorUserId: string;
  body: string;
}) {
  const exception = await queryExceptionById(args.workspaceId, args.exceptionId);
  if (!exception) {
    throw new Error('Exception not found');
  }

  const note = await prisma.exceptionNote.create({
    data: {
      workspaceId: args.workspaceId,
      exceptionId: args.exceptionId,
      authorUserId: args.actorUserId,
      body: args.body.trim(),
    },
    include: {
      authorUser: {
        select: {
          userId: true,
          email: true,
          displayName: true,
        },
      },
    },
  });

  return serializeExceptionNote(note);
}

export async function getExceptionDetail(workspaceId: string, exceptionId: string) {
  const exception = await queryExceptionById(workspaceId, exceptionId);
  if (!exception) {
    throw new Error('Exception not found');
  }

  const notes = await prisma.exceptionNote.findMany({
    where: { workspaceId, exceptionId },
    include: {
      authorUser: {
        select: {
          userId: true,
          email: true,
          displayName: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return {
    ...serializeException(exception),
    notes: notes.map(serializeExceptionNote),
    availableActions: getAvailableExceptionActions(exception.status),
  };
}

export async function listWorkspaceExceptions(args: {
  workspaceId: string;
  limit?: number;
  status?: string;
  severity?: string;
}) {
  const rows = await queryExceptionsByWorkspace({
    workspaceId: args.workspaceId,
    severity: args.severity,
  });

  const filtered = args.status
    ? rows.filter((row) => row.status === args.status)
    : rows;

  return filtered.slice(0, args.limit ?? 100).map(serializeException);
}

function buildQueueItems(args: {
  transferRequests: TransferRequestWithRelations[];
  matches: SettlementMatchRow[];
  exceptions: ExceptionRow[];
}) {
  const matchesByRequestId = new Map(args.matches.map((row) => [row.transfer_request_id, row] as const));
  const exceptionsByRequestId = new Map<string, ExceptionRow[]>();

  for (const exception of args.exceptions) {
    if (!exception.transfer_request_id) continue;
    const bucket = exceptionsByRequestId.get(exception.transfer_request_id) ?? [];
    bucket.push(exception);
    exceptionsByRequestId.set(exception.transfer_request_id, bucket);
  }

  return args.transferRequests.map((request) => {
    const matchRow = matchesByRequestId.get(request.transferRequestId) ?? null;
    const exceptions = (exceptionsByRequestId.get(request.transferRequestId) ?? []).map(serializeException);
    const requestDisplayState = deriveRequestDisplayState({
      requestStatus: request.status,
      matchStatus: matchRow?.match_status ?? null,
      exceptionStatuses: exceptions.map((item) => item.status),
    });
    const linkedTransferIds = uniqueValues(
      [
        matchRow?.observed_transfer_id,
        ...exceptions.map((item) => item.observedTransferId),
      ].filter((value): value is string => Boolean(value)),
    );
    const linkedSignature =
      matchRow?.signature ??
      exceptions.find((item) => item.signature)?.signature ??
      null;

    const match = matchRow ? serializeMatch(matchRow) : null;
    return {
      ...serializeTransferRequest(request),
      approvalState: deriveApprovalState(request.status),
      executionState: deriveExecutionState({
        requestStatus: request.status,
        linkedSignature,
        matchStatus: matchRow?.match_status ?? null,
        exceptionStatuses: exceptions.map((item) => item.status),
      }),
      requestDisplayState,
      availableTransitions: getAvailableOperatorTransitions({
        requestStatus: request.status as RequestStatus,
        requestDisplayState,
      }),
      linkedSignature,
      linkedPaymentId: extractLinkedPaymentId(request.events ?? []),
      linkedTransferIds,
      match,
      matchExplanation: match?.explanation ?? null,
      exceptionExplanation: exceptions[0]?.explanation ?? null,
      exceptions,
    };
  });
}

function annotateObservedPayment(
  payment: Awaited<ReturnType<typeof queryObservedPaymentById>> extends infer T
    ? NonNullable<T>
    : never,
  expectedDestinationWallet: string | null,
  addressLabels: Map<string, AddressLabel>,
) {
  const knownRecipient = payment.destinationWallet
    ? addressLabels.get(payment.destinationWallet) ?? null
    : null;

  const recipientRole: RelatedPaymentRole =
    payment.destinationWallet && expectedDestinationWallet && payment.destinationWallet === expectedDestinationWallet
      ? 'expected_destination'
      : deriveRecipientRole(knownRecipient);

  return {
    ...payment,
    recipientRole,
    destinationLabel:
      recipientRole === 'expected_destination'
        ? 'Expected destination'
        : knownRecipient?.entityName ?? null,
    labelKind: knownRecipient?.labelKind ?? null,
    entityType: knownRecipient?.entityType ?? null,
    roleTags: normalizeRoleTags(knownRecipient?.roleTags),
    labelConfidence: knownRecipient?.confidence ?? null,
  };
}

function deriveRecipientRole(label: AddressLabel | null): RelatedPaymentRole {
  if (!label) {
    return 'other_destination';
  }

  if (
    label.labelKind === 'fee_collector'
    || normalizeRoleTags(label.roleTags).includes('fee_recipient')
  ) {
    return 'known_fee_recipient';
  }

  return 'other_destination';
}

function buildDetailedMatchExplanation(args: {
  requestAmountRaw: string;
  expectedDestinationWallet: string | null;
  defaultExplanation: string | null;
  match: ReturnType<typeof serializeMatch> | null;
  relatedObservedPayments: Array<
    ReturnType<typeof annotateObservedPayment>
  >;
}) {
  if (!args.match || args.match.matchStatus !== 'matched_partial') {
    return args.defaultExplanation;
  }

  const expectedLeg = args.relatedObservedPayments.find(
    (payment) => payment.recipientRole === 'expected_destination',
  );
  const siblingLegs = args.relatedObservedPayments.filter(
    (payment) => payment.recipientRole !== 'expected_destination',
  );

  if (!expectedLeg || !siblingLegs.length) {
    return args.defaultExplanation;
  }

  const siblingBreakdown = siblingLegs
    .map((payment) => {
      const amount = formatRawUsdc(payment.netDestinationAmountRaw);
      const destination =
        payment.destinationLabel ??
        payment.destinationWallet ??
        'another destination';
      return `${amount} USDC to ${destination}`;
    })
    .join(', ');

  return `Only ${formatRawUsdc(expectedLeg.netDestinationAmountRaw)} of the requested ${formatRawUsdc(
    args.requestAmountRaw,
  )} USDC reached the expected destination${
    args.expectedDestinationWallet ? ` wallet ${args.expectedDestinationWallet}` : ''
  }. The remaining settlement in the same transaction was routed as ${siblingBreakdown}.`;
}

function extractLinkedPaymentId(events: TransferRequestEvent[]) {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.linkedPaymentId);
  return event?.linkedPaymentId ?? null;
}

export function serializeTransferRequest(request: TransferRequestWithRelations) {
  return {
    transferRequestId: request.transferRequestId,
    workspaceId: request.workspaceId,
    sourceWorkspaceAddressId: request.sourceWorkspaceAddressId,
    destinationWorkspaceAddressId: request.destinationWorkspaceAddressId,
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
    sourceWorkspaceAddress: request.sourceWorkspaceAddress
      ? serializeWorkspaceAddress(request.sourceWorkspaceAddress)
      : null,
    destinationWorkspaceAddress: request.destinationWorkspaceAddress
      ? serializeWorkspaceAddress(request.destinationWorkspaceAddress)
      : null,
    destination: request.destination
      ? serializeDestination(request.destination)
      : null,
    requestedByUser: request.requestedByUser
      ? {
          userId: request.requestedByUser.userId,
          email: request.requestedByUser.email,
          displayName: request.requestedByUser.displayName,
        }
      : null,
  };
}

function serializeApprovalDecision(
  decision: ApprovalDecision & {
    actorUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
    approvalPolicy: ApprovalPolicy | null;
  },
) {
  return {
    approvalDecisionId: decision.approvalDecisionId,
    approvalPolicyId: decision.approvalPolicyId,
    transferRequestId: decision.transferRequestId,
    workspaceId: decision.workspaceId,
    actorUserId: decision.actorUserId,
    actorType: decision.actorType,
    action: decision.action,
    comment: decision.comment,
    payloadJson: decision.payloadJson,
    createdAt: decision.createdAt,
    actorUser: decision.actorUser
      ? {
          userId: decision.actorUser.userId,
          email: decision.actorUser.email,
          displayName: decision.actorUser.displayName,
        }
      : null,
    approvalPolicy: decision.approvalPolicy
      ? serializeApprovalPolicy(decision.approvalPolicy)
      : null,
  };
}

function serializeWorkspaceAddress(address: WorkspaceAddress) {
  return {
    workspaceAddressId: address.workspaceAddressId,
    address: address.address,
    usdcAtaAddress: address.usdcAtaAddress,
    addressKind: address.addressKind,
    displayName: address.displayName,
    notes: address.notes,
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

function serializeDestination(
  destination: Destination & {
    counterparty: Counterparty | null;
  },
) {
  return {
    destinationId: destination.destinationId,
    workspaceId: destination.workspaceId,
    counterpartyId: destination.counterpartyId,
    linkedWorkspaceAddressId: destination.linkedWorkspaceAddressId,
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
    counterparty: destination.counterparty
      ? serializeCounterparty(destination.counterparty)
      : null,
  };
}

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
    workspaceId: event.workspaceId,
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
    authorUser: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  },
) {
  return {
    transferRequestNoteId: note.transferRequestNoteId,
    transferRequestId: note.transferRequestId,
    workspaceId: note.workspaceId,
    body: note.body,
    createdAt: note.createdAt,
    authorUser: note.authorUser
      ? {
          userId: note.authorUser.userId,
          email: note.authorUser.email,
          displayName: note.authorUser.displayName,
        }
      : null,
  };
}

function serializeExceptionNote(
  note: Prisma.ExceptionNoteGetPayload<{
    include: {
      authorUser: {
        select: {
          userId: true;
          email: true;
          displayName: true;
        };
      };
    };
  }>,
) {
  return {
    exceptionNoteId: note.exceptionNoteId,
    exceptionId: note.exceptionId,
    workspaceId: note.workspaceId,
    body: note.body,
    createdAt: note.createdAt,
    authorUser: note.authorUser
      ? {
          userId: note.authorUser.userId,
          email: note.authorUser.email,
          displayName: note.authorUser.displayName,
        }
      : null,
  };
}

export function buildTimeline(args: {
  events: ReturnType<typeof parseTransferRequestEvent>[];
  notes: ReturnType<typeof serializeTransferRequestNote>[];
  match: ReturnType<typeof serializeMatch> | null;
  exceptions: Array<ReturnType<typeof serializeException> & { notes?: ReturnType<typeof serializeExceptionNote>[] }>;
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
      notes: exception.notes ?? [],
    })),
  ];

  return items.sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime();
    const rightTime = new Date(right.createdAt).getTime();
    return leftTime - rightTime;
  });
}

function serializeMatch(row: SettlementMatchRow) {
  return {
    signature: row.signature,
    observedTransferId: row.observed_transfer_id,
    matchStatus: row.match_status,
    confidenceScore: Number(row.confidence_score),
    confidenceBand: row.confidence_band,
    matchedAmountRaw: row.matched_amount_raw,
    amountVarianceRaw: row.amount_variance_raw,
    destinationMatchType: row.destination_match_type,
    timeDeltaSeconds: Number(row.time_delta_seconds),
    matchRule: row.match_rule,
    candidateCount: Number(row.candidate_count),
    explanation: row.explanation,
    observedEventTime: normalizeClickHouseDateTime(row.observed_event_time),
    matchedAt: normalizeClickHouseDateTime(row.matched_at ?? row.updated_at),
    updatedAt: normalizeClickHouseDateTime(row.updated_at)!,
    chainToMatchMs: row.chain_to_match_ms === undefined || row.chain_to_match_ms === null
      ? null
      : Number(row.chain_to_match_ms),
  };
}

export function serializeException(row: ExceptionRow) {
  return {
    exceptionId: row.exception_id,
    transferRequestId: row.transfer_request_id,
    signature: row.signature,
    observedTransferId: row.observed_transfer_id,
    exceptionType: row.exception_type,
    reasonCode: normalizeExceptionReasonCode(row.exception_type),
    severity: row.severity,
    status: row.status,
    explanation: row.explanation,
    propertiesJson: safeJsonParse(row.properties_json),
    observedEventTime: normalizeClickHouseDateTime(row.observed_event_time),
    processedAt: normalizeClickHouseDateTime(row.processed_at ?? row.updated_at),
    createdAt: normalizeClickHouseDateTime(row.created_at)!,
    updatedAt: normalizeClickHouseDateTime(row.updated_at)!,
    chainToProcessMs:
      row.chain_to_process_ms === undefined || row.chain_to_process_ms === null
        ? null
        : Number(row.chain_to_process_ms),
  };
}

function normalizeExceptionReasonCode(exceptionType: string) {
  switch (exceptionType) {
    case 'unexpected_observation':
      return 'unexpected_destination';
    case 'unallocated_residual':
      return 'residual_amount';
    default:
      return exceptionType;
  }
}

export function getAvailableExceptionActions(status: string) {
  const actions: ExceptionAction[] = [];
  for (const action of ['reviewed', 'expected', 'dismissed', 'reopen'] as const) {
    if (isExceptionActionAllowed(status, action)) {
      actions.push(action);
    }
  }
  return actions;
}

function applyExceptionStateOverlay(
  row: ExceptionRow,
  state: {
    status: string;
    updatedAt: Date;
  } | null,
): ExceptionRow {
  if (!state) {
    return row;
  }

  const updatedAt = state.updatedAt.toISOString();
  return {
    ...row,
    status: state.status,
    processed_at: updatedAt,
    updated_at: updatedAt,
    chain_to_process_ms: null,
  };
}

async function getExceptionStateMap(workspaceId: string, exceptionIds: string[]) {
  if (!exceptionIds.length) {
    return new Map<
      string,
      {
        status: string;
        updatedAt: Date;
      }
    >();
  }

  const states = await prisma.exceptionState.findMany({
    where: {
      workspaceId,
      exceptionId: {
        in: exceptionIds,
      },
    },
    select: {
      exceptionId: true,
      status: true,
      updatedAt: true,
    },
  });

  return new Map(
    states.map((state) => [
      state.exceptionId,
      {
        status: state.status,
        updatedAt: state.updatedAt,
      },
    ]),
  );
}

async function querySettlementMatches(workspaceId: string, transferRequestIds: string[]) {
  if (!transferRequestIds.length) {
    return [] as SettlementMatchRow[];
  }

  const ids = transferRequestIds.map((id) => `toUUID('${escapeClickHouseString(id)}')`).join(', ');
  return queryClickHouse<SettlementMatchRow>(`
    SELECT
      transfer_request_id,
      signature,
      observed_transfer_id,
      match_status,
      confidence_score,
      confidence_band,
      matched_amount_raw,
      amount_variance_raw,
      destination_match_type,
      time_delta_seconds,
      match_rule,
      candidate_count,
      explanation,
      observed_event_time,
      matched_at,
      if(isNull(observed_event_time) OR isNull(matched_at), NULL, dateDiff('millisecond', observed_event_time, matched_at)) AS chain_to_match_ms,
      updated_at
    FROM ${config.clickhouseDatabase}.settlement_matches FINAL
    WHERE workspace_id = toUUID('${workspaceId}')
      AND transfer_request_id IN (${ids})
    ORDER BY updated_at DESC
    LIMIT 1 BY transfer_request_id
    FORMAT JSONEachRow
  `);
}

async function queryExceptions(workspaceId: string, transferRequestIds: string[]) {
  if (!transferRequestIds.length) {
    return [] as ExceptionRow[];
  }

  const ids = transferRequestIds.map((id) => `toUUID('${escapeClickHouseString(id)}')`).join(', ');
  const rows = await queryClickHouse<ExceptionRow>(`
    SELECT
      exception_id,
      transfer_request_id,
      signature,
      observed_transfer_id,
      exception_type,
      severity,
      status,
      explanation,
      properties_json,
      observed_event_time,
      processed_at,
      if(isNull(observed_event_time) OR isNull(processed_at), NULL, dateDiff('millisecond', observed_event_time, processed_at)) AS chain_to_process_ms,
      created_at,
      updated_at
    FROM ${config.clickhouseDatabase}.exceptions FINAL
    WHERE workspace_id = toUUID('${workspaceId}')
      AND transfer_request_id IN (${ids})
    ORDER BY updated_at DESC
    LIMIT 1 BY exception_id
    FORMAT JSONEachRow
  `);

  const stateMap = await getExceptionStateMap(
    workspaceId,
    rows.map((row) => row.exception_id),
  );

  return rows.map((row) => applyExceptionStateOverlay(row, stateMap.get(row.exception_id) ?? null));
}

async function queryExceptionById(workspaceId: string, exceptionId: string) {
  const rows = await queryClickHouse<ExceptionRow>(`
    SELECT
      exception_id,
      transfer_request_id,
      signature,
      observed_transfer_id,
      exception_type,
      severity,
      status,
      explanation,
      properties_json,
      observed_event_time,
      processed_at,
      created_at,
      updated_at
    FROM ${config.clickhouseDatabase}.exceptions FINAL
    WHERE workspace_id = toUUID('${workspaceId}')
      AND exception_id = toUUID('${exceptionId}')
    ORDER BY updated_at DESC
    LIMIT 1
    FORMAT JSONEachRow
  `);

  const row = rows[0] ?? null;
  if (!row) {
    return null;
  }

  const state = await prisma.exceptionState.findUnique({
    where: {
      workspaceId_exceptionId: {
        workspaceId,
        exceptionId,
      },
    },
    select: {
      status: true,
      updatedAt: true,
    },
  });

  return applyExceptionStateOverlay(row, state);
}

async function queryExceptionsByWorkspace(args: {
  workspaceId: string;
  severity?: string;
}) {
  const clauses = [`workspace_id = toUUID('${args.workspaceId}')`];
  if (args.severity) {
    clauses.push(`severity = '${escapeClickHouseString(args.severity)}'`);
  }

  const rows = await queryClickHouse<ExceptionRow>(`
    SELECT
      exception_id,
      transfer_request_id,
      signature,
      observed_transfer_id,
      exception_type,
      severity,
      status,
      explanation,
      properties_json,
      observed_event_time,
      processed_at,
      if(isNull(observed_event_time) OR isNull(processed_at), NULL, dateDiff('millisecond', observed_event_time, processed_at)) AS chain_to_process_ms,
      created_at,
      updated_at
    FROM ${config.clickhouseDatabase}.exceptions FINAL
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT 1 BY exception_id
    FORMAT JSONEachRow
  `);

  const stateMap = await getExceptionStateMap(
    args.workspaceId,
    rows.map((row) => row.exception_id),
  );

  return rows.map((row) => applyExceptionStateOverlay(row, stateMap.get(row.exception_id) ?? null));
}

async function queryObservedTransfersByIds(transferIds: string[]) {
  if (!transferIds.length) {
    return [];
  }

  const ids = transferIds.map((value) => `toUUID('${escapeClickHouseString(value)}')`).join(', ');
  const rows = await queryClickHouse<ObservedTransferRow>(`
    SELECT
      transfer_id,
      signature,
      slot,
      event_time,
      asset,
      source_token_account,
      source_wallet,
      destination_token_account,
      destination_wallet,
      amount_raw,
      amount_decimal,
      transfer_kind,
      instruction_index,
      inner_instruction_index,
      route_group,
      leg_role,
      properties_json,
      created_at
    FROM ${config.clickhouseDatabase}.observed_transfers
    WHERE transfer_id IN (${ids})
    ORDER BY event_time ASC
    FORMAT JSONEachRow
  `);

  return rows.map((row) => ({
    transferId: row.transfer_id,
    signature: row.signature,
    slot: Number(row.slot),
    eventTime: normalizeClickHouseDateTime(row.event_time)!,
    asset: row.asset,
    sourceTokenAccount: row.source_token_account,
    sourceWallet: row.source_wallet,
    destinationTokenAccount: row.destination_token_account,
    destinationWallet: row.destination_wallet,
    amountRaw: row.amount_raw,
    amountDecimal: row.amount_decimal,
    transferKind: row.transfer_kind,
    instructionIndex: row.instruction_index === null ? null : Number(row.instruction_index),
    innerInstructionIndex:
      row.inner_instruction_index === null ? null : Number(row.inner_instruction_index),
    routeGroup: row.route_group,
    legRole: row.leg_role,
    propertiesJson: safeJsonParse(row.properties_json),
    createdAt: normalizeClickHouseDateTime(row.created_at)!,
  }));
}

async function queryObservedPaymentById(paymentId: string) {
  const rows = await queryClickHouse<ObservedPaymentRow>(`
    SELECT
      payment_id,
      signature,
      slot,
      event_time,
      asset,
      source_wallet,
      destination_wallet,
      gross_amount_raw,
      gross_amount_decimal,
      net_destination_amount_raw,
      net_destination_amount_decimal,
      fee_amount_raw,
      fee_amount_decimal,
      route_count,
      payment_kind,
      reconstruction_rule,
      confidence_band,
      properties_json,
      created_at
    FROM ${config.clickhouseDatabase}.observed_payments
    WHERE payment_id = toUUID('${escapeClickHouseString(paymentId)}')
    LIMIT 1
    FORMAT JSONEachRow
  `);

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    paymentId: row.payment_id,
    signature: row.signature,
    slot: Number(row.slot),
    eventTime: normalizeClickHouseDateTime(row.event_time)!,
    asset: row.asset,
    sourceWallet: row.source_wallet,
    destinationWallet: row.destination_wallet,
    grossAmountRaw: row.gross_amount_raw,
    grossAmountDecimal: row.gross_amount_decimal,
    netDestinationAmountRaw: row.net_destination_amount_raw,
    netDestinationAmountDecimal: row.net_destination_amount_decimal,
    feeAmountRaw: row.fee_amount_raw,
    feeAmountDecimal: row.fee_amount_decimal,
    routeCount: Number(row.route_count),
    paymentKind: row.payment_kind,
    reconstructionRule: row.reconstruction_rule,
    confidenceBand: row.confidence_band,
    propertiesJson: safeJsonParse(row.properties_json),
    createdAt: normalizeClickHouseDateTime(row.created_at)!,
  };
}

async function queryObservedPaymentsBySignature(signature: string) {
  const rows = await queryClickHouse<ObservedPaymentRow>(`
    SELECT
      payment_id,
      signature,
      slot,
      event_time,
      asset,
      source_wallet,
      destination_wallet,
      gross_amount_raw,
      gross_amount_decimal,
      net_destination_amount_raw,
      net_destination_amount_decimal,
      fee_amount_raw,
      fee_amount_decimal,
      route_count,
      payment_kind,
      reconstruction_rule,
      confidence_band,
      properties_json,
      created_at
    FROM ${config.clickhouseDatabase}.observed_payments
    WHERE signature = '${escapeClickHouseString(signature)}'
    ORDER BY event_time ASC, payment_id ASC
    FORMAT JSONEachRow
  `);

  return rows.map((row) => ({
    paymentId: row.payment_id,
    signature: row.signature,
    slot: Number(row.slot),
    eventTime: normalizeClickHouseDateTime(row.event_time)!,
    asset: row.asset,
    sourceWallet: row.source_wallet,
    destinationWallet: row.destination_wallet,
    grossAmountRaw: row.gross_amount_raw,
    grossAmountDecimal: row.gross_amount_decimal,
    netDestinationAmountRaw: row.net_destination_amount_raw,
    netDestinationAmountDecimal: row.net_destination_amount_decimal,
    feeAmountRaw: row.fee_amount_raw,
    feeAmountDecimal: row.fee_amount_decimal,
    routeCount: Number(row.route_count),
    paymentKind: row.payment_kind,
    reconstructionRule: row.reconstruction_rule,
    confidenceBand: row.confidence_band,
    propertiesJson: safeJsonParse(row.properties_json),
    createdAt: normalizeClickHouseDateTime(row.created_at)!,
  }));
}

async function queryObservedPaymentsBySignatures(signatures: string[]) {
  const uniqueSignatures = uniqueValues(signatures.filter(Boolean));
  if (!uniqueSignatures.length) {
    return [] as Array<Awaited<ReturnType<typeof queryObservedPaymentById>> extends infer T ? NonNullable<T> : never>;
  }

  const response = await queryClickHouse<ObservedPaymentRow>(
    `
      SELECT
        payment_id,
        signature,
        slot,
        event_time,
        asset,
        source_wallet,
        destination_wallet,
        gross_amount_raw,
        gross_amount_decimal,
        net_destination_amount_raw,
        net_destination_amount_decimal,
        fee_amount_raw,
        fee_amount_decimal,
        route_count,
        payment_kind,
        reconstruction_rule,
        confidence_band,
        properties_json,
        created_at
      FROM ${config.clickhouseDatabase}.observed_payments
      WHERE signature IN (${uniqueSignatures.map((signature) => `'${signature}'`).join(', ')})
      FORMAT JSONEachRow
    `,
  );

  return response.map((row) => serializeObservedPayment(row));
}

async function hydrateAddressLabelsForQueueItems(
  items: Array<ReturnType<typeof buildQueueItems>[number]>,
) {
  const signaturesToHydrate = uniqueValues(
    items
      .filter((item) =>
        item.linkedSignature
        && (item.requestDisplayState === 'partial' || item.requestDisplayState === 'exception'),
      )
      .map((item) => item.linkedSignature)
      .filter((value): value is string => Boolean(value)),
  );

  if (!signaturesToHydrate.length) {
    return;
  }

  const relatedPayments = await queryObservedPaymentsBySignatures(signaturesToHydrate);
  const destinationWallets = uniqueValues(
    relatedPayments
      .map((payment) => payment.destinationWallet)
      .filter((value): value is string => Boolean(value)),
  );

  if (!destinationWallets.length) {
    return;
  }

  await getOrResolveAddressLabels('solana', destinationWallets);
}

function safeJsonParse(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function escapeClickHouseString(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function uniqueValues(values: string[]) {
  return [...new Set(values)];
}

function serializeObservedPayment(row: ObservedPaymentRow) {
  return {
    paymentId: row.payment_id,
    signature: row.signature,
    slot: Number(row.slot),
    eventTime: normalizeClickHouseDateTime(row.event_time)!,
    asset: row.asset,
    sourceWallet: row.source_wallet,
    destinationWallet: row.destination_wallet,
    grossAmountRaw: row.gross_amount_raw,
    grossAmountDecimal: row.gross_amount_decimal,
    netDestinationAmountRaw: row.net_destination_amount_raw,
    netDestinationAmountDecimal: row.net_destination_amount_decimal,
    feeAmountRaw: row.fee_amount_raw,
    feeAmountDecimal: row.fee_amount_decimal,
    routeCount: Number(row.route_count),
    paymentKind: row.payment_kind,
    reconstructionRule: row.reconstruction_rule,
    confidenceBand: row.confidence_band,
    propertiesJson: safeJsonParse(row.properties_json),
    createdAt: normalizeClickHouseDateTime(row.created_at)!,
  };
}

function normalizeRoleTags(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function formatRawUsdc(amountRaw: string) {
  const negative = amountRaw.startsWith('-');
  const digits = negative ? amountRaw.slice(1) : amountRaw;
  const padded = digits.padStart(7, '0');
  const whole = padded.slice(0, -6) || '0';
  const fraction = padded.slice(-6);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
