import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  CreateOrganizationInviteResponse,
  OrganizationInviteRole,
} from '../types';
import { formatRelativeTime, formatTimestamp } from '../domain';
import { useToast } from '../ui/Toast';
import { EmptyIcon, RdEmptyState } from '../ui-primitives';

export function MembersPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const currentMembership = useMemo(
    () => session.organizations.find((o) => o.organizationId === organizationId),
    [session.organizations, organizationId],
  );
  const isAdmin =
    currentMembership?.role === 'owner' || currentMembership?.role === 'admin';

  const [inviteOpen, setInviteOpen] = useState(false);
  const [revealedInvite, setRevealedInvite] =
    useState<CreateOrganizationInviteResponse | null>(null);

  const membersQuery = useQuery({
    queryKey: ['organization-members', organizationId] as const,
    queryFn: () => api.listOrganizationMembers(organizationId!),
    enabled: Boolean(organizationId),
  });

  const invitesQuery = useQuery({
    queryKey: ['organization-invites', organizationId, 'pending'] as const,
    queryFn: () => api.listOrganizationInvites(organizationId!, 'pending'),
    enabled: Boolean(organizationId) && isAdmin,
  });

  const createInviteMutation = useMutation({
    mutationFn: (input: { email: string; role: OrganizationInviteRole }) =>
      api.createOrganizationInvite(organizationId!, input),
    onSuccess: async (created) => {
      success('Invite created. Share the link before it expires.');
      setInviteOpen(false);
      setRevealedInvite(created);
      await queryClient.invalidateQueries({
        queryKey: ['organization-invites', organizationId, 'pending'],
      });
    },
    onError: (err) => {
      toastError(err instanceof Error ? err.message : 'Unable to create invite.');
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (organizationInviteId: string) =>
      api.revokeOrganizationInvite(organizationId!, organizationInviteId),
    onSuccess: async () => {
      success('Invite revoked.');
      await queryClient.invalidateQueries({
        queryKey: ['organization-invites', organizationId, 'pending'],
      });
    },
    onError: (err) => {
      toastError(err instanceof Error ? err.message : 'Unable to revoke invite.');
    },
  });

  if (!organizationId) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Organization unavailable</h2>
          <p className="rd-state-body">Pick an organization from the sidebar.</p>
        </div>
      </main>
    );
  }

  const members = membersQuery.data?.items ?? [];
  const pendingInvites = invitesQuery.data?.items ?? [];

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Registry</p>
          <h1>Members</h1>
          <p>
            Invite teammates into Decimal first. Add them to a Squads treasury
            separately after they create a signing wallet.
          </p>
        </div>
        {isAdmin ? (
          <div className="page-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => setInviteOpen(true)}
            >
              + Invite member
            </button>
          </div>
        ) : null}
      </header>

      {revealedInvite ? (
        <NewInviteReveal
          invite={revealedInvite}
          onDismiss={() => setRevealedInvite(null)}
        />
      ) : null}

      <section className="rd-section" style={{ marginTop: 8 }}>
        <div className="rd-table-shell">
          {membersQuery.isLoading ? (
            <div style={{ padding: 16 }}>
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
            </div>
          ) : members.length === 0 ? (
            <RdEmptyState
              icon={<EmptyIcon kind="users" />}
              title="No members yet"
              description={
                isAdmin
                  ? 'Invite teammates to collaborate on this organization.'
                  : 'Ask an admin to invite teammates.'
              }
              primary={isAdmin ? { label: 'Invite teammate', onClick: () => setInviteOpen(true) } : undefined}
            />
          ) : (
            <table className="rd-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.membershipId}>
                    <td>{m.user.displayName || '—'}</td>
                    <td>{m.user.email}</td>
                    <td>
                      <RolePill role={m.role} />
                    </td>
                    <td>
                      <span className="rd-pill rd-pill-info">
                        <span className="rd-pill-dot" />
                        {m.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {isAdmin ? (
        <section className="rd-section" style={{ marginTop: 24 }}>
          <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>Pending invites</h2>
            <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
              Invite links are shown once at creation. Revoke and re-invite if the link is lost.
            </p>
          </header>
          <div className="rd-table-shell">
            {invitesQuery.isLoading ? (
              <div style={{ padding: 16 }}>
                <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
              </div>
            ) : pendingInvites.length === 0 ? (
              <div className="rd-empty-cell" style={{ padding: '32px 24px' }}>
                <strong>No pending invites</strong>
                <p style={{ margin: 0 }}>Create an invite to add a teammate.</p>
              </div>
            ) : (
              <table className="rd-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Invited by</th>
                    <th>Expires</th>
                    <th>Created</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingInvites.map((invite) => (
                    <tr key={invite.organizationInviteId}>
                      <td>{invite.invitedEmail}</td>
                      <td>
                        <RolePill role={invite.role} />
                      </td>
                      <td>
                        {invite.invitedByUser.displayName || invite.invitedByUser.email}
                      </td>
                      <td title={formatTimestamp(invite.expiresAt)}>
                        {formatRelativeTime(invite.expiresAt)}
                      </td>
                      <td title={formatTimestamp(invite.createdAt)}>
                        {formatRelativeTime(invite.createdAt)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Revoke invite for ${invite.invitedEmail}? They will need a new link to join.`,
                              )
                            ) {
                              revokeInviteMutation.mutate(invite.organizationInviteId);
                            }
                          }}
                          disabled={revokeInviteMutation.isPending}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      ) : null}

      {inviteOpen ? (
        <InviteMemberDialog
          pending={createInviteMutation.isPending}
          onClose={() => setInviteOpen(false)}
          onSubmit={(input) => createInviteMutation.mutate(input)}
        />
      ) : null}
    </main>
  );
}

function RolePill({ role }: { role: string }) {
  return (
    <span className="rd-pill rd-pill-info">
      <span className="rd-pill-dot" />
      {role}
    </span>
  );
}

function NewInviteReveal({
  invite,
  onDismiss,
}: {
  invite: CreateOrganizationInviteResponse;
  onDismiss: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(invite.inviteLink);
      setCopied(true);
      success('Invite link copied.');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toastError('Unable to copy. Select the link and copy manually.');
    }
  }

  return (
    <section
      className="rd-section"
      style={{
        marginTop: 8,
        border: '1px solid rgba(120, 220, 160, 0.35)',
        borderRadius: 12,
        padding: 16,
        background: 'rgba(60, 180, 110, 0.08)',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>
          Invite link for {invite.invitedEmail}
        </h2>
        <button
          type="button"
          className="button button-secondary"
          onClick={onDismiss}
          style={{ padding: '4px 10px', fontSize: 13 }}
        >
          Dismiss
        </button>
      </header>
      <p style={{ margin: '0 0 12px', fontSize: 13, opacity: 0.85 }}>
        Share this link with {invite.invitedEmail}. They must sign in with that email to accept. The link is shown once — revoke and re-invite if it's lost.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <input
          readOnly
          value={invite.inviteLink}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid rgba(255, 255, 255, 0.12)',
            background: 'rgba(0, 0, 0, 0.25)',
            color: 'inherit',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
          }}
        />
        <button type="button" className="button button-primary" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </section>
  );
}

function InviteMemberDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: { email: string; role: OrganizationInviteRole }) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationInviteRole>('member');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    onSubmit({ email: trimmed, role });
  }

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-invite-member-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 480 }}>
        <h2 id="rd-invite-member-title" className="rd-dialog-title">
          Invite member
        </h2>
        <p className="rd-dialog-body">
          Send a Decimal invite link. The recipient must sign in with this email to accept. They can be promoted to admin after joining.
        </p>
        <form onSubmit={handleSubmit}>
          <label className="field">
            Email
            <input
              name="email"
              type="email"
              required
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="teammate@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            Role
            <select
              name="role"
              value={role}
              onChange={(e) => setRole(e.target.value as OrganizationInviteRole)}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={pending || !email.trim()}
              aria-busy={pending}
            >
              {pending ? 'Creating…' : 'Create invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
