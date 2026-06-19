// Sidebar — implements the Decimal design (handoff: pages-shell.jsx +
// components.css .sidebar). Hosts the wordmark, org switcher, 3 nav groups
// (Operations / Registry / Governance), theme segment, and user chip.
// All visual classes are namespaced under .dec — AppShell wraps in .dec.

import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import type { AuthenticatedSession, OrganizationMembership } from './api';
import { Ico } from './dec/icons';

type OrganizationContext = {
  organization: OrganizationMembership;
};

function initialsFromEmail(email: string) {
  const local = email.split('@')[0] ?? '?';
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function initialsFromName(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function useOutsideClick<T extends HTMLElement>(enabled: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!enabled) return;
    function onDoc(event: MouseEvent) {
      if (!ref.current) return;
      if (event.target instanceof Node && ref.current.contains(event.target)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [enabled, onClose]);
  return ref;
}

// Theme — toggles data-theme on <html>. The design CSS keys off
// [data-theme="light"|"dark"]. Persists in localStorage.
function useTheme(): { theme: 'light' | 'dark'; setTheme: (next: 'light' | 'dark') => void } {
  const [theme, setLocalTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  );
  function setTheme(next: 'light' | 'dark') {
    setLocalTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      window.localStorage.setItem('decimal.theme', next);
    } catch {
      // storage unavailable; fine
    }
  }
  return { theme, setTheme };
}

export function AppSidebar({
  session,
  organizationContexts,
  activeOrganizationId,
  paymentsIncompleteCount,
  collectionsOpenCount,
  unreviewedWalletsCount,
  onOrganizationSwitch,
  onLogout,
}: {
  session: AuthenticatedSession;
  organizationContexts: OrganizationContext[];
  activeOrganizationId?: string;
  paymentsIncompleteCount?: number;
  collectionsOpenCount?: number;
  unreviewedWalletsCount?: number;
  onOrganizationSwitch: (organizationId: string) => void;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const activeContext =
    organizationContexts.find((ctx) => ctx.organization.organizationId === activeOrganizationId) ??
    organizationContexts[0];
  const activeOrganization = activeContext?.organization;

  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const wsRef = useOutsideClick<HTMLDivElement>(wsMenuOpen, () => setWsMenuOpen(false));
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userRef = useOutsideClick<HTMLDivElement>(userMenuOpen, () => setUserMenuOpen(false));
  const { theme, setTheme } = useTheme();

  const base = activeOrganization ? `/organizations/${activeOrganization.organizationId}` : null;
  const onProfilePage = location.pathname === '/profile';

  return (
    <div className="sidebar">
      {/* Wordmark — D glyph + name */}
      <div className="sb-top">
        <div className="sb-wordmark">
          <span className="glyph">D</span>
          Decimal
        </div>
      </div>

      {/* Org switcher chip */}
      {organizationContexts.length ? (
        <div ref={wsRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className="sb-org"
            style={{ width: 'calc(100% - 32px)', cursor: 'pointer', background: 'transparent' }}
            onClick={() => setWsMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={wsMenuOpen}
          >
            <span className="org-initials">
              {initialsFromName(activeOrganization?.organizationName ?? '?')}
            </span>
            <span className="org-name">{activeOrganization?.organizationName ?? 'Select organization'}</span>
            <Ico.chevDown w={14} className="org-chev" />
          </button>

          {wsMenuOpen ? (
            <div
              role="menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                left: 16,
                right: 16,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
                padding: 4,
                zIndex: 30,
              }}
            >
              {organizationContexts.map(({ organization }) => {
                const isActive = organization.organizationId === activeOrganizationId;
                return (
                  <button
                    key={organization.organizationId}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setWsMenuOpen(false);
                      if (!isActive) onOrganizationSwitch(organization.organizationId);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '8px 10px',
                      border: 'none',
                      background: isActive ? 'var(--bg-surface-2)' : 'transparent',
                      color: 'var(--text-primary)',
                      fontSize: 13,
                      textAlign: 'left',
                      borderRadius: 'var(--r-xs)',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {organization.organizationName}
                    </span>
                    {isActive ? <Ico.check w={14} /> : null}
                  </button>
                );
              })}
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setWsMenuOpen(false);
                  navigate('/setup');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '8px 10px',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--accent)',
                  fontSize: 13,
                  textAlign: 'left',
                  borderRadius: 'var(--r-xs)',
                  cursor: 'pointer',
                }}
              >
                <Ico.plus w={14} />
                <span>New organization</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <Link to="/setup" className="sb-org" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="org-initials is-create" aria-hidden>
            <Ico.plus w={14} />
          </span>
          <span className="org-name">Create organization</span>
        </Link>
      )}

      {/* Nav groups */}
      <div className="sb-nav">
        {base ? (
          <>
            <div className="sb-group-label">Operations</div>
            <NavItem to={base} end icon={<Ico.grid w={16} />} label="Overview" />
            <NavItem
              to={`${base}/payments`}
              icon={<Ico.payments w={16} />}
              label="Payments"
              badge={paymentsIncompleteCount}
            />
            <NavItem
              to={`${base}/collections`}
              icon={<Ico.collections w={16} />}
              label="Collections"
              badge={collectionsOpenCount}
            />

            <div className="sb-group-label">Registry</div>
            <NavItem to={`${base}/wallets`} icon={<Ico.treasury w={16} />} label="Treasury accounts" />
            <NavItem to={`${base}/members`} icon={<Ico.members w={16} />} label="Members" />
            <NavItem
              to={`${base}/counterparties`}
              icon={<Ico.address w={16} />}
              label="Address book"
              badge={unreviewedWalletsCount}
            />

            <div className="sb-group-label">Governance</div>
            <NavItem to={`${base}/proposals`} icon={<Ico.proposals w={16} />} label="Proposals" />
            <NavItem to={`${base}/spending-limits`} icon={<Ico.shield w={16} />} label="Auto-pay" />

            <div className="sb-group-label">Integrations</div>
            <NavItem to={`${base}/accounting`} icon={<Ico.book w={16} />} label="Accounting" />
          </>
        ) : null}
      </div>

      {/* Footer — theme segment + user chip */}
      <div className="sb-footer">
        <div className="theme-seg" role="radiogroup" aria-label="Theme">
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'light'}
            className={theme === 'light' ? 'on' : ''}
            onClick={() => setTheme('light')}
          >
            <Ico.sun w={13} />
            <span>Light</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'dark'}
            className={theme === 'dark' ? 'on' : ''}
            onClick={() => setTheme('dark')}
          >
            <Ico.moon w={13} />
            <span>Dark</span>
          </button>
        </div>

        <div ref={userRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className={`sb-user${onProfilePage ? ' is-active-user' : ''}`}
            style={{ width: '100%', border: 'none', background: 'transparent', cursor: 'pointer' }}
            onClick={() => setUserMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
          >
            <span className="avatar">{initialsFromEmail(session.user.email)}</span>
            <div className="col" style={{ flex: 1, minWidth: 0, alignItems: 'flex-start' }}>
              <span className="u-name">{session.user.displayName ?? session.user.email.split('@')[0]}</span>
              <span className="u-mail">{session.user.email}</span>
            </div>
            <Ico.chevDown w={14} style={{ color: 'var(--text-faint)' }} />
          </button>

          {userMenuOpen ? (
            <div
              role="menu"
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 6px)',
                left: 0,
                right: 0,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
                padding: 4,
                zIndex: 30,
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  navigate('/profile');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '8px 10px',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  textAlign: 'left',
                  borderRadius: 'var(--r-xs)',
                  cursor: 'pointer',
                }}
              >
                <Ico.members w={14} />
                <span>Profile</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  onLogout();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '8px 10px',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--danger)',
                  fontSize: 13,
                  textAlign: 'left',
                  borderRadius: 'var(--r-xs)',
                  cursor: 'pointer',
                }}
              >
                <Ico.external w={14} />
                <span>Sign out</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function NavItem({
  to,
  end,
  icon,
  label,
  badge,
}: {
  to: string;
  end?: boolean;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `sb-item${isActive ? ' is-active' : ''}`}
      style={{ textDecoration: 'none' }}
    >
      {icon}
      <span className="sb-label">{label}</span>
      {badge && badge > 0 ? <span className="sb-badge">{badge}</span> : null}
    </NavLink>
  );
}
