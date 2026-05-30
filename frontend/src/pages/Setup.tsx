// First-run onboarding — "Create your organization" full-bleed page.
// Implements PageSetup from the design handoff (pages-onboard.jsx).
// Treasury creation + invites happen inside the workspace on Overview.

import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AuthenticatedSession } from '../api';
import { useToast } from '../ui/Toast';
import { getOrganizations, queryKeys } from '../lib/app-helpers';
import { Ico } from '../dec/icons';

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
  const [name, setName] = useState('');

  const createOrganizationMutation = useMutation({
    mutationFn: async (organizationName: string) => {
      const trimmed = organizationName.trim();
      if (!trimmed) throw new Error('Organization name is required.');
      return api.createOrganization({ organizationName: trimmed });
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
    onError: (err) =>
      toastError(err instanceof Error ? err.message : 'Unable to set up workspace.'),
  });

  const pending = createOrganizationMutation.isPending;

  return (
    <div className="setup">
      <div className="setup-word">
        <span className="sw-g">D</span>Decimal
      </div>
      <div className="setup-card">
        <h1>Create your organization</h1>
        <p className="setup-sub">
          This is the workspace your team signs into. You'll set up a treasury and invite people once you're in.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createOrganizationMutation.mutate(name);
          }}
        >
          <div className="row" style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            {/* Logo upload is a future affordance — the dashed square is the
                design's placeholder. Click does nothing yet. */}
            <div
              className="logo-drop"
              role="button"
              tabIndex={-1}
              aria-label="Upload logo (coming soon)"
            >
              <Ico.plus w={18} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label" htmlFor="dec-org-name">
                Organization name
              </label>
              <input
                id="dec-org-name"
                className="input"
                name="organizationName"
                placeholder="Acme Corp"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="organization"
                autoFocus
                required
              />
              <span className="input-help">Add a logo later from settings.</span>
            </div>
          </div>
          <div className="setup-foot">
            <button
              type="submit"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={pending || !name.trim()}
              aria-busy={pending}
            >
              {pending ? 'Setting up your workspace…' : (
                <>
                  Create organization
                  <Ico.arrowRight w={15} />
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Lightweight reassurance about invites — moved to a low-key card
          below the main one rather than a full side panel, since first-run
          users are creating, not joining. */}
      <div
        className="setup-card"
        style={{ marginTop: 16, background: 'var(--bg-canvas)', borderStyle: 'dashed' }}
      >
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>Have an invite?</h1>
        <p className="setup-sub" style={{ marginBottom: 0 }}>
          Open the link your admin sent while signed in with the email it was sent to —
          there's nothing to enter here.
        </p>
      </div>
    </div>
  );
}
