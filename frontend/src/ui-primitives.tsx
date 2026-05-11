import type { ReactNode } from 'react';
import { useEffect, useId, useState } from 'react';
import { orbAccountUrl, orbTransactionUrl, shortenAddress } from './domain';

export function Modal({
  title,
  children,
  open,
  onClose,
  footer,
  size = 'default',
}: {
  title: string;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  footer?: ReactNode;
  size?: 'default' | 'wide';
}) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-root" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={onClose} />
      <div className={`modal-dialog${size === 'wide' ? ' modal-dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={`tabs-tab${active === tab.id ? ' tabs-tab-active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Collapsible({
  title,
  description,
  defaultOpen = true,
  children,
  id,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  id?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="collapsible" id={id}>
      <button type="button" className="collapsible-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="collapsible-chevron" aria-hidden>
          {open ? '▼' : '▶'}
        </span>
        <span className="collapsible-titles">
          <strong>{title}</strong>
          {description ? <small>{description}</small> : null}
        </span>
      </button>
      {open ? <div className="collapsible-panel">{children}</div> : null}
    </section>
  );
}

export function Drawer({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer-root" role="presentation">
      <button type="button" className="drawer-backdrop" aria-label="Close panel" onClick={onClose} />
      <aside className="drawer-panel">
        <header className="drawer-header">
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export function InstitutionalPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={className ? `panel ${className}` : 'panel'}>{children}</section>;
}

export function PanelHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="section-header section-header-institutional">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="section-header-actions">{actions}</div> : null}
    </header>
  );
}

export function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric metric-institutional">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function EmptyPanel({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state empty-state-institutional">
      <strong>{title}</strong>
      <p>{description}</p>
      {action ? <div className="empty-state-actions">{action}</div> : null}
    </div>
  );
}

