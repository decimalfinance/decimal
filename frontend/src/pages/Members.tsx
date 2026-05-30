// Members — implements the design (pages-people.jsx PageMembers + InviteModal).
// Single unified roster: real members + pending invites in one table.
// 3-tile metrics. Invite modal is two steps: compose → link generated.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  CreateOrganizationInviteResponse,
  OrganizationInvite,
  OrganizationInviteRole,
  OrganizationMember,
} from '../types';
import { useToast } from '../ui/Toast';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';

type RosterRow =
  | {
      kind: 'member';
      id: string;
      name: string | null;
      email: string;
      avatarUrl: string | null;
      role: string;
      status: string;
      joined: string;
      initials: string;
    }
  | {
      kind: 'invite';
      id: string;
      email: string;
      role: OrganizationInviteRole;
      status: 'Invited';
      createdAt: string;
    };

function initialsFromName(name: string | null, email: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  const local = email.split('@')[0] ?? '?';
  return local.slice(0, 2).toUpperCase();
}

function shortMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function rolePillClass(role: string): string {
  return role.toLowerCase() === 'owner' ? 'role owner' : 'role';
}

function statusPill(status: string) {
  if (status === 'Active') return { cls: 'pill-success', label: 'Active' };
  if (status === 'Invited') return { cls: 'pill-warning', label: 'Invited' };
  if (status === 'Revoked') return { cls: 'pill-neutral', label: 'Revoked' };
  return { cls: 'pill-neutral', label: status };
}

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
      success('Invite created.');
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

  if (!organizationId) return null;

  const members = membersQuery.data?.items ?? [];
  const pendingInvites: OrganizationInvite[] = invitesQuery.data?.items ?? [];

  // Merge into a single roster — real members first, pending invites below.
  // The design puts them in one table with status pills doing the visual
  // discrimination (Active vs Invited vs Revoked).
  const roster: RosterRow[] = [
    ...members.map<RosterRow>((m: OrganizationMember) => ({
      kind: 'member',
      id: m.membershipId,
      name: m.user.displayName,
      email: m.user.email,
      avatarUrl: m.user.avatarUrl ?? null,
      role: m.role.charAt(0).toUpperCase() + m.role.slice(1),
      status: m.status === 'active' ? 'Active' : m.status,
      joined: '—', // OrganizationMember doesn't carry joinedAt; surface "—" until backend exposes it
      initials: initialsFromName(m.user.displayName, m.user.email),
    })),
    ...pendingInvites.map<RosterRow>((inv) => ({
      kind: 'invite',
      id: inv.organizationInviteId,
      email: inv.invitedEmail,
      role: inv.role,
      status: 'Invited',
      createdAt: inv.createdAt,
    })),
  ];

  const activeMembers = members.filter((m) => m.status === 'active').length;
  const pendingCount = pendingInvites.length;
  const adminsCount = members.filter(
    (m) => m.status === 'active' && (m.role === 'owner' || m.role === 'admin'),
  ).length;

  const orgName = currentMembership?.organizationName ?? 'this workspace';

  return (
    <div className="page">
      <div className="stack stack-24">
        <PageHead
          eyebrow="REGISTRY"
          title="Members"
          desc={`People in ${orgName}. Invite a teammate by email — they'll get a link to sign in and join.`}
          actions={
            isAdmin ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setInviteOpen(true)}
              >
                <Ico.userPlus w={15} />Invite member
              </button>
            ) : undefined
          }
        />

        <div className="metrics" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="metric">
            <div className="m-label">Members</div>
            <div className="m-value">{activeMembers}</div>
            <div className="m-sub">{activeMembers === 1 ? 'active' : 'active'}</div>
          </div>
          <div className="metric">
            <div className="m-label">Pending invites</div>
            <div className="m-value">{pendingCount}</div>
            <div className="m-sub">{pendingCount === 1 ? 'awaiting sign-in' : 'awaiting sign-in'}</div>
          </div>
          <div className="metric">
            <div className="m-label">Admins</div>
            <div className="m-value">{adminsCount}</div>
            <div className="m-sub">{adminsCount > 0 ? 'incl. owner' : ''}</div>
          </div>
        </div>

        {revealedInvite ? (
          <RevealedInviteBanner
            invite={revealedInvite}
            onDismiss={() => setRevealedInvite(null)}
          />
        ) : null}

        <div className="tbl-card">
          {membersQuery.isLoading ? (
            <div style={{ padding: 16 }}>
              <div className="skeleton" style={{ height: 48, marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 48 }} />
            </div>
          ) : roster.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Ico.members w={22} /></div>
              <h4>No members yet</h4>
              <p>
                {isAdmin
                  ? 'Invite teammates to collaborate on this organization.'
                  : 'Ask an admin to invite teammates.'}
              </p>
              {isAdmin ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ marginTop: 6 }}
                  onClick={() => setInviteOpen(true)}
                >
                  <Ico.userPlus w={15} />Invite member
                </button>
              ) : null}
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>Member</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Joined</th>
                  <th className="num" style={{ width: 160 }}></th>
                </tr>
              </thead>
              <tbody>
                {roster.map((row) => (
                  <RosterTableRow
                    key={`${row.kind}:${row.id}`}
                    row={row}
                    isAdmin={isAdmin}
                    onRevoke={(id) => {
                      if (
                        window.confirm(
                          `Revoke invite for ${row.kind === 'invite' ? row.email : ''}? They will need a new link to join.`,
                        )
                      ) {
                        revokeInviteMutation.mutate(id);
                      }
                    }}
                    revoking={revokeInviteMutation.isPending}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {inviteOpen ? (
        <InviteMemberDialog
          pending={createInviteMutation.isPending}
          onClose={() => setInviteOpen(false)}
          onSubmit={(input) => createInviteMutation.mutate(input)}
        />
      ) : null}
    </div>
  );
}

function RosterTableRow({
  row,
  isAdmin,
  onRevoke,
  revoking,
}: {
  row: RosterRow;
  isAdmin: boolean;
  onRevoke: (id: string) => void;
  revoking: boolean;
}) {
  if (row.kind === 'member') {
    const status = statusPill(row.status);
    return (
      <tr>
        <td>
          <div className="member-cell">
            <MemberAvatar avatarUrl={row.avatarUrl} initials={row.initials} />
            <div className="col">
              <span className="m-name">{row.name ?? row.email}</span>
              {row.name ? (
                <span className="m-sub" style={{ fontFamily: 'var(--font-body)' }}>{row.email}</span>
              ) : null}
            </div>
          </div>
        </td>
        <td>
          <span className={rolePillClass(row.role)}>
            {row.role.toLowerCase() === 'owner' ? <Ico.key w={12} /> : null}
            {row.role}
          </span>
        </td>
        <td>
          <span className={`pill ${status.cls}`}><span className="dot" />{status.label}</span>
        </td>
        <td><span className="joined">{shortMonth(row.joined) === '—' ? '—' : row.joined}</span></td>
        <td />
      </tr>
    );
  }

  // invited row
  const status = statusPill(row.status);
  return (
    <tr>
      <td>
        <div className="member-cell">
          <span className="m-avatar invited"><Ico.mail w={15} /></span>
          <div className="col">
            <span className="m-name">{row.email}</span>
            <span className="m-sub" style={{ fontFamily: 'var(--font-body)' }}>Invitation sent · not yet joined</span>
          </div>
        </div>
      </td>
      <td>
        <span className={rolePillClass(row.role)}>
          {row.role.charAt(0).toUpperCase() + row.role.slice(1)}
        </span>
      </td>
      <td>
        <span className={`pill ${status.cls}`}><span className="dot" />{status.label}</span>
      </td>
      <td><span className="joined">—</span></td>
      <td>
        <div className="row-actions">
          {isAdmin ? (
            <button
              type="button"
              className="btn btn-sm btn-danger-ghost"
              onClick={() => onRevoke(row.id)}
              disabled={revoking}
            >
              Revoke
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

// Real-photo avatar with initials fallback. Google profile photos block
// requests with an unfamiliar Referer header, so we set
// referrerPolicy="no-referrer" and fall back to initials if the image fails.
function MemberAvatar({ avatarUrl, initials }: { avatarUrl: string | null; initials: string }) {
  const [failed, setFailed] = useState(false);
  if (!avatarUrl || failed) {
    return <span className="m-avatar">{initials}</span>;
  }
  return (
    <span
      className="m-avatar"
      style={{ padding: 0, overflow: 'hidden', background: 'transparent' }}
    >
      <img
        src={avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </span>
  );
}

// Inline banner that shows once after creating an invite. Per the design,
// the link is shown ONCE with a copyable field + "Shown once" warning.
function RevealedInviteBanner({
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
    <div
      className="surface"
      style={{
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        borderColor: 'color-mix(in srgb, var(--success) 35%, var(--border))',
        background: 'color-mix(in srgb, var(--success) 6%, var(--bg-surface))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--success)' }}>
            Invitation ready
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 4 }}>
            Share this link with {invite.invitedEmail}
          </div>
        </div>
        <button type="button" className="drawer-x" onClick={onDismiss}>
          <Ico.x w={14} />
        </button>
      </div>
      <div className="copy-field">
        <input readOnly value={invite.inviteLink} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn btn-primary" onClick={handleCopy}>
          <Ico.copy w={14} />{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
        <span className="pill pill-warning" style={{ marginTop: 1 }}>
          <span className="dot" />Shown once
        </span>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Copy this link now — for security it won't be shown again. Expires in 7 days · single use.
          You can revoke it and generate a new one anytime.
        </span>
      </div>
    </div>
  );
}

// Two-step centered dialog: compose → link generated. We don't actually
// transition steps in this component — once the user submits, the parent
// closes the modal and reveals the link as an inline banner. This keeps
// the surface single-purpose (compose) and matches the data flow (the
// link only exists after the mutation succeeds).
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
    <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dec-invite-title">
        <div className="dialog-head">
          <div>
            <h2 id="dec-invite-title">Invite a member</h2>
            <p>Enter their email and pick a role. We'll generate a link you can share.</p>
          </div>
          <button type="button" className="drawer-x" onClick={onClose} aria-label="Close">
            <Ico.x w={14} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="dialog-body">
            <div className="field">
              <label className="field-label">Email address</label>
              <div className="input-search" style={{ position: 'relative' }}>
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    left: 11,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-faint)',
                    pointerEvents: 'none',
                    display: 'inline-flex',
                  }}
                >
                  <Ico.mail w={15} />
                </span>
                <input
                  className="input"
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
                  style={{ paddingLeft: 34 }}
                />
              </div>
            </div>
            <div className="field">
              <label className="field-label">Role</label>
              <div className="select">
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as OrganizationInviteRole)}
                >
                  <option value="member">Member — can view and initiate payments</option>
                  <option value="admin">Admin — can manage members &amp; settings</option>
                </select>
                <Ico.chevDown w={14} />
              </div>
            </div>
          </div>
          <div className="dialog-foot">
            <button
              type="submit"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={pending || !email.trim()}
              aria-busy={pending}
            >
              {pending ? 'Generating…' : <>Generate invite link<Ico.arrowRight w={14} /></>}
            </button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
