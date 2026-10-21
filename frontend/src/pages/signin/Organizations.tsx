// Creating an organisation (designs 7k and 7l) and choosing one (7j). Both
// stand outside the app, like Sign in: there is no sidebar until there is an
// organisation to open.
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { accessApi, api, ApiError, type AuthenticatedSession } from '../../api';
import { queryKeys } from '../../lib/app-helpers';
import { orgTone, roleLabel } from '../../kit/people';
import { Body, Chevron, Field, Frame, Ink, LinkButton, Links, Note, OrgMark, Pill, Title, failureText, useFocusOnOpen } from './parts';
import { homeFor, landingFor, readSafeReturnTo, rememberOrganization, signOut } from './landing';

function UseAnotherAccount() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <Links>
      <LinkButton
        onClick={async () => {
          await signOut(queryClient);
          navigate('/login', { replace: true });
        }}
      >
        Use another account
      </LinkButton>
    </Links>
  );
}

// ─── 7k · Create an organisation (7l: the name is taken) ────────────────

export function CreateOrganizationPage({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const first = useFocusOnOpen<HTMLInputElement>();

  const create = useMutation({
    mutationFn: (organizationName: string) => api.createOrganization({ organizationName }),
    onSuccess: async (organization) => {
      rememberOrganization(organization.organizationId);
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      // Its first screen: Bills, before the first bill.
      navigate(`/organizations/${organization.organizationId}/bills`, { replace: true });
    },
    onError: (err, organizationName) =>
      setError(
        err instanceof ApiError && err.code === 'organization_name_taken'
          ? `An organisation called “${organizationName}” already exists. Try another name.`
          : failureText(err),
      ),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value) {
      setError('Enter the organisation’s name.');
      return;
    }
    setError(null);
    create.mutate(value);
  }

  return (
    <Frame>
      <Title>Create an organisation</Title>
      <Body>Signed in as <Ink>{session.user.email}</Ink>.</Body>
      <form onSubmit={submit} noValidate>
        <div className="si-fields">
          <Field
            ref={first}
            id="si-org"
            label="ORGANISATION NAME"
            name="organizationName"
            placeholder="Testing Labs"
            autoComplete="organization"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={error}
          />
        </div>
        <Pill busy={create.isPending} busyLabel="Creating organisation…">Create organisation</Pill>
      </form>
      <Note>You’ll be its primary admin, and it gets its own address for forwarding bills.</Note>
      <UseAnotherAccount />
    </Frame>
  );
}

// ─── 7j · Choose an organisation ───────────────────────────────────────
// For someone in more than one, when this browser hasn't opened one before.

export function ChooseOrganizationPage({ session }: { session: AuthenticatedSession }) {
  const navigate = useNavigate();
  const organizations = session.organizations;
  const ids = organizations.map((o) => o.organizationId);
  // What they are in each, as the sidebar's switcher asks it.
  const access = useQueries({
    queries: organizations.map((o) => ({
      queryKey: ['my-access', o.organizationId],
      queryFn: () => accessApi.get(o.organizationId),
      staleTime: 60_000,
    })),
  });

  if (organizations.length < 2) return <Navigate to={homeFor(session)} replace />;

  return (
    <Frame>
      <Title>Choose an organisation</Title>
      <div className="si-who">
        {session.user.avatarUrl ? <img src={session.user.avatarUrl} alt="" /> : null}
        <span>{session.user.email}</span>
      </div>
      <div className="si-orgs">
        {organizations.map((o, i) => {
          const role = roleLabel(access[i]?.data);
          return (
            <button
              key={o.organizationId}
              type="button"
              className="si-org"
              aria-label={role ? `${o.organizationName}, ${role}` : o.organizationName}
              onClick={() => {
                rememberOrganization(o.organizationId);
                navigate(`/organizations/${o.organizationId}`);
              }}
            >
              <OrgMark name={o.organizationName} tone={orgTone(ids, o.organizationId)} />
              <span className="si-org-text">
                <span className="si-org-name">{o.organizationName}</span>
                {role ? <span className="si-org-role">{role}</span> : null}
              </span>
              <Chevron />
            </button>
          );
        })}
      </div>
      <Note>You can switch at any time from the top of the sidebar.</Note>
      <UseAnotherAccount />
    </Frame>
  );
}

/** Inside the app, an address that leads nowhere goes home instead. */
export function HomeRedirect({ session }: { session: AuthenticatedSession }) {
  return <Navigate to={homeFor(session)} replace />;
}

/**
 * Check your email, for an address that is already confirmed: on to where
 * they were going. The same place the page itself sends them the moment the
 * code is accepted, so whichever moves first, they land in one place.
 */
export function OnwardRedirect({ session }: { session: AuthenticatedSession }) {
  const returnTo = readSafeReturnTo(useLocation().search);
  return <Navigate to={landingFor(session, returnTo)} replace />;
}
