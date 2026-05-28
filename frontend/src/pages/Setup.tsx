import { Navigate, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AuthenticatedSession } from '../api';
import { useToast } from '../ui/Toast';
import { PageFrame, SectionHeader } from '../ui-primitives';
import { getOrganizations, queryKeys } from '../lib/app-helpers';

export function HomeRedirect({ session }: { session: AuthenticatedSession }) {
  const [first] = getOrganizations(session);
  if (!first) {
    const firstOrganization = session.organizations[0];
    return (
      <Navigate
        to={firstOrganization ? `/organizations/${firstOrganization.organizationId}` : '/setup'}
        replace
      />
    );
  }

  return <Navigate to={`/organizations/${first.organization.organizationId}`} replace />;
}

export function SetupPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();
  const createOrganizationMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const organizationName = String(formData.get('organizationName') ?? '').trim();
      if (!organizationName) {
        throw new Error('Company name is required.');
      }
      return api.createOrganization({ organizationName });
    },
    onSuccess: async (organization) => {
      // Backend auto-provisions the owner's personal wallet + a default
      // automation agent + the agent's wallet on org creation. Happy path
      // is silent — only surface a warning if provisioning didn't complete.
      const personalStatus = organization.provisioning?.personalWallet?.status;
      const agentStatus = organization.provisioning?.defaultAgent?.status;
      const setupIncomplete =
        personalStatus === 'failed' ||
        personalStatus === 'skipped' ||
        agentStatus === 'failed' ||
        agentStatus === 'skipped';
      if (setupIncomplete) {
        toastError(
          'Workspace created, but background setup is incomplete. You can retry from settings.',
        );
      } else {
        success('Welcome to Decimal.');
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      navigate(`/organizations/${organization.organizationId}`, { replace: true });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to set up workspace.'),
  });
  return (
    <PageFrame
      eyebrow="Welcome"
      title="Name your company"
      description="This is what teammates and vendors will see. You can change it later in settings."
    >
      <div className="split-panels">
        <section className="panel">
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              createOrganizationMutation.mutate(new FormData(event.currentTarget));
            }}
          >
            <label className="field">
              Company name
              <input
                name="organizationName"
                placeholder="Acme Corp"
                autoComplete="organization"
                autoFocus
              />
            </label>
            <button
              className="button button-primary"
              disabled={createOrganizationMutation.isPending}
              type="submit"
              aria-busy={createOrganizationMutation.isPending}
            >
              {createOrganizationMutation.isPending ? 'Setting up your workspace…' : 'Continue'}
            </button>
            <p className="form-help">
              We'll set up your workspace in the background. You can invite teammates after.
            </p>
          </form>
        </section>
        <section className="panel">
          <SectionHeader
            title="Have an invite?"
            description="Open the link your admin sent while signed in with the email it was sent to."
          />
          <p className="form-help">
            Invites are accepted by opening the link directly — there's nothing to enter here.
          </p>
        </section>
      </div>
    </PageFrame>
  );
}
