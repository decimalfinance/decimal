import type {
  AuthenticatedSession,
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
  listReconciliationQueue(workspaceId: string, displayState?: ReconciliationRow['requestDisplayState']) {
    const query = displayState ? `?limit=100&displayState=${encodeURIComponent(displayState)}` : '?limit=100';
    return request<{ servedAt: string; items: ReconciliationRow[] }>(
      `/workspaces/${workspaceId}/reconciliation-queue${query}`,
    );
  },
  getReconciliationDetail(workspaceId: string, transferRequestId: string) {
    return request<ReconciliationDetail>(
      `/workspaces/${workspaceId}/reconciliation-queue/${transferRequestId}`,
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
      destinationWorkspaceAddressId: string;
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
