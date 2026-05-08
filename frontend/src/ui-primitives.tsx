import type { ReactNode } from 'react';
import { useEffect, useId, useState } from 'react';
import { orbAccountUrl, shortenAddress } from './domain';

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

export function DataTableShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={className ? `data-table ${className}` : 'data-table'}>{children}</div>;
}

// Vertical "label · value" pair used in detail-page metric grids. The label
// is small uppercase muted; the value is normal-size body. Used by treasury,
// proposal, and payment detail pages.
export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.6 }}>
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

// Mono-style address link that opens Solscan in a new tab. Used wherever
// detail pages render an on-chain account/PDA reference.
export function ChainLink({
  address,
  prefix = 6,
  suffix = 6,
}: {
  address: string;
  prefix?: number;
  suffix?: number;
}) {
  return (
    <a
      href={orbAccountUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="rd-addr-link"
      title={address}
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
    >
      {shortenAddress(address, prefix, suffix)}
    </a>
  );
}
