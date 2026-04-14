import type {
  ApprovalPolicy,
  AuthenticatedSession,
  Counterparty,
  Destination,
  ExceptionItem,
  ExceptionNote,
  LoginResponse,
  ObservedTransfer,
  OrganizationDirectoryItem,
  OrganizationMembership,
  PaymentExecutionPreparation,
  PaymentOrder,
  PaymentProofPacket,
  Payee,
  PaymentRequest,
  PaymentRun,
  PaymentRunExecutionPreparation,
  PaymentRunImportResult,
  ReconciliationRow,
  Workspace,
  WorkspaceAddress,
} from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3100';
const AUTH_STORAGE_KEY = 'usdc_ops_v2.session_token';
const LEGACY_AUTH_STORAGE_KEY = 'usdc_ops.session_token';

let sessionToken = loadStoredToken();

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
    try {
      const body = await response.json();
      if (body?.message) {
        message = body.message;
      }
    } catch {
      // keep default
    }

    if (response.status === 401) {
      clearSessionToken();
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function download(path: string) {
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
  const fileNameMatch = disposition?.match(/filename=\"([^\"]+)\"/);
  const fileName = fileNameMatch?.[1] ?? 'export.csv';
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
  login(input: { email: string; displayName?: string }) {
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
  listOrganizations() {
    return request<{ items: OrganizationDirectoryItem[] }>('/organizations');
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
  createDemoWorkspace(organizationId: string) {
    return request<Workspace>(`/organizations/${organizationId}/demo-workspace`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  listAddresses(workspaceId: string) {
    return request<{ items: WorkspaceAddress[] }>(`/workspaces/${workspaceId}/addresses`);
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
      linkedWorkspaceAddressId: string;
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
  createAddress(
    workspaceId: string,
    input: {
      address: string;
      displayName?: string;
      assetScope?: string;
      notes?: string;
    },
  ) {
    return request(`/workspaces/${workspaceId}/addresses`, {
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
  listPayees(workspaceId: string, status?: Payee['status']) {
    const params = new URLSearchParams({ limit: '100' });
    if (status) {
      params.set('status', status);
    }
    return request<{ servedAt: string; items: Payee[] }>(
      `/workspaces/${workspaceId}/payees?${params.toString()}`,
    );
  },
  createPayee(
    workspaceId: string,
    input: {
      name: string;
      defaultDestinationId?: string | null;
      externalReference?: string | null;
      status?: string;
      notes?: string | null;
      metadataJson?: Record<string, unknown>;
    },
  ) {
    return request<Payee>(`/workspaces/${workspaceId}/payees`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
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
      sourceWorkspaceAddressId?: string;
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
      payeeId?: string;
      destinationId: string;
      amountRaw: string;
      asset?: string;
      reason: string;
      externalReference?: string;
      dueAt?: string;
      metadataJson?: Record<string, unknown>;
      createOrderNow?: boolean;
      sourceWorkspaceAddressId?: string;
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
      sourceWorkspaceAddressId?: string;
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
      sourceWorkspaceAddressId?: string;
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
  downloadPaymentOrderAuditExport(workspaceId: string, paymentOrderId: string) {
    return download(`/workspaces/${workspaceId}/payment-orders/${paymentOrderId}/audit-export?format=csv`);
  },
  getPaymentOrderProof(workspaceId: string, paymentOrderId: string) {
    return request<PaymentProofPacket>(`/workspaces/${workspaceId}/payment-orders/${paymentOrderId}/proof`);
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
