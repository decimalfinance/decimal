// Joining an organisation from an invitation (design 7b). Most people arrive
// this way. The invitation fixed the address, so a new person gives only a
// name and a password; someone already signed in as that address just joins.
import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AuthenticatedSession } from '../../api';
import type { PublicInvite } from '../../types';
import { queryKeys } from '../../lib/app-helpers';
import { fullDay } from '../../kit/format';
import { orgTone } from '../../kit/people';
import { Body, Field, FixedEmail, Frame, GoogleRow, Ink, LinkButton, Links, OrgMark, Pill, TextLink, Title, failureText, useFocusOnOpen } from './parts';
import { keepSession, rememberOrganization, signOut, startClean, withReturn } from './landing';
import { passwordProblem, type DevCodeState } from './SignIn';

const AS: Record<string, string> = {
  approver: 'an approver',
  bill_clerk: 'a bill clerk',
  payer: 'a payer',
  viewer: 'a viewer',
};

/** "Priya Raman invited you to join as an approver. The invitation lasts until 12 Oct 2026." */
function InvitedLine({ invite }: { invite: PublicInvite }) {
  const who = invite.invitedByUser.displayName || invite.invitedByUser.email;
  const as = invite.role === 'admin' ? 'an admin' : invite.jobRole ? AS[invite.jobRole] : undefined;
  return (
    <Body>
      <Ink>{who}</Ink> invited you to join{as ? ` as ${as}` : ''}. The invitation lasts until {fullDay(invite.expiresAt)}.
    </Body>
  );
}

/** The organisation's mark over the title, above the title line. */
function Mark({ invite }: { invite: PublicInvite }) {
  const { organizationId, organizationName } = invite.organization;
  return (
    <div className="si-mark">
      <OrgMark large name={organizationName} tone={orgTone([organizationId], organizationId)} />
    </div>
  );
}

function Ended({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Frame>
      <Title>{title}</Title>
      <Body>{children}</Body>
      <Links><TextLink to="/login">Back to sign in</TextLink></Links>
    </Frame>
  );
}

export function InviteAcceptPage() {
  const { inviteToken = '' } = useParams<{ inviteToken: string }>();
  const queryClient = useQueryClient();
  // Signing out happens here; this redraws the page for the new state.
  const [, redraw] = useState(0);

  const preview = useQuery({
    queryKey: ['invite-preview', inviteToken] as const,
    queryFn: () => api.previewInvite(inviteToken),
    enabled: Boolean(inviteToken),
    retry: false,
  });
  const signedIn = api.hasSessionToken();
  const session = useQuery({
    queryKey: queryKeys().session,
    queryFn: () => api.getSession(),
    enabled: signedIn,
    retry: false,
  });

  const invite = preview.data;
  if (preview.isLoading || (signedIn && session.isLoading)) return <Frame />;
  if (!invite) {
    return <Ended title="Invitation not found">This link doesn’t lead to an invitation. Ask whoever sent it for a new one.</Ended>;
  }

  const org = invite.organization.organizationName;
  const inviter = invite.invitedByUser.displayName || invite.invitedByUser.email;
  const me = session.data;
  if (invite.status === 'expired') {
    return <Ended title="Invitation expired">This invitation to {org} has expired. Ask {inviter} to send a new one.</Ended>;
  }
  if (invite.status === 'revoked') {
    return <Ended title="Invitation cancelled">This invitation to {org} was cancelled. Ask {inviter} for a new one if you still need it.</Ended>;
  }
  if (invite.status === 'accepted') {
    const member = me?.organizations.some((o) => o.organizationId === invite.organization.organizationId);
    if (member) return <Navigate to={`/organizations/${invite.organization.organizationId}`} replace />;
    return <Ended title="Invitation used">This invitation to {org} has already been used. Sign in to open it.</Ended>;
  }

  const switchAccount = async () => {
    await signOut(queryClient);
    redraw((n) => n + 1);
  };
  if (!me) return <NewPerson invite={invite} inviteToken={inviteToken} />;
  if (me.user.email.toLowerCase() !== invite.invitedEmail.toLowerCase()) {
    return (
      <Frame>
        <Mark invite={invite} />
        <Title>Join {org}</Title>
        <Body>
          This invitation is for <Ink>{invite.invitedEmail}</Ink>. You’re signed in as <Ink>{me.user.email}</Ink>, so sign out to join.
        </Body>
        <Pill type="button" far onClick={() => void switchAccount()}>Sign out</Pill>
      </Frame>
    );
  }
  return <SignedInAsInvited invite={invite} inviteToken={inviteToken} session={me} onSwitch={() => void switchAccount()} />;
}

