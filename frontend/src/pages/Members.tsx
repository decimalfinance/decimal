// Members & roles. The core split: ACCESS tiers (owner/admin/member = settings
// power, quiet) vs ROLES (Reviewer/Approver/Payer/Viewer = prebuilt permission
// bundles for the AP pipeline, prominent). The role set is fixed — you assign
// roles, you don't design them (roles-research/SYNTHESIS-decimal-roles.md).
import { useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accessApi, api, rolesApi, type AuthenticatedSession, type MemberWithRoles, type OrgRole, type OrganizationInviteRole, type RoleKey } from '../api';
import { useToast } from '../ui/Toast';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';

const PERSON_COLORS = ['#B4632B', '#A24B6B', '#3F5FA8', '#2E7D5B', '#7A5CA8', '#3A7CA5', '#A8574A', '#5B7F3B'];
const colorOf = (s: string) => { let h = 0; for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0; return PERSON_COLORS[h % PERSON_COLORS.length]!; };
const initialsOf = (name: string, email = '') => {
  const src = name?.trim() || email;
  const p = src.split(/[\s@._-]+/).filter(Boolean);
  return p.length >= 2 ? (p[0]![0]! + p[1]![0]!).toUpperCase() : src.slice(0, 2).toUpperCase();
};
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// Access tiers, in product words: 'owner' is the primary admin (one per org).
const accessLabel = (a: string) => (a === 'owner' ? 'Primary admin' : titleCase(a));

