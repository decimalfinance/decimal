import { useEffect, useRef, useState } from 'react';
import { IconCheck } from './Icons';
import {
  CsvImportMockup,
  LifecycleRail,
  NextStepCard,
  ProductCard,
  ProofJsonMockup,
  ReviewMockup,
} from './ProductUI';

type Step = { id: string; title: string; desc: string };

const WF_STEPS: Step[] = [
  { id: 'intent', title: 'Create intent', desc: 'Drop in a CSV. Every row validated before it enters.' },
  { id: 'review', title: 'Review', desc: 'See parsed rows and totals. Confirm or go fix.' },
  { id: 'approve', title: 'Approve', desc: 'Trusted destinations auto-approve. Unknown ones wait.' },
  { id: 'execute', title: 'Execute', desc: 'One signature submits the whole batch on-chain.' },
  { id: 'prove', title: 'Export proof', desc: 'Signed JSON bundling intent, signature, settlement, and match.' },
];

function useScrollProgress(ref: React.RefObject<HTMLElement | null>) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const total = el.offsetHeight - vh;
      const scrolled = Math.max(0, Math.min(total, -r.top));
      setP(total > 0 ? scrolled / total : 0);
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [ref]);
  return p;
}

export function Workflow() {
  const ref = useRef<HTMLElement | null>(null);
  const p = useScrollProgress(ref);
  const n = WF_STEPS.length;
  const stageF = p * n;
  const stageI = Math.min(n - 1, Math.max(0, Math.floor(stageF)));

  return (
    <section id="how" ref={ref} className="lp-wf-sec">
      <div className="lp-wf-stage">
        <div className="lp-container lp-wf-inner">
          <div className="lp-wf-copy">
            <span className="eyebrow">How it works</span>
            <div className="lp-wf-steps">
              {WF_STEPS.map((s, i) => {
                const state = i === stageI ? 'active' : i < stageI ? 'done' : 'idle';
                const isLast = i === WF_STEPS.length - 1;
                return (
                  <div key={s.id} className={`lp-wf-item ${state}`}>
                    <div className="lp-wf-rail">
                      <span className="lp-wf-dot">
                        {state === 'done' ? <IconCheck size={7} /> : null}
                        {state === 'active' ? <span className="lp-wf-dot-pulse" /> : null}
                      </span>
                      {!isLast ? <span className="lp-wf-line" /> : null}
                    </div>
                    <div className="lp-wf-body">
                      <span className="lp-wf-num mono">{String(i + 1).padStart(2, '0')}</span>
                      <div className="lp-wf-item-title">{s.title}</div>
                      {state === 'active' ? (
                        <div className="lp-wf-item-desc">{s.desc}</div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="lp-wf-visual">
            <WorkflowVisual stage={stageI} />
          </div>
        </div>
        <div className="lp-wf-progress" aria-hidden="true">
          <div className="lp-wf-progress-track">
            <div className="lp-wf-progress-fill" style={{ height: `${Math.min(100, p * 100)}%` }} />
          </div>
        </div>
      </div>
    </section>
  );
}

function WorkflowVisual({ stage }: { stage: number }) {
  const panels = [
    <CsvImportMockup key="intent" />,
    <ReviewMockup key="review" />,
    <ProductCard key="approve" status={{ label: 'In approval', tone: 'approval' }}>
      <LifecycleRail active={2} pulse />
      <NextStepCard
        stage="Approvals"
        title="7 payments need approval"
        body="Policy routed these because the destinations are not in your trusted set. Approve the whole batch at once, or review individually."
        cta="Approve all (7)"
        ctaSecondary="Review individually →"
      />
    </ProductCard>,
    <ProductCard key="execute" status={{ label: 'Ready to sign', tone: 'ready' }}>
      <LifecycleRail active={3} pulse />
      <NextStepCard
        stage="Sign and execute"
        title="10,100.00 USDC across 7 payments"
        body="One signature submits the full batch. Each payment reconciles independently on-chain."
        cta="Sign and submit (7)"
      />
    </ProductCard>,
    <ProofJsonMockup key="prove" />,
  ];

  return (
    <div className="lp-wf-panels">
      {panels.map((p, i) => (
        <div
          key={i}
          className={`lp-wf-panel${i === stage ? ' on' : ''}`}
          aria-hidden={i !== stage}
        >
          {p}
        </div>
      ))}
    </div>
  );
}
