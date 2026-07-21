import { useEffect, useState, type ReactElement } from 'react';
import { IconDownload } from './Icons';

function PolicyVisual() {
  return (
    <div className="lp-feat-rules">
      <div className="lp-feat-rule">
        <span>Trusted destinations auto-approve</span>
        <span className="lp-feat-rule-val lp-feat-rule-on">ON</span>
      </div>
      <div className="lp-feat-rule">
        <span>External payment threshold</span>
        <span className="lp-feat-rule-val mono">1,000 USDC</span>
      </div>
      <div className="lp-feat-rule">
        <span>Internal payment threshold</span>
        <span className="lp-feat-rule-val mono">10,000 USDC</span>
      </div>
      <div className="lp-feat-rule">
        <span>Approval routing</span>
        <span className="lp-feat-rule-val">Per-payment</span>
      </div>
    </div>
  );
}

function BatchVisual() {
  const rows = [
    { inv: 'INV-1001', amt: '1,000.00' },
    { inv: 'INV-1002', amt: '1,500.00' },
    { inv: 'INV-1003', amt: '750.00' },
    { inv: 'INV-1004', amt: '2,200.00' },
    { inv: 'INV-1005', amt: '500.00' },
  ];
  return (
    <div className="lp-feat-sig">
      {rows.map((r) => (
        <div key={r.inv} className="lp-feat-sig-row">
          <span className="mono">{r.inv}</span>
          <span className="mono">{r.amt} USDC</span>
        </div>
      ))}
      <div className="lp-feat-sig-seal">
        <span className="lp-feat-sig-dot" />
        <span>one signature</span>
        <span className="mono lp-feat-sig-kind">ed25519</span>
      </div>
    </div>
  );
}

function MatchVisual() {
  const pairs = [
    { amount: '1,000.00', dest: '8cZ65…h43Zx' },
    { amount: '1,500.00', dest: '33yL6…m1BnP' },
  ];
  return (
    <div className="lp-feat-match">
      {pairs.map((p) => (
        <div key={p.dest} className="lp-feat-match-pair">
          <div className="lp-feat-match-row">
            <span className="lp-feat-match-label mono">INTENT</span>
            <span className="mono">{p.amount} USDC → {p.dest}</span>
          </div>
          <div className="lp-feat-match-line" aria-hidden="true" />
          <div className="lp-feat-match-row lp-feat-match-done">
            <span className="lp-feat-match-label mono">TRANSFER</span>
            <span className="mono">{p.amount} USDC → {p.dest}</span>
            <svg
              className="lp-feat-match-check"
              viewBox="0 0 10 10"
              width="10"
              height="10"
              aria-hidden="true"
            >
              <path
                d="M1.5 5.2 L4 7.5 L8.5 2.5"
                stroke="var(--ax-accent)"
                strokeWidth="1.6"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProofVisual() {
  return (
    <div className="lp-feat-proof">
      <div className="lp-feat-proof-topbar">
        <span className="lp-feat-proof-label mono">Payment run proof</span>
        <span className="lp-feat-proof-download">
          <IconDownload size={11} />
          <span>JSON</span>
        </span>
      </div>
      <div className="lp-feat-digest">
        <div className="lp-feat-digest-label mono">Proof digest · sha-256 canonical</div>
        <div className="lp-feat-digest-value mono">
          6e4f15f3·168546ec·7ea80328·eda76d82
          <br />
          5c6b39ea·8ca2e8f8·70842951·709ebf13
        </div>
      </div>
      <div className="lp-feat-proof-meta mono">
        payouts · 7 orders · 10,100.00 USDC · settled
      </div>
    </div>
  );
}

type Feature = {
  id: string;
  title: string;
  desc: string;
  Visual: () => ReactElement;
};

const FEATURES: Feature[] = [
  {
    id: 'policy',
    title: 'Policy before signature.',
    desc: 'Set rules once. Trusted destinations auto-clear, unknown ones wait for a human. Configure thresholds, trust, and internal-vs-external routing per organization.',
    Visual: PolicyVisual,
  },
  {
    id: 'batch',
    title: 'One signature, whole batch.',
    desc: 'Fifty payments. One atomic Solana transaction. One hardware-wallet confirmation. Each payment still reconciles independently on-chain.',
    Visual: BatchVisual,
  },
  {
    id: 'match',
    title: 'Matched on-chain. Never silent.',
    desc: 'Decimal observes USDC transfers in real time and matches every intent to its on-chain transfer. Amount variance, partials, and overfills surface as exceptions.',
    Visual: MatchVisual,
  },
  {
    id: 'proof',
    title: 'Deterministic proof, forever.',
    desc: 'Every run ships as a SHA-256-stamped JSON packet. Recompute the canonical digest a year from now — same inputs, same hash. Verifiable without Decimal running.',
    Visual: ProofVisual,
  },
];

const AUTO_MS = 6000;

export function Features() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const total = FEATURES.length;

  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      setActive((a) => (a + 1) % total);
    }, AUTO_MS);
    return () => window.clearInterval(id);
  }, [paused, active, total]);

  return (
    <section id="features" className="lp-features">
      <div className="lp-container">
        <span className="eyebrow lp-feat-eyebrow">Features</span>

        <div
          className="lp-feat-carousel"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
          role="region"
          aria-roledescription="carousel"
          aria-label="Product features"
        >
          <div className="lp-feat-stage">
            {FEATURES.map((f, i) => {
              const Visual = f.Visual;
              return (
                <div
                  key={f.id}
                  className={`lp-feat-panel${i === active ? ' on' : ''}`}
                  aria-hidden={i !== active}
                >
                  <div className="lp-feat-copy">
                    <span className="lp-feat-num mono">{String(i + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}</span>
                    <h3 className="lp-feat-title">{f.title}</h3>
                    <p className="lp-feat-desc">{f.desc}</p>
                    <div className="lp-feat-controls" role="tablist" aria-label="Feature navigation">
                      {FEATURES.map((f2, j) => (
                        <button
                          key={f2.id}
                          type="button"
                          role="tab"
                          className={`lp-feat-dot${j === active ? ' on' : ''}`}
                          onClick={() => setActive(j)}
                          aria-selected={j === active}
                          aria-label={`Feature ${j + 1} of ${total}: ${f2.title}`}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="lp-feat-visual">
                    <Visual />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
