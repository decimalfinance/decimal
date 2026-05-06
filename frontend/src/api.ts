import type {
  ApprovalPolicy,
  AuthenticatedSession,
  CollectionCsvPreview,
  CollectionRequest,
  CollectionProofPacket,
  CollectionRunProofPacket,
  CollectionRunCsvPreview,
  CollectionRunImportResult,
  CollectionRunSummary,
  CollectionSource,
  CollectionSourceTrustState,
  Counterparty,
  Destination,
  ExceptionItem,
  ExceptionNote,
  LoginResponse,
  ObservedTransfer,
  OrganizationMembership,
  OrganizationSummary,
  PaymentExecutionPreparation,
  PaymentOrder,
  PaymentProofPacket,
  PaymentRequest,
  PaymentRun,
  PaymentRunExecutionPreparation,
  PaymentRunImportResult,
  ReconciliationRow,
  Organization,
  ConfirmSquadsTreasuryRequest,
  CreateSquadsTreasuryIntentRequest,
  CreateSquadsTreasuryIntentResponse,
  SquadsTreasuryStatus,
  TreasuryWallet,
  ManagedWalletProvider,
  UserWallet,
  WalletAuthorization,
  WalletAuthorizationRole,
  WalletAuthorizationScope,
  WalletAuthorizationStatus,
  WalletChallenge,
} from './types';
import { getPublicApiBaseUrl } from './public-config';

const API_BASE_URL = getPublicApiBaseUrl();
const AUTH_STORAGE_KEY = 'usdc_ops_v2.session_token';
const LEGACY_AUTH_STORAGE_KEY = 'usdc_ops.session_token';

let sessionToken = loadStoredToken();