export function MembersPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const myRole = session.organizations.find((o) => o.organizationId === organizationId)?.role;
  const canManage = myRole === 'owner' || myRole === 'admin';
  const isPrimary = myRole === 'owner';
  const myUserId = session.user.userId;

  const q = useQuery({ queryKey: ['members-roles', organizationId], queryFn: () => rolesApi.get(organizationId), enabled: Boolean(organizationId) });
  const invitesQuery = useQuery({
    queryKey: ['org-invites', organizationId, 'pending'],
    queryFn: () => api.listOrganizationInvites(organizationId, 'pending'),
    enabled: Boolean(organizationId),
  });

  const [search, setSearch] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [manageFor, setManageFor] = useState<string | null>(null); // userId → manage-roles modal
  const [assignFor, setAssignFor] = useState<OrgRole | null>(null); // role card → pick a member
  const [linkModal, setLinkModal] = useState<{ email: string; link: string } | null>(null);
  const [reinviting, setReinviting] = useState<string | null>(null);

  const invalidateInvites = () => queryClient.invalidateQueries({ queryKey: ['org-invites', organizationId, 'pending'] });
  const revokeM = useMutation({
    mutationFn: (inviteId: string) => api.revokeOrganizationInvite(organizationId, inviteId),
    onSuccess: () => { void invalidateInvites(); },
    onError: (e) => toast.error('Could not revoke', e instanceof Error ? e.message : 'Try again.'),
  });
  // Links are one-time (the token is stored hashed), so "New link" = revoke the
  // old invite and mint a fresh one, then show it.
  const reinvite = async (inv: { organizationInviteId: string; invitedEmail: string; role: OrganizationInviteRole }) => {
    setReinviting(inv.organizationInviteId);
    try {
      await api.revokeOrganizationInvite(organizationId, inv.organizationInviteId);
      const res = await api.createOrganizationInvite(organizationId, { email: inv.invitedEmail, role: inv.role });
      setLinkModal({ email: inv.invitedEmail, link: res.inviteLink });
      void invalidateInvites();
    } catch (e) {
      toast.error('Could not create a new link', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setReinviting(null);
    }
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['members-roles', organizationId] });
    void queryClient.invalidateQueries({ queryKey: ['flow-stage'] });
    void queryClient.invalidateQueries({ queryKey: ['release-config', organizationId] });
  };

  const assignM = useMutation({
    mutationFn: (v: { roleKey: RoleKey; userId: string }) => rolesApi.assign(organizationId, v.roleKey, v.userId),
    onSuccess: invalidate,
    onError: (e) => toast.error('Could not assign', e instanceof Error ? e.message : 'Try again.'),
  });
  const unassignM = useMutation({
    mutationFn: (v: { roleKey: RoleKey; personId: string }) => rolesApi.unassign(organizationId, v.roleKey, v.personId),
    onSuccess: invalidate,
  });
  const accessM = useMutation({
    mutationFn: (v: { userId: string; access: 'admin' | 'member' }) => accessApi.setMemberAccess(organizationId, v.userId, v.access),
    onSuccess: () => { invalidate(); void queryClient.invalidateQueries({ queryKey: ['my-access'] }); },
    onError: (e) => toast.error('Could not change access', e instanceof Error ? e.message : 'Try again.'),
  });
  const [transferFor, setTransferFor] = useState<MemberWithRoles | null>(null);
  const transferM = useMutation({
    mutationFn: (userId: string) => accessApi.transferPrimaryAdmin(organizationId, userId),
    // The seat moved — our own session role changed, so reload for a clean slate.
    onSuccess: () => { window.location.reload(); },
    onError: (e) => toast.error('Could not transfer', e instanceof Error ? e.message : 'Try again.'),
  });

  const data = q.data;
  const members = data?.members ?? [];
  const roles = data?.roles ?? [];
  const roleName = (key: RoleKey) => roles.find((r) => r.key === key)?.name ?? titleCase(key);
  const s = search.trim().toLowerCase();
  const filtered = members.filter((m) => !s || m.name.toLowerCase().includes(s) || m.email.toLowerCase().includes(s));
  const pending = invitesQuery.data?.items ?? [];

  const toggleRole = (member: MemberWithRoles, roleKey: RoleKey) => {
    if (member.roles.includes(roleKey)) {
      if (member.personId) unassignM.mutate({ roleKey, personId: member.personId });
    } else {
      assignM.mutate({ roleKey, userId: member.userId });
    }
  };

  return (
    <div className="page page-wide mr">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Registry"
          title="Members & roles"
          desc="Who's on the team, and the job each person does as a bill moves from received to paid."
          actions={canManage ? <button type="button" className="btn btn-primary" onClick={() => setInviteOpen(true)}><Ico.userPlus w={15} /> Invite member</button> : undefined}
        />

        {q.isLoading ? <div className="skeleton" style={{ height: 320 }} /> : (
          <>
            {/* Roster */}
            <section>
              <div className="sec-head">
                <div className="sh-titles"><h2>Team</h2><p className="sh-desc">{members.length} {members.length === 1 ? 'person' : 'people'}</p></div>
                <div className="input-search" style={{ width: 240 }}>
                  <Ico.search w={15} />
                  <input className="input" placeholder="Search people" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
              </div>
              <div className="tbl-card">
                <table className="tbl" style={{ tableLayout: 'fixed' }}>
                  <thead>
                    <tr><th style={{ width: '28%' }}>Member</th><th style={{ width: '34%' }}>Email</th><th style={{ width: '30%' }}>Roles</th><th style={{ width: '8%' }} /></tr>
                  </thead>
                  <tbody>
                    {filtered.map((m) => (
                      <tr key={m.userId}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                            <span className="p-av" style={{ width: 36, height: 36, fontSize: 11, background: colorOf(m.name || m.email) }}>{initialsOf(m.name, m.email)}</span>
                            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14.5, letterSpacing: '-0.01em', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                          </div>
                        </td>
                        <td><span className="cell-mono" style={{ fontSize: 12.5 }}>{m.email}</span></td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            {m.access !== 'member' ? (
                              // Admins hold every capability — no role chips, just the tier.
                              isPrimary && m.userId !== myUserId
                                ? <button type="button" className="rolepill muted" style={{ cursor: 'pointer' }} onClick={() => setManageFor(m.userId)}>{accessLabel(m.access)}</button>
                                : <span className="rolepill muted">{accessLabel(m.access)}</span>
                            ) : (
                              <>
                                {m.roles.map((r) => (
                                  canManage
                                    ? <button key={r} type="button" className="rolepill" style={{ cursor: 'pointer' }} onClick={() => setManageFor(m.userId)}>{roleName(r)}</button>
                                    : <span key={r} className="rolepill">{roleName(r)}</span>
                                ))}
                                {canManage && m.roles.length === 0 ? (
                                  <button type="button" className="addrole" onClick={() => setManageFor(m.userId)}><Ico.plus w={11} /> Add role</button>
                                ) : null}
                              </>
                            )}
                          </div>
                        </td>
                        <td />
                      </tr>
                    ))}
                    {pending.map((inv) => (
                      <tr key={inv.organizationInviteId} style={{ opacity: 0.6 }}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <span className="p-av" style={{ width: 36, height: 36, fontSize: 11, background: 'var(--text-faint)' }}>{initialsOf('', inv.invitedEmail)}</span>
                            <div style={{ fontWeight: 600, color: 'var(--text-muted)' }}>Invited</div>
                          </div>
                        </td>
                        <td><span className="cell-mono" style={{ fontSize: 12.5 }}>{inv.invitedEmail}</span></td>
                        <td><span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Assign a role once they join</span></td>
                        <td>
                          {canManage ? (
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--accent)' }} disabled={reinviting === inv.organizationInviteId} onClick={() => reinvite(inv)}>{reinviting === inv.organizationInviteId ? 'Working…' : 'New link'}</button>
                              <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--text-muted)' }} onClick={() => revokeM.mutate(inv.organizationInviteId)}>Revoke</button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Roles — fixed set, full-bleed separator (escapes the 32px page padding) */}
            <div style={{ height: 1, background: 'var(--border)', margin: '0 -32px' }} />
            <section>
              <div className="sec-head">
                <div className="sh-titles"><h2>Roles</h2><p className="sh-desc">Each role is a job in the pipeline and comes with exactly the access that job needs. A person can hold more than one. Owners and admins always have full access.</p></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {roles.map((r) => (
                  <div key={r.key} className="rolecard" style={{ alignItems: 'flex-start' }}>
                    <span className="rolechip-lg"><Ico.members w={17} /></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{r.name}</span>
                        {r.holders.length > 0 ? <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{r.holders.length} {r.holders.length === 1 ? 'person' : 'people'}</span> : null}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.5 }}>{r.summary}</div>
                      {r.holders.length > 0 ? (
                        <div className="avstack" style={{ marginTop: 8 }}>
                          {r.holders.slice(0, 6).map((h) => <span key={h.personId} className="p-av" style={{ width: 26, height: 26, fontSize: 9, background: colorOf(h.name) }} title={h.name}>{initialsOf(h.name)}</span>)}
                        </div>
                      ) : (
                        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 8 }}>No one holds this yet</div>
                      )}
                    </div>
                    {canManage ? (
                      <button type="button" className="btn btn-secondary btn-sm" style={{ flex: 'none' }} onClick={() => setAssignFor(r)}>Assign</button>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>

      {inviteOpen ? (
        <InviteDialog
          organizationId={organizationId}
          canInviteAdmins={isPrimary}
          onClose={() => setInviteOpen(false)}
          onCreated={(email, link) => { setInviteOpen(false); setLinkModal({ email, link }); void invalidateInvites(); }}
          toast={toast}
        />
      ) : null}

      {linkModal ? <LinkDialog email={linkModal.email} link={linkModal.link} onClose={() => setLinkModal(null)} toast={toast} /> : null}

      {manageFor && members.some((m) => m.userId === manageFor) ? (
        <MemberRolesDialog
          member={members.find((m) => m.userId === manageFor)!}
          roles={roles}
          tier={isPrimary && manageFor !== myUserId ? {
            busy: accessM.isPending,
            onSet: (access) => accessM.mutate({ userId: manageFor, access }),
            onTransfer: () => { setTransferFor(members.find((m) => m.userId === manageFor)!); setManageFor(null); },
          } : undefined}
          onClose={() => setManageFor(null)}
          onToggle={(roleKey) => toggleRole(members.find((m) => m.userId === manageFor)!, roleKey)}
        />
      ) : null}

      {transferFor ? (
        <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 62 }} onClick={(e) => { if (e.target === e.currentTarget && !transferM.isPending) setTransferFor(null); }}>
          <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 440 }}>
            <div className="dialog-head"><div><h2>Make {transferFor.name} the primary admin?</h2></div><button type="button" className="drawer-x" onClick={() => setTransferFor(null)} aria-label="Close">×</button></div>
            <div className="dialog-body"><p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, margin: 0 }}>There is exactly one primary admin. {transferFor.name} takes the seat — only they will be able to publish the pipeline, change protections, and manage admins. You stay on as an admin.</p></div>
            <div className="dialog-foot">
              <button type="button" className="btn btn-secondary" onClick={() => setTransferFor(null)} disabled={transferM.isPending}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={() => transferM.mutate(transferFor.userId)} disabled={transferM.isPending}>{transferM.isPending ? 'Transferring…' : 'Transfer primary admin'}</button>
            </div>
          </div>
        </div>
      ) : null}

      {assignFor ? (
        <AssignMemberDialog
          role={assignFor}
          members={members.filter((m) => m.access === 'member')}
          onClose={() => setAssignFor(null)}
          onAssign={(userId) => { assignM.mutate({ roleKey: assignFor.key, userId }); setAssignFor(null); }}
        />
      ) : null}
    </div>
  );
}

