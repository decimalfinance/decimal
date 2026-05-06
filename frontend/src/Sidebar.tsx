import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import type { AuthenticatedSession, OrganizationMembership } from './api';
import { useTour } from './Tour';

type OrganizationContext = {
  organization: OrganizationMembership;
};

function SvgIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className ?? 'ax-nav-link-icon'}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const icons = {
  overview: (
    <SvgIcon>
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <rect x="11" y="3" width="6" height="6" rx="1.5" />
      <rect x="3" y="11" width="6" height="6" rx="1.5" />
      <rect x="11" y="11" width="6" height="6" rx="1.5" />
    </SvgIcon>
  ),
  payments: (
    <SvgIcon>
      <rect x="2.5" y="5" width="15" height="10" rx="1.5" />
      <path d="M2.5 8h15" />
      <path d="M5.5 12.5h2" />
    </SvgIcon>
  ),
  collections: (
    <SvgIcon>
      <path d="M10 3v9" />
      <path d="M6 8.5 10 12.5 14 8.5" />
      <path d="M3 14.5h14v2H3z" />
    </SvgIcon>
  ),
  proofs: (
    <SvgIcon>
      <path d="M5 2.5h6L15 6.5v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" />
      <path d="M11 2.5v4h4" />
      <path d="M7 11h6M7 14h4" />
    </SvgIcon>
  ),
  address: (
    <SvgIcon>
      <path d="M10 17.5s-5.5-4.5-5.5-9a5.5 5.5 0 0 1 11 0c0 4.5-5.5 9-5.5 9Z" />
      <circle cx="10" cy="8.5" r="2.2" />
    </SvgIcon>
  ),
  approvals: (
    <SvgIcon>
      <circle cx="10" cy="10" r="7" />
      <path d="M7 10.5l2 2 4-4.5" />
    </SvgIcon>
  ),
  execution: (
    <SvgIcon>
      <path d="M11 3 4 12h5l-1 6 7-9h-5l1-6Z" />
    </SvgIcon>
  ),
  settlement: (
    <SvgIcon>
      <path d="M3 5.5h14" />
      <path d="M5.5 5.5v9a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2v-9" />
      <path d="M8 9.5h4" />
    </SvgIcon>
  ),
  exceptions: (
    <SvgIcon>
      <path d="M10 2.5 18 16H2L10 2.5Z" />
      <path d="M10 8v3" />
      <circle cx="10" cy="13.5" r="0.7" fill="currentColor" />
    </SvgIcon>
  ),
  policy: (
    <SvgIcon>
      <path d="M10 2.5 17 5v5c0 4-3 6.5-7 7.5-4-1-7-3.5-7-7.5V5l7-2.5Z" />
      <path d="M7.5 10.5l2 2 3.5-4" />
    </SvgIcon>
  ),
  wallet: (
    <SvgIcon>
      <rect x="2.5" y="5" width="15" height="11" rx="2" />
      <path d="M2.5 8h15" />
      <circle cx="14" cy="12.5" r="1" fill="currentColor" />
    </SvgIcon>
  ),
  counterparty: (
    <SvgIcon>
      <circle cx="10" cy="7" r="3" />
      <path d="M4 16.5a6 6 0 0 1 12 0" />
    </SvgIcon>
  ),
  members: (
    <SvgIcon>
      <circle cx="7.5" cy="8" r="2.5" />
      <circle cx="14" cy="8.5" r="2" />
      <path d="M3 16.5a4.5 4.5 0 0 1 9 0" />
      <path d="M12.5 16.5a4 4 0 0 1 5 0" />
    </SvgIcon>
  ),
  proposals: (
    <SvgIcon>
      <path d="M5 2.5h6L15 6.5v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" />
      <path d="M11 2.5v4h4" />
      <path d="M7 11l1.5 1.5L13 8" />
    </SvgIcon>
  ),
  destinations: (
    <SvgIcon>
      <path d="M10 17.5s-5.5-4.5-5.5-9a5.5 5.5 0 0 1 11 0c0 4.5-5.5 9-5.5 9Z" />
      <circle cx="10" cy="8.5" r="2.2" />
    </SvgIcon>
  ),
  payers: (
    <SvgIcon>
      <circle cx="10" cy="7" r="3" />
      <path d="M4 16.5a6 6 0 0 1 12 0" />
      <path d="M14 5l2 2 3-3" />
    </SvgIcon>
  ),
  chevron: (
    <SvgIcon className="ax-ws-button-chev">
      <path d="M5 7.5 10 12.5 15 7.5" />
    </SvgIcon>
  ),
  check: (
    <SvgIcon className="ax-ws-menu-item-check">
      <path d="M4.5 10.5 8 14l7.5-8" />
    </SvgIcon>
  ),
  sun: (
    <SvgIcon className="ax-theme-option-icon">
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5 6 6M14 14l1.5 1.5M4.5 15.5 6 14M14 6l1.5-1.5" />
    </SvgIcon>
  ),
  moon: (
    <SvgIcon className="ax-theme-option-icon">
      <path d="M16.5 12A7 7 0 1 1 8 3.5a5.5 5.5 0 0 0 8.5 8.5Z" />
    </SvgIcon>
  ),
  logout: (
    <SvgIcon className="ax-user-menu-icon" >
      <path d="M8 4.5H5a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 5 15.5h3" />
      <path d="M12 6.5 15.5 10 12 13.5" />
      <path d="M15.5 10H8" />
    </SvgIcon>
  ),
  user: (
    <SvgIcon className="ax-user-menu-icon">
      <circle cx="10" cy="7" r="3" />
      <path d="M4 16.5a6 6 0 0 1 12 0" />
    </SvgIcon>
  ),
  plus: (
    <SvgIcon className="ax-ws-menu-item-check">
      <path d="M10 4v12M4 10h12" />
    </SvgIcon>
  ),
  tutorial: (
    <SvgIcon className="ax-user-menu-icon">
      <circle cx="10" cy="10" r="7" />
      <path d="M7.5 7.5a2.5 2.5 0 1 1 3.5 2.3c-.8.3-1 .8-1 1.5v.2" />
      <circle cx="10" cy="14.5" r="0.6" fill="currentColor" />
    </SvgIcon>
  ),
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

function useTheme(): { theme: 'light' | 'dark'; setTheme: (next: 'light' | 'dark') => void } {
  const [theme, setLocalTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  );
  function setTheme(next: 'light' | 'dark') {
    if (next === theme) return;
    setLocalTheme(next);
    if (next === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      window.localStorage.setItem('decimal.theme', next);
    } catch {
      // storage may be unavailable; that's fine
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
  destinationsUnreviewedCount,
  payersUnreviewedCount,
  approvalPendingCount,
  executionQueueCount,
  onOrganizationSwitch,
  onLogout,
}: {
  session: AuthenticatedSession;
  organizationContexts: OrganizationContext[];
  activeOrganizationId?: string;
  paymentsIncompleteCount?: number;
  collectionsOpenCount?: number;
  destinationsUnreviewedCount?: number;
  payersUnreviewedCount?: number;
  approvalPendingCount?: number;
  executionQueueCount?: number;
  onOrganizationSwitch: (organizationId: string) => void;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  const tour = useTour();
  const activeContext =
    organizationContexts.find((ctx) => ctx.organization.organizationId === activeOrganizationId) ?? organizationContexts[0];
  const activeOrganization = activeContext?.organization;
  const hasOrganization = organizationContexts.length > 0;

  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showOrganizationRequiredModal, setShowOrganizationRequiredModal] = useState(false);
  const wsRef = useOutsideClick<HTMLDivElement>(wsMenuOpen, () => setWsMenuOpen(false));
  const userRef = useOutsideClick<HTMLDivElement>(userMenuOpen, () => setUserMenuOpen(false));
  const { theme, setTheme } = useTheme();

  const base = activeOrganization ? `/organizations/${activeOrganization.organizationId}` : null;

  return (
    <aside className="ax-sidebar" aria-label="Application">
      <div className="ax-sidebar-brand">
        <span className="ax-sidebar-brand-mark" aria-hidden>
          A
        </span>
        <div className="ax-sidebar-brand-text">
          <strong>Decimal</strong>
        </div>
      </div>

      {organizationContexts.length ? (
        <div className="ax-ws-switcher" ref={wsRef}>
          <button
            type="button"
            className="ax-ws-button"
            aria-haspopup="menu"
            aria-expanded={wsMenuOpen}
            onClick={() => setWsMenuOpen((v) => !v)}
          >
            <span className="ax-ws-button-avatar" aria-hidden>
              {initialsFromName(activeOrganization?.organizationName ?? '?')}
            </span>
            <span className="ax-ws-button-text">
              <span className="ax-ws-button-org">Organization</span>
              <span className="ax-ws-button-name">{activeOrganization?.organizationName ?? 'Select organization'}</span>
            </span>
            {icons.chevron}
          </button>

          {wsMenuOpen ? (
            <div className="ax-ws-menu" role="menu">
              {organizationContexts.map(({ organization }) => {
                const isActive = organization.organizationId === activeOrganizationId;
                return (
                  <button
                    key={organization.organizationId}
                    type="button"
                    role="menuitem"
                    className={`ax-ws-menu-item${isActive ? ' ax-ws-menu-item-active' : ''}`}
                    onClick={() => {
                      setWsMenuOpen(false);
                      if (!isActive) onOrganizationSwitch(organization.organizationId);
                    }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {organization.organizationName}
                    </span>
                    {isActive ? icons.check : null}
                  </button>
                );
              })}
              <div className="ax-ws-menu-sep" />
              <button
                type="button"
                className="ax-ws-menu-item ax-ws-menu-new"
                role="menuitem"
                onClick={() => {
                  setWsMenuOpen(false);
                  navigate('/setup');
                }}
              >
                {icons.plus}
                <span>New organization</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="ax-ws-switcher">
          <Link to="/setup" className="ax-ws-button" style={{ gap: 10 }}>
            <span className="ax-ws-button-avatar" aria-hidden>
              +
            </span>
            <span className="ax-ws-button-text">
              <span className="ax-ws-button-name">Create organization</span>
              <span className="ax-ws-button-org">Get started</span>
            </span>
          </Link>
        </div>
      )}

      <nav className="ax-nav" aria-label="Organization navigation">
        {base ? (
          <>
            <div className="ax-nav-group">
              <div className="ax-nav-group-label">Operations</div>
              <NavLinkItem to={base} end icon={icons.overview} label="Overview" tourKey="overview" />
              <NavLinkItem
                to={`${base}/proposals`}
                icon={icons.proposals}
                label="Proposals"
                tourKey="proposals"
              />
              <NavLinkItem
                to={`${base}/payments`}
                icon={icons.payments}
                label="Payments"
                badge={paymentsIncompleteCount}
                tourKey="payments"
              />
              <NavLinkItem
                to={`${base}/collections`}
                icon={icons.collections}
                label="Collections"
                badge={collectionsOpenCount}
                tourKey="collections"
              />
              <NavLinkItem to={`${base}/policy`} icon={icons.policy} label="Policy" tourKey="policy" />
              <NavLinkItem to={`${base}/proofs`} icon={icons.proofs} label="Proofs" tourKey="proofs" />
            </div>

            <div className="ax-nav-group">
              <div className="ax-nav-group-label">Registry</div>
              <NavLinkItem to={`${base}/wallets`} icon={icons.wallet} label="Treasury accounts" tourKey="wallets" />
              <NavLinkItem to={`${base}/members`} icon={icons.members} label="Members" tourKey="members" />
              <NavLinkItem
                to={`${base}/counterparties`}
                icon={icons.counterparty}
                label="Counterparties"
                tourKey="counterparties"
              />
              <NavLinkItem
                to={`${base}/destinations`}
                icon={icons.destinations}
                label="Destinations"
                badge={destinationsUnreviewedCount}
                tourKey="destinations"
              />
              <NavLinkItem
                to={`${base}/payers`}
                icon={icons.payers}
                label="Payers"
                badge={payersUnreviewedCount}
                tourKey="payers"
              />
            </div>

            <details className="ax-nav-advanced">
              <summary>
                <span className="ax-nav-advanced-chev" aria-hidden>
                  ▸
                </span>
                <span>Advanced</span>
              </summary>
              <div className="ax-nav-advanced-body">
                <NavLinkItem
                  to={`${base}/approvals`}
                  icon={icons.approvals}
                  label="Approvals"
                  badge={approvalPendingCount}
                />
                <NavLinkItem
                  to={`${base}/execution`}
                  icon={icons.execution}
                  label="Execution"
                  badge={executionQueueCount}
                />
                <NavLinkItem to={`${base}/settlement`} icon={icons.settlement} label="Settlement" />
                <NavLinkItem to={`${base}/exceptions`} icon={icons.exceptions} label="Exceptions" />
              </div>
            </details>
          </>
        ) : null}
      </nav>

      <div className="ax-footer">
        <div className="ax-theme-toggle" role="radiogroup" aria-label="Theme">
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'light'}
            aria-pressed={theme === 'light'}
            className="ax-theme-option"
            onClick={() => setTheme('light')}
          >
            {icons.sun}
            <span>Light</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'dark'}
            aria-pressed={theme === 'dark'}
            className="ax-theme-option"
            onClick={() => setTheme('dark')}
          >
            {icons.moon}
            <span>Dark</span>
          </button>
        </div>

        <div className="ax-user-menu" ref={userRef}>
          <button
            type="button"
            className="ax-user-button"
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            onClick={() => setUserMenuOpen((v) => !v)}
          >
            <span className="ax-user-avatar" aria-hidden>
              {initialsFromEmail(session.user.email)}
            </span>
            <span className="ax-user-text">
              <div className="ax-user-email" title={session.user.email}>
                {session.user.email}
              </div>
              <div className="ax-user-sub">{session.user.displayName || 'Signed in'}</div>
            </span>
          </button>
          {userMenuOpen ? (
            <div className="ax-user-menu-dropdown" role="menu">
              <button
                type="button"
                role="menuitem"
                className="ax-user-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  navigate('/profile');
                }}
              >
                {icons.user}
                <span>Profile</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="ax-user-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  if (hasOrganization) {
                    tour.start();
                    return;
                  }
                  setShowOrganizationRequiredModal(true);
                }}
              >
                {icons.tutorial}
                <span>Show tutorial</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="ax-user-menu-item"
                data-tone="danger"
                onClick={() => {
                  setUserMenuOpen(false);
                  onLogout();
                }}
              >
                {icons.logout}
                <span>Sign out</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {showOrganizationRequiredModal ? (
        <div className="modal-root" role="dialog" aria-modal="true" aria-labelledby="org-required-title">
          <button
            type="button"
            className="modal-backdrop"
            aria-label="Close"
            onClick={() => setShowOrganizationRequiredModal(false)}
          />
          <section className="modal-dialog">
            <header className="modal-header">
              <div>
                <h2 id="org-required-title">Create an organization first</h2>
                <p className="modal-subtitle">
                  The product tour walks through organization pages like payments, collections, wallets, and policy.
                  Create an organization before starting it.
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label="Close"
                onClick={() => setShowOrganizationRequiredModal(false)}
              >
                ×
              </button>
            </header>
            <footer className="modal-footer">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setShowOrganizationRequiredModal(false)}
              >
                Not now
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  setShowOrganizationRequiredModal(false);
                  navigate('/setup');
                }}
              >
                Create organization
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </aside>
  );
}

function NavLinkItem({
  to,
  end,
  icon,
  label,
  badge,
  tourKey,
}: {
  to: string;
  end?: boolean;
  icon: ReactNode;
  label: string;
  badge?: number;
  tourKey?: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `ax-nav-link${isActive ? ' ax-nav-link-active' : ''}`}
      data-tour-key={tourKey}
    >
      <span className="ax-nav-link-icon">{icon}</span>
      <span className="ax-nav-link-label">{label}</span>
      {badge && badge > 0 ? (
        <span className="ax-nav-link-badge" aria-label={`${badge} pending`}>
          {badge}
        </span>
      ) : null}
    </NavLink>
  );
}
