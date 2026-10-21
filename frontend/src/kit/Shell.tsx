import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import { accessApi, inboxApi, type AuthenticatedSession, type Capability, type OrganizationMembership } from '../api';
import { ConfirmDialog } from './Dialog';
import { Icon } from './icons';
import { initialsOf, orgInitials, orgTone, personTone, roleLabel } from './people';
import { ToastHost } from './Toast';

/**
 * The app frame: the one sidebar (Sidebar.dc.html) beside the page.
 *
 * The sidebar folds to a 52px rail with the handle on its edge or the [ key,
 * and the grid column animates. Resting on the rail for 220ms slides the full
 * sidebar out over the page, without reflowing it; leaving folds it back.
 * Folded or not is remembered in this browser.
 */
const FOLD_KEY = 'decimal.sidebar.folded';

const SignOutContext = createContext<() => void>(() => {});

/** Asks before signing out, from a page: the same question the sidebar asks. */
export function useSignOut() {
  return useContext(SignOutContext);
}

function readFolded() {
  try {
    return window.localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFolded(folded: boolean) {
  try {
    window.localStorage.setItem(FOLD_KEY, folded ? '1' : '0');
  } catch {
    // Storage blocked: the fold still works for this visit.
  }
}

type Place = {
  key: string;
  label: string;
  to: string;
  icon: (p: { size?: number }) => ReactNode;
  on: (path: string) => boolean;
  count?: number;
};

export function Shell({
  session,
  organizations,
  activeOrganizationId,
  onLogout,
  children,
}: {
  session: AuthenticatedSession;
  organizations: OrganizationMembership[];
  activeOrganizationId?: string;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [folded, setFolded] = useState(readFolded);
  const [peek, setPeek] = useState(false);
  const [menu, setMenu] = useState<null | 'org' | 'me'>(null);
  const [askSignOut, setAskSignOut] = useState(false);
  const askToSignOut = useCallback(() => {
    setMenu(null);
    setAskSignOut(true);
  }, []);
  const [tip, setTip] = useState<null | 'handle' | 'pin'>(null);
  const peekTimer = useRef<number | undefined>(undefined);

  const toggle = useCallback(() => {
    window.clearTimeout(peekTimer.current);
    setFolded((f) => {
      writeFolded(!f);
      return !f;
    });
    setPeek(false);
    setTip(null);
    setMenu(null);
  }, []);

  // [ folds and unfolds, unless someone is typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      toggle();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  // Menus close on a press anywhere else, and on Esc.
  useEffect(() => {
    if (!menu) return;
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest(`[data-menu="${menu}"]`)) return;
      setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenu(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  useEffect(() => () => window.clearTimeout(peekTimer.current), []);

  const active = organizations.find((o) => o.organizationId === activeOrganizationId) ?? organizations[0];
  const orgId = active?.organizationId;
  const base = orgId ? `/organizations/${orgId}` : null;

  const accessQuery = useQuery({
    queryKey: ['my-access', orgId],
    queryFn: () => accessApi.get(orgId!),
    enabled: Boolean(orgId),
    staleTime: 60_000,
  });
  const caps = accessQuery.data?.capabilities;
  const can = (c: Capability) => !caps || caps.includes(c);

  const inboxQuery = useQuery({
    queryKey: ['inbox', orgId ?? ''],
    queryFn: () => inboxApi.get(orgId!),
    enabled: Boolean(orgId),
    refetchInterval: 30_000,
  });
  const inboxCount = inboxQuery.data?.count ?? 0;

  const places: Place[] = base
    ? [
        { key: 'home', label: 'Home', to: base, icon: Icon.home, on: (p) => p === base || p === `${base}/` },
        { key: 'inbox', label: 'Inbox', to: `${base}/inbox`, icon: Icon.inbox, on: (p) => p.startsWith(`${base}/inbox`), count: inboxCount },
        ...(can('bills.view')
          ? [{ key: 'bills', label: 'Bills', to: `${base}/bills`, icon: Icon.bills, on: (p: string) => p.startsWith(`${base}/bills`) || p.startsWith(`${base}/payments`) }]
          : []),
        ...(can('vendors.view')
          ? [{ key: 'vendors', label: 'Vendors', to: `${base}/counterparties`, icon: Icon.vendors, on: (p: string) => p.startsWith(`${base}/counterparties`) || p.startsWith(`${base}/vendors`) }]
          : []),
      ]
    : [];
  const settings: Place[] = base
    ? [
        { key: 'organisation', label: 'Organisation', to: `${base}/policies`, icon: Icon.organisation, on: (p) => p.startsWith(`${base}/policies`) || p.startsWith(`${base}/organisation`) },
        { key: 'rules', label: 'Approval rules', to: `${base}/approval-flow`, icon: Icon.approvalRules, on: (p) => p.startsWith(`${base}/approval-flow`) },
        { key: 'team', label: 'Team members', to: `${base}/members`, icon: Icon.team, on: (p) => p.startsWith(`${base}/members`) },
      ]
    : [];

  const me = {
    name: session.user.displayName || session.user.email.split('@')[0] || '',
    email: session.user.email,
    photo: session.user.avatarUrl ?? null,
    role: roleLabel(accessQuery.data),
    how: session.user.signInMethod === 'google' ? 'Signed in with Google' : 'Signed in with email',
    tone: personTone(session.user.userId),
  };

  const body = (
    <SidebarBody
      organizations={organizations}
      active={active}
      places={places}
      settings={settings}
      inboxCount={inboxCount}
      me={me}
      menu={menu}
      setMenu={setMenu}
      onSignOut={askToSignOut}
    />
  );

  return (
    <div className={`shell${folded ? ' is-folded' : ''}`}>
      {folded ? (
        <nav
          className="ui sb-rail"
          aria-label="Places"
          onMouseEnter={() => {
            window.clearTimeout(peekTimer.current);
            peekTimer.current = window.setTimeout(() => setPeek(true), 220);
          }}
          onMouseLeave={() => {
            window.clearTimeout(peekTimer.current);
            if (!peek) return;
            setPeek(false);
            setTip(null);
            setMenu(null);
          }}
        >
          <SidebarRail
            orgIds={organizations.map((o) => o.organizationId)}
            active={active}
            places={places}
            settings={settings}
            inboxCount={inboxCount}
            me={me}
            onMe={() => {
              window.clearTimeout(peekTimer.current);
              setPeek(true);
              setMenu('me');
            }}
          />
          {peek ? (
            <div className="sb-peek">
              {body}
              <button
                type="button"
                className="sb-handle"
                aria-label="Keep the sidebar open"
                onClick={toggle}
                onMouseEnter={() => setTip('pin')}
                onMouseLeave={() => setTip(null)}
              >
                <Icon.chevLeft size={10} className="sb-handle-chev is-flipped" />
                {tip === 'pin' ? (
                  <span className="tip is-right">
                    Keep it open <span className="kbd">[</span>
                  </span>
                ) : null}
              </button>
            </div>
          ) : null}
        </nav>
      ) : (
        <nav className="ui sb-col" aria-label="Places">
          {body}
        </nav>
      )}

      <main className="shell-main">
        <SignOutContext.Provider value={askToSignOut}>{children}</SignOutContext.Provider>
        <ToastHost />
      </main>

      {folded && peek ? null : (
        <button
          type="button"
          className="ui sb-handle"
          aria-label={folded ? 'Expand the sidebar' : 'Collapse the sidebar'}
          onClick={toggle}
          onMouseEnter={() => setTip('handle')}
          onMouseLeave={() => setTip(null)}
        >
          <Icon.chevLeft size={10} className={`sb-handle-chev${folded ? ' is-flipped' : ''}`} />
          {tip === 'handle' ? (
            <span className="tip is-right">
              <span>{folded ? 'Expand the sidebar' : 'Collapse the sidebar'}</span>
              <span className="kbd">[</span>
            </span>
          ) : null}
        </button>
      )}

      {askSignOut ? (
        <ConfirmDialog
          title="Sign out of Decimal?"
          line="You’ll need to sign in again to use Decimal in this browser. Your team and your bills aren’t affected."
          confirmLabel="Sign out"
          onCancel={() => setAskSignOut(false)}
          onConfirm={() => {
            setAskSignOut(false);
            onLogout();
          }}
        />
      ) : null}
    </div>
  );
}

type Me = { name: string; email: string; photo: string | null; role: string; how: string; tone: string };

function SidebarBody({
  organizations,
  active,
  places,
  settings,
  inboxCount,
  me,
  menu,
  setMenu,
  onSignOut,
}: {
  organizations: OrganizationMembership[];
  active?: OrganizationMembership;
  places: Place[];
  settings: Place[];
  inboxCount: number;
  me: Me;
  menu: null | 'org' | 'me';
  setMenu: (m: null | 'org' | 'me') => void;
  onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const multi = organizations.length > 1;
  const orgIds = organizations.map((o) => o.organizationId);
  const roles = useQueries({
    queries: multi
      ? organizations.map((o) => ({
          queryKey: ['my-access', o.organizationId],
          queryFn: () => accessApi.get(o.organizationId),
          staleTime: 60_000,
        }))
      : [],
  });

  return (
    <div className="sb-body">
      {active ? (
        <div className="sb-org" data-menu="org">
          {multi ? (
            <>
              <button
                type="button"
                className={`sb-org-strip${menu === 'org' ? ' is-open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={menu === 'org'}
                onClick={() => setMenu(menu === 'org' ? null : 'org')}
              >
                <span className="org-mark" style={{ background: orgTone(orgIds, active.organizationId) }}>
                  {orgInitials(active.organizationName)}
                </span>
                <span className="sb-org-name">{active.organizationName}</span>
                <Icon.chevUpDown size={12} className="sb-org-chev" />
              </button>
              {menu === 'org' ? (
                <div className="sb-org-menu menu" role="menu">
                  {organizations.map((o, i) => {
                    const current = o.organizationId === active.organizationId;
                    return (
                      <button
                        key={o.organizationId}
                        type="button"
                        role="menuitem"
                        className="sb-org-item"
                        onClick={() => {
                          setMenu(null);
                          if (!current) navigate(`/organizations/${o.organizationId}`);
                        }}
                      >
                        <span className="org-mark is-sm" style={{ background: orgTone(orgIds, o.organizationId) }}>
                          {orgInitials(o.organizationName)}
                        </span>
                        <span className="sb-org-item-text">
                          <span className="sb-org-item-name">{o.organizationName}</span>
                          <span className="sb-org-item-role">{roleLabel(roles[i]?.data) || ' '}</span>
                        </span>
                        {current ? <span className="sb-org-item-tick">✓</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <div className="sb-org-strip">
              <span className="org-mark" style={{ background: orgTone(orgIds, active.organizationId) }}>
                {orgInitials(active.organizationName)}
              </span>
              <span className="sb-org-name">{active.organizationName}</span>
            </div>
          )}
        </div>
      ) : null}

      {places.map((p) => (
        <PlaceRow key={p.key} place={p} on={p.on(location.pathname)} count={p.key === 'inbox' ? inboxCount : undefined} />
      ))}
      {settings.length ? <span className="sb-label">SETTINGS</span> : null}
      {settings.map((p) => (
        <PlaceRow key={p.key} place={p} on={p.on(location.pathname)} />
      ))}

      <div className="sb-me">
        <div className={`sb-me-wrap${menu === 'me' ? ' is-open' : ''}`} data-menu="me">
          {menu === 'me' ? (
            <div className="sb-me-menu">
              <div className="menu" role="menu">
                <div className="sb-me-head">
                  <span className="sb-me-email">{me.email}</span>
                  <span className="sb-me-how">{me.how}</span>
                </div>
                <div className="sb-me-items">
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      setMenu(null);
                      navigate('/profile');
                    }}
                  >
                    Your account
                  </button>
                  <button type="button" role="menuitem" className="menu-item" onClick={onSignOut}>
                    Sign out
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            className="sb-me-btn"
            aria-haspopup="menu"
            aria-expanded={menu === 'me'}
            onClick={() => setMenu(menu === 'me' ? null : 'me')}
          >
            {me.photo ? <img className="sb-pic" src={me.photo} alt="" referrerPolicy="no-referrer" /> : null}
            <span className="sb-me-text">
              <span className="sb-me-name">{me.name}</span>
              {me.role ? <span className="sb-me-role">{me.role}</span> : null}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function PlaceRow({ place, on, count }: { place: Place; on: boolean; count?: number }) {
  const I = place.icon;
  return (
    <Link to={place.to} className={`sb-row${on ? ' is-on' : ''}`} aria-current={on ? 'page' : undefined}>
      <I size={15} />
      <span className="sb-row-label">{place.label}</span>
      {count && count > 0 ? (
        <span className="sb-count" aria-label={`${count} in your Inbox`}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}

function SidebarRail({
  orgIds,
  active,
  places,
  settings,
  inboxCount,
  me,
  onMe,
}: {
  orgIds: string[];
  active?: OrganizationMembership;
  places: Place[];
  settings: Place[];
  inboxCount: number;
  me: Me;
  onMe: () => void;
}) {
  const location = useLocation();
  const cell = (p: Place, count?: number) => {
    const I = p.icon;
    const on = p.on(location.pathname);
    return (
      <div key={p.key} className="sb-rail-cell">
        <Link to={p.to} className={`sb-rail-row${on ? ' is-on' : ''}`} aria-label={p.label} aria-current={on ? 'page' : undefined}>
          <I size={15} />
          {count && count > 0 ? <span className="sb-rail-count">{count}</span> : null}
        </Link>
      </div>
    );
  };
  return (
    <>
      <div className="sb-rail-org">
        <div className="sb-rail-org-strip">
          {active ? (
            <span className="org-mark" style={{ background: orgTone(orgIds, active.organizationId) }} title={active.organizationName}>
              {orgInitials(active.organizationName)}
            </span>
          ) : null}
        </div>
      </div>
      {places.map((p) => cell(p, p.key === 'inbox' ? inboxCount : undefined))}
      {settings.length ? (
        <span className="sb-rail-label" aria-hidden>
          S
        </span>
      ) : null}
      {settings.map((p) => cell(p))}
      <div className="sb-rail-me">
        <button type="button" className="sb-rail-me-btn" aria-label={`${me.name}, your account`} onClick={onMe}>
          {me.photo ? (
            <img className="sb-pic" src={me.photo} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span className="sb-ini" style={{ background: me.tone }} title={me.name}>
              {initialsOf(me.name)}
            </span>
          )}
        </button>
      </div>
    </>
  );
}
