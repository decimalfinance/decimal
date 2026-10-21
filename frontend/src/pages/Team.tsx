/**
 * Team members (1a): who is in the organisation, what each person can do and
 * what is waiting on them. An admin changes a role from its cell, always
 * through a confirmation that says what the new role can do, and invites
 * people; everyone else reads the roster. Nobody is removed here yet, and
 * Decimal sends no email: an invitation is a link, shown once, that the admin
 * sends themselves.
 */
import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accessApi, api, billsApi, rolesApi, type MemberWithRoles, type OrganizationInvite } from '../api';
import { Avatar } from '../kit/Avatar';
import { Cells } from '../kit/Cells';
import { ConfirmDialog, Dialog } from '../kit/Dialog';
import { firstName, fullDay } from '../kit/format';
import { useDismiss } from '../kit/hooks';
import { Icon } from '../kit/icons';
import { roleLabel } from '../kit/people';
import { useToaster } from '../kit/Toast';
import {
  CHOICES,
  CHOICE_CAN,
  CHOICE_NAMES,
  CHOICE_SUMMARIES,
  TABS,
  choiceOf,
  inviteChoice,
  sharedLine,
  tabOf,
  topRole,
  waitingByUser,
  withArticle,
  type Choice,
  type Tab,
  type Waiting,
} from './teamRoles';

const ONLY_PRIMARY = 'Only the primary admin can do this.';

function messageOf(e: unknown) {
  return e instanceof Error && e.message ? e.message : 'That didn’t go through. Try again.';
}

function roleNameOf(choice: Choice | null) {
  return choice ? CHOICE_NAMES[choice] : 'Payer';
}

type Made = { email: string; roleName: string; link: string; again: boolean };

