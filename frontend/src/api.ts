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
  PaymentExecutionPreparation,
  PaymentOrder,
  PaymentProofPacket,
  PaymentRequest,
  PaymentRun,
  PaymentRunExecutionPreparation,
  PaymentRunImportResult,
  ReconciliationRow,
  Workspace,
  TreasuryWallet,
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
  createWorkspace(
    organizationId: string,
    input: {
      workspaceName: string;
      status?: string;
    },
  ) {
    return request<Workspace>(`/organizations/${organizationId}/workspaces`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  listTreasuryWallets(workspaceId: string) {
    return request<{ items: TreasuryWallet[] }>(`/workspaces/${workspaceId}/treasury-wallets`);
  },
  listTreasuryWalletBalances(workspaceId: string) {
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
    }>(`/workspaces/${workspaceId}/treasury-wallets/balances`);
  },
  listCounterparties(workspaceId: string) {
    return request<{ items: Counterparty[] }>(`/workspaces/${workspaceId}/counterparties`);
  },
  createCounterparty(
    workspaceId: string,
    input: {
      displayName: string;
      category?: string;
      externalReference?: string;
      status?: string;
    },
  ) {
    return request<Counterparty>(`/workspaces/${workspaceId}/counterparties`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  listDestinations(workspaceId: string) {
    return request<{ items: Destination[] }>(`/workspaces/${workspaceId}/destinations`);
  },
  createDestination(
    workspaceId: string,
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
    return request<Destination>(`/workspaces/${workspaceId}/destinations`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateDestination(
    workspaceId: string,
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
    return request<Destination>(`/workspaces/${workspaceId}/destinations/${destinationId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  createTreasuryWallet(
    workspaceId: string,
    input: {
      address: string;
      displayName?: string;
      assetScope?: string;
      notes?: string;
    },
  ) {
    return request(`/workspaces/${workspaceId}/treasury-wallets`, {
      method: 'POST',
      body: JSON.stringify({
        chain: 'solana',
        source: 'manual',
        assetScope: input.assetScope ?? 'usdc',
        ...input,
      }),
    });
  },
  listTransfers(workspaceId: string) {
    return request<{ servedAt: string; items: ObservedTransfer[] }>(
      `/workspaces/${workspaceId}/transfers?limit=100`,
    );
  },
  listReconciliation(workspaceId: string) {
    return request<{ servedAt: string; items: ReconciliationRow[] }>(
      `/workspaces/${workspaceId}/reconciliation?limit=100`,
    );
  },
  getApprovalPolicy(workspaceId: string) {
    return request<ApprovalPolicy>(`/workspaces/${workspaceId}/approval-policy`);
  },
  updateApprovalPolicy(
    workspaceId: string,
    input: {
      policyName?: string;
      isActive?: boolean;
      ruleJson?: Partial<ApprovalPolicy['ruleJson']>;
    },
  ) {
    return request<ApprovalPolicy>(`/workspaces/${workspaceId}/approval-policy`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  createApprovalDecision(
    workspaceId: string,
    transferRequestId: string,
    input: {
      action: 'approve' | 'reject' | 'escalate';
      comment?: string;
    },
  ) {
    return request<{ transferRequestId: string; status: string }>(
      `/workspaces/${workspaceId}/transfer-requests/${transferRequestId}/approval-decisions`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  listExceptions(workspaceId: string) {
    return request<{ servedAt: string; items: ExceptionItem[] }>(
      `/workspaces/${workspaceId}/exceptions?limit=100`,
    );
  },
  getWorkspaceException(workspaceId: string, exceptionId: string) {
    return request<ExceptionItem & { notes: ExceptionNote[] }>(
      `/workspaces/${workspaceId}/exceptions/${exceptionId}`,
    );
  },
  applyExceptionAction(
    workspaceId: string,
    exceptionId: string,
    input: {
      action: 'reviewed' | 'expected' | 'dismissed' | 'reopen';
      note?: string;
    },
  ) {
    return request<ExceptionItem>(`/workspaces/${workspaceId}/exceptions/${exceptionId}/actions`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  addExceptionNote(workspaceId: string, exceptionId: string, input: { body: string }) {
    return request<ExceptionNote>(`/workspaces/${workspaceId}/exceptions/${exceptionId}/notes`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  listPaymentOrders(workspaceId: string, state?: PaymentOrder['state']) {
    const params = new URLSearchParams({ limit: '100' });
    if (state) {
      params.set('state', state);
    }
    return request<{ servedAt: string; items: PaymentOrder[] }>(
      `/workspaces/${workspaceId}/payment-orders?${params.toString()}`,
    );
  },
  listPaymentRequests(workspaceId: string, state?: PaymentRequest['state']) {
    const params = new URLSearchParams({ limit: '100' });
    if (state) {
      params.set('state', state);
    }
    return request<{ servedAt: string; items: PaymentRequest[] }>(
      `/workspaces/${workspaceId}/payment-requests?${params.toString()}`,
    );
  },
  listPaymentRuns(workspaceId: string) {
    return request<{ servedAt: string; items: PaymentRun[] }>(`/workspaces/${workspaceId}/payment-runs`);
  },
  getPaymentRunDetail(workspaceId: string, paymentRunId: string) {
    return request<PaymentRun>(`/workspaces/${workspaceId}/payment-runs/${paymentRunId}`);
  },
  deletePaymentRun(workspaceId: string, paymentRunId: string) {
    return request<Record<string, unknown>>(`/workspaces/${workspaceId}/payment-runs/${paymentRunId}`, {
      method: 'DELETE',
    });
  },
  importPaymentRunCsv(
    workspaceId: string,
    input: {
      csv: string;
      runName?: string;
      sourceTreasuryWalletId?: string;
      submitOrderNow?: boolean;
    },
  ) {
    return request<PaymentRunImportResult>(`/workspaces/${workspaceId}/payment-runs/import-csv`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  createPaymentRequest(
    workspaceId: string,
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
    return request<PaymentRequest>(`/workspaces/${workspaceId}/payment-requests`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  getPaymentOrderDetail(workspaceId: string, paymentOrderId: string) {
    return request<PaymentOrder>(`/workspaces/${workspaceId}/payment-orders/${paymentOrderId}`);
  },
  submitPaymentOrder(workspaceId: string, paymentOrderId: string) {
    return request<PaymentOrder>(`/workspaces/${workspaceId}/payment-orders/${paymentOrderId}/submit`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  cancelPaymentOrder(workspaceId: string, paymentOrderId: string) {
    return request<PaymentOrder>(`/workspaces/${workspaceId}/payment-orders/${paymentOrderId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  preparePaymentOrderExecution(
    workspaceId: string,
    paymentOrderId: string,
    input?: {
      sourceTreasuryWalletId?: string;
    },
  ) {
    return request<PaymentExecutionPreparation>(
      `/workspaces/${workspaceId}/payment-orders/${paymentOrderId}/prepare-execution`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    );
  },
  preparePaymentRunExecution(
    workspaceId: string,
    paymentRunId: string,
    input?: {
      sourceTreasuryWalletId?: string;
    },
  ) {
    return request<PaymentRunExecutionPreparation>(
      `/workspaces/${workspaceId}/payment-runs/${paymentRunId}/prepare-execution`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    );
  },
  attachPaymentRunSignature(
    workspaceId: string,
    paymentRunId: string,
    input: {
      submittedSignature: string;
      submittedAt?: string;
    },
  ) {
    return request<{ executionRecords: unknown[]; paymentRun: PaymentRun }>(
      `/workspaces/${workspaceId}/payment-runs/${paymentRunId}/attach-signature`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getPaymentRunProof(workspaceId: string, paymentRunId: string) {
    return request<Record<string, unknown>>(`/workspaces/${workspaceId}/payment-runs/${paymentRunId}/proof`);
  },
  attachPaymentOrderSignature(
    workspaceId: string,
    paymentOrderId: string,
    input: {
      submittedSignature?: string;
      externalReference?: string;
      submittedAt?: string;
      metadataJson?: Record<string, unknown>;
    },
  ) {
    return request(
      `/workspaces/${workspaceId}/payment-orders/${paymentOrderId}/attach-signature`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getPaymentOrderProof(workspaceId: string, paymentOrderId: string) {
    return request<PaymentProofPacket>(`/workspaces/${workspaceId}/payment-orders/${paymentOrderId}/proof`);
  },
  listCollections(
    workspaceId: string,
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
    }>(`/workspaces/${workspaceId}/collections?${qs.toString()}`);
  },
  createCollection(
    workspaceId: string,
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
    return request<CollectionRequest>(`/workspaces/${workspaceId}/collections`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  listCollectionSources(workspaceId: string, params?: { limit?: number }) {
    const qs = new URLSearchParams();
    qs.set('limit', String(params?.limit ?? 100));
    return request<{ items: CollectionSource[]; limit: number }>(
      `/workspaces/${workspaceId}/collection-sources?${qs.toString()}`,
    );
  },
  createCollectionSource(
    workspaceId: string,
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
    return request<CollectionSource>(`/workspaces/${workspaceId}/collection-sources`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateCollectionSource(
    workspaceId: string,
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
      `/workspaces/${workspaceId}/collection-sources/${collectionSourceId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
    );
  },
  previewCollectionCsv(
    workspaceId: string,
    input: { csv: string; receivingTreasuryWalletId?: string },
  ) {
    return request<CollectionCsvPreview>(
      `/workspaces/${workspaceId}/collections/import-csv/preview`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getCollection(workspaceId: string, collectionRequestId: string) {
    return request<CollectionRequest>(
      `/workspaces/${workspaceId}/collections/${collectionRequestId}`,
    );
  },
  getCollectionProof(workspaceId: string, collectionRequestId: string) {
    return request<CollectionProofPacket>(
      `/workspaces/${workspaceId}/collections/${collectionRequestId}/proof`,
    );
  },
  downloadCollectionProofJson(workspaceId: string, collectionRequestId: string) {
    return download(
      `/workspaces/${workspaceId}/collections/${collectionRequestId}/proof`,
      `collection-${collectionRequestId}-proof.json`,
    );
  },
  cancelCollection(workspaceId: string, collectionRequestId: string) {
    return request<CollectionRequest>(
      `/workspaces/${workspaceId}/collections/${collectionRequestId}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  },
  listCollectionRuns(workspaceId: string) {
    return request<{ items: CollectionRunSummary[]; limit: number }>(
      `/workspaces/${workspaceId}/collection-runs`,
    );
  },
  importCollectionRunCsv(
    workspaceId: string,
    input: {
      csv: string;
      runName?: string;
      receivingTreasuryWalletId?: string;
      importKey?: string;
    },
  ) {
    return request<CollectionRunImportResult>(
      `/workspaces/${workspaceId}/collection-runs/import-csv`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  previewCollectionRunCsv(
    workspaceId: string,
    input: { csv: string; receivingTreasuryWalletId?: string },
  ) {
    return request<CollectionRunCsvPreview>(
      `/workspaces/${workspaceId}/collection-runs/import-csv/preview`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  getCollectionRun(workspaceId: string, collectionRunId: string) {
    return request<CollectionRunSummary>(
      `/workspaces/${workspaceId}/collection-runs/${collectionRunId}`,
    );
  },
  getCollectionRunProof(workspaceId: string, collectionRunId: string) {
    return request<CollectionRunProofPacket>(
      `/workspaces/${workspaceId}/collection-runs/${collectionRunId}/proof`,
    );
  },
  downloadCollectionRunProofJson(workspaceId: string, collectionRunId: string) {
    return download(
      `/workspaces/${workspaceId}/collection-runs/${collectionRunId}/proof`,
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
