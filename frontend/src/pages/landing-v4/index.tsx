// Landing v4 — implements the design_handoff_decimal_landing bundle.
// Page order per the handoff: Hero → Anatomy of a bill → Features → FAQ → Final CTA → Footer.
// Desktop-first at the 1440px design width; below that the whole sheet scales to fit.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Hero } from './hero';
import { Anatomy } from './anatomy';
import { Faq, Features, FinalCta } from './sections';
import './landing4.css';

const DESIGN_W = 1440;

/** Full-bleed hairline between page sections. */
const Sep = () => <div style={{ borderTop: '1px solid var(--border)' }} />;

export function LandingPage() {
  const [vw, setVw] = useState(() => window.innerWidth);
  const [contentH, setContentH] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const scale = Math.min(1, vw / DESIGN_W);

  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContentH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    document.title = 'Decimal — Self-driving Accounts Payable';
  }, []);

  const scaled = scale < 1;
  return (
    <div className="dec l4" data-style="print" style={{ minHeight: '100vh', overflowX: 'clip' }}>
      <div style={scaled ? { height: contentH * scale || undefined, overflow: 'hidden' } : undefined}>
        <div
          ref={sheetRef}
          style={scaled ? { width: DESIGN_W, transform: `scale(${scale})`, transformOrigin: 'top left' } : { width: '100%' }}
        >
          <div style={{ maxWidth: DESIGN_W, margin: '0 auto' }}>
            <Hero />
          </div>
          <Sep />
          <div style={{ maxWidth: DESIGN_W, margin: '0 auto' }}>
            <Anatomy />
          </div>
          <Sep />
          <Features />
          <Sep />
          <Faq />
          <FinalCta />
        </div>
      </div>
    </div>
  );
}
