import { IconArrowRight } from './Icons';

export function FinalCTA({ startHref = '/login' }: { startHref?: string }) {
  return (
    <section id="get-started" className="lp-sec-pad lp-cta">
      <div className="lp-container" style={{ position: 'relative', textAlign: 'center' }}>
        <div
          className="lp-stack lp-gap-24"
          style={{ alignItems: 'center', maxWidth: 780, margin: '0 auto' }}
        >
          <h2
            style={{
              fontSize: 'clamp(40px, 5.6vw, 72px)',
              lineHeight: 1.02,
              letterSpacing: '-0.035em',
              color: 'var(--ax-text)',
              fontWeight: 500,
            }}
          >
            Stop reconciling.
            <br />
            <span style={{ color: 'var(--ax-accent)' }}>Start shipping receipts.</span>
          </h2>
          <div className="lp-row lp-gap-12" style={{ justifyContent: 'center' }}>
            <a
              href={startHref}
              className="lp-btn lp-btn-primary"
              style={{ height: 44, padding: '0 20px', fontSize: 15 }}
            >
              Get started <IconArrowRight />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
