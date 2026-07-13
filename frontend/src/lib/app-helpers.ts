import type { AuthenticatedSession } from '../api';

// Approval-action errors, with a way forward: the SoD veto (e.g. a solo owner
// approving their own bill) is a policy the owner may relax on the record —
// tell them where, instead of dead-ending (testbench VERIFY follow-up).
export function approvalActErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : 'Try again.';
  return /separation-of-duties/i.test(msg)
    ? `${msg} If your team is small enough that this rule doesn't fit, the primary admin can relax it on the Protections page — it goes on the record.`
    : msg;
}

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