export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit & { includeAuth?: boolean }): Promise<T> {
  const includeAuth = init?.includeAuth ?? true;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(includeAuth && sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code: string | null = null;
    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
      if (typeof body?.code === 'string') {
        code = body.code;
      }
    } catch {
      // keep default
    }

    if (response.status === 401) {
      clearSessionToken();
    }

    throw new ApiError(message, response.status, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function download(path: string, fallbackFileName = 'export.csv') {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition');
  const fileNameMatch = disposition?.match(/filename="([^"]+)"/);
  const fileName = fileNameMatch?.[1] ?? fallbackFileName;
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

export const api = {
  hasSessionToken() {
    return Boolean(sessionToken);
  },
  setSessionToken(nextToken: string) {
    sessionToken = nextToken;
    window.localStorage.setItem(AUTH_STORAGE_KEY, nextToken);
  },
  clearSessionToken() {
    clearSessionToken();
  },
  getGoogleOAuthStartUrl(returnTo = '/setup') {
    const params = new URLSearchParams({
      returnTo,
      frontendOrigin: window.location.origin,
    });
    return `${API_BASE_URL}/auth/google/start?${params.toString()}`;
  },
  register(input: { email: string; password: string; displayName?: string }) {
    return request<LoginResponse>('/auth/register', {
      method: 'POST',
      includeAuth: false,
      body: JSON.stringify(input),
    });
  },
  login(input: { email: string; password: string }) {
    return request<LoginResponse>('/auth/login', {
      method: 'POST',
      includeAuth: false,
      body: JSON.stringify(input),
    });
  },
  getSession() {
    return request<AuthenticatedSession>('/auth/session');
  },
  verifyEmail(input: { code: string }) {
    return request<{ user: AuthenticatedSession['user'] }>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  resendVerification() {
    return request<{ user: AuthenticatedSession['user']; devEmailVerificationCode: string | null }>(
      '/auth/resend-verification',
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  },
  logout() {
    return request<void>('/auth/logout', {
      method: 'POST',
    });
  },
  createOrganization(input: { organizationName: string }) {
    return request<OrganizationMembership>('/organizations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  joinOrganization(organizationId: string) {
    return request<OrganizationMembership>(`/organizations/${organizationId}/join`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  getOrganizationSummary(organizationId: string) {
    return request<OrganizationSummary>(`/organizations/${organizationId}/summary`);
  },
  // Personal wallets — user-owned signing wallets.
  // Backend accepts both /personal-wallets/* (preferred) and /user-wallets/*
  // (legacy alias). New code uses the preferred path.
  listPersonalWallets() {
    return request<{ items: UserWallet[] }>('/personal-wallets');
  },
  /** @deprecated use listPersonalWallets */
  listUserWallets() {
    return request<{ items: UserWallet[] }>('/personal-wallets');
  },
  createWalletChallenge(input: { walletAddress: string }) {
    return request<WalletChallenge>('/personal-wallets/challenge', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  connectExternalWallet(input: {
    walletAddress: string;
    nonce: string;
    signedMessageBase64: string;
    signatureBase64: string;
    provider?: string;
    label?: string;
  }) {
    return request<UserWallet>('/personal-wallets/external', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  registerEmbeddedWallet(input: {
    walletAddress: string;
    provider?: string;
    providerWalletId?: string;
    label?: string;
  }) {
    return request<UserWallet>('/personal-wallets/embedded', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  createPersonalWalletManaged(input: {
    provider: ManagedWalletProvider;
    label?: string;
  }) {
    return request<UserWallet>('/personal-wallets/managed', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  // Backend signs the serialized VersionedTransaction with the user's
  // Privy-embedded wallet (private key never leaves the backend or
  // Privy). Backend validates: wallet belongs to caller, is active +
  // Solana + privy_embedded, the wallet is a required signer on the
  // transaction, and the transaction includes the Squads v4 program.
  signPersonalWalletVersionedTransaction(
    userWalletId: string,
    input: { serializedTransactionBase64: string },
  ) {
    return request<{
      userWalletId: string;
      walletAddress: string;
      signedTransactionBase64: string;
      encoding: 'base64';
    }>(`/personal-wallets/${userWalletId}/sign-versioned-transaction`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  /** @deprecated use createPersonalWalletManaged */
  createManagedWallet(input: {
    provider: ManagedWalletProvider;
    label?: string;
  }) {
    return request<UserWallet>('/personal-wallets/managed', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  // Wallet authorizations — explicit bridge between a personal wallet and an
  // organization (or specific treasury wallet within it).
  listWalletAuthorizations(
    organizationId: string,
    params: {
      treasuryWalletId?: string;
      userWalletId?: string;
      status?: WalletAuthorizationStatus;
    } = {},
  ) {
    const qs = new URLSearchParams();
    if (params.treasuryWalletId) qs.set('treasuryWalletId', params.treasuryWalletId);
    if (params.userWalletId) qs.set('userWalletId', params.userWalletId);
    if (params.status) qs.set('status', params.status);
    const query = qs.toString();
    return request<{ items: WalletAuthorization[] }>(
      `/organizations/${organizationId}/wallet-authorizations${query ? `?${query}` : ''}`,
    );
  },
  createWalletAuthorization(
    organizationId: string,
    input: {
      userWalletId: string;
      treasuryWalletId?: string | null;
      membershipId?: string;
      role?: WalletAuthorizationRole;
      scope?: WalletAuthorizationScope;
      metadataJson?: Record<string, unknown>;
    },
  ) {
    return request<WalletAuthorization>(
      `/organizations/${organizationId}/wallet-authorizations`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  revokeWalletAuthorization(organizationId: string, walletAuthorizationId: string) {
    return request<WalletAuthorization>(
      `/organizations/${organizationId}/wallet-authorizations/${walletAuthorizationId}/revoke`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  },
  listTreasuryWallets(organizationId: string) {
    return request<{ items: TreasuryWallet[] }>(`/organizations/${organizationId}/treasury-wallets`);
  },
  listTreasuryWalletBalances(organizationId: string) {
    return request<{
      fetchedAt: string;
      solUsdPrice: number | null;
      priceSource: string | null;
      items: Array<{
        treasuryWalletId: string;
        address: string;
        usdcAtaAddress: string | null;
        displayName: string | null;
        isActive: boolean;
        solLamports: string;
        usdcRaw: string | null;
        rpcError: string | null;
      }>;
    }>(`/organizations/${organizationId}/treasury-wallets/balances`);
  },
  listCounterparties(organizationId: string) {
    return request<{ items: Counterparty[] }>(`/organizations/${organizationId}/counterparties`);
  },
  createCounterparty(
    organizationId: string,
    input: {
      displayName: string;
      category?: string;
      externalReference?: string;
      status?: string;
    },
  ) {
    return request<Counterparty>(`/organizations/${organizationId}/counterparties`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  listDestinations(organizationId: string) {
    return request<{ items: Destination[] }>(`/organizations/${organizationId}/destinations`);
  },
  createDestination(
    organizationId: string,
    input: {
      counterpartyId?: string;
      walletAddress: string;
      tokenAccountAddress?: string;
      destinationType?: string;
      trustState?: Destination['trustState'];
      label: string;
      notes?: string;
      isInternal?: boolean;
      isActive?: boolean;
    },
  ) {
    return request<Destination>(`/organizations/${organizationId}/destinations`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateDestination(
    organizationId: string,
    destinationId: string,
    input: {
      counterpartyId?: string | null;
      walletAddress?: string;
      trustState?: Destination['trustState'];
      label?: string;
      notes?: string;
      isInternal?: boolean;
      isActive?: boolean;
    },
  ) {
    return request<Destination>(`/organizations/${organizationId}/destinations/${destinationId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  createTreasuryWallet(
    organizationId: string,
    input: {
      address: string;
      displayName?: string;
      assetScope?: string;
      notes?: string;
    },
  ) {
    return request(`/organizations/${organizationId}/treasury-wallets`, {
      method: 'POST',
      body: JSON.stringify({
        chain: 'solana',
        source: 'manual',
        assetScope: input.assetScope ?? 'usdc',
        ...input,
      }),
    });
  },

  // Squads v4 treasury creation. Three-step flow:
  //   1. createSquadsTreasuryIntent — backend prepares + partially signs
  //      a VersionedTransaction; returns intent metadata + serialized tx
  //   2. (frontend) sign with the user's personal wallet, submit to chain
  //   3. confirmSquadsTreasury — backend confirms onchain state and
  //      persists a TreasuryWallet row with source='squads_v4',
  //      address=vault PDA, sourceRef=multisig PDA
  // getSquadsTreasuryStatus reads live Squads state for an existing
  // squads_v4 treasury — useful for badges and a details panel.
  createSquadsTreasuryIntent(
    organizationId: string,
    input: CreateSquadsTreasuryIntentRequest,
  ) {
    return request<CreateSquadsTreasuryIntentResponse>(
      `/organizations/${organizationId}/treasury-wallets/squads/create-intent`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  confirmSquadsTreasury(
    organizationId: string,
    input: ConfirmSquadsTreasuryRequest,
  ) {
    return request<TreasuryWallet>(
      `/organizations/${organizationId}/treasury-wallets/squads/confirm`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getSquadsTreasuryStatus(organizationId: string, treasuryWalletId: string) {
    return request<SquadsTreasuryStatus>(
      `/organizations/${organizationId}/treasury-wallets/${treasuryWalletId}/squads/status`,
    );
  },

  listTransfers(organizationId: string) {
    return request<{ servedAt: string; items: ObservedTransfer[] }>(
      `/organizations/${organizationId}/transfers?limit=100`,
    );
  },
  listReconciliation(organizationId: string) {
    return request<{ servedAt: string; items: ReconciliationRow[] }>(
      `/organizations/${organizationId}/reconciliation?limit=100`,
    );
  },
  getApprovalPolicy(organizationId: string) {
    return request<ApprovalPolicy>(`/organizations/${organizationId}/approval-policy`);
  },
  updateApprovalPolicy(
    organizationId: string,
    input: {
      policyName?: string;
      isActive?: boolean;
      ruleJson?: Partial<ApprovalPolicy['ruleJson']>;
    },
  ) {
    return request<ApprovalPolicy>(`/organizations/${organizationId}/approval-policy`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  createApprovalDecision(
    organizationId: string,
    transferRequestId: string,
    input: {
      action: 'approve' | 'reject' | 'escalate';
      comment?: string;
    },
  ) {
    return request<{ transferRequestId: string; status: string }>(
      `/organizations/${organizationId}/transfer-requests/${transferRequestId}/approval-decisions`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  listExceptions(organizationId: string) {
    return request<{ servedAt: string; items: ExceptionItem[] }>(
      `/organizations/${organizationId}/exceptions?limit=100`,
    );
  },
  getOrganizationException(organizationId: string, exceptionId: string) {
    return request<ExceptionItem & { notes: ExceptionNote[] }>(
      `/organizations/${organizationId}/exceptions/${exceptionId}`,
    );
  },
  applyExceptionAction(
    organizationId: string,
    exceptionId: string,
    input: {
      action: 'reviewed' | 'expected' | 'dismissed' | 'reopen';
      note?: string;
    },
  ) {
    return request<ExceptionItem>(`/organizations/${organizationId}/exceptions/${exceptionId}/actions`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  addExceptionNote(organizationId: string, exceptionId: string, input: { body: string }) {
    return request<ExceptionNote>(`/organizations/${organizationId}/exceptions/${exceptionId}/notes`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  listPaymentOrders(organizationId: string, state?: PaymentOrder['state']) {
    const params = new URLSearchParams({ limit: '100' });
    if (state) {
      params.set('state', state);
    }
    return request<{ servedAt: string; items: PaymentOrder[] }>(
      `/organizations/${organizationId}/payment-orders?${params.toString()}`,
    );
  },
  listPaymentRequests(organizationId: string, state?: PaymentRequest['state']) {
    const params = new URLSearchParams({ limit: '100' });
    if (state) {
      params.set('state', state);
    }
    return request<{ servedAt: string; items: PaymentRequest[] }>(
      `/organizations/${organizationId}/payment-requests?${params.toString()}`,
    );
  },
  listPaymentRuns(organizationId: string) {
    return request<{ servedAt: string; items: PaymentRun[] }>(`/organizations/${organizationId}/payment-runs`);
  },
  getPaymentRunDetail(organizationId: string, paymentRunId: string) {
    return request<PaymentRun>(`/organizations/${organizationId}/payment-runs/${paymentRunId}`);
  },
  deletePaymentRun(organizationId: string, paymentRunId: string) {
    return request<Record<string, unknown>>(`/organizations/${organizationId}/payment-runs/${paymentRunId}`, {
      method: 'DELETE',
    });
  },
  importPaymentRunCsv(
    organizationId: string,
    input: {
      csv: string;
      runName?: string;
      sourceTreasuryWalletId?: string;
      submitOrderNow?: boolean;
    },
  ) {
    return request<PaymentRunImportResult>(`/organizations/${organizationId}/payment-runs/import-csv`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  createPaymentRequest(
    organizationId: string,
    input: {
      destinationId: string;
      amountRaw: string;
      asset?: string;
      reason: string;
      externalReference?: string;
      dueAt?: string;
      metadataJson?: Record<string, unknown>;
      createOrderNow?: boolean;
      sourceTreasuryWalletId?: string;
      submitOrderNow?: boolean;
    },
  ) {
    return request<PaymentRequest>(`/organizations/${organizationId}/payment-requests`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  getPaymentOrderDetail(organizationId: string, paymentOrderId: string) {
    return request<PaymentOrder>(`/organizations/${organizationId}/payment-orders/${paymentOrderId}`);
  },
  submitPaymentOrder(organizationId: string, paymentOrderId: string) {
    return request<PaymentOrder>(`/organizations/${organizationId}/payment-orders/${paymentOrderId}/submit`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  cancelPaymentOrder(organizationId: string, paymentOrderId: string) {
    return request<PaymentOrder>(`/organizations/${organizationId}/payment-orders/${paymentOrderId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  preparePaymentOrderExecution(
    organizationId: string,
    paymentOrderId: string,
    input?: {
      sourceTreasuryWalletId?: string;
    },
  ) {
    return request<PaymentExecutionPreparation>(
      `/organizations/${organizationId}/payment-orders/${paymentOrderId}/prepare-execution`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    );
  },
  preparePaymentRunExecution(
    organizationId: string,
    paymentRunId: string,
    input?: {
      sourceTreasuryWalletId?: string;
    },
  ) {
    return request<PaymentRunExecutionPreparation>(
      `/organizations/${organizationId}/payment-runs/${paymentRunId}/prepare-execution`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    );
  },
  attachPaymentRunSignature(
    organizationId: string,
    paymentRunId: string,
    input: {
      submittedSignature: string;
      submittedAt?: string;
    },
  ) {
    return request<{ executionRecords: unknown[]; paymentRun: PaymentRun }>(
      `/organizations/${organizationId}/payment-runs/${paymentRunId}/attach-signature`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getPaymentRunProof(organizationId: string, paymentRunId: string) {
    return request<Record<string, unknown>>(`/organizations/${organizationId}/payment-runs/${paymentRunId}/proof`);
  },
  attachPaymentOrderSignature(
    organizationId: string,
    paymentOrderId: string,
    input: {
      submittedSignature?: string;
      externalReference?: string;
      submittedAt?: string;
      metadataJson?: Record<string, unknown>;
    },
  ) {
    return request(
      `/organizations/${organizationId}/payment-orders/${paymentOrderId}/attach-signature`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getPaymentOrderProof(organizationId: string, paymentOrderId: string) {
    return request<PaymentProofPacket>(`/organizations/${organizationId}/payment-orders/${paymentOrderId}/proof`);
  },
  listCollections(
    organizationId: string,
    params?: { state?: string; collectionRunId?: string; limit?: number },
  ) {
    const qs = new URLSearchParams();
    qs.set('limit', String(params?.limit ?? 100));
    if (params?.state) qs.set('state', params.state);
    if (params?.collectionRunId) qs.set('collectionRunId', params.collectionRunId);
    return request<{
      items: CollectionRequest[];
      limit: number;
      state: string | null;
      collectionRunId: string | null;
    }>(`/organizations/${organizationId}/collections?${qs.toString()}`);
  },
  createCollection(
    organizationId: string,
    input: {
      collectionRunId?: string;
      receivingTreasuryWalletId: string;
      collectionSourceId?: string;
      counterpartyId?: string;
      payerWalletAddress?: string;
      payerTokenAccountAddress?: string;
      amountRaw: string;
      asset?: string;
      reason: string;
      externalReference?: string;
      dueAt?: string;
      metadataJson?: Record<string, unknown>;
    },
  ) {
    return request<CollectionRequest>(`/organizations/${organizationId}/collections`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  listCollectionSources(organizationId: string, params?: { limit?: number }) {
    const qs = new URLSearchParams();
    qs.set('limit', String(params?.limit ?? 100));
    return request<{ items: CollectionSource[]; limit: number }>(
      `/organizations/${organizationId}/collection-sources?${qs.toString()}`,
    );
  },
  createCollectionSource(
    organizationId: string,
    input: {
      counterpartyId?: string;
      walletAddress: string;
      tokenAccountAddress?: string;
      sourceType?: string;
      trustState?: CollectionSourceTrustState;
      label: string;
      notes?: string;
      isActive?: boolean;
    },
  ) {
    return request<CollectionSource>(`/organizations/${organizationId}/collection-sources`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateCollectionSource(
    organizationId: string,
    collectionSourceId: string,
    input: {
      counterpartyId?: string | null;
      walletAddress?: string;
      tokenAccountAddress?: string | null;
      sourceType?: string;
      trustState?: CollectionSourceTrustState;
      label?: string;
      notes?: string | null;
      isActive?: boolean;
    },
  ) {
    return request<CollectionSource>(
      `/organizations/${organizationId}/collection-sources/${collectionSourceId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
    );
  },
  previewCollectionCsv(
    organizationId: string,
    input: { csv: string; receivingTreasuryWalletId?: string },
  ) {
    return request<CollectionCsvPreview>(
      `/organizations/${organizationId}/collections/import-csv/preview`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getCollection(organizationId: string, collectionRequestId: string) {
    return request<CollectionRequest>(
      `/organizations/${organizationId}/collections/${collectionRequestId}`,
    );
  },
  getCollectionProof(organizationId: string, collectionRequestId: string) {
    return request<CollectionProofPacket>(
      `/organizations/${organizationId}/collections/${collectionRequestId}/proof`,
    );
  },
  downloadCollectionProofJson(organizationId: string, collectionRequestId: string) {
    return download(
      `/organizations/${organizationId}/collections/${collectionRequestId}/proof`,
      `collection-${collectionRequestId}-proof.json`,
    );
  },
  cancelCollection(organizationId: string, collectionRequestId: string) {
    return request<CollectionRequest>(
      `/organizations/${organizationId}/collections/${collectionRequestId}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  },
  listCollectionRuns(organizationId: string) {
    return request<{ items: CollectionRunSummary[]; limit: number }>(
      `/organizations/${organizationId}/collection-runs`,
    );
  },
  importCollectionRunCsv(
    organizationId: string,
    input: {
      csv: string;
      runName?: string;
      receivingTreasuryWalletId?: string;
      importKey?: string;
    },
  ) {
    return request<CollectionRunImportResult>(
      `/organizations/${organizationId}/collection-runs/import-csv`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  previewCollectionRunCsv(
    organizationId: string,
    input: { csv: string; receivingTreasuryWalletId?: string },
  ) {
    return request<CollectionRunCsvPreview>(
      `/organizations/${organizationId}/collection-runs/import-csv/preview`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getCollectionRun(organizationId: string, collectionRunId: string) {
    return request<CollectionRunSummary>(
      `/organizations/${organizationId}/collection-runs/${collectionRunId}`,
    );
  },
  getCollectionRunProof(organizationId: string, collectionRunId: string) {
    return request<CollectionRunProofPacket>(
      `/organizations/${organizationId}/collection-runs/${collectionRunId}/proof`,
    );
  },
  downloadCollectionRunProofJson(organizationId: string, collectionRunId: string) {
    return download(
      `/organizations/${organizationId}/collection-runs/${collectionRunId}/proof`,
      `collection-run-${collectionRunId}-proof.json`,
    );
  },
};

function clearSessionToken() {
  sessionToken = null;
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
}

function loadStoredToken() {
  return window.localStorage.getItem(AUTH_STORAGE_KEY);
}


export type * from './types';