export function TeamPage() {
  const { organizationId = '' } = useParams();
  const queryClient = useQueryClient();
  const toaster = useToaster();

  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession(), staleTime: Infinity });
  const access = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });
  const roster = useQuery({
    queryKey: ['members-roles', organizationId],
    queryFn: () => rolesApi.get(organizationId),
    enabled: Boolean(organizationId),
  });
  const canManage = access.data?.capabilities.includes('members.manage') ?? false;
  const isPrimary = access.data?.membershipRole === 'primary_admin';
  const invites = useQuery({
    queryKey: ['org-invites', organizationId],
    queryFn: () => api.listOrganizationInvites(organizationId),
    enabled: Boolean(organizationId) && canManage,
  });
  // Bills' own query: who each bill in approval is waiting on.
  const workbench = useQuery({
    queryKey: ['bills-workbench', organizationId],
    queryFn: () => billsApi.workbench(organizationId),
    enabled: Boolean(organizationId),
  });

  const me = session.data?.user;
  const orgName =
    session.data?.organizations.find((o) => o.organizationId === organizationId)?.organizationName ?? 'your organisation';

  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [change, setChange] = useState<{ member: MemberWithRoles; to: Choice } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  const [cancelling, setCancelling] = useState<OrganizationInvite | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const members = useMemo(
    () => [...(roster.data?.members ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [roster.data],
  );
  const primary = members.find((m) => m.access === 'primary_admin') ?? null;
  const primaryName = isPrimary ? 'you' : primary?.name ?? 'the primary admin';
  const waiting = useMemo(() => waitingByUser(workbench.data?.bills ?? []), [workbench.data]);
  const openInvites = useMemo(
    () => (invites.data?.items ?? []).filter((i) => i.status === 'pending' || i.status === 'expired'),
    [invites.data],
  );
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: members.length, admins: 0, bill_clerk: 0, approver: 0, viewer: 0 };
    for (const m of members) {
      const t = tabOf(choiceOf(m));
      if (t) c[t] += 1;
    }
    return c;
  }, [members]);

  const q = search.trim().toLowerCase();
  const shownMembers = members.filter(
    (m) =>
      (tab === 'all' || tabOf(choiceOf(m)) === tab) &&
      (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)),
  );
  const shownInvites = canManage
    ? openInvites.filter(
        (i) => (tab === 'all' || tabOf(inviteChoice(i)) === tab) && (!q || i.invitedEmail.toLowerCase().includes(q)),
      )
    : [];
  const tabLabel = TABS.find((t) => t.key === tab)?.label ?? 'All';

  /** Why someone's role can't be changed here, or null when it can. */
  function lockOf(m: MemberWithRoles) {
    const primaryAdmin = primary?.name ?? 'the primary admin';
    if (m.userId === me?.userId) {
      return m.access === 'primary_admin' ? 'Your role can’t be changed here' : `Only ${primaryAdmin} can change your role`;
    }
    if (m.access === 'primary_admin') return `Only ${m.name} can hand on the primary admin role`;
    if (m.access === 'admin' && !isPrimary) return `Only ${primaryAdmin} can change an admin’s role`;
    return null;
  }

  function refreshRoles(tier: boolean) {
    void queryClient.invalidateQueries({ queryKey: ['members-roles', organizationId] });
    void queryClient.invalidateQueries({ queryKey: ['flow-stage'] });
    void queryClient.invalidateQueries({ queryKey: ['release-config', organizationId] });
    if (tier) void queryClient.invalidateQueries({ queryKey: ['my-access'] });
  }

  // Admin is a tier and the rest are job roles: an admin is made a member
  // before a role is set, and becoming an admin drops the job role.
  async function giveRole(m: MemberWithRoles, to: Choice) {
    if (to === 'admin') {
      await accessApi.setMemberAccess(organizationId, m.userId, 'admin');
      return;
    }
    if (m.access === 'admin') await accessApi.setMemberAccess(organizationId, m.userId, 'member');
    await rolesApi.setRole(organizationId, to, m.userId);
  }

  /** Puts someone back as they were before they were made `to`. */
  async function restoreRole(before: MemberWithRoles, to: Choice) {
    if (before.access === 'admin') {
      await accessApi.setMemberAccess(organizationId, before.userId, 'admin');
      return;
    }
    if (to === 'admin') await accessApi.setMemberAccess(organizationId, before.userId, 'member');
    await rolesApi.setRole(organizationId, topRole(before.roles) ?? 'viewer', before.userId);
  }

  const changeRole = useMutation({
    mutationFn: (v: { member: MemberWithRoles; to: Choice }) => giveRole(v.member, v.to),
    onSuccess: (_done, v) => {
      const tier = v.to === 'admin' || v.member.access === 'admin';
      setChange(null);
      refreshRoles(tier);
      toaster.show(`${v.member.name} is now ${withArticle(CHOICE_NAMES[v.to])}.`, {
        undo: () => {
          restoreRole(v.member, v.to).then(
            () => refreshRoles(tier),
            (e) => {
              refreshRoles(tier);
              toaster.show(messageOf(e));
            },
          );
        },
      });
    },
    onError: (e, v) => {
      setChange(null);
      refreshRoles(v.to === 'admin' || v.member.access === 'admin');
      toaster.show(messageOf(e));
    },
  });

  const refreshInvites = () => void queryClient.invalidateQueries({ queryKey: ['org-invites', organizationId] });

  // A new link is a new invitation: the server retires the old one, so the
  // link sent before stops working.
  async function newLink(invite: OrganizationInvite) {
    setWorking(invite.organizationInviteId);
    try {
      const again = await api.createOrganizationInvite(
        organizationId,
        invite.role === 'admin'
          ? { email: invite.invitedEmail, role: 'admin' }
          : { email: invite.invitedEmail, role: 'member', jobRole: invite.jobRole ?? 'viewer' },
      );
      setMade({
        email: again.invitedEmail,
        roleName: roleNameOf(inviteChoice(again)),
        link: again.inviteLink,
        // Only a link that still worked is worth saying is dead now.
        again: invite.status === 'pending',
      });
    } catch (e) {
      toaster.show(messageOf(e));
    } finally {
      setWorking(null);
      refreshInvites();
    }
  }

  // An expired link is already dead, so removing it doesn't ask.
  async function removeExpired(invite: OrganizationInvite) {
    setWorking(invite.organizationInviteId);
    try {
      await api.revokeOrganizationInvite(organizationId, invite.organizationInviteId);
      toaster.show(`Expired invitation to ${invite.invitedEmail} removed.`);
    } catch (e) {
      toaster.show(messageOf(e));
    } finally {
      setWorking(null);
      refreshInvites();
    }
  }

  const cancelInvite = useMutation({
    mutationFn: (invite: OrganizationInvite) => api.revokeOrganizationInvite(organizationId, invite.organizationInviteId),
    onSuccess: (_done, invite) => {
      setCancelling(null);
      toaster.show(`Invitation to ${invite.invitedEmail} cancelled.`);
    },
    onError: (e) => {
      setCancelling(null);
      toaster.show(messageOf(e));
    },
    onSettled: refreshInvites,
  });

  return (
    <div className="ui list-page">
      <div className="list-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="list-title">Team members</h1>
          <div className="list-sub">Who’s in {orgName}, what each person can do, and what’s waiting on them.</div>
        </div>
        {!access.isSuccess ? null : canManage ? (
          <div className="split">
            <button
              type="button"
              className="split-main is-alone"
              onClick={() => {
                setMenu(null);
                setInviting(true);
              }}
            >
              <Icon.userPlus size={13} />
              Invite a team member
            </button>
          </div>
        ) : (
          <div className="tm-noinvite">
            Only admins can invite team members
            <button type="button" className="split-main is-alone tm-invite" disabled tabIndex={-1}>
              <Icon.userPlus size={13} />
              Invite a team member
            </button>
          </div>
        )}
      </div>

      <div className="bl-bar">
        <div className="bl-stages" role="tablist" aria-label="Roles">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`bl-stage${tab === t.key ? ' is-on' : ''}`}
              onClick={() => {
                setTab(t.key);
                setMenu(null);
              }}
            >
              {t.label}
              <span className="bl-stage-n">{roster.isSuccess ? counts[t.key] : null}</span>
            </button>
          ))}
        </div>
        <div className="bl-tools">
          <label className="bl-search tm-search">
            <Icon.search size={11} />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setMenu(null);
              }}
              placeholder="Search name or email"
              aria-label="Search name or email"
            />
          </label>
        </div>
      </div>

      <div className="bl-table">
        <div className="tm-grid is-roster">
          <div className="bl-head">
            <Cells>
              <span className="bl-th">NAME</span>
              <span className="bl-th">EMAIL</span>
              <span className="bl-th">ROLE</span>
              <span className="bl-th">WAITING ON THEM</span>
            </Cells>
          </div>
          {!roster.isSuccess ? (
            roster.isError ? (
              <div className="tm-empty">
                Team members couldn’t be loaded.
                <button type="button" className="tm-show" onClick={() => void roster.refetch()}>
                  Try again
                </button>
              </div>
            ) : null
          ) : shownMembers.length === 0 ? (
            <div className="tm-empty">
              {q ? `No team members match “${search.trim()}”.` : `No ${tabLabel.toLowerCase()} in ${orgName}.`}
              <button
                type="button"
                className="tm-show"
                onClick={() => {
                  setSearch('');
                  setTab('all');
                }}
              >
                Show everyone
              </button>
            </div>
          ) : (
            shownMembers.map((m) => {
              const lock = canManage ? lockOf(m) : '';
              return (
                <div key={m.userId} className="tm-row">
                  <Cells>
                    <span className="bl-td tm-name">
                      <Avatar name={m.name} src={m.avatarUrl} size={16} />
                      <span className="tm-name-text">
                        {m.name}
                        {m.userId === me?.userId ? <span className="tm-you">(you)</span> : null}
                      </span>
                    </span>
                    <span className="bl-td tm-email">{m.email}</span>
                    {lock === null ? (
                      <RoleCell
                        member={m}
                        open={menu === m.userId}
                        isPrimary={isPrimary}
                        primaryName={primaryName}
                        onToggle={() => setMenu(menu === m.userId ? null : m.userId)}
                        onClose={() => setMenu((open) => (open === m.userId ? null : open))}
                        onPick={(to) => setChange({ member: m, to })}
                      />
                    ) : (
                      <span className="bl-td tm-rolecell" title={lock || undefined}>
                        {roleLabel({ membershipRole: m.access, roles: m.roles })}
                      </span>
                    )}
                    <span className="bl-td tm-wait">
                      {workbench.isSuccess ? <WaitingText waiting={waiting.get(m.userId)} /> : null}
                    </span>
                  </Cells>
                </div>
              );
            })
          )}
        </div>
      </div>

      {shownInvites.length > 0 ? (
        <>
          <div className="tm-inv-head">
            <span className="tm-inv-title">Invitations</span>
            <span className="tm-inv-n num">{shownInvites.length}</span>
            <span className="tm-inv-line">People join {orgName} when they accept.</span>
          </div>
          <div className="bl-table">
            <div className="tm-grid">
              <div className="bl-head">
                <Cells>
                  <span className="bl-th">EMAIL</span>
                  <span className="bl-th">ROLE</span>
                  <span className="bl-th">SENT</span>
                  <span className="bl-th">STATUS</span>
                  <span className="bl-th is-end" />
                </Cells>
              </div>
              {shownInvites.map((i) => (
                <InviteRow
                  key={i.organizationInviteId}
                  invite={i}
                  byYou={i.invitedByUser.userId === me?.userId}
                  working={working === i.organizationInviteId}
                  locked={i.role === 'admin' && !isPrimary}
                  onNewLink={() => void newLink(i)}
                  onCancel={() => setCancelling(i)}
                  onRemove={() => void removeExpired(i)}
                />
              ))}
            </div>
          </div>
        </>
      ) : null}

      {inviting ? (
        <InviteDialog
          organizationId={organizationId}
          orgName={orgName}
          members={members}
          invites={openInvites}
          isPrimary={isPrimary}
          primaryName={primaryName}
          myEmail={me?.email ?? ''}
          onClose={() => setInviting(false)}
          onCreated={(link) => {
            setInviting(false);
            refreshInvites();
            setMade({ ...link, again: false });
          }}
        />
      ) : null}
      {made ? <LinkDialog made={made} orgName={orgName} onClose={() => setMade(null)} /> : null}
      {change ? (
        <ChangeDialog
          member={change.member}
          to={change.to}
          busy={changeRole.isPending}
          onCancel={() => setChange(null)}
          onConfirm={() => changeRole.mutate(change)}
        />
      ) : null}
      {cancelling ? (
        <ConfirmDialog
          title={`Cancel the invitation to ${cancelling.invitedEmail}?`}
          line="The link you sent them will stop working. You can invite them again at any time."
          cancelLabel="Keep it"
          confirmLabel="Cancel invitation"
          tone="remove"
          busy={cancelInvite.isPending}
          onCancel={() => setCancelling(null)}
          onConfirm={() => cancelInvite.mutate(cancelling)}
        />
      ) : null}
    </div>
  );
}

