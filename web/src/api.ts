import type {
  AuthenticatedSession,
  EventParticipant,
  LoginResponse,
  OnboardingSnapshot,
  OperationalEvent,
  OrganizationDirectoryItem,
  OrganizationMembership,
  ReconciliationRow,
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
  createOrganization(input: { organizationName: string; organizationSlug: string }) {
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
  listWorkspaces(organizationId: string) {
    return request<{ items: Workspace[] }>(`/organizations/${organizationId}/workspaces`);
  },
  createWorkspace(
    organizationId: string,
    input: {
      workspaceSlug: string;
      workspaceName: string;
      status?: string;
    },
  ) {
    return request<Workspace>(`/organizations/${organizationId}/workspaces`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  getOnboardingSnapshot(workspaceId: string) {
    return request<OnboardingSnapshot>(`/workspaces/${workspaceId}/onboarding`);
  },
  createAddress(
    workspaceId: string,
    input: {
      address: string;
      addressKind: string;
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
  createLabel(
    workspaceId: string,
    input: {
      labelName: string;
      labelType: string;
      color?: string;
      description?: string;
    },
  ) {
    return request(`/workspaces/${workspaceId}/labels`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  attachLabel(
    workspaceId: string,
    input: {
      workspaceAddressId: string;
      labelId: string;
    },
  ) {
    return request(`/workspaces/${workspaceId}/address-labels`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  createObject(
    workspaceId: string,
    input: {
      objectType: string;
      objectKey: string;
      displayName: string;
      status?: string;
    },
  ) {
    return request(`/workspaces/${workspaceId}/objects`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  createObjectMapping(
    workspaceId: string,
    input: {
      workspaceAddressId: string;
      workspaceObjectId: string;
      mappingRole: string;
      confidence?: number;
      isPrimary?: boolean;
    },
  ) {
    return request(`/workspaces/${workspaceId}/address-object-mappings`, {
      method: 'POST',
      body: JSON.stringify({
        source: 'manual',
        confidence: input.confidence ?? 1,
        isPrimary: input.isPrimary ?? true,
        ...input,
      }),
    });
  },
  listEvents(workspaceId: string, filters?: { eventType?: string; direction?: string }) {
    const params = new URLSearchParams();
    params.set('limit', '100');
    if (filters?.eventType) params.set('eventType', filters.eventType);
    if (filters?.direction) params.set('direction', filters.direction);
    return request<{ items: OperationalEvent[] }>(`/workspaces/${workspaceId}/events?${params.toString()}`);
  },
  listReconciliation(workspaceId: string) {
    return request<{ items: ReconciliationRow[] }>(`/workspaces/${workspaceId}/reconciliation?limit=100`);
  },
  listParticipants(workspaceId: string, workspaceEventId: string) {
    return request<{ items: EventParticipant[] }>(
      `/workspaces/${workspaceId}/events/${workspaceEventId}/participants`,
    );
  },
};

function clearSessionToken() {
  sessionToken = null;
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

function loadStoredToken() {
  return window.localStorage.getItem(AUTH_STORAGE_KEY);
}
