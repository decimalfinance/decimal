// Shared bits for landing-v4 — resolved design values + tiny repeated elements.
import type { CSSProperties, ReactNode } from 'react';

export const INK = '#5C1F33';
export const HIGHLIGHT = '#F9C6D0';
export const BAND = '#F5F4F2';
// "Rough marker" highlight path from the handoff.
export const MARKER_PATH =
  'M3.4 5.6 Q18 3.2 39 3.8 Q66 2.4 96.2 4.4 Q98.6 7.4 97.4 11 Q98.2 14.2 96 16.4 Q70 15.4 44 16.8 Q20 17.8 3 16 Q1.6 13 2.6 10.4 Q1.8 7.6 3.4 5.6 Z';

/** Marker-highlighted word(s): <mark> with the rough-marker SVG behind the text. */
export function Marker({ children, side = 'left' }: { children: ReactNode; side?: 'left' | 'right' }) {
  const pad: CSSProperties =
    side === 'left'
      ? { padding: '0 8px 2px', marginLeft: -8 }
      : { padding: '0 10px 2px', marginRight: -10 };
  return (
    <mark style={{ position: 'relative', background: 'transparent', color: 'inherit', zIndex: 0, ...pad }}>
      <svg viewBox="0 0 100 20" preserveAspectRatio="none" style={{ position: 'absolute', inset: '-2% -1.5%', width: '103%', height: '104%', zIndex: -1 }}>
        <path d={MARKER_PATH} fill={HIGHLIGHT} />
      </svg>
      {children}
    </mark>
  );
}

/** Solid person-silhouette icon (avatar chips). */
export function PersonIcon({ w = 15 }: { w?: number }) {
  return (
    <svg width={w} height={w} viewBox="0 0 24 24" fill="currentColor">
      <ellipse cx="12" cy="8.5" rx="4.4" ry="5" />
      <path d="M2.5 24c0-5 4.2-8 9.5-8s9.5 3 9.5 8z" />
    </svg>
  );
}

/** Round avatar chip with the person silhouette. */
export function Av({ bg, fg, size = 20, ml, iconW = 15 }: { bg: string; fg: string; size?: number; ml?: number; iconW?: number }) {
  return (
    <span
      style={{
        width: size, height: size, borderRadius: 99, background: bg, color: fg,
        border: '1.5px solid var(--bg-surface)', display: 'inline-flex', alignItems: 'flex-end',
        justifyContent: 'center', overflow: 'hidden', flex: 'none', marginLeft: ml,
      }}
    >
      <PersonIcon w={iconW} />
    </span>
  );
}

/** Ink cursor arrow with white outline; pass the animation via style. */
export function Cursor({ w = 22, style }: { w?: number; style?: CSSProperties }) {
  return (
    <svg width={w} height={w} viewBox="0 0 24 24" style={style} fill="var(--ink)" stroke="#FFFFFF" strokeWidth="1.1" strokeLinejoin="round">
      <path d="M5.5 3.2v13.6l3.4-3 2 4.6 2.6-1.1-2-4.6h4.6z" />
    </svg>
  );
}

/** Shimmer sweep overlay used inside animated form fields. */
export function Shimmer({ anim }: { anim: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute', top: 0, bottom: 0, left: 0, width: '45%',
        background: 'linear-gradient(100deg,transparent,color-mix(in srgb, var(--ink) 14%, transparent),transparent)',
        animation: anim,
      }}
    />
  );
}

/** Animated review field (label + faux input with shimmer + value fade-in). */
export function AnimField({
  label, value, mono, pulse, val, shimmer, minHeight = 27, fontSize = 11, labelSize,
}: {
  label: string; value: string; mono?: boolean;
  pulse: string; val: string; shimmer: string;
  minHeight?: number; fontSize?: number; labelSize?: number;
}) {
  return (
    <div className="rev-field">
      <span className="field-label" style={labelSize ? { fontSize: labelSize } : undefined}>{label}</span>
      <div
        className={mono ? 'input mono' : 'input'}
        style={{
          pointerEvents: 'none', height: 'auto', minHeight, fontSize,
          display: 'flex', alignItems: 'center', position: 'relative', overflow: 'hidden',
          animation: pulse,
        }}
      >
        <span style={{ animation: val }}>{value}</span>
        <Shimmer anim={shimmer} />
      </div>
    </div>
  );
}
