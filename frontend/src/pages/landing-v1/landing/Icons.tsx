type IconProps = { size?: number };

const base = (size = 18) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function IconSun({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.5 5.5l1 1M17.5 17.5l1 1M5.5 18.5l1-1M17.5 6.5l1-1" />
    </svg>
  );
}

export function IconMoon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
    </svg>
  );
}

export function IconArrowRight({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconArrowDown({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  );
}

export function IconDownload({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 4v12M6 11l6 6 6-6M4 20h16" />
    </svg>
  );
}

export function IconCheck({ size = 10 }: IconProps) {
  return (
    <svg viewBox="0 0 10 10" width={size} height={size} aria-hidden="true">
      <path
        d="M1.5 5.2 L4 7.5 L8.5 2.5"
        stroke="var(--ax-on-accent)"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