// Richer empty-state for the main list pages. Same dashed institutional
// frame as EmptyPanel, but with a muted icon at the top and a primary +
// secondary CTA pair so the operator always knows the next move.
// Works equally well dropped into a `<td colSpan>` or a plain `<div>`.
export function RdEmptyState({
  icon,
  title,
  description,
  primary,
  secondary,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  primary?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div className="empty-state empty-state-institutional" style={{ gap: 4 }}>
      {icon ? (
        <div
          aria-hidden
          style={{
            color: 'var(--ax-text-muted)',
            opacity: 0.55,
            marginBottom: 8,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {icon}
        </div>
      ) : null}
      <strong>{title}</strong>
      <p>{description}</p>
      {primary || secondary ? (
        <div className="empty-state-actions">
          {primary ? (
            <button type="button" className="button button-primary" onClick={primary.onClick}>
              {primary.label}
            </button>
          ) : null}
          {secondary ? (
            <button type="button" className="button button-secondary" onClick={secondary.onClick}>
              {secondary.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Outline icons for empty states. Lucide-style; sized 32px so they
// register as a visual anchor without dominating.
export function EmptyIcon({ kind }: { kind: 'receipt' | 'inbox' | 'users' | 'wallet' | 'address-book' | 'proposal' }) {
  const props = {
    width: 32,
    height: 32,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (kind) {
    case 'receipt':
      return (
        <svg {...props}>
          <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 2V2z" />
          <line x1="8" y1="8" x2="16" y2="8" />
          <line x1="8" y1="12" x2="16" y2="12" />
          <line x1="8" y1="16" x2="12" y2="16" />
        </svg>
      );
    case 'inbox':
      return (
        <svg {...props}>
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
      );
    case 'users':
      return (
        <svg {...props}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'wallet':
      return (
        <svg {...props}>
          <path d="M20 12V8H6a2 2 0 0 1 0-4h12v4" />
          <path d="M4 6v12a2 2 0 0 0 2 2h14v-4" />
          <path d="M18 12a2 2 0 0 0 0 4h4v-4z" />
        </svg>
      );
    case 'address-book':
      return (
        <svg {...props}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          <circle cx="12" cy="11" r="3" />
        </svg>
      );
    case 'proposal':
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9" y1="15" x2="15" y2="15" />
          <line x1="9" y1="11" x2="15" y2="11" />
        </svg>
      );
  }
}

export function DataTableShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={className ? `data-table ${className}` : 'data-table'}>{children}</div>;
}

// Primary-action card frame on rd-styled detail pages. Each lifecycle
// variant ('needs_submit', 'ready_to_propose', 'ready_to_sign',
// 'proposal_in_progress', 'in_flight', 'settled', 'exception',
// 'cancelled') uses the same eyebrow/title/body shell with variant-
// specific copy and (optionally) action buttons or richer content as
// children.
export function RdPrimaryCard({
  emphasis,
  eyebrow,
  title,
  body,
  children,
}: {
  emphasis?: 'action' | 'blocked' | 'waiting' | 'warning' | 'success' | 'muted';
  eyebrow: string;
  title: ReactNode;
  body?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rd-primary" data-emphasis={emphasis}>
      <p className="rd-primary-eyebrow">{eyebrow}</p>
      <h2 className="rd-primary-title">{title}</h2>
      {body ? <p className="rd-primary-body">{body}</p> : null}
      {children}
    </div>
  );
}

// Header chrome for rd-styled detail pages (PaymentDetail, PaymentRunDetail,
// CollectionDetail): eyebrow + title + per-page meta line on the left, an
// optional side slot (status pill, actions, etc) on the right.
export function RdPageHeader({
  eyebrow,
  title,
  meta,
  side,
}: {
  eyebrow: string;
  title: ReactNode;
  meta?: ReactNode;
  side?: ReactNode;
}) {
  return (
    <header className="rd-header">
      <div>
        <p className="rd-eyebrow">{eyebrow}</p>
        <h1 className="rd-title">{title}</h1>
        {meta ? <p className="rd-meta">{meta}</p> : null}
      </div>
      {side ? <div className="rd-header-side">{side}</div> : null}
    </header>
  );
}

// Vertical "label · value" pair used in detail-page metric grids. The label
// is small uppercase muted; the value is normal-size body. Used by treasury,
// proposal, and payment detail pages.
export function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Use color (with alpha) instead of `opacity` so children with their
          own background — like the LabelWithInfo tooltip on the proposal
          page — don't inherit the dim. */}
      <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ax-text-muted)' }}>
        {label}
      </span>
      <span style={{ fontSize: 14 }}>{children}</span>
    </div>
  );
}

// `<dt>/<dd>` variant for `rd-metric-label`-styled detail grids on the
// payment and collection detail pages. Visually similar to InfoRow but uses
// definition-list semantics.
export function DetailEntry({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="rd-metric-label" style={{ marginBottom: 6 }}>
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: 13, color: 'var(--ax-text)' }}>{children}</dd>
    </div>
  );
}

// Standard loading skeleton for detail pages. Matches the visual rhythm of
// PaymentDetail / PaymentRunDetail: a small back-link line, a title line,
// optionally a meta line, then hero + body blocks.
export function DetailPageSkeleton({
  containerClassName = 'rd-page-container',
  showMetaLine = false,
}: {
  containerClassName?: string;
  showMetaLine?: boolean;
}) {
  return (
    <main className="page-frame" data-layout="rd">
      <div className={containerClassName}>
        <div className="rd-skeleton rd-skeleton-line" style={{ width: 120 }} />
        <div className="rd-skeleton rd-skeleton-line" style={{ width: 280, height: 28, marginBottom: 8 }} />
        {showMetaLine ? <div className="rd-skeleton rd-skeleton-line" style={{ width: 360 }} /> : null}
        <div className="rd-skeleton rd-skeleton-block" style={{ height: 120, marginTop: showMetaLine ? 32 : 24 }} />
        <div className="rd-skeleton rd-skeleton-block" style={{ height: 200, marginTop: 32 }} />
      </div>
    </main>
  );
}

// "Couldn't load X" / "X unavailable" / "Not found" empty-state card for
// detail pages. Wraps in the page-frame shell so it sits in the same frame
// as a successful render. Pass an `action` to show a retry button.
export function DetailPageState({
  title,
  body,
  back,
  action,
  containerClassName = 'rd-page-container',
}: {
  title: string;
  body: ReactNode;
  /**
   * Optional back link rendered above the state card. Provide as a
   * pre-rendered ReactNode (typically a `<Link>`) so the caller controls
   * the destination.
   */
  back?: ReactNode;
  action?: ReactNode;
  containerClassName?: string;
}) {
  return (
    <main className="page-frame" data-layout="rd">
      <div className={containerClassName}>
        {back ?? null}
        <div className="rd-state">
          <h2 className="rd-state-title">{title}</h2>
          <div className="rd-state-body">{body}</div>
          {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
        </div>
      </div>
    </main>
  );
}

// Shared filter bar used above every list-style table — search input
// (optional), pill tabs (optional), labelled selects (optional), and a
// right-aligned meta slot (e.g. "1 of 12"). Renders nothing if no
// filters are passed.
export type RdFilterBarTab = {
  id: string;
  label: string;
  active: boolean;
  onClick: () => void;
};

export type RdFilterBarSelectOption = { value: string; label: string };

export type RdFilterBarSelect = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: RdFilterBarSelectOption[];
  ariaLabel?: string;
};

export type RdFilterBarSearch = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
};

export function RdFilterBar({
  search,
  tabs,
  selects,
  rightMeta,
}: {
  search?: RdFilterBarSearch;
  tabs?: RdFilterBarTab[];
  selects?: RdFilterBarSelect[];
  rightMeta?: ReactNode;
}) {
  if (!search && !tabs?.length && !selects?.length && !rightMeta) {
    return null;
  }
  return (
    <div className="rd-filter-bar">
      {search ? (
        <div className="rd-search">
          <svg className="rd-search-icon" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="m14 14-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder={search.placeholder ?? 'Search'}
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            aria-label={search.ariaLabel ?? search.placeholder ?? 'Search'}
          />
        </div>
      ) : null}
      {tabs && tabs.length > 0 ? (
        <div className="rd-tabs" role="tablist" aria-label="Filter">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={tab.active}
              className="rd-tab"
              onClick={tab.onClick}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      {selects && selects.length > 0
        ? selects.map((sel) => (
            <label key={sel.label} className="rd-filter-select">
              <span className="rd-filter-select-label">{sel.label}:</span>
              <select
                value={sel.value}
                onChange={(e) => sel.onChange(e.target.value)}
                aria-label={sel.ariaLabel ?? sel.label}
              >
                {sel.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          ))
        : null}
      {rightMeta ? (
        <div className="rd-toolbar-right">
          <span className="rd-section-meta">{rightMeta}</span>
        </div>
      ) : null}
    </div>
  );
}

// Mono-style on-chain reference. Renders the truncated value as a Solscan
// link (account or transaction depending on which prop is supplied) plus a
// small copy-to-clipboard button. Use this for every account, PDA, ATA,
// or signature shown to the operator — the copy affordance is the
// difference between "I can read this" and "I can act on it".
export function ChainLink({
  address,
  signature,
  prefix = 6,
  suffix = 6,
  showCopy = true,
}: {
  address?: string;
  signature?: string;
  prefix?: number;
  suffix?: number;
  showCopy?: boolean;
}) {
  const value = address ?? signature ?? '';
  const href = signature ? orbTransactionUrl(value) : orbAccountUrl(value);
  return (
    <span
      className="rd-addr-link"
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
    >
      <a href={href} target="_blank" rel="noreferrer" title={value} style={{ color: 'inherit' }}>
        {shortenAddress(value, prefix, suffix)}
      </a>
      {showCopy ? <CopyButton value={value} ariaLabel={signature ? 'Copy signature' : 'Copy address'} /> : null}
    </span>
  );
}

// Tiny inline clipboard button. Briefly swaps to a check icon for ~1.4s
// after a successful copy so the operator gets visual confirmation
// without us needing to surface a toast for every copy.
export function CopyButton({
  value,
  ariaLabel = 'Copy',
  size = 12,
}: {
  value: string;
  ariaLabel?: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Permissions denied or unsupported — fail silently rather than
      // showing an error; the user can still triple-click + Cmd+C.
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={copied ? 'Copied' : ariaLabel}
      title={copied ? 'Copied' : ariaLabel}
      className="rd-copy-btn"
      style={{
        background: 'transparent',
        border: 'none',
        padding: 2,
        margin: 0,
        display: 'inline-flex',
        alignItems: 'center',
        cursor: 'pointer',
        color: copied ? 'var(--ax-success, #4ade80)' : 'inherit',
        opacity: copied ? 1 : 0.65,
        transition: 'opacity 120ms ease, color 120ms ease',
        lineHeight: 0,
      }}
      onMouseEnter={(e) => {
        if (!copied) e.currentTarget.style.opacity = '1';
      }}
      onMouseLeave={(e) => {
        if (!copied) e.currentTarget.style.opacity = '0.65';
      }}
    >
      {copied ? <CheckIcon size={size} /> : <CopyIcon size={size} />}
    </button>
  );
}

function CopyIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
