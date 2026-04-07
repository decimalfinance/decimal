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

export type TransferRequest = {
  transferRequestId: string;
  workspaceId: string;
  sourceWorkspaceAddressId: string | null;
  destinationWorkspaceAddressId: string;
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
  requestDisplayState: 'pending' | 'matched' | 'partial' | 'exception';
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

export type ExceptionItem = {
  exceptionId: string;
  transferRequestId: string | null;
  signature: string | null;
  observedTransferId: string | null;
  exceptionType: string;
  reasonCode: string;
  severity: string;
  status: string;
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
  linkedObservedTransfers: ObservedTransfer[];
  linkedObservedPayment: ObservedPayment | null;
  relatedObservedPayments: ObservedPayment[];
  events: TransferRequestEvent[];
  notes: TransferRequestNote[];
  timeline: ReconciliationTimelineItem[];
  availableTransitions: string[];
};
