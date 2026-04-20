import type { ReactNode } from 'react';
import { IconArrowRight, IconArrowDown } from './Icons';

export function Hero({
  startHref = '/login',
  visual,
}: {
  startHref?: string;
  visual?: ReactNode;
}) {
  return (
    <section id="hero" className="lp-hero">
      <div
        className="lp-container"
        style={{ position: 'relative', paddingTop: 40, paddingBottom: 40, width: '100%', zIndex: 1 }}
      >
        <div className={visual ? 'lp-hero-grid' : ''}>
          <div className="lp-stack lp-gap-24" style={{ alignItems: 'flex-start', maxWidth: 820 }}>
            <span className="lp-chip">
              <span className="lp-dot live" />
              <span className="mono" style={{ fontSize: 11, color: 'var(--ax-text-secondary)' }}>
                Solana · USDC
              </span>
            </span>
            <h1
              style={{
                fontSize: 'clamp(52px, 7.2vw, 96px)',
                lineHeight: 0.98,
                letterSpacing: '-0.035em',
                fontWeight: 500,
              }}
            >
              Payouts
              <br />
              <span style={{ color: 'var(--ax-accent)' }}>with proof.</span>
            </h1>
            <p className="lp-lead" style={{ fontSize: 19, maxWidth: '52ch' }}>
              Stablecoin payouts, signed as a batch and matched on-chain. Every run ships with a
              verifiable proof.
            </p>
            <div className="lp-row lp-gap-12" style={{ flexWrap: 'wrap' }}>
              <a href={startHref} className="lp-btn lp-btn-primary">
                Get started <IconArrowRight />
              </a>
              <a href="#how" className="lp-btn lp-btn-ghost">
                How it works <IconArrowDown />
              </a>
            </div>
          </div>
          {visual ? <div className="lp-hero-visual-slot">{visual}</div> : null}
        </div>
      </div>
    </section>
  );
}
