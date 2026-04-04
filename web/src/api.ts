import type {
  AuthenticatedSession,
  ExceptionItem,
  LoginResponse,
  ObservedTransfer,
  OrganizationDirectoryItem,
  OrganizationMembership,
  ReconciliationRow,
  TransferRequest,
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
  listExceptions(workspaceId: string) {
    return request<{ servedAt: string; items: ExceptionItem[] }>(
      `/workspaces/${workspaceId}/exceptions?limit=100`,
    );
  },
  listTransferRequests(workspaceId: string) {
    return request<{ items: TransferRequest[] }>(`/workspaces/${workspaceId}/transfer-requests`);
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
