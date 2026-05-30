// Decimal — shared primitives ported from
// design/design_handoff_decimal/decimal/pages-shell.jsx
// All classes are namespaced under .dec — the AppShell wraps in .dec.

import type { ReactNode } from 'react';
import { Ico } from './icons';

// ─── Pill ─────────────────────────────────────────────────────────────────
// Status pills follow a small semantic palette. The design's STATUS_MAP
// is the canonical mapping for payment statuses; callers can also pass an
// explicit `tone` for non-payment uses.

export type PillTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const PAYMENT_STATUS_TONE: Record<string, PillTone> = {
  Received: 'neutral',
  Reviewed: 'info',
  Signing: 'warning',
  Send: 'info',
  Settled: 'success',
  Cancelled: 'neutral',
  Exception: 'danger',
};

export function Pill({
  status,
  tone,
  children,
}: {
  status?: string;
  tone?: PillTone;
  children?: ReactNode;
}) {
  const resolved: PillTone = tone ?? (status ? PAYMENT_STATUS_TONE[status] ?? 'neutral' : 'neutral');
  return (
    <span className={`pill pill-${resolved}`}>
      <span className="dot" />
      {children ?? status}
    </span>
  );
}

// ─── SLPill ───────────────────────────────────────────────────────────────
// Outline-only info-tone pill marking agent-route (spending-limit) payments.
// Smaller than a status pill — rides next to one, never replaces it.

export function SLPill() {
  return (
    <span className="pill-sl">
      <Ico.bolt w={10} fill="currentColor" sw={0} />
      SL
    </span>
  );
}

// ─── Origin pill ──────────────────────────────────────────────────────────
// Neutral square chip — "Single" or batch name ("Apr cloud", etc).

export function OriginPill({ children }: { children: ReactNode }) {
  return <span className="pill-origin">{children}</span>;
}

// ─── PageHead ─────────────────────────────────────────────────────────────
// Standard page header used on every page. Optional eyebrow + h1 + desc +
// right-aligned actions slot. The greet flag is for Overview's larger title.

export function PageHead({
  eyebrow,
  title,
  desc,
  actions,
  greet,
}: {
  eyebrow?: string;
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  greet?: boolean;
}) {
  return (
    <div className={greet ? 'greet' : ''}>
      {eyebrow ? (
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          {eyebrow}
        </div>
      ) : null}
      <div
        className="pagehead"
        style={!actions && !desc ? { borderBottom: 'none', paddingBottom: 0 } : undefined}
      >
        <div className="ph-titles">
          <h1>{title}</h1>
          {desc ? <p className="ph-desc">{desc}</p> : null}
        </div>
        {actions ? <div className="ph-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
