export type User = {
  userId: string;
  email: string;
  displayName: string;
};

export type Workspace = {
  workspaceId: string;
  organizationId?: string;
  workspaceName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationMembership = {
  organizationId: string;
  organizationName: string;
  role: string;
  status: string;
  workspaces: Workspace[];
};

export type WorkspaceMember = {
  membershipId: string;
  role: string;
  status: string;
  user: User;
};

export type OrganizationDirectoryItem = {
  organizationId: string;
  organizationName: string;
  status: string;
  workspaceCount: number;
  isMember: boolean;
  membershipRole: string | null;
};

export type AuthenticatedSession = {
  authenticated: true;
  user: User;
  organizations: OrganizationMembership[];
};

export type LoginResponse = {
  status: 'authenticated';
  sessionToken: string;
  user: User;
  organizations: OrganizationMembership[];
};

export type WorkspaceAddress = {
  workspaceAddressId: string;
  workspaceId: string;
  chain: string;
  address: string;
  addressKind: string;
  assetScope: string;
  usdcAtaAddress: string | null;
  isActive: boolean;
  source: string;
  sourceRef: string | null;
  displayName: string | null;
  notes: string | null;
  propertiesJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceAddressLite = {
  workspaceAddressId: string;
  address: string;
  usdcAtaAddress: string | null;
  addressKind: string;
  displayName: string | null;
  notes: string | null;
};

export type Counterparty = {
  counterpartyId: string;
  organizationId: string;
  displayName: string;
  category: string;
  externalReference: string | null;
  status: string;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type Destination = {
  destinationId: string;
  workspaceId: string;
  counterpartyId: string | null;
  linkedWorkspaceAddressId: string | null;
  chain: string;
  asset: string;
  walletAddress: string;
  tokenAccountAddress: string | null;
  destinationType: string;
  trustState: 'unreviewed' | 'trusted' | 'restricted' | 'blocked';
  label: string;
  notes: string | null;
  isInternal: boolean;
  isActive: boolean;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  counterparty: Counterparty | null;
  linkedWorkspaceAddress: WorkspaceAddressLite | null;
};

export type ApprovalPolicyRule = {
  requireTrustedDestination: boolean;
  requireApprovalForExternal: boolean;
  requireApprovalForInternal: boolean;
  externalApprovalThresholdRaw: string;
  internalApprovalThresholdRaw: string;
};

export type ApprovalPolicy = {
  approvalPolicyId: string;
  workspaceId: string;
  policyName: string;
  isActive: boolean;
  ruleJson: ApprovalPolicyRule;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalReason = {
  code: string;
  message: string;
};

export type ApprovalEvaluation = {
  approvalPolicyId: string | null;
  policyName: string;
  isActive: boolean;
  requiresApproval: boolean;
  rules: ApprovalPolicyRule;
  reasons: ApprovalReason[];
};

export type ApprovalDecision = {
  approvalDecisionId: string;
  approvalPolicyId: string | null;
  transferRequestId: string;
  workspaceId: string;
  actorUserId: string | null;
  actorType: string;
  action: 'routed_for_approval' | 'auto_approved' | 'approve' | 'reject' | 'escalate';
  comment: string | null;
  payloadJson: Record<string, unknown>;
  createdAt: string;
  actorUser: User | null;
  approvalPolicy: ApprovalPolicy | null;
};

export type TransferRequest = {
  transferRequestId: string;
  workspaceId: string;
  sourceWorkspaceAddressId: string | null;
  destinationWorkspaceAddressId: string;
  destinationId: string | null;
  requestType: string;
  asset: string;
  amountRaw: string;
  requestedByUserId: string | null;
  reason: string | null;
  externalReference: string | null;
  status: string;
  requestedAt: string;
  dueAt: string | null;
  propertiesJson: Record<string, unknown>;
  sourceWorkspaceAddress: WorkspaceAddressLite | null;
  destinationWorkspaceAddress: WorkspaceAddressLite | null;
  destination: Destination | null;
};

export type ExecutionRecord = {
  executionRecordId: string;
  transferRequestId: string;
  workspaceId: string;
  submittedSignature: string | null;
  executionSource: string;
  executorUserId: string | null;
  state:
    | 'ready_for_execution'
    | 'submitted_onchain'
    | 'broadcast_failed'
    | 'observed'
    | 'settled'
    | 'execution_exception';
  submittedAt: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  executorUser: User | null;
};

export type ObservedExecutionTransaction = {
  signature: string;
  slot: number;
  eventTime: string;
  status: string;
  createdAt: string;
};

export type TransferRequestEvent = {
  transferRequestEventId: string;
  transferRequestId: string;
  workspaceId: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  eventSource: string;
  beforeState: string | null;
  afterState: string | null;
  linkedSignature: string | null;
  linkedPaymentId: string | null;
  linkedTransferIds: string[];
  payloadJson: Record<string, unknown>;
  createdAt: string;
};

export type TransferRequestNote = {
  transferRequestNoteId: string;
  transferRequestId: string;
  workspaceId: string;
  body: string;
  createdAt: string;
  authorUser: User | null;
};

export type ObservedTransfer = {
  transferId: string;
  signature: string;
  slot: number;
  eventTime: string;
  asset: string;
  sourceTokenAccount: string | null;
  sourceWallet: string | null;
  destinationTokenAccount: string;
  destinationWallet: string | null;
  amountRaw: string;
  amountDecimal: string;
  transferKind: string;
  instructionIndex: number | null;
  innerInstructionIndex: number | null;
  routeGroup: string;
  legRole: string;
  propertiesJson: Record<string, unknown> | string | null;
  createdAt: string;
  chainToWriteMs: number;
};

export type ReconciliationRow = {
  transferRequestId: string;
  workspaceId: string;
  sourceWorkspaceAddressId: string | null;
  destinationWorkspaceAddressId: string;
  destinationId: string | null;
  requestType: string;
  asset: string;
  amountRaw: string;
  status: string;
  requestedAt: string;
  dueAt: string | null;
  reason: string | null;
  externalReference: string | null;
  propertiesJson: Record<string, unknown>;
  requestedByUser: User | null;
  sourceWorkspaceAddress: WorkspaceAddressLite | null;
  destinationWorkspaceAddress: WorkspaceAddressLite | null;
  destination: Destination | null;
  approvalState: 'draft' | 'submitted' | 'pending_approval' | 'escalated' | 'approved' | 'closed' | 'rejected';
  executionState:
    | 'not_started'
    | 'ready_for_execution'
    | 'submitted_onchain'
    | 'broadcast_failed'
    | 'observed'
    | 'settled'
    | 'execution_exception'
    | 'closed'
    | 'rejected';
  latestExecution: ExecutionRecord | null;
  executionRecords: ExecutionRecord[];
  requestDisplayState: 'pending' | 'matched' | 'partial' | 'exception';
  availableTransitions: string[];
  linkedSignature: string | null;
  linkedPaymentId: string | null;
  linkedTransferIds: string[];
  match: {
    signature: string | null;
    observedTransferId: string | null;
    matchStatus: string;
    confidenceScore: number;
    confidenceBand: string;
    matchedAmountRaw: string;
    amountVarianceRaw: string;
    destinationMatchType: string;
    timeDeltaSeconds: number;
    matchRule: string;
    candidateCount: number;
    explanation: string;
    observedEventTime: string | null;
    matchedAt: string | null;
    updatedAt: string;
    chainToMatchMs: number | null;
  } | null;
  matchExplanation: string | null;
  exceptionExplanation: string | null;
  exceptions: ExceptionItem[];
};

export type ApprovalInboxItem = ReconciliationRow & {
  approvalEvaluation: ApprovalEvaluation;
};

export type ExceptionItem = {
  exceptionId: string;
  transferRequestId: string | null;
  signature: string | null;
  observedTransferId: string | null;
  exceptionType: string;
  reasonCode: string;
  severity: string;
  status: string;
  resolutionCode: string | null;
  assignedToUserId: string | null;
  assignedToUser: User | null;
  explanation: string;
  propertiesJson: Record<string, unknown> | string | null;
  observedEventTime: string | null;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
  chainToProcessMs: number | null;
  notes?: ExceptionNote[];
  availableActions?: ('reviewed' | 'expected' | 'dismissed' | 'reopen')[];
};

export type ExceptionNote = {
  exceptionNoteId: string;
  exceptionId: string;
  workspaceId: string;
  body: string;
  createdAt: string;
  authorUser: User | null;
};

export type ObservedPayment = {
  paymentId: string;
  signature: string;
  slot: number;
  eventTime: string;
  asset: string;
  sourceWallet: string | null;
  destinationWallet: string | null;
  grossAmountRaw: string;
  grossAmountDecimal: string;
  netDestinationAmountRaw: string;
  netDestinationAmountDecimal: string;
  feeAmountRaw: string;
  feeAmountDecimal: string;
  routeCount: number;
  paymentKind: string;
  reconstructionRule: string;
  confidenceBand: string;
  propertiesJson: Record<string, unknown> | string | null;
  createdAt: string;
  recipientRole?: 'expected_destination' | 'known_fee_recipient' | 'other_destination';
  destinationLabel?: string | null;
};

export type ReconciliationTimelineItem =
  | {
      timelineType: 'request_event';
      createdAt: string;
      eventType: string;
      actorType: string;
      actorId: string | null;
      eventSource: string;
      beforeState: string | null;
      afterState: string | null;
      linkedSignature: string | null;
      linkedPaymentId: string | null;
      linkedTransferIds: string[];
      payloadJson: Record<string, unknown>;
    }
  | {
      timelineType: 'request_note';
      createdAt: string;
      body: string;
      authorUser: User | null;
    }
  | {
      timelineType: 'approval_decision';
      createdAt: string;
      action: string;
      comment: string | null;
      actorUser: User | null;
      payloadJson: Record<string, unknown>;
    }
  | {
      timelineType: 'execution_record';
      createdAt: string;
      state: string;
      executionSource: string;
      submittedSignature: string | null;
      executorUser: User | null;
    }
  | {
      timelineType: 'observed_execution';
      createdAt: string;
      signature: string;
      slot: number;
      status: string;
    }
  | {
      timelineType: 'match_result';
      createdAt: string;
      matchStatus: string;
      explanation: string;
      linkedSignature: string | null;
      linkedTransferIds: string[];
    }
  | {
      timelineType: 'exception';
      createdAt: string;
      exceptionId: string;
      reasonCode: string;
      severity: string;
      status: string;
      explanation: string;
      linkedSignature: string | null;
      linkedTransferIds: string[];
      notes: ExceptionNote[];
    };

export type ReconciliationDetail = ReconciliationRow & {
  observedExecutionTransaction: ObservedExecutionTransaction | null;
  linkedObservedTransfers: ObservedTransfer[];
  linkedObservedPayment: ObservedPayment | null;
  relatedObservedPayments: ObservedPayment[];
  approvalPolicy: ApprovalPolicy;
  approvalEvaluation: ApprovalEvaluation;
  approvalDecisions: ApprovalDecision[];
  events: TransferRequestEvent[];
  notes: TransferRequestNote[];
  timeline: ReconciliationTimelineItem[];
  availableTransitions: string[];
};

export type ExportJob = {
  exportJobId: string;
  workspaceId: string;
  requestedByUserId: string | null;
  exportKind: string;
  format: 'csv' | 'json';
  status: string;
  rowCount: number;
  filterJson: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
  requestedByUser: User | null;
};

export type OpsHealth = {
  postgres: string;
  workerStatus: 'healthy' | 'degraded' | 'stale' | 'offline';
  latestSlot: number | null;
  latestEventTime: string | null;
  latestWorkerReceivedAt: string | null;
  latestTxWriteAt: string | null;
  latestMatchAt: string | null;
  workerFreshnessMs: number | null;
  observedTransactionCount: number;
  matchCount: number;
  openExceptionCount: number;
  latencies: {
    yellowstoneToWorkerMs: { p50: number | null; p95: number | null };
    chainToWriteMs: { p50: number | null; p95: number | null };
    chainToMatchMs: { p50: number | null; p95: number | null };
  };
};
