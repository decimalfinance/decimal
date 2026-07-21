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
              fontSize: 'clamp(32px, 4vw, 52px)',
              lineHeight: 1.06,
              letterSpacing: '-0.025em',
              color: 'var(--ax-text)',
              fontWeight: 500,
            }}
          >
            Ship your first
            <br />
            <span style={{ color: 'var(--ax-accent)' }}>payout.</span>
          </h2>
          <p
            className="lp-lead"
            style={{ fontSize: 19, maxWidth: '52ch', textAlign: 'center' }}
          >
            Policy, signature, settlement, proof — in one deterministic run.
          </p>
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