/** Someone with no session: an account for the invited address, then in. */
function NewPerson({ invite, inviteToken }: { invite: PublicInvite; inviteToken: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const here = `/invites/${inviteToken}`;
  const org = invite.organization.organizationName;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; name?: string; password?: string }>({});
  const first = useFocusOnOpen<HTMLInputElement>();

  const join = useMutation({
    mutationFn: async (input: { displayName: string; password: string }) => {
      startClean(queryClient);
      const result = await api.register({ email: invite.invitedEmail, ...input });
      // Only the token for now: keeping the session would redraw this page as
      // someone signed in while they are still joining.
      api.setSessionToken(result.sessionToken);
      // An address still to confirm joins once it is confirmed.
      if (!result.user.emailVerifiedAt) return { result, joined: null };
      return { result, joined: await api.acceptInvite(inviteToken) };
    },
    onSuccess: async ({ result, joined }) => {
      if (!joined) {
        keepSession(queryClient, result);
        const state: DevCodeState = { devCode: result.devEmailVerificationCode ?? null };
        navigate(withReturn('/verify-email', here), { replace: true, state });
        return;
      }
      rememberOrganization(joined.organizationId);
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      navigate(`/organizations/${joined.organizationId}`, { replace: true });
    },
    onError: (error) =>
      setErrors(
        error instanceof ApiError && error.code === 'conflict'
          ? { email: 'There’s already an account with this address. Sign in to join.' }
          : { password: failureText(error) },
      ),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const displayName = name.trim();
    const next = { name: displayName ? undefined : 'Enter your name.', password: passwordProblem(password) };
    setErrors(next);
    if (!next.name && !next.password) join.mutate({ displayName, password });
  }

  return (
    <Frame>
      <Mark invite={invite} />
      <Title>Join {org}</Title>
      <InvitedLine invite={invite} />
      <form onSubmit={submit} noValidate>
        <GoogleRow returnTo={here} />
        <div className="si-fields">
          <FixedEmail email={invite.invitedEmail} error={errors.email} />
          <Field
            ref={first}
            id="si-name"
            label="FULL NAME"
            name="name"
            placeholder="Your name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
          />
          <Field
            id="si-password"
            label="PASSWORD"
            type="password"
            name="password"
            placeholder="At least 8 characters"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
          />
        </div>
        <Pill busy={join.isPending} busyLabel="Joining…">Join {org}</Pill>
      </form>
      <Links>
        Already have an account? <TextLink to={withReturn('/login', here)}>Sign in</TextLink>
      </Links>
    </Frame>
  );
}

/** Signed in as the address the invitation was sent to: one press joins. */
function SignedInAsInvited({
  invite,
  inviteToken,
  session,
  onSwitch,
}: {
  invite: PublicInvite;
  inviteToken: string;
  session: AuthenticatedSession;
  onSwitch: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const org = invite.organization.organizationName;
  const [error, setError] = useState<string | null>(null);

  const join = useMutation({
    mutationFn: () => api.acceptInvite(inviteToken),
    onSuccess: async (joined) => {
      rememberOrganization(joined.organizationId);
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      navigate(`/organizations/${joined.organizationId}`, { replace: true });
    },
    onError: (err) => setError(failureText(err)),
  });

  return (
    <Frame>
      <Mark invite={invite} />
      <Title>Join {org}</Title>
      <InvitedLine invite={invite} />
      <div className="si-fields">
        <FixedEmail email={invite.invitedEmail} error={error} />
      </div>
      <Pill
        type="button"
        busy={join.isPending}
        busyLabel="Joining…"
        onClick={() => {
          // The organisation takes only a confirmed address.
          if (!session.user.emailVerifiedAt) navigate(withReturn('/verify-email', `/invites/${inviteToken}`));
          else join.mutate();
        }}
      >
        Join {org}
      </Pill>
      <Links><LinkButton onClick={onSwitch}>Use another account</LinkButton></Links>
    </Frame>
  );
}
