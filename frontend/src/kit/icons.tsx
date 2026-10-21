// Icons drawn for Decimal in the design handoff, lifted from the files as is.
// Filled glyphs on a 24px grid; pass the rendered size.
import type { SVGProps } from 'react';

type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>;

function Filled({ size = 15, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden {...rest}>
      {children}
    </svg>
  );
}

function Stroked({ size = 12, strokeWidth = 2, children, ...rest }: IconProps & { strokeWidth?: number | string; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  home: (p: IconProps) => (
    <Filled {...p}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
    </Filled>
  ),
  inbox: (p: IconProps) => (
    <Filled {...p}>
      <path fillRule="evenodd" d="M5.2 3h13.6l3.2 10v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7L5.2 3zm1.5 2-2.5 7.8H8.5l1.5 2.4h4l1.5-2.4h4.3L17.3 5H6.7z" />
    </Filled>
  ),
  bills: (p: IconProps) => (
    <Filled {...p}>
      <path fillRule="evenodd" d="M6 2a1.6 1.6 0 0 0-1.6 1.6v16.8A1.6 1.6 0 0 0 6 22h12a1.6 1.6 0 0 0 1.6-1.6V8l-6-6H6zm2.5 10.2h7v1.8h-7v-1.8zm0 3.8h7v1.8h-7V16z" />
    </Filled>
  ),
  vendors: (p: IconProps) => (
    <Filled {...p}>
      <path d="M12 2.5 21.5 8.2h-19L12 2.5zM4.2 9.6h3v8.2h-3V9.6zm6.3 0h3v8.2h-3V9.6zm6.3 0h3v8.2h-3V9.6zM3 19.2h18v2.6H3v-2.6z" />
    </Filled>
  ),
  organisation: (p: IconProps) => (
    <Filled {...p}>
      <path fillRule="evenodd" d="M4 3h11a1 1 0 0 1 1 1v6h4a1 1 0 0 1 1 1v10H3V4a1 1 0 0 1 1-1zm2 4v2h2V7H6zm4 0v2h2V7h-2zm-4 4v2h2v-2H6zm4 0v2h2v-2h-2zm6 2v2h2v-2h-2zm0 4v2h2v-2h-2zM6 15v2h2v-2H6zm4 0v2h2v-2h-2z" />
    </Filled>
  ),
  approvalRules: (p: IconProps) => (
    <Filled {...p}>
      <path d="M14 3.2l6.8 4.8L14 12.8V10H8V6h6V3.2zM10 11.2 3.2 16l6.8 4.8V18h6v-4h-6v-2.8z" />
    </Filled>
  ),
  team: (p: IconProps) => (
    <Filled {...p}>
      <path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7.5.4a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3.3 3.1-5.4 7-5.4s7 2.1 7 5.4v1H2v-1zm16.1 1H22v-1c0-2.3-1.6-4-3.9-4.6.7 1 1.1 2.2 1.1 3.6v2z" />
    </Filled>
  ),
  /** Up-and-down chevrons: something that opens a list. */
  chevUpDown: (p: IconProps) => (
    <Stroked {...p}>
      <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
    </Stroked>
  ),
  /** A left-pointing chevron; flip it for right. */
  chevLeft: (p: IconProps) => (
    <Stroked strokeWidth={2.4} {...p}>
      <path d="m14.5 6-6 6 6 6" />
    </Stroked>
  ),
  /** The small down chevron on a split pill. */
  chevDown: (p: IconProps) => (
    <Stroked strokeWidth={2.2} {...p}>
      <path d="m7 10 5 5 5-5" />
    </Stroked>
  ),
  /** The wider down chevron on a sort or select. */
  caret: (p: IconProps) => (
    <Stroked strokeWidth={2.5} {...p}>
      <polyline points="6 9 12 15 18 9" />
    </Stroked>
  ),
  upload: (p: IconProps) => (
    <Stroked {...p}>
      <path d="M12 15V4.5M7.5 9 12 4.5 16.5 9M5 19.5h14" />
    </Stroked>
  ),
  mail: (p: IconProps) => (
    <Stroked strokeWidth={1.9} {...p}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </Stroked>
  ),
  search: (p: IconProps) => (
    <Stroked {...p}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Stroked>
  ),
  copy: (p: IconProps) => (
    <Stroked {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a1 1 0 0 1 1-1h10" />
    </Stroked>
  ),
  tick: (p: IconProps) => (
    <Stroked strokeWidth={2.6} {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Stroked>
  ),
  x: (p: IconProps) => (
    <Stroked strokeWidth={2.4} {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Stroked>
  ),
  /** A person with a plus: inviting someone. */
  userPlus: (p: IconProps) => (
    <Stroked {...p}>
      <circle cx="9.5" cy="8" r="3.5" />
      <path d="M3 20c.6-3.6 3.2-5.8 6.5-5.8 1.6 0 3 .5 4.1 1.4" />
      <path d="M18.5 13v7M15 16.5h7" />
    </Stroked>
  ),
  file: (p: IconProps) => (
    <Stroked strokeWidth={1.9} {...p}>
      <path d="M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M13.5 3.5V8H18" />
    </Stroked>
  ),
  // Approval rules
  plus: (p: IconProps) => (
    <Stroked strokeWidth={3} {...p}>
      <path d="M12 5v14M5 12h14" />
    </Stroked>
  ),
  minus: (p: IconProps) => (
    <Stroked strokeWidth={2.4} {...p}>
      <path d="M5 12h14" />
    </Stroked>
  ),
  /** A frame's corners: fit to the window. */
  fit: (p: IconProps) => (
    <Stroked {...p}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </Stroked>
  ),
  /** One path becoming two: a split. */
  fork: (p: IconProps) => (
    <Stroked strokeWidth={2.2} {...p}>
      <path d="M12 3v7M12 10l-6 6v5M12 10l6 6v5" />
    </Stroked>
  ),
  arrowDown: (p: IconProps) => (
    <Stroked strokeWidth={3} {...p}>
      <path d="M12 5v14M5.5 12.5 12 19l6.5-6.5" />
    </Stroked>
  ),
  person: (p: IconProps) => (
    <Stroked {...p}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20c.7-3.7 3.6-6 7.5-6s6.8 2.3 7.5 6" />
    </Stroked>
  ),
  /** A tick in a ring: where a path ends. */
  ringTick: (p: IconProps) => (
    <Stroked strokeWidth={2.2} {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.8 2.8 5.4-5.6" />
    </Stroked>
  ),
  undo: (p: IconProps) => (
    <Stroked {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Stroked>
  ),
  redo: (p: IconProps) => (
    <Stroked {...p}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </Stroked>
  ),
  /** A flask: trying a bill out. */
  flask: (p: IconProps) => (
    <Stroked strokeWidth={1.9} {...p}>
      <path d="M9 3h6M10 3v6.5L5.2 18a2 2 0 0 0 1.8 3h10a2 2 0 0 0 1.8-3L14 9.5V3" />
      <path d="M7.4 15h9.2" />
    </Stroked>
  ),
  lock: (p: IconProps) => (
    <Stroked {...p}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </Stroked>
  ),
};
