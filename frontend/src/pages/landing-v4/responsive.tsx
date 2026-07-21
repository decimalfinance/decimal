// Mobile helpers for the v4 landing. Desktop renders exactly as before; below
// MOBILE_BP the sections stack to one column and the fixed-size product visuals
// are wrapped in <FitScale> so they shrink to fit the phone as previews.
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export const MOBILE_BP = 820;
export const M_PAD = 20; // horizontal page padding on mobile

/** True when the viewport is narrower than `bp` (phone / small tablet). */
export function useNarrow(bp = MOBILE_BP): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < bp);
  useLayoutEffect(() => {
    const on = () => setNarrow(window.innerWidth < bp);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [bp]);
  return narrow;
}

/**
 * Renders `children` at their natural width `w`, then uniformly scales the whole
 * block down to fit the container width (never scales up past 1). Reserves the
 * scaled height so surrounding content flows correctly. Used only on mobile —
 * the fixed-pixel product mockups become faithful, legible previews.
 */
export function FitScale({
  w, children, style,
}: { w: number; children: ReactNode; style?: CSSProperties }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [s, setS] = useState(1);
  const [h, setH] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;
    const compute = () => {
      const cw = wrap.clientWidth;
      const scale = Math.min(1, cw / w);
      setS(scale);
      setH(inner.offsetHeight * scale);
    };
    const ro = new ResizeObserver(compute);
    ro.observe(wrap);
    ro.observe(inner);
    compute();
    return () => ro.disconnect();
  }, [w]);

  // Scale from the top-left corner: since scaled width (w*s) equals the wrapper
  // width, the content fills the wrapper exactly with no offset. Centering the
  // pre-scale box would push an over-wide block off to the right.
  return (
    <div ref={wrapRef} style={{ width: '100%', height: h, overflow: 'hidden', ...style }}>
      <div ref={innerRef} style={{ width: w, transform: `scale(${s})`, transformOrigin: 'top left' }}>
        {children}
      </div>
    </div>
  );
}
