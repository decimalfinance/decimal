// Where someone goes once they're signed in. Every way in (a password,
// Google, a confirmed email, an invitation, the developer page) ends here, so
// they all land the same way.
import type { QueryClient } from '@tanstack/react-query';
import { api, type AuthenticatedSession } from '../../api';
import type { LoginResponse } from '../../types';
import { queryKeys, toAuthenticatedSession } from '../../lib/app-helpers';

const LAST_ORGANIZATION = 'decimal.last-organization';

/** A returnTo from the address bar, only if it stays on this site. */
export function readSafeReturnTo(search: string): string | null {
  const raw = new URLSearchParams(search).get('returnTo');
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  return raw;
}

export function withReturn(path: string, returnTo: string | null) {
  return returnTo ? `${path}?returnTo=${encodeURIComponent(returnTo)}` : path;
}

/** The organisation this browser opened last, so signing in goes back to it. */
export function rememberOrganization(organizationId: string) {
  try {
    window.localStorage.setItem(LAST_ORGANIZATION, organizationId);
  } catch {
    // Storage off (a private window): every sign-in asks again.
  }
}

function lastOrganization() {
  try {
    return window.localStorage.getItem(LAST_ORGANIZATION);
  } catch {
    return null;
  }
}

/**
 * Where a signed-in person lands with nowhere in particular to go: making an
 * organisation if they have none, theirs if they have one, the one they last
 * opened if they have several, and otherwise a choice.
 */
export function homeFor(session: AuthenticatedSession) {
  const organizations = session.organizations;
  if (organizations.length === 0) return '/setup';
  if (organizations.length === 1) return `/organizations/${organizations[0]!.organizationId}`;
  const last = lastOrganization();
  if (last && organizations.some((o) => o.organizationId === last)) return `/organizations/${last}`;
  return '/choose-organization';
}

/** Where someone goes the moment they're signed in. An address still to confirm comes first. */
export function landingFor(session: AuthenticatedSession, returnTo: string | null) {
  if (!session.user.emailVerifiedAt) return withReturn('/verify-email', returnTo);
  return returnTo ?? homeFor(session);
}

/** Signing in always starts clean, so an old session can't win. */
export function startClean(queryClient: QueryClient) {
  void queryClient.cancelQueries({ queryKey: queryKeys().session });
  queryClient.removeQueries({ queryKey: queryKeys().session });
  api.clearSessionToken();
}

/** Keeps the session a sign-in or a new account returned, and gives it back. */
export function keepSession(queryClient: QueryClient, result: LoginResponse) {
  api.setSessionToken(result.sessionToken);
  const session = toAuthenticatedSession(result);
  queryClient.setQueryData(queryKeys().session, session);
  return session;
}

/** Signs out here and forgets everything this session loaded. */
export async function signOut(queryClient: QueryClient) {
  await queryClient.cancelQueries();
  await api.logout().catch(() => undefined);
  api.clearSessionToken();
  queryClient.clear();
}
