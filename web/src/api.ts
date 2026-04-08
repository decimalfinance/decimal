import type {
  ApprovalInboxItem,
  ApprovalPolicy,
  AuthenticatedSession,
  Counterparty,
  Destination,
  ExceptionItem,
  ExceptionNote,
  LoginResponse,
  ObservedTransfer,
  ReconciliationDetail,
  OrganizationDirectoryItem,
  OrganizationMembership,
  ReconciliationRow,
  TransferRequest,
  TransferRequestNote,
  WorkspaceAddress,
  Workspace,
} from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3100';
const AUTH_STORAGE_KEY = 'usdc_ops.session_token';

let sessionToken = loadStoredToken();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
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

export const api = {
  getSessionToken() {
    return sessionToken;
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
  joinOrganization(organizationId: string) {
    return request<OrganizationMembership>(`/organizations/${organizationId}/join`, {
      method: 'POST',
      body: JSON.stringify({}),
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
  updateCounterparty(
    workspaceId: string,
    counterpartyId: string,
    input: {
      displayName?: string;
      category?: string;
      externalReference?: string;
      status?: string;
    },
  ) {
    return request<Counterparty>(`/workspaces/${workspaceId}/counterparties/${counterpartyId}`, {
      method: 'PATCH',
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
  updateDestination(
    workspaceId: string,
    destinationId: string,
    input: {
      counterpartyId?: string | null;
      linkedWorkspaceAddressId?: string;
      destinationType?: string;
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
  updateAddress(
    workspaceId: string,
    workspaceAddressId: string,
    input: {
      address?: string;
      displayName?: string;
      notes?: string;
      isActive?: boolean;
    },
  ) {
    return request<WorkspaceAddress>(`/workspaces/${workspaceId}/addresses/${workspaceAddressId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
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
  listReconciliationQueue(workspaceId: string, displayState?: ReconciliationRow['requestDisplayState']) {
    return api.listReconciliationQueueWithStatus(workspaceId, {
      displayState,
    });
  },
  listReconciliationQueueWithStatus(
    workspaceId: string,
    filters?: {
      displayState?: ReconciliationRow['requestDisplayState'];
      requestStatus?: string;
    },
  ) {
    const params = new URLSearchParams({ limit: '100' });
    if (filters?.displayState) {
      params.set('displayState', filters.displayState);
    }
    if (filters?.requestStatus) {
      params.set('requestStatus', filters.requestStatus);
    }
    return request<{ servedAt: string; items: ReconciliationRow[] }>(
      `/workspaces/${workspaceId}/reconciliation-queue?${params.toString()}`,
    );
  },
  getReconciliationDetail(workspaceId: string, transferRequestId: string) {
    return request<ReconciliationDetail>(
      `/workspaces/${workspaceId}/reconciliation-queue/${transferRequestId}`,
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
  listApprovalInbox(
    workspaceId: string,
    input?: {
      status?: 'pending_approval' | 'escalated' | 'all';
    },
  ) {
    const params = new URLSearchParams({ limit: '100' });
    if (input?.status) {
      params.set('status', input.status);
    }
    return request<{ servedAt: string; approvalPolicy: ApprovalPolicy; items: ApprovalInboxItem[] }>(
      `/workspaces/${workspaceId}/approval-inbox?${params.toString()}`,
    );
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
  listTransferRequests(workspaceId: string) {
    return request<{ items: TransferRequest[] }>(`/workspaces/${workspaceId}/transfer-requests`);
  },
  addTransferRequestNote(workspaceId: string, transferRequestId: string, input: { body: string }) {
    return request<TransferRequestNote>(
      `/workspaces/${workspaceId}/transfer-requests/${transferRequestId}/notes`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  transitionTransferRequest(
    workspaceId: string,
    transferRequestId: string,
    input: {
      toStatus: string;
      note?: string;
      payloadJson?: Record<string, unknown>;
      linkedSignature?: string;
      linkedPaymentId?: string;
      linkedTransferIds?: string[];
    },
  ) {
    return request<TransferRequest>(
      `/workspaces/${workspaceId}/transfer-requests/${transferRequestId}/transitions`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  createTransferRequest(
    workspaceId: string,
    input: {
      sourceWorkspaceAddressId?: string;
      destinationWorkspaceAddressId?: string;
      destinationId?: string;
      requestType: string;
      asset?: string;
      amountRaw: string;
      reason?: string;
      externalReference?: string;
      status?: string;
      dueAt?: string;
    },
  ) {
    return request<TransferRequest>(`/workspaces/${workspaceId}/transfer-requests`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
};

function clearSessionToken() {
  sessionToken = null;
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

function loadStoredToken() {
  return window.localStorage.getItem(AUTH_STORAGE_KEY);
}
