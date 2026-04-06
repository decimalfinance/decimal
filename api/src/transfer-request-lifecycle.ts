export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'pending_approval',
  'approved',
  'ready_for_execution',
  'submitted_onchain',
  'observed',
  'matched',
  'partially_matched',
  'exception',
  'closed',
  'rejected',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const CREATE_REQUEST_STATUSES = ['draft', 'submitted'] as const;

export const USER_MUTABLE_REQUEST_STATUSES = [
  'submitted',
  'pending_approval',
  'approved',
  'ready_for_execution',
  'submitted_onchain',
  'closed',
  'rejected',
] as const;

export const ACTIVE_MATCHING_REQUEST_STATUSES = [
  'submitted',
  'pending_approval',
  'approved',
  'ready_for_execution',
  'submitted_onchain',
  'observed',
  'partially_matched',
  'exception',
] as const satisfies readonly RequestStatus[];

export const REQUEST_DISPLAY_STATES = ['pending', 'matched', 'partial', 'exception'] as const;
export type RequestDisplayState = (typeof REQUEST_DISPLAY_STATES)[number];
export const EXCEPTION_ACTIONS = ['reviewed', 'expected', 'dismissed', 'reopen'] as const;
export type ExceptionAction = (typeof EXCEPTION_ACTIONS)[number];

const REQUEST_STATUS_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  draft: ['submitted'],
  submitted: ['pending_approval'],
  pending_approval: ['approved', 'rejected'],
  approved: ['ready_for_execution'],
  ready_for_execution: ['submitted_onchain'],
  submitted_onchain: ['observed'],
  observed: ['matched', 'partially_matched', 'exception'],
  matched: ['closed'],
  partially_matched: ['matched', 'exception'],
  exception: ['matched', 'closed'],
  closed: [],
  rejected: [],
};

const USER_ALLOWED_REQUEST_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  draft: ['submitted'],
  submitted: ['pending_approval'],
  pending_approval: ['approved', 'rejected'],
  approved: ['ready_for_execution'],
  ready_for_execution: ['submitted_onchain'],
  submitted_onchain: [],
  observed: [],
  matched: ['closed'],
  partially_matched: [],
  exception: ['closed'],
  closed: [],
  rejected: [],
};

const ACTIVE_EXCEPTION_STATUSES = new Set(['open', 'reviewed', 'expected', 'reopened']);
const PRE_SETTLEMENT_REQUEST_STATUSES = new Set<RequestStatus>([
  'draft',
  'submitted',
  'pending_approval',
  'approved',
  'ready_for_execution',
  'submitted_onchain',
]);
const POST_SETTLEMENT_REQUEST_STATUSES = new Set<RequestStatus>([
  'observed',
  'matched',
  'partially_matched',
  'exception',
  'closed',
]);
const EXCEPTION_ACTION_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  open: ['reviewed', 'expected', 'dismissed'],
  reviewed: ['expected', 'dismissed'],
  expected: ['reviewed', 'dismissed'],
  reopened: ['reviewed', 'expected', 'dismissed'],
  dismissed: ['reopened'],
};

export function isRequestStatus(value: string): value is RequestStatus {
  return REQUEST_STATUSES.includes(value as RequestStatus);
}

export function isRequestStatusTransitionAllowed(from: RequestStatus, to: RequestStatus) {
  return REQUEST_STATUS_TRANSITIONS[from].includes(to);
}

export function isUserRequestStatusTransitionAllowed(from: RequestStatus, to: RequestStatus) {
  return USER_ALLOWED_REQUEST_TRANSITIONS[from].includes(to);
}

export function getAvailableUserTransitions(status: RequestStatus) {
  return [...USER_ALLOWED_REQUEST_TRANSITIONS[status]];
}

export function buildSystemProjectionPath(args: {
  currentStatus: RequestStatus;
  targetStatus: RequestStatus | null;
}) {
  const { currentStatus, targetStatus } = args;
  if (!targetStatus || currentStatus === targetStatus) {
    return [] as RequestStatus[];
  }

  if (currentStatus === 'closed' || currentStatus === 'rejected') {
    return [] as RequestStatus[];
  }

  const path: RequestStatus[] = [];
  let cursor = currentStatus;

  if (
    targetStatus !== 'observed' &&
    PRE_SETTLEMENT_REQUEST_STATUSES.has(cursor) &&
    POST_SETTLEMENT_REQUEST_STATUSES.has(targetStatus)
  ) {
    path.push('observed');
    cursor = 'observed';
  }

  if (cursor !== targetStatus) {
    path.push(targetStatus);
  }

  return path;
}

export function deriveProjectedSettlementStatus(args: {
  currentStatus: RequestStatus;
  matchStatus?: string | null;
  exceptionStatuses?: string[];
}) {
  const { currentStatus, matchStatus, exceptionStatuses = [] } = args;

  if (currentStatus === 'closed' || currentStatus === 'rejected') {
    return null;
  }

  const hasActiveException = exceptionStatuses.some((status) => ACTIVE_EXCEPTION_STATUSES.has(status));
  if (hasActiveException) {
    return 'exception' satisfies RequestStatus;
  }

  if (matchStatus === 'matched_partial') {
    return 'partially_matched' satisfies RequestStatus;
  }

  if (matchStatus === 'matched_exact' || matchStatus === 'matched_split') {
    return 'matched' satisfies RequestStatus;
  }

  return null;
}

export function getTargetExceptionStatusForAction(action: ExceptionAction) {
  switch (action) {
    case 'reviewed':
      return 'reviewed';
    case 'expected':
      return 'expected';
    case 'dismissed':
      return 'dismissed';
    case 'reopen':
      return 'reopened';
  }
}

export function isExceptionActionAllowed(currentStatus: string, action: ExceptionAction) {
  const nextStatus = getTargetExceptionStatusForAction(action);
  return EXCEPTION_ACTION_STATUS_TRANSITIONS[currentStatus]?.includes(nextStatus) ?? false;
}

export function deriveRequestDisplayState(args: {
  requestStatus: string;
  matchStatus?: string | null;
  exceptionStatuses?: string[];
}) {
  const { requestStatus, matchStatus, exceptionStatuses = [] } = args;
  const hasActiveException = exceptionStatuses.some((status) => ACTIVE_EXCEPTION_STATUSES.has(status));

  if (hasActiveException || requestStatus === 'exception') {
    return 'exception' satisfies RequestDisplayState;
  }

  if (matchStatus === 'matched_partial' || requestStatus === 'partially_matched') {
    return 'partial' satisfies RequestDisplayState;
  }

  if (
    matchStatus === 'matched_exact' ||
    matchStatus === 'matched_split' ||
    requestStatus === 'matched' ||
    requestStatus === 'closed'
  ) {
    return 'matched' satisfies RequestDisplayState;
  }

  return 'pending' satisfies RequestDisplayState;
}