// Tick the roles a member holds. Each row shows the role's plain-English
// summary so assignment doubles as the explanation of what it grants.
function MemberRolesDialog(props: {
  member: MemberWithRoles;
  roles: OrgRole[];
  tier?: { busy: boolean; onSet: (access: 'admin' | 'member') => void; onTransfer: () => void };
  onClose: () => void; onToggle: (roleKey: RoleKey) => void;
}) {
  const { member, roles, tier, onClose, onToggle } = props;
  const held = new Set(member.roles);
  return (
    <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog roles-dialog" role="dialog" aria-modal="true" style={{ maxWidth: 480 }}>
        <div className="dialog-head">
          <div><h2>{member.access !== 'member' ? `${member.name}'s access` : `${member.name}'s roles`}</h2><p>{member.access !== 'member' ? 'Access tier and the primary-admin seat.' : 'Tick the jobs this person does. Their access follows from the roles they hold.'}</p></div>
          <button type="button" className="drawer-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dialog-body">
          {member.access !== 'member' ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, margin: 0 }}>
              {member.name.split(' ')[0]} is {member.access === 'owner' ? 'the primary admin' : 'an admin'} and already has full access — roles are for members. Move them to Member below if you want their access to come from roles instead.
            </p>
          ) : (
          <div className="role-box">
            {roles.map((r) => (
              <button key={r.key} type="button" className={`role-row${held.has(r.key) ? ' on' : ''}`} onClick={() => onToggle(r.key)} style={{ alignItems: 'flex-start' }}>
                <span className="rr-check" style={{ marginTop: 2 }}>{held.has(r.key) ? <Ico.checkSm w={12} /> : null}</span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left', minWidth: 0 }}>
                  <span className="rr-name">{r.name}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45, whiteSpace: 'normal' }}>{r.summary}</span>
                </span>
              </button>
            ))}
          </div>
          )}
          {tier ? (
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Access level</span>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>Admins can change anything except who the admins are.</span>
                <div className="seg-pick" style={{ display: 'flex', padding: 3, gap: 3, background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', flex: 'none', width: 180 }}>
                  {(['member', 'admin'] as const).map((a) => (
                    <button key={a} type="button" disabled={tier.busy} onClick={() => member.access !== a && tier.onSet(a)}
                      style={{ flex: 1, height: 28, border: 'none', borderRadius: 'var(--r-sm)', background: member.access === a ? 'var(--bg-surface)' : 'transparent', boxShadow: member.access === a ? '0 1px 2px rgba(0,0,0,.06)' : undefined, color: member.access === a ? 'var(--text-primary)' : 'var(--text-muted)', fontSize: 12, fontWeight: member.access === a ? 600 : 500, cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
                      {a === 'member' ? 'Member' : 'Admin'}
                    </button>
                  ))}
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', color: 'var(--danger)' }} onClick={tier.onTransfer}>
                Make {member.name.split(' ')[0]} the primary admin…
              </button>
            </div>
          ) : null}
        </div>
        <div className="dialog-foot" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn btn-primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

function AssignMemberDialog(props: { role: OrgRole; members: MemberWithRoles[]; onClose: () => void; onAssign: (userId: string) => void }) {
  const held = new Set(props.role.holders.map((h) => h.userId));
  return (
    <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 440 }}>
        <div className="dialog-head">
          <div><h2>Assign “{props.role.name}”</h2><p>{props.role.summary}</p></div>
          <button type="button" className="drawer-x" onClick={props.onClose} aria-label="Close">×</button>
        </div>
        <div className="dialog-body">
          <div className="check-list">
            {props.members.map((m) => (
              <button key={m.userId} type="button" className={`check-item${held.has(m.userId) ? ' on' : ''}`} disabled={held.has(m.userId)} onClick={() => props.onAssign(m.userId)}>
                <span className="ci-av" style={{ background: colorOf(m.name) }}>{initialsOf(m.name, m.email)}</span>
                <div className="col"><span className="ci-name">{m.name}</span><span className="ci-sub">{m.email}</span></div>
                {held.has(m.userId) ? <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--success)' }}>Holds it</span> : null}
              </button>
            ))}
          </div>
        </div>
        <div className="dialog-foot"><button type="button" className="btn btn-secondary" onClick={props.onClose}>Done</button></div>
      </div>
    </div>
  );
}

function InviteDialog(props: { organizationId: string; canInviteAdmins: boolean; onClose: () => void; onCreated: (email: string, link: string) => void; toast: ReturnType<typeof useToast> }) {
  const [email, setEmail] = useState('');
  const [access, setAccess] = useState<OrganizationInviteRole>('member');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!email.trim()) return;
    setSending(true);
    try {
      const res = await api.createOrganizationInvite(props.organizationId, { email: email.trim(), role: access });
      props.onCreated(email.trim(), res.inviteLink);
    } catch (err) {
      props.toast.error('Could not invite', err instanceof Error ? err.message : 'Try again.');
      setSending(false);
    }
  };

  return (
    <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={(e) => { if (e.target === e.currentTarget && !sending) props.onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 460 }}>
        <div className="dialog-head">
          <div><h2>Invite a member</h2><p>You'll get a link to share — no email is sent.</p></div>
          <button type="button" className="drawer-x" onClick={props.onClose} aria-label="Close">×</button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field"><span className="field-label">Email address</span><input className="input" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></div>
            <div className="field">
              <span className="field-label">Access level</span>
              <div className="seg-pick" style={{ display: 'flex', padding: 3, gap: 3, background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
                {(['member', 'admin'] as const).map((a) => {
                  const locked = a === 'admin' && !props.canInviteAdmins;
                  return (
                    <button key={a} type="button" disabled={locked} onClick={() => setAccess(a)} title={locked ? 'Only the primary admin can invite admins' : undefined}
                      style={{ flex: 1, height: 32, border: 'none', borderRadius: 'var(--r-sm)', background: access === a ? 'var(--bg-surface)' : 'transparent', boxShadow: access === a ? '0 1px 2px rgba(0,0,0,.06)' : undefined, color: locked ? 'var(--text-faint)' : access === a ? 'var(--text-primary)' : 'var(--text-muted)', fontSize: 12.5, fontWeight: access === a ? 600 : 500, cursor: locked ? 'default' : 'pointer', fontFamily: 'var(--font-body)' }}>{titleCase(a)}</button>
                  );
                })}
              </div>
              <div className="input-help">Admins can change anything. Members get access from their roles. Only the primary admin can invite admins.</div>
            </div>
            <div className="field">
              <span className="field-label">Role <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· assign after they join</span></span>
              <div className="input-help">Pick their job (Reviewer, Approver, Payer, Viewer) from the roster once they've joined.</div>
            </div>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-secondary" onClick={props.onClose} disabled={sending}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={sending || !email.trim()}>{sending ? 'Creating…' : 'Create invite link'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Shown after creating (or re-minting) an invite. The link is only available
// this once — the token is stored hashed and can't be retrieved again.
function LinkDialog(props: { email: string; link: string; onClose: () => void; toast: ReturnType<typeof useToast> }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(props.link); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { props.toast.error('Copy failed', 'Select the link and copy it manually.'); }
  };
  return (
    <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 61 }} onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 480 }}>
        <div className="dialog-head">
          <div><h2>Invite link for {props.email}</h2><p>Copy it now and send it over — you can't see this link again.</p></div>
          <button type="button" className="drawer-x" onClick={props.onClose} aria-label="Close">×</button>
        </div>
        <div className="dialog-body">
          <div className="field">
            <span className="field-label">Invite link</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" readOnly value={props.link} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
              <button type="button" className="btn btn-primary" onClick={copy} style={{ flex: 'none' }}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
          <p className="input-help" style={{ marginTop: 10 }}>Anyone with this link can join as the invited member. If you lose it, use “New link” on their row to mint a fresh one.</p>
        </div>
        <div className="dialog-foot" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn btn-secondary" onClick={props.onClose}>Done</button></div>
      </div>
    </div>
  );
}
