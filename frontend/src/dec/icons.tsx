// Decimal — design icon set, ported verbatim from
// design/design_handoff_decimal/decimal/icons.jsx.
// Stroke icons, 1.6 weight, currentColor.

import type { CSSProperties, SVGProps } from 'react';

type IcoProps = SVGProps<SVGSVGElement> & {
  w?: number;
  sw?: number;
  vb?: number;
  fill?: string;
  className?: string;
  style?: CSSProperties;
};

function I({
  w = 16,
  sw = 1.6,
  vb = 24,
  fill = 'none',
  children,
  ...rest
}: IcoProps & { children?: React.ReactNode }) {
  return (
    <svg
      width={w}
      height={w}
      viewBox={`0 0 ${vb} ${vb}`}
      fill={fill}
      stroke={fill === 'none' ? 'currentColor' : 'none'}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Ico = {
  grid: (p: IcoProps = {}) => (
    <I {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </I>
  ),
  payments: (p: IcoProps = {}) => (
    <I {...p}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 9.5h19" />
    </I>
  ),
  collections: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M12 3v18M5 8l7-5 7 5M5 8v8l7 5 7-5V8" />
    </I>
  ),
  treasury: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M3 9.5 12 4l9 5.5M5 10v8M19 10v8M9 10v8M15 10v8M3.5 20.5h17" />
    </I>
  ),
  members: (p: IcoProps = {}) => (
    <I {...p}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5 5 0 0 0-2-4" />
    </I>
  ),
  address: (p: IcoProps = {}) => (
    <I {...p}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </I>
  ),
  proposals: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M9 5h11M9 12h11M9 19h11M4.5 5h.01M4.5 12h.01M4.5 19h.01" />
    </I>
  ),
  shield: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />
      <path d="M9 12l2 2 4-4" />
    </I>
  ),
  search: (p: IcoProps = {}) => (
    <I {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </I>
  ),
  chevDown: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="m6 9 6 6 6-6" />
    </I>
  ),
  chevRight: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="m9 6 6 6-6 6" />
    </I>
  ),
  chevLeft: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="m15 6-6 6 6 6" />
    </I>
  ),
  check: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M5 12.5 10 17 19 6.5" />
    </I>
  ),
  checkSm: (p: IcoProps = {}) => (
    <I {...p} sw={2.2}>
      <path d="M5 12.5 10 17 19 6.5" />
    </I>
  ),
  plus: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M12 5v14M5 12h14" />
    </I>
  ),
  upload: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
    </I>
  ),
  download: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />
    </I>
  ),
  csv: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
      <path d="M14 3v6h6" />
    </I>
  ),
  external: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </I>
  ),
  x: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </I>
  ),
  sun: (p: IcoProps = {}) => (
    <I {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
    </I>
  ),
  moon: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </I>
  ),
  doc: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
    </I>
  ),
  arrowRight: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </I>
  ),
  bolt: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z" />
    </I>
  ),
  inbox: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M3 13h5l1.5 3h5l1.5-3h5M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5L5 5Z" />
    </I>
  ),
  link: (p: IcoProps = {}) => (
    <I {...p}>
      <path d="M9 14.5 14.5 9M10 6l1.5-1.5a3.5 3.5 0 0 1 5 5L15 11M9 13l-1.5 1.5a3.5 3.5 0 0 1-5-5L4 8" />
    </I>
  ),
  vault: (p: IcoProps = {}) => (
    <I {...p}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="11" cy="12" r="3.2" />
      <path d="M11 12h3.5" />
      <path d="M6 19.5v1M18 19.5v1" />
    </I>
  ),
  users: (p: IcoProps = {}) => (
    <I {...p}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5 5 0 0 0-2-4" />
    </I>
  ),
  mail: (p: IcoProps = {}) => (
    <I {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 6.5 8.5 6 8.5-6" />
    </I>
  ),
  copy: (p: IcoProps = {}) => (
    <I {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </I>
  ),
  userPlus: (p: IcoProps = {}) => (
    <I {...p}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M19 8v6M22 11h-6" />
    </I>
  ),
  key: (p: IcoProps = {}) => (
    <I {...p}>
      <circle cx="8" cy="14" r="4" />
      <path d="m11 11 8-8M16 6l2 2M14 8l1.5 1.5" />
    </I>
  ),
  google: ({ w = 18 }: { w?: number }) => (
    <svg width={w} height={w} viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  ),
};
