// Join via invite — implements the design (pages-auth.jsx PageJoin).
// Reuses the AuthLayout (BrandPanel + form column) and renders a
// state-driven inner card: loading / invalid / terminal / not-signed-in /
// wrong-email / ready. The "ready" state matches the design exactly with
// a locked email (.input-lock) + verified check + accept button.

import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type { AuthenticatedSession, PublicInvite, UserWallet } from '../types';
import { Ico } from '../dec/icons';
import { AuthLayout } from './auth';

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

  const status = useMemo(
    () =>
      deriveStatus({
        inviteToken,
        previewQuery,
        sessionQuery,
        sessionEmail,
        invite,
      }),
    [inviteToken, previewQuery, sessionQuery, sessionEmail, invite],
  );

  const orgName = invite?.organization.organizationName ?? 'this workspace';
  const tagline =
    status.kind === 'ready' || status.kind === 'wrong-email'
      ? `You've been invited to ${orgName}. Finish setting up your account.`
      : status.kind === 'not-signed-in'
        ? `You've been invited to ${orgName}. Sign in to accept.`
        : "Hang tight — we're checking your invite.";

  return (
    <AuthLayout tagline={tagline}>
      <InviteCard
        status={status}
        invite={invite}
        error={error}
        accepting={acceptMutation.isPending}
        inviteToken={inviteToken}
        onAccept={() => {
          setError(null);
          acceptMutation.mutate();
        }}
      />
    </AuthLayout>
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

function InviteCard({
  status,
  invite,
  error,
  accepting,
  inviteToken,
  onAccept,
}: {
  status: InviteScreenStatus;
  invite: PublicInvite | undefined;
  error: string | null;
  accepting: boolean;
  inviteToken: string | undefined;
  onAccept: () => void;
}) {
  if (status.kind === 'loading') {
    return (
      <>
        <h1>Checking your invite…</h1>
        <p className="auth-sub">One moment.</p>
      </>
    );
  }

  if (status.kind === 'invalid') {
    return (
      <>
        <h1>Invite unavailable</h1>
        <p className="auth-sub">{status.message}</p>
        <a className="btn btn-primary" href="/" style={{ marginTop: 14, width: '100%', height: 46 }}>
          Back to home
        </a>
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
        <p className="auth-sub">{copy}</p>
        {invite ? (
          <p className="auth-sub">
            Organization: <b style={{ color: 'var(--text-primary)' }}>{invite.organization.organizationName}</b>
          </p>
        ) : null}
        <a className="btn btn-secondary" href="/" style={{ marginTop: 14, width: '100%', height: 46 }}>
          Back to home
        </a>
      </>
    );
  }

  if (!invite) return null;

  if (status.kind === 'not-signed-in') {
    const returnPath = `/invites/${inviteToken ?? ''}`;
    const returnToParam = encodeURIComponent(returnPath);
    return (
      <>
        <h1>Join {invite.organization.organizationName}</h1>
        <p className="auth-sub">
          You were invited as a <b style={{ color: 'var(--text-primary)' }}>{invite.role.charAt(0).toUpperCase() + invite.role.slice(1)}</b>.
          Sign in or create an account with <b style={{ color: 'var(--text-primary)' }}>{invite.invitedEmail}</b> to accept.
        </p>

        <button
          type="button"
          className="btn-google"
          onClick={() => window.location.assign(api.getGoogleOAuthStartUrl(returnPath))}
        >
          <Ico.google w={18} />Continue with Google
        </button>
        <div className="auth-divider">or</div>

        <div className="stack-field">
          <div className="field">
            <label className="field-label">Email</label>
            <div className="input-lock">
              <Ico.mail w={15} />{invite.invitedEmail}
              <span className="il-check"><Ico.checkSm w={15} /></span>
            </div>
          </div>
        </div>

        <a
          className="btn btn-primary"
          href={`/register?returnTo=${returnToParam}`}
          style={{ marginTop: 14, width: '100%', height: 46 }}
        >
          Create account &amp; join<Ico.arrowRight w={15} />
        </a>
        <p className="auth-switch">
          Already have an account? <a href={`/login?returnTo=${returnToParam}`}>Log in</a>
        </p>
      </>
    );
  }

  if (status.kind === 'wrong-email') {
    const returnPath = `/invites/${inviteToken ?? ''}`;
    return (
      <>
        <h1>Wrong account</h1>
        <p className="auth-sub">
          This invite was sent to <b style={{ color: 'var(--text-primary)' }}>{status.expected}</b>, but you're
          signed in as <b style={{ color: 'var(--text-primary)' }}>{status.current}</b>. Sign out and sign back in
          with the invited email to accept.
        </p>

        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 14, width: '100%', height: 46 }}
          onClick={async () => {
            try {
              await api.logout();
            } catch {
              // ignore
            }
            api.clearSessionToken();
            window.location.assign(`/login?returnTo=${encodeURIComponent(returnPath)}`);
          }}
        >
          Sign out and switch accounts
        </button>
      </>
    );
  }

  // ready: user is signed in with the right email — just one button to accept.
  return (
    <>
      <h1>Join {invite.organization.organizationName}</h1>
      <p className="auth-sub">
        You were invited by <b style={{ color: 'var(--text-primary)' }}>{invite.invitedByUser.displayName || invite.invitedByUser.email}</b>
        {' '}as a <b style={{ color: 'var(--text-primary)' }}>{invite.role.charAt(0).toUpperCase() + invite.role.slice(1)}</b>.
      </p>

      <div className="stack-field">
        <div className="field">
          <label className="field-label">Email</label>
          <div className="input-lock">
            <Ico.mail w={15} />{invite.invitedEmail}
            <span className="il-check"><Ico.checkSm w={15} /></span>
          </div>
        </div>
      </div>

      {error ? (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--danger)' }}>{error}</div>
      ) : null}

      <button
        type="button"
        className="btn btn-primary"
        style={{ marginTop: 14, width: '100%', height: 46 }}
        onClick={onAccept}
        disabled={accepting}
        aria-busy={accepting}
      >
        {accepting ? 'Joining…' : <>Accept invite<Ico.arrowRight w={15} /></>}
      </button>
    </>
  );
}
