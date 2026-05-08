export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'ready_for_execution',
  'submitted_onchain',
  'matched',
  'exception',
  'closed',
  'rejected',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const CREATE_REQUEST_STATUSES = ['draft', 'submitted'] as const;

export const USER_MUTABLE_REQUEST_STATUSES = [
  'submitted',
  'ready_for_execution',
  'submitted_onchain',
  'closed',
  'rejected',
] as const;

export const ACTIVE_MATCHING_REQUEST_STATUSES = [
  'approved',
  'ready_for_execution',
  'submitted_onchain',
] as const satisfies readonly RequestStatus[];

export const REQUEST_DISPLAY_STATES = ['pending', 'matched', 'partial', 'exception'] as const;
export type RequestDisplayState = (typeof REQUEST_DISPLAY_STATES)[number];
export const APPROVAL_STATES = ['draft', 'submitted', 'approved', 'closed', 'rejected'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const EXECUTION_STATES = [
  'not_started',
  'ready_for_execution',
  'submitted_onchain',
  'broadcast_failed',
  'settled',
  'execution_exception',
  'closed',
  'rejected',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];
export const EXCEPTION_ACTIONS = ['reviewed', 'expected', 'dismissed', 'reopen'] as const;
export type ExceptionAction = (typeof EXCEPTION_ACTIONS)[number];

const REQUEST_STATUS_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  draft: ['submitted'],
  submitted: ['approved'],
  approved: ['ready_for_execution'],
  ready_for_execution: ['submitted_onchain'],
  submitted_onchain: ['matched', 'exception'],
  matched: ['closed'],
  exception: ['matched', 'closed'],
  closed: [],
  rejected: [],
};

const USER_ALLOWED_REQUEST_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  draft: ['submitted'],
  submitted: [],
  approved: [],
  ready_for_execution: [],
  submitted_onchain: [],
  matched: ['closed'],
  exception: ['closed'],
  closed: [],
  rejected: [],
};

const ACTIVE_EXCEPTION_STATUSES = new Set(['open', 'reviewed', 'expected', 'reopened']);
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

export function deriveApprovalState(requestStatus: string): ApprovalState {
  switch (requestStatus) {
    case 'draft':
      return 'draft';
    case 'submitted':
      return 'submitted';
    case 'rejected':
      return 'rejected';
    case 'closed':
      return 'closed';
    default:
      return 'approved';
  }
}

export function deriveExecutionState(args: {
  requestStatus: string;
  executionState?: string | null;
  submittedSignature?: string | null;
  hasObservedTransaction?: boolean;
  matchStatus?: string | null;
  exceptionStatuses?: string[];
}): ExecutionState {
  const {
    requestStatus,
    executionState,
    submittedSignature,
    hasObservedTransaction = false,
    matchStatus,
    exceptionStatuses = [],
  } = args;
  const hasActiveException = exceptionStatuses.some((status) => ACTIVE_EXCEPTION_STATUSES.has(status));
  const hasObservedSettlement =
    hasObservedTransaction
    || Boolean(matchStatus)
    || hasActiveException;

  if (requestStatus === 'closed') {
    return 'closed';
  }

  if (requestStatus === 'rejected') {
    return 'rejected';
  }

  if (hasActiveException && (hasObservedSettlement || Boolean(submittedSignature))) {
    return 'execution_exception';
  }

  if (executionState === 'settled' || requestStatus === 'matched') {
    return 'settled';
  }

  if (executionState === 'broadcast_failed') {
    return 'broadcast_failed';
  }

  if (executionState === 'submitted_onchain' || requestStatus === 'submitted_onchain' || Boolean(submittedSignature)) {
    return 'submitted_onchain';
  }

  if (executionState === 'ready_for_execution' || requestStatus === 'approved' || requestStatus === 'ready_for_execution') {
    return 'ready_for_execution';
  }

  return 'not_started';
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

  if (matchStatus === 'rpc_verified' || requestStatus === 'matched' || requestStatus === 'closed') {
    return 'matched' satisfies RequestDisplayState;
  }

  return 'pending' satisfies RequestDisplayState;
}

export function getAvailableOperatorTransitions(args: {
  requestStatus: RequestStatus;
  requestDisplayState: RequestDisplayState;
}) {
  const { requestStatus, requestDisplayState } = args;

  if (requestStatus === 'closed' || requestStatus === 'rejected') {
    return [] as RequestStatus[];
  }

  if (requestDisplayState !== 'pending') {
    return ['closed'] as RequestStatus[];
  }

  return getAvailableUserTransitions(requestStatus);
}
