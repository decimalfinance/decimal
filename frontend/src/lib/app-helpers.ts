import type { AuthenticatedSession } from '../api';

export function queryKeys(organizationId?: string, paymentOrderId?: string) {
  return {
    session: ['session'] as const,
    addresses: ['addresses', organizationId] as const,
    counterparties: ['counterparties', organizationId] as const,
    counterpartyWallets: ['counterparty-wallets', organizationId] as const,
    paymentOrders: ['payment-orders', organizationId] as const,
    paymentOrder: ['payment-order', organizationId, paymentOrderId] as const,
  };
}

export function toAuthenticatedSession(result: {
  user: AuthenticatedSession['user'];
  organizations: AuthenticatedSession['organizations'];
}): AuthenticatedSession {
  return {
    authenticated: true,
    user: result.user,
    organizations: result.organizations,
  };
}

export function getOrganizations(session: AuthenticatedSession) {
  return session.organizations.map((organization) => ({ organization }));
}

export function getFormString(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

export function getOptionalFormString(formData: FormData, key: string) {
  const value = getFormString(formData, key);
  return value || null;
}
