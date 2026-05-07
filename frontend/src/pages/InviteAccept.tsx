import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type { AuthenticatedSession, PublicInvite, UserWallet } from '../types';

export function InviteAcceptPage() {
  const { inviteToken } = useParams<{ inviteToken: string }>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const previewQuery = useQuery({
    queryKey: ['invite-preview', inviteToken] as const,
    queryFn: () => api.previewInvite(inviteToken!),
    enabled: Boolean(inviteToken),
    retry: false,
  });

  const sessionQuery = useQuery<AuthenticatedSession>({
    queryKey: ['session'] as const,
    queryFn: () => api.getSession(),
    enabled: api.hasSessionToken(),
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: () => api.acceptInvite(inviteToken!),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      let personalWallets: UserWallet[] = [];
      try {
        const data = await api.listPersonalWallets();
        personalWallets = data.items.filter(
          (w) => w.status === 'active' && w.chain === 'solana',
        );
      } catch {
        // ignore — fall back to default redirect
      }
      const target =
        personalWallets.length === 0
          ? '/profile'
          : `/organizations/${result.organizationId}/wallets`;
      navigate(target, { replace: true });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError || err instanceof Error
          ? err.message
          : 'Unable to accept invite.';
      setError(message);
    },
  });

  const sessionEmail = sessionQuery.data?.user.email ?? null;
  const invite = previewQuery.data;

  const status = useMemo(() => deriveStatus({
    inviteToken,
    previewQuery,
    sessionQuery,
    sessionEmail,
    invite,
  }), [inviteToken, previewQuery, sessionQuery, sessionEmail, invite]);

  return (
    <main className="login-shell">
      <section className="login-panel" style={{ width: 'min(100%, 560px)' }}>
        {renderContent({
          status,
          invite,
          sessionEmail,
          error,
          accepting: acceptMutation.isPending,
          onAccept: () => {
            setError(null);
            acceptMutation.mutate();
          },
          inviteToken,
        })}
      </section>
    </main>
  );
}

type InviteScreenStatus =
  | { kind: 'loading' }
  | { kind: 'invalid'; message: string }
  | { kind: 'terminal'; reason: 'accepted' | 'revoked' | 'expired' }
  | { kind: 'not-signed-in' }
  | { kind: 'wrong-email'; expected: string; current: string }
  | { kind: 'ready' };

function deriveStatus(args: {
  inviteToken: string | undefined;
  previewQuery: ReturnType<typeof useQuery<PublicInvite>>;
  sessionQuery: ReturnType<typeof useQuery<AuthenticatedSession>>;
  sessionEmail: string | null;
  invite: PublicInvite | undefined;
}): InviteScreenStatus {
  const { inviteToken, previewQuery, sessionQuery, sessionEmail, invite } = args;
  if (!inviteToken) return { kind: 'invalid', message: 'Invite link is missing a token.' };
  if (previewQuery.isLoading) return { kind: 'loading' };
  if (previewQuery.error) {
    const message =
      previewQuery.error instanceof Error
        ? previewQuery.error.message
        : 'Invite link is invalid.';
    return { kind: 'invalid', message };
  }
  if (!invite) return { kind: 'invalid', message: 'Invite not found.' };
  if (invite.status === 'accepted') return { kind: 'terminal', reason: 'accepted' };
  if (invite.status === 'revoked') return { kind: 'terminal', reason: 'revoked' };
  if (invite.status === 'expired') return { kind: 'terminal', reason: 'expired' };
  if (!api.hasSessionToken()) return { kind: 'not-signed-in' };
  if (sessionQuery.isLoading) return { kind: 'loading' };
  if (!sessionEmail) return { kind: 'not-signed-in' };
  if (sessionEmail.toLowerCase() !== invite.invitedEmail.toLowerCase()) {
    return { kind: 'wrong-email', expected: invite.invitedEmail, current: sessionEmail };
  }
  return { kind: 'ready' };
}

function renderContent(args: {
  status: InviteScreenStatus;
  invite: PublicInvite | undefined;
  sessionEmail: string | null;
  error: string | null;
  accepting: boolean;
  onAccept: () => void;
  inviteToken: string | undefined;
}) {
  const { status, invite, error, accepting, onAccept, inviteToken } = args;

  if (status.kind === 'loading') {
    return <p style={{ margin: 0 }}>Loading invite…</p>;
  }

  if (status.kind === 'invalid') {
    return (
      <>
        <h1>Invite unavailable</h1>
        <p>{status.message}</p>
        <p style={{ fontSize: 13 }}>
          <a href="/">Back to home</a>
        </p>
      </>
    );
  }

  if (status.kind === 'terminal') {
    const copy = {
      accepted: 'This invite has already been accepted.',
      revoked: 'This invite was revoked. Ask your admin for a new link.',
      expired: 'This invite has expired. Ask your admin for a new link.',
    }[status.reason];
    return (
      <>
        <h1>Invite unavailable</h1>
        <p>{copy}</p>
        {invite ? (
          <p style={{ fontSize: 13 }}>
            <strong>Organization:</strong> {invite.organization.organizationName}
          </p>
        ) : null}
        <p style={{ fontSize: 13 }}>
          <a href="/">Back to home</a>
        </p>
      </>
    );
  }

  if (!invite) return null;

  if (status.kind === 'not-signed-in') {
    const returnTo = encodeURIComponent(`/invites/${inviteToken ?? ''}`);
    return (
      <>
        <h1>You're invited to {invite.organization.organizationName}</h1>
        <p>
          {invite.invitedByUser.displayName || invite.invitedByUser.email} invited{' '}
          <strong>{invite.invitedEmail}</strong> to join as a{' '}
          <strong>{invite.role}</strong>. Sign in with that email to accept.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <a className="button button-primary" href={`/login?returnTo=${returnTo}`}>
            Sign in
          </a>
          <a className="button button-secondary" href={`/register?returnTo=${returnTo}`}>
            Create account
          </a>
        </div>
      </>
    );
  }

  if (status.kind === 'wrong-email') {
    return (
      <>
        <h1>Wrong email</h1>
        <p>
          This invite was sent to <strong>{status.expected}</strong>, but you're
          signed in as <strong>{status.current}</strong>. Sign out and sign back
          in with the invited email to accept.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="button button-secondary"
            onClick={async () => {
              try {
                await api.logout();
              } catch {
                // ignore
              }
              api.clearSessionToken();
              const returnTo = encodeURIComponent(`/invites/${inviteToken ?? ''}`);
              window.location.assign(`/login?returnTo=${returnTo}`);
            }}
          >
            Sign out and switch accounts
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Join {invite.organization.organizationName}</h1>
      <p>
        {invite.invitedByUser.displayName || invite.invitedByUser.email} invited
        you to join <strong>{invite.organization.organizationName}</strong> as a{' '}
        <strong>{invite.role}</strong>.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="button button-primary"
          onClick={onAccept}
          disabled={accepting}
          aria-busy={accepting}
        >
          {accepting ? 'Accepting…' : 'Accept invite'}
        </button>
      </div>
      {error ? <p className="form-error" style={{ marginTop: 14 }}>{error}</p> : null}
    </>
  );
}
