export type User = {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  emailVerifiedAt: string | null;
};

export type Organization = {
  organizationId: string;
  organizationName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationMembership = {
  organizationId: string;
  organizationName: string;
  role: string;
  status: string;
};

export type OrganizationSummary = {
  pendingApprovalCount: number;
  executionQueueCount: number;
  paymentsIncompleteCount: number;
  collectionsOpenCount: number;
  destinationsUnreviewedCount: number;
  payersUnreviewedCount: number;
  generatedAt: string;
};

export type OrganizationMember = {
  membershipId: string;
  role: string;
  status: string;
  user: User;
};

export type OrganizationInviteRole = 'admin' | 'member';
export type OrganizationInviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type OrganizationInvite = {
  organizationInviteId: string;
  organizationId: string;
  invitedEmail: string;
  role: OrganizationInviteRole;
  status: OrganizationInviteStatus;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  organization: {
    organizationId: string;
    organizationName: string;
    status: string;
  };
  invitedByUser: {
    userId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
  acceptedByUser: {
    userId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
};

export type CreateOrganizationInviteResponse = OrganizationInvite & {
  inviteToken: string;
  inviteLink: string;
};

export type PublicInvite = {
  organizationInviteId: string;
  invitedEmail: string;
  role: OrganizationInviteRole;
  status: OrganizationInviteStatus;
  expiresAt: string;
  organization: {
    organizationId: string;
    organizationName: string;
    status: string;
  };
  invitedByUser: {
    userId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
};

export type AcceptInviteResponse = {
  organizationId: string;
  organizationName: string;
  membershipId: string;
  role: OrganizationInviteRole;
  invite: OrganizationInvite;
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
  devEmailVerificationCode?: string | null;
};

export type SolanaNetwork = 'devnet' | 'mainnet';

export type CapabilitiesResponse = {
  product: string;
  version: number;
  generatedAt: string;
  solana: {
    network: SolanaNetwork;
    usdcMint: string;
    rpcUrl: string;
  };
  auth: Record<string, unknown>;
  apiSurface: Record<string, unknown>;
  workflows: Array<Record<string, unknown>>;
  endpointGroups: Array<Record<string, unknown>>;
  safetyNotes: string[];
};

export type UserWallet = {
  userWalletId: string;
  userId: string;
  chain: string;
  walletAddress: string;
  walletType: 'external' | 'privy_embedded' | string;
  provider: string | null;
  providerWalletId: string | null;
  label: string | null;
  status: string;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/**
 * Personal wallet — a signing wallet owned by an individual user.
 * Same shape as UserWallet (the underlying DB table is still `user_wallets`
 * for migration safety, but Prisma now calls the model `PersonalWallet`).
 * New code should prefer this type name.
 */
export type PersonalWallet = UserWallet;

/**
 * Personal wallet enriched with its owner + organization membership for
 * picking Squads members at treasury creation.
 */
export type OrganizationPersonalWallet = UserWallet & {
  user: {
    userId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
  membership: {
    membershipId: string;
    role: string;
    status: string;
  } | null;
};

export type ManagedWalletProvider =
  | 'privy'
  | 'fireblocks'
  | 'coinbase_cdp'
  | 'para'
  | 'turnkey'
  | 'dfns';

export type WalletAuthorizationRole = 'owner' | 'admin' | 'signer' | 'approver';
export type WalletAuthorizationScope = 'organization' | 'treasury_wallet';
export type WalletAuthorizationStatus = 'active' | 'revoked';

export type WalletAuthorization = {
  walletAuthorizationId: string;
  organizationId: string;
  treasuryWalletId: string | null;
  userWalletId: string;
  membershipId: string;
  role: WalletAuthorizationRole;
  status: WalletAuthorizationStatus;
  scope: WalletAuthorizationScope;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  metadataJson: Record<string, unknown>;
  personalWallet: {
    userWalletId: string;
    userId: string;
    chain: string;
    walletAddress: string;
    walletType: string;
    provider: string | null;
    providerWalletId: string | null;
    label: string | null;
    status: string;
  };
  membership: {
    membershipId: string;
    userId: string;
    role: string;
    status: string;
    user: {
      userId: string;
      email: string;
      displayName: string;
      avatarUrl: string | null;
    };
  };
  treasuryWallet: {
    treasuryWalletId: string;
    chain: string;
    address: string;
    usdcAtaAddress: string | null;
    displayName: string | null;
    isActive: boolean;
  } | null;
};

export type WalletChallenge = {
  chain: 'solana';
  walletAddress: string;
  nonce: string;
  message: string;
  expiresAt: string;
};

export type TreasuryWallet = {
  treasuryWalletId: string;
  organizationId: string;
  chain: string;
  address: string;
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

// Squads v4 treasury creation — see backend api/src/squads-treasury.ts.
// Frontend obtains an "intent" with a partially-signed VersionedTransaction,
// adds the user's personal-wallet signature, submits to chain, then calls
// confirm to persist the new treasury record.

export type SquadsPermission = 'initiate' | 'vote' | 'execute';

export type SquadsTreasuryProvider = 'squads_v4';

export type SquadsTreasurySource = 'squads_v4';

export type CreateSquadsTreasuryIntentRequest = {
  displayName?: string | null;
  creatorPersonalWalletId: string;
  threshold: number;
  timeLockSeconds?: number;
  vaultIndex?: number;
  members: Array<{
    personalWalletId: string;
    permissions: SquadsPermission[];
  }>;
};

export type SquadsIntentMember = {
  personalWalletId: string;
  walletAddress: string;
  userId: string;
  membershipId: string;
  permissions: SquadsPermission[];
};

export type CreateSquadsTreasuryIntentResponse = {
  intent: {
    provider: SquadsTreasuryProvider;
    programId: string;
    createKey: string;
    multisigPda: string;
    vaultPda: string;
    vaultIndex: number;
    threshold: number;
    timeLockSeconds: number;
    displayName: string | null;
    members: SquadsIntentMember[];
  };
  transaction: {
    encoding: 'base64';
    serializedTransaction: string;
    requiredSigner: string;
    recentBlockhash: string;
    lastValidBlockHeight: number;
  };
};

export type ConfirmSquadsTreasuryRequest = {
  signature: string;
  displayName?: string | null;
  createKey: string;
  multisigPda: string;
  vaultIndex?: number;
};

export type SquadsMemberLinkStatus =
  | 'linked'
  | 'unlinked'
  | 'wallet_inactive'
  | 'not_org_member'
  | 'authorization_missing';

export type SquadsDetailMember = {
  walletAddress: string;
  permissionsMask: number;
  permissions: SquadsPermission[];
  linkStatus: SquadsMemberLinkStatus;
  personalWallet: {
    userWalletId: string;
    userId: string;
    chain: string;
    walletAddress: string;
    walletType: string;
    provider: string | null;
    label: string | null;
    status: string;
    verifiedAt: string | null;
    lastUsedAt: string | null;
  } | null;
  organizationMembership: {
    membershipId: string;
    role: string;
    status: string;
    createdAt: string;
    user: {
      userId: string;
      email: string;
      displayName: string;
      avatarUrl: string | null;
    };
  } | null;
  localAuthorization: {
    walletAuthorizationId: string;
    role: string;
    scope: string;
    status: string;
    revokedAt: string | null;
    metadataJson: Record<string, unknown> | null;
    createdAt: string;
  } | null;
};

export type SquadsTreasuryDetail = {
  treasuryWallet: TreasuryWallet;
  squads: {
    provider: SquadsTreasuryProvider;
    programId: string;
    multisigPda: string;
    vaultPda: string;
    vaultIndex: number;
    configAuthority: string | null;
    isAutonomous: boolean;
    threshold: number;
    timeLockSeconds: number;
    transactionIndex: string;
    staleTransactionIndex: string;
    members: SquadsDetailMember[];
    capabilities: {
      canInitiate: boolean;
      canVote: boolean;
      canExecute: boolean;
      canCreateConfigProposals: boolean;
      canCreatePaymentProposals: boolean;
    };
    localStateMatchesChain: boolean;
  };
};

export type SquadsTreasuryStatus = {
  treasuryWalletId: string;
  provider: SquadsTreasuryProvider;
  programId: string;
  multisigPda: string;
  vaultPda: string;
  vaultIndex: number;
  threshold: number;
  timeLockSeconds: number;
  transactionIndex: string;
  staleTransactionIndex: string;
  members: Array<{
    walletAddress: string;
    permissionsMask: number;
    permissions: SquadsPermission[];
  }>;
  localStateMatchesChain: boolean;
};

export type TreasuryWalletLite = {
  treasuryWalletId: string;
  address: string;
  usdcAtaAddress: string | null;
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
  organizationId: string;
  counterpartyId: string | null;
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
  organizationId: string;
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
  organizationId: string;
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
  organizationId: string;
  paymentOrderId: string | null;
  sourceTreasuryWalletId: string | null;
  destinationId: string;
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
  sourceTreasuryWallet: TreasuryWalletLite | null;
  destination: Destination | null;
};

export type ExecutionRecord = {
  executionRecordId: string;
  transferRequestId: string;
  organizationId: string;
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
  organizationId: string;
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
  organizationId: string;
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
  organizationId: string;
  paymentOrderId: string | null;
  sourceTreasuryWalletId: string | null;
  destinationId: string;
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
  sourceTreasuryWallet: TreasuryWalletLite | null;
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

export type PaymentOrderState =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'ready_for_execution'
  | 'execution_recorded'
  | 'partially_settled'
  | 'settled'
  | 'exception'
  | 'closed'
  | 'cancelled';

export type PaymentOrderEvent = {
  paymentOrderEventId: string;
  paymentOrderId: string;
  organizationId: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  beforeState: string | null;
  afterState: string | null;
  linkedTransferRequestId: string | null;
  linkedExecutionRecordId: string | null;
  linkedSignature: string | null;
  payloadJson: Record<string, unknown>;
  createdAt: string;
};

export type PaymentRequestState = 'submitted' | 'converted_to_order' | 'cancelled';

export type PaymentRequest = {
  paymentRequestId: string;
  organizationId: string;
  paymentRunId: string | null;
  destinationId: string;
  counterpartyId: string | null;
  requestedByUserId: string | null;
  amountRaw: string;
  asset: string;
  reason: string;
  externalReference: string | null;
  dueAt: string | null;
  state: PaymentRequestState;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  destination: Destination;
  counterparty: Counterparty | null;
  requestedByUser: User | null;
  paymentOrder: {
    paymentOrderId: string;
    state: PaymentOrderState;
    createdAt: string;
  } | null;
};

export type PreparedSolanaInstruction = {
  programId: string;
  keys: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  dataBase64: string;
};

export type PaymentExecutionPacket = {
  kind: 'solana_spl_usdc_transfer' | 'solana_spl_usdc_transfer_batch';
  version: number;
  network: string;
  paymentOrderId?: string;
  paymentRunId?: string;
  runName?: string;
  paymentOrderIds?: string[];
  transferRequestId?: string;
  transferRequestIds?: string[];
  executionRecordId?: string;
  executionRecordIds?: string[];
  createdAt: string;
  source: {
    treasuryWalletId: string;
    walletAddress: string;
    tokenAccountAddress: string;
    label: string | null;
  };
  destination?: {
    destinationId: string;
    label: string;
    walletAddress: string;
    tokenAccountAddress: string;
    counterpartyName: string | null;
  };
  transfers?: Array<{
    paymentOrderId: string;
    transferRequestId: string;
    executionRecordId: string;
    destination: {
      destinationId: string;
      label: string;
      walletAddress: string;
      tokenAccountAddress: string;
    };
    amountRaw: string;
    memo: string | null;
    reference: string | null;
  }>;
  token: {
    symbol: string;
    mint: string;
    decimals: number;
  };
  amountRaw: string;
  memo: string | null;
  reference: string | null;
  signerWallet: string;
  feePayer: string;
  requiredSigners: string[];
  instructions: PreparedSolanaInstruction[];
  signing: {
    mode: string;
    requiresRecentBlockhash: boolean;
    note: string;
  };
};

export type PaymentExecutionPreparation = {
  executionRecord: ExecutionRecord;
  executionPacket: PaymentExecutionPacket;
  paymentOrder: PaymentOrder;
};

export type PaymentRun = {
  paymentRunId: string;
  organizationId: string;
  sourceTreasuryWalletId: string | null;
  runName: string;
  inputSource: string;
  state: string;
  derivedState: string;
  metadataJson: Record<string, unknown>;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  sourceTreasuryWallet: TreasuryWallet | null;
  createdByUser: User | null;
  totals: {
    orderCount: number;
    actionableCount: number;
    cancelledCount: number;
    totalAmountRaw: string;
    settledCount: number;
    exceptionCount: number;
    pendingApprovalCount: number;
    approvedCount: number;
    readyCount: number;
  };
  paymentOrders?: PaymentOrder[];
};

export type PaymentRunImportResult = {
  paymentRun: PaymentRun;
  importResult: PaymentRequestsCsvImportResult;
};

export type PaymentRunExecutionPreparation = {
  executionRecords: ExecutionRecord[];
  executionPacket: PaymentExecutionPacket;
  paymentRun: PaymentRun;
};

export type PaymentOrder = {
  paymentOrderId: string;
  organizationId: string;
  paymentRequestId: string | null;
  paymentRunId: string | null;
  destinationId: string;
  counterpartyId: string | null;
  sourceTreasuryWalletId: string | null;
  transferRequestId: string | null;
  amountRaw: string;
  asset: string;
  memo: string | null;
  externalReference: string | null;
  invoiceNumber: string | null;
  attachmentUrl: string | null;
  dueAt: string | null;
  state: PaymentOrderState;
  derivedState: PaymentOrderState;
  sourceBalanceSnapshotJson: Record<string, unknown>;
  balanceWarning: {
    status: 'unknown' | 'sufficient' | 'insufficient';
    message: string;
    balanceRaw?: string;
  };
  metadataJson: Record<string, unknown>;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  destination: Destination;
  counterparty: Counterparty | null;
  sourceTreasuryWallet: TreasuryWallet | null;
  createdByUser: User | null;
  paymentRequest: Omit<PaymentRequest, 'destination' | 'counterparty' | 'paymentOrder'> | null;
  transferRequests: Array<{
    transferRequestId: string;
    status: string;
    amountRaw: string;
    requestedAt: string;
  }>;
  events: PaymentOrderEvent[];
  reconciliationDetail: ReconciliationDetail | null;
};

export type PaymentRequestsCsvImportResult = {
  imported: number;
  failed: number;
  items: Array<{
    rowNumber: number;
    status: 'imported' | 'failed';
    error?: string;
    paymentRequest?: PaymentRequest;
  }>;
};

export type PaymentProofPacket = {
  packetType: 'stablecoin_payment_proof';
  version: number;
  generatedAt: string;
  organizationId: string;
  status: 'complete' | 'partial' | 'exception' | 'closed' | 'in_progress';
  intent: Record<string, unknown>;
  parties: Record<string, unknown>;
  approval: Record<string, unknown>;
  execution: Record<string, unknown>;
  settlement: Record<string, unknown>;
  exceptions: Array<Record<string, unknown>>;
  auditTrail: ReconciliationTimelineItem[];
};

export type ProofReadiness = {
  status: 'complete' | 'in_progress' | 'needs_review' | 'blocked';
  blockers: string[];
  warnings: string[];
  pending: string[];
  checks: Array<{
    id: string;
    label: string;
    status: 'pass' | 'pending' | 'warn' | 'fail';
    detail: string;
  }>;
  recommendedAction: string;
};

export type CollectionSourceReview = {
  status:
    | 'pass'
    | 'unspecified_source'
    | 'source_needs_review'
    | 'awaiting_observation'
    | 'source_mismatch'
    | 'source_restricted';
  severity: 'none' | 'info' | 'warning' | 'error';
  expectedSourceWallet: string | null;
  observedSourceWallet: string | null;
  trustState: CollectionSourceTrustState | null;
  message: string;
};

export type CollectionProofPacket = {
  proofId: string;
  canonicalDigest: string;
  canonicalDigestAlgorithm: string;
  packetType: 'stablecoin_collection_proof';
  version: number;
  generatedAt: string;
  organizationId: string;
  status: 'complete' | 'partial' | 'exception' | 'closed' | 'cancelled' | 'in_progress';
  readiness: ProofReadiness;
  intent: Record<string, unknown>;
  parties: Record<string, unknown>;
  collectionSourceReview: CollectionSourceReview;
  settlement: Record<string, unknown>;
  exceptions: Array<Record<string, unknown>>;
  auditTrail: ReconciliationTimelineItem[];
};

export type CollectionRunProofPacket = {
  proofId: string;
  canonicalDigest: string;
  canonicalDigestAlgorithm: string;
  packetType: 'stablecoin_collection_run_proof';
  version: number;
  generatedAt: string;
  organizationId: string;
  collectionRunId: string;
  runName: string;
  status: string;
  readiness: Omit<ProofReadiness, 'checks'> & {
    counts: Record<string, number>;
  };
  summary: CollectionRunSummary['summary'];
  collections: Array<Record<string, unknown>>;
};

export type CollectionRequestState =
  | 'open'
  | 'partially_collected'
  | 'collected'
  | 'exception'
  | 'closed'
  | 'cancelled';

export type CollectionSourceTrustState = 'unreviewed' | 'trusted' | 'restricted' | 'blocked';

export type CollectionSource = {
  collectionSourceId: string;
  organizationId: string;
  counterpartyId: string | null;
  chain: string;
  asset: string;
  walletAddress: string;
  tokenAccountAddress: string | null;
  sourceType: string;
  trustState: CollectionSourceTrustState;
  label: string;
  notes: string | null;
  isActive: boolean;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  counterparty: Counterparty | null;
};

export type CollectionRequestEvent = {
  collectionRequestEventId: string;
  collectionRequestId: string;
  organizationId: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  beforeState: string | null;
  afterState: string | null;
  linkedTransferRequestId: string | null;
  payloadJson: Record<string, unknown>;
  createdAt: string;
};

export type CollectionRequest = {
  collectionRequestId: string;
  organizationId: string;
  collectionRunId: string | null;
  receivingTreasuryWalletId: string;
  collectionSourceId: string | null;
  counterpartyId: string | null;
  transferRequestId: string | null;
  payerWalletAddress: string | null;
  payerTokenAccountAddress: string | null;
  amountRaw: string;
  asset: string;
  reason: string;
  externalReference: string | null;
  dueAt: string | null;
  state: CollectionRequestState;
  derivedState: CollectionRequestState;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  collectionRun: {
    collectionRunId: string;
    runName: string;
    state: string;
    createdAt: string;
  } | null;
  receivingTreasuryWallet: TreasuryWallet;
  collectionSource: CollectionSource | null;
  counterparty: Counterparty | null;
  transferRequest: {
    transferRequestId: string;
    requestType: string;
    status: string;
    amountRaw: string;
    externalReference: string | null;
    destinationId: string;
  } | null;
  createdByUser: User | null;
  reconciliationDetail: ReconciliationDetail | null;
  events?: CollectionRequestEvent[];
};

export type CollectionRunSummary = {
  collectionRunId: string;
  organizationId: string;
  receivingTreasuryWalletId: string | null;
  runName: string;
  inputSource: string;
  state: string;
  derivedState: string;
  metadataJson: Record<string, unknown>;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  receivingTreasuryWallet: TreasuryWallet | null;
  createdByUser: User | null;
  summary: {
    total: number;
    open: number;
    partiallyCollected: number;
    collected: number;
    exception: number;
    totalAmountRaw: string;
  };
  collectionRequests?: CollectionRequest[];
};

export type CollectionCsvPreviewItem = {
  rowNumber: number;
  status: 'ready' | 'warning' | 'failed';
  warnings?: string[];
  parsed?: Record<string, unknown>;
  duplicate?: { collectionRequestId: string; state: string } | null;
  error?: string;
};

export type CollectionCsvPreview = {
  totalRows: number;
  ready: number;
  warnings: number;
  failed: number;
  canImport: boolean;
  items: CollectionCsvPreviewItem[];
};

export type CollectionRunCsvPreview = CollectionCsvPreview & {
  csvFingerprint: string;
};

export type CollectionRunImportResult = {
  collectionRun: CollectionRunSummary;
  importResult: {
    idempotentReplay?: boolean;
    imported: number;
    failed: number;
    items: Array<{
      rowNumber: number;
      status: 'imported' | 'failed';
      collectionRequest?: CollectionRequest;
      error?: string;
    }>;
  };
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
  organizationId: string;
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