/** A role an admin can change: the role and a chevron, opening the four roles. */
function RoleCell({
  member,
  open,
  isPrimary,
  primaryName,
  onToggle,
  onClose,
  onPick,
}: {
  member: MemberWithRoles;
  open: boolean;
  isPrimary: boolean;
  primaryName: string;
  onToggle: () => void;
  onClose: () => void;
  onPick: (to: Choice) => void;
}) {
  const cell = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState(false);
  useDismiss(open, cell, onClose);
  const current = choiceOf(member);
  return (
    <span ref={cell} className="bl-td tm-rolecell">
      <button
        type="button"
        className={`tm-role${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {roleLabel({ membershipRole: member.access, roles: member.roles })}
        <Icon.chevDown size={10} strokeWidth={2.4} />
      </button>
      {open ? (
        <span className="menu tm-menu" role="menu">
          {CHOICES.map((c) => {
            const off = c === 'admin' && !isPrimary;
            return (
              <button
                key={c}
                type="button"
                role="menuitem"
                className={`tm-item${off ? ' is-off' : ''}`}
                aria-disabled={off || undefined}
                onMouseEnter={off ? () => setTip(true) : undefined}
                onMouseLeave={off ? () => setTip(false) : undefined}
                onFocus={off ? () => setTip(true) : undefined}
                onBlur={off ? () => setTip(false) : undefined}
                onClick={() => {
                  if (off) return;
                  onClose();
                  if (c !== current) onPick(c);
                }}
              >
                <span className="tm-item-name">{CHOICE_NAMES[c]}</span>
                <span className="tm-item-mark">{c === current ? <Icon.tick size={11} /> : null}</span>
                <span className="tm-item-desc">{CHOICE_SUMMARIES[c]}</span>
                {off && tip ? <span className="tip">{ONLY_PRIMARY}</span> : null}
              </button>
            );
          })}
          <span className="tm-menu-foot">Only {primaryName} can hand on the primary admin role.</span>
        </span>
      ) : null}
    </span>
  );
}

/** "2 bills · 1 overdue · shared with Tom", or "Nothing". */
function WaitingText({ waiting }: { waiting: Waiting | undefined }) {
  if (!waiting || waiting.count === 0) return <span className="tm-nothing">Nothing</span>;
  const shared = sharedLine(waiting.sharedWith);
  return (
    <>
      <span className="tm-count">
        <span className="num">{waiting.count}</span>
        {waiting.count === 1 ? 'bill' : 'bills'}
      </span>
      {waiting.overdue > 0 ? (
        <>
          <span className="tm-sep">·</span>
          <span className="tm-over">
            <span className="num">{waiting.overdue}</span> overdue
          </span>
        </>
      ) : null}
      {shared ? (
        <>
          <span className="tm-sep">·</span>
          <span className="tm-note">{shared}</span>
        </>
      ) : null}
    </>
  );
}

function InviteRow({
  invite,
  byYou,
  working,
  locked,
  onNewLink,
  onCancel,
  onRemove,
}: {
  invite: OrganizationInvite;
  byYou: boolean;
  working: boolean;
  /** An admin's invitation, which only the primary admin can make again. */
  locked: boolean;
  onNewLink: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const [tip, setTip] = useState(false);
  const expired = invite.status === 'expired';
  return (
    <div className="tm-row">
      <Cells>
        <span className="bl-td tm-name">
          <span className="tm-ring" aria-hidden />
          {invite.invitedEmail}
        </span>
        <span className="bl-td tm-rolecell">{roleNameOf(inviteChoice(invite))}</span>
        <span className="bl-td tm-sent">
          <span className="num">{fullDay(invite.createdAt)}</span>· by {byYou ? 'you' : invite.invitedByUser.displayName}
        </span>
        <span className="bl-td">
          {expired ? <span className="chip is-finished">Expired</span> : <span className="chip is-waiting">Invited</span>}
        </span>
        <span className="bl-td is-end tm-acts">
          <button
            type="button"
            className={`tm-pill ${locked ? 'is-off' : 'is-new'}`}
            aria-disabled={locked || working || undefined}
            onMouseEnter={locked ? () => setTip(true) : undefined}
            onMouseLeave={locked ? () => setTip(false) : undefined}
            onFocus={locked ? () => setTip(true) : undefined}
            onBlur={locked ? () => setTip(false) : undefined}
            onClick={() => {
              if (!locked && !working) onNewLink();
            }}
          >
            New link
            {locked && tip ? <span className="tip">{ONLY_PRIMARY}</span> : null}
          </button>
          {expired ? (
            <button type="button" className="tm-pill is-remove" disabled={working} onClick={onRemove}>
              Remove
            </button>
          ) : (
            <button type="button" className="tm-pill is-cancel" disabled={working} onClick={onCancel}>
              Cancel
            </button>
          )}
        </span>
      </Cells>
    </div>
  );
}

function InviteDialog({
  organizationId,
  orgName,
  members,
  invites,
  isPrimary,
  primaryName,
  myEmail,
  onClose,
  onCreated,
}: {
  organizationId: string;
  orgName: string;
  members: MemberWithRoles[];
  invites: OrganizationInvite[];
  isPrimary: boolean;
  primaryName: string;
  myEmail: string;
  onClose: () => void;
  onCreated: (link: Omit<Made, 'again'>) => void;
}) {
  const [email, setEmail] = useState('');
  const [choice, setChoice] = useState<Choice>('approver');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const domain = myEmail.split('@')[1] || 'company.com';

  function fail(message: string) {
    setError(message);
    field.current?.focus();
  }

  async function create() {
    if (busy) return;
    const value = email.trim().toLowerCase();
    if (!value) return fail('Enter their email address.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return fail('Enter a full email address, like name@company.com.');
    const member = members.find((m) => m.email.toLowerCase() === value);
    if (member) return fail(`${member.name} is already in ${orgName}.`);
    const pending = invites.find((i) => i.status === 'pending' && i.invitedEmail.toLowerCase() === value);
    if (pending) {
      return fail(`${value} was invited on ${fullDay(pending.createdAt)}. You can make a new link from Invitations.`);
    }
    setBusy(true);
    try {
      const invite = await api.createOrganizationInvite(
        organizationId,
        choice === 'admin' ? { email: value, role: 'admin' } : { email: value, role: 'member', jobRole: choice },
      );
      onCreated({ email: invite.invitedEmail, roleName: CHOICE_NAMES[choice], link: invite.inviteLink });
    } catch (e) {
      setBusy(false);
      fail(messageOf(e));
    }
  }

  return (
    <Dialog
      title="Invite a team member"
      line={`You’ll get a link to send them. It lets them join ${orgName} and expires after 14 days.`}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onConfirm={() => void create()}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn is-primary" aria-busy={busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create invitation'}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Email</span>
        <input
          ref={field}
          className={`input${error ? ' is-error' : ''}`}
          type="email"
          autoComplete="off"
          spellCheck={false}
          placeholder={`name@${domain}`}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          data-autofocus
        />
        {error ? <span className="field-error">{error}</span> : null}
      </label>
      <div className="field">
        <span className="field-label">Role</span>
        <div className="tm-radios" role="radiogroup" aria-label="Role">
          {CHOICES.map((c) => {
            const off = c === 'admin' && !isPrimary;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={choice === c}
                aria-disabled={off || undefined}
                className={`tm-radio-row${off ? ' is-off' : ''}`}
                onMouseEnter={off ? () => setTip(true) : undefined}
                onMouseLeave={off ? () => setTip(false) : undefined}
                onFocus={off ? () => setTip(true) : undefined}
                onBlur={off ? () => setTip(false) : undefined}
                onClick={() => {
                  if (!off) setChoice(c);
                }}
              >
                <span className="tm-radio" aria-hidden />
                <span className="tm-radio-name">{CHOICE_NAMES[c]}</span>
                <span className="tm-radio-desc">{CHOICE_SUMMARIES[c]}</span>
                {off && tip ? <span className="tip">{ONLY_PRIMARY}</span> : null}
              </button>
            );
          })}
        </div>
        <span className="tm-foot">Only {primaryName} can hand on the primary admin role.</span>
      </div>
    </Dialog>
  );
}

/** The invitation's link, shown this once: its token is kept only as a hash. */
function LinkDialog({ made, orgName, onClose }: { made: Made; orgName: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(made.link);
      setCopied(true);
    } catch {
      // No clipboard: the link is selected in its field for copying by hand.
    }
  }
  return (
    <Dialog
      title={`Send this link to ${made.email}`}
      line={`It lets them join ${orgName} as ${withArticle(made.roleName)} and expires after 14 days. Copy it now: it isn’t shown again.${made.again ? ' The link made before no longer works.' : ''}`}
      onCancel={onClose}
      onConfirm={onClose}
      actions={
        <button type="button" className="btn is-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="tm-link">
        <input
          className="input"
          readOnly
          value={made.link}
          aria-label="Invitation link"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="btn" onClick={() => void copy()} data-autofocus>
          <Icon.copy size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Dialog>
  );
}

/** Asking first: what the new role can do, before anything changes. */
function ChangeDialog({
  member,
  to,
  busy,
  onCancel,
  onConfirm,
}: {
  member: MemberWithRoles;
  to: Choice;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const first = firstName(member.name);
  const role = withArticle(CHOICE_NAMES[to]);
  return (
    <Dialog
      title={`Change ${member.name}’s role?`}
      line={
        <>
          <span className="tm-card">
            <Avatar name={member.name} src={member.avatarUrl} size={16} />
            <span className="tm-card-name">{member.name}</span>
            <span className="tm-card-roles">
              <span className="tm-card-old">{roleLabel({ membershipRole: member.access, roles: member.roles })}</span>
              <span className="tm-card-arrow" aria-hidden>
                →
              </span>
              <span className="tm-card-new">{CHOICE_NAMES[to]}</span>
            </span>
          </span>
          As {role}, {first} {CHOICE_CAN[to]}.
        </>
      }
      onCancel={() => {
        if (!busy) onCancel();
      }}
      onConfirm={busy ? undefined : onConfirm}
      actions={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn is-primary" aria-busy={busy} onClick={() => !busy && onConfirm()} data-autofocus>
            Make {first} {role}
          </button>
        </>
      }
    />
  );
}
