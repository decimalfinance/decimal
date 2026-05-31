import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import '../styles/landing.css';

const ACCENT = '#e6005c';

const HERO = {
  eyebrow: 'Decimal — finance for global teams',
  line1: 'Reducing',
  line1Tail: 'friction',
  line2: 'for businesses paying',
  line2Tail: 'globally.',
  lede:
    'AI-powered cross-border AP: vendors paid in their currency, your team controlling every approval and every limit.',
} as const;

export function LandingPage() {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--pink', ACCENT);
    root.dataset.density = 'regular';
    root.dataset.marquee = 'dark';
    root.dataset.tinted = 'on';
    root.removeAttribute('data-theme');
    return () => {
      delete root.dataset.density;
      delete root.dataset.marquee;
      delete root.dataset.tinted;
    };
  }, []);

  const googleHref = api.getGoogleOAuthStartUrl('/setup');

  return (
    <>
      <Nav googleHref={googleHref} />
      <Hero googleHref={googleHref} />
      <PaymentsSection />
      <SpendingLimitsSection />
      <HowItWorks />
      <ClosingCTA googleHref={googleHref} />
      <Foot />
    </>
  );
}

/* ───────────────── Nav ───────────────── */

function Nav({ googleHref }: { googleHref: string }) {
  return (
    <header className="l-nav">
      <div className="l-nav-inner">
        <Link to="/" className="l-brand">
          <img src="/decimal-logo.png" alt="Decimal" />
          <span>Decimal</span>
        </Link>
        <nav className="l-nav-links">
          <a href="#payments">Payments</a>
          <a href="#limits">Spending limits</a>
          <a href="#how">How it works</a>
        </nav>
        <div className="l-nav-cta">
          <Link to="/login" className="l-signin">Sign in</Link>
          <a className="l-btn l-btn-primary l-btn-sm" href={googleHref}>
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}

/* ───────────────── Hero ───────────────── */

function Hero({ googleHref }: { googleHref: string }) {
  return (
    <section className="hero">
      <div className="container">
        <div className="hero-grid">
          <div className="hero-headline">
            <div className="eyebrow">
              <span className="dot" />
              {HERO.eyebrow}
            </div>

            <h1 className="display h-xxl">
              <span className="line">
                {HERO.line1} <span className="accent pink">{HERO.line1Tail}</span>
              </span>
              <span className="line">
                {HERO.line2} <span className="accent squiggle">{HERO.line2Tail}</span>
              </span>
            </h1>

            <p className="lede">{HERO.lede}</p>

            <div className="hero-actions">
              <a className="gbtn" href={googleHref} style={{ fontFamily: '"Bricolage Grotesque"' }}>
                <span className="g">
                  <GoogleG />
                </span>
                Continue with Google
              </a>
              <a className="btn btn-ghost" href="#how">
                See the product →
              </a>
            </div>
          </div>

          <div className="hero-visual">
            <HeroOrb />
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroOrb() {
  return (
    <div className="orb-stage">
      <div className="orb-glow" aria-hidden="true" />
      <img src="/decimal-logo.png" alt="" className="orb-img" style={{ objectFit: 'contain' }} />
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="11" height="11" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7C13.42 14.62 18.27 10.75 24 10.75z"
      />
    </svg>
  );
}

/* ───────────────── Payments section ───────────────── */
// Static rendering of the Payments product UI inside a browser frame.
// Faithful to the real /payments page (heading + 4 metrics + table)
// but scoped to .lp-pay so .dec styles don't leak in. Per the design
// handoff we'd ideally scale-mount the real product UI; for a marketing
// page a clean static composition reads better and stays maintainable.

function PaymentsSection() {
  return (
    <section id="payments" className="l-section">
      <div className="l-wrap">
        <div className="l-prod-head">
          <div className="l-kicker">PAYMENTS</div>
          <h2>Run payments across the globe.</h2>
          <p>Pay any vendor, in any currency, from one place.</p>
        </div>
        <div className="l-browser">
          <div className="l-browser-bar">
            <span className="l-dot" />
            <span className="l-dot" />
            <span className="l-dot" />
            <span className="l-url">app.decimal.finance/payments</span>
          </div>
          <div className="l-screen">
            <div className="lp-pay">
              <PaymentsSidebar />
              <div className="lp-pay-main">
              {/* Page head — eyebrow + title + 3 toolbar buttons */}
              <div className="hd">
                <div>
                  <div className="eyebrow">PAYMENTS</div>
                  <h3>All payments</h3>
                  <p>Every payment and batch payout in this organization.</p>
                </div>
                <div className="hd-actions">
                  <button type="button" className="pay-btn secondary"><PlusMini />Upload invoice</button>
                  <button type="button" className="pay-btn secondary"><PlusMini />Import CSV</button>
                  <button type="button" className="pay-btn">+ New payment</button>
                </div>
              </div>

              {/* 4 metric tiles — third one is the alert variant */}
              <div className="met">
                <div className="m">
                  <div className="ml">Awaiting your approval</div>
                  <div className="mv">3</div>
                  <div className="ms">payments</div>
                </div>
                <div className="m">
                  <div className="ml">Auto-paid this month</div>
                  <div className="mv">7</div>
                  <div className="ms">18,420.00 USDC</div>
                </div>
                <div className="m alert">
                  <div className="ml">Needs review</div>
                  <div className="mv">2</div>
                  <div className="ms">vendors unreviewed</div>
                </div>
                <div className="m">
                  <div className="ml">Settled this month</div>
                  <div className="mv">12</div>
                  <div className="ms">42,176.67 USDC</div>
                </div>
              </div>

              {/* Filter bar — tabs + search + treasury select */}
              <div className="fb">
                <div className="tabs">
                  {[
                    ['All', 10, true],
                    ['Active', 5, false],
                    ['Settled', 3, false],
                    ['Needs review', 2, false],
                  ].map(([label, count, on]) => (
                    <button
                      type="button"
                      key={String(label)}
                      className={`tab${on ? ' on' : ''}`}
                    >
                      {label}<span className="tab-count">{count}</span>
                    </button>
                  ))}
                </div>
                <div className="fb-right">
                  <div className="fb-search">
                    <SearchMini />
                    <input type="text" placeholder="Vendor, address, invoice #" readOnly />
                  </div>
                  <div className="fb-select">
                    All treasuries
                    <ChevronMini />
                  </div>
                </div>
              </div>

              {/* 10-row table */}
              <div className="pt">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '22%' }}>Vendor</th>
                      <th style={{ width: '14%' }}>Source</th>
                      <th className="num" style={{ width: '15%' }}>Amount</th>
                      <th style={{ width: '14%' }}>Origin</th>
                      <th style={{ width: '20%' }}>Status</th>
                      <th style={{ width: 28 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {PAYMENT_ROWS.map((r, i) => (
                      <tr key={i}>
                        <td><span className="vn">{r.vendor}</span></td>
                        <td><span className="so"><TreasuryMini />{r.source}</span></td>
                        <td className="num">{r.amount} <span style={{ color: '#9D9893' }}>USDC</span></td>
                        <td><span className="po">{r.origin}</span></td>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span className={`pl s-${r.tone}`}><span className="d" />{r.status}</span>
                            {r.sl ? <span className="pl-sl"><BoltMini />SL</span> : null}
                          </span>
                        </td>
                        <td><span className="ra">›</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="tf">
                  <span className="tf-count">Showing 10 of 48 payments</span>
                  <div className="pager">
                    <button type="button" aria-label="Previous">‹</button>
                    <button type="button" className="on">1</button>
                    <button type="button">2</button>
                    <button type="button">3</button>
                    <button type="button">4</button>
                    <button type="button">5</button>
                    <button type="button" aria-label="Next">›</button>
                  </div>
                </div>
              </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Static sidebar mirroring the real app shell — Decimal wordmark, org
// chip, three nav groups, user chip. Read-only; only Payments is
// shown as the active item.
function PaymentsSidebar() {
  return (
    <aside className="lp-pay-sb">
      <div className="sb-brand">
        <span className="sb-logo">D</span>
        <span className="sb-name">Decimal</span>
      </div>
      <div className="sb-org">
        <span className="sb-org-init">NV</span>
        <span className="sb-org-name">Northvale Labs</span>
        <ChevronMini />
      </div>
      <div className="sb-nav">
        <div className="sb-group">OPERATIONS</div>
        <SbItem icon={<GridMini />} label="Overview" />
        <SbItem icon={<PaymentsIco />} label="Payments" active count="3" />
        <SbItem icon={<CollectionsIco />} label="Collections" />
        <div className="sb-group">REGISTRY</div>
        <SbItem icon={<TreasuryMini />} label="Treasury accounts" />
        <SbItem icon={<MembersIco />} label="Members" />
        <SbItem icon={<AddressIco />} label="Address book" count="2" />
        <div className="sb-group">GOVERNANCE</div>
        <SbItem icon={<ProposalsIco />} label="Proposals" />
        <SbItem icon={<ShieldIco />} label="Spending limits" />
      </div>
      <div className="sb-user">
        <span className="sb-user-av">JK</span>
        <div className="sb-user-col">
          <span className="sb-user-nm">Jordan Keil</span>
          <span className="sb-user-em">jordan@northvale.co</span>
        </div>
        <ChevronMini />
      </div>
    </aside>
  );
}

function SbItem({
  icon,
  label,
  active,
  count,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  count?: string;
}) {
  return (
    <div className={`sb-item${active ? ' on' : ''}`}>
      {active ? <span className="sb-bar" /> : null}
      <span className="sb-ico">{icon}</span>
      <span className="sb-lab">{label}</span>
      {count ? <span className="sb-count">{count}</span> : null}
    </div>
  );
}

function GridMini() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function PaymentsIco() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 9.5h19" />
    </svg>
  );
}
function CollectionsIco() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v18M5 8l7-5 7 5M5 8v8l7 5 7-5V8" />
    </svg>
  );
}
function MembersIco() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5 5 0 0 0-2-4" />
    </svg>
  );
}
function AddressIco() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}
function ProposalsIco() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 5h11M9 12h11M9 19h11M4.5 5h.01M4.5 12h.01M4.5 19h.01" />
    </svg>
  );
}
function ShieldIco() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

// Mock data lifted from design_handoff_landing/decimal/pages-shell.jsx so
// the screenshot matches the design exactly — same vendors, amounts,
// origins, and statuses.
const PAYMENT_ROWS: Array<{
  vendor: string;
  source: string;
  amount: string;
  origin: string;
  status: string;
  tone: 'ok' | 'wa' | 'in' | 'ne' | 'da';
  sl: boolean;
}> = [
  { vendor: 'Bangalore Ops Pvt Ltd', source: 'Operating', amount: '2,176.67', origin: 'Single', status: 'Signing', tone: 'wa', sl: false },
  { vendor: 'Lumen Cloud Inc', source: 'Operating', amount: '940.00', origin: 'Apr cloud', status: 'Settled', tone: 'ok', sl: true },
  { vendor: 'Río Diseño SA', source: 'Operating', amount: '3,500.00', origin: 'Single', status: 'Received', tone: 'ne', sl: false },
  { vendor: 'Praxis Legal LLP', source: 'Payroll reserve', amount: '1,250.00', origin: 'Single', status: 'Exception', tone: 'da', sl: false },
  { vendor: 'Northwind Hosting', source: 'Operating', amount: '610.40', origin: 'Apr cloud', status: 'Settled', tone: 'ok', sl: true },
  { vendor: 'Meridian Translations', source: 'Operating', amount: '480.00', origin: 'Single', status: 'Reviewed', tone: 'in', sl: false },
  { vendor: 'Cobalt Studio', source: 'Operating', amount: '5,200.00', origin: 'Single', status: 'Send', tone: 'in', sl: false },
  { vendor: 'Atlas Freight Co', source: 'Operating', amount: '1,845.20', origin: 'Q1 logistics', status: 'Settled', tone: 'ok', sl: false },
  { vendor: 'Verde Energy', source: 'Operating', amount: '320.00', origin: 'Apr cloud', status: 'Settled', tone: 'ok', sl: true },
  { vendor: 'Sundial Media', source: 'Payroll reserve', amount: '2,750.00', origin: 'Single', status: 'Cancelled', tone: 'ne', sl: false },
];

function PlusMini() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function SearchMini() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
function ChevronMini() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function BoltMini() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
    </svg>
  );
}

/* ───────────────── Spending limits section ───────────────── */

function SpendingLimitsSection() {
  return (
    <section id="limits" className="l-section">
      <div className="l-wrap">
        <div className="l-prod-head">
          <div className="l-kicker">SPENDING LIMITS</div>
          <h2>Automate recurring payments.</h2>
          <p>Set spending limits and Decimal handles the process for you.</p>
        </div>
        <div className="l-limit-grid">
          <div className="l-vig">
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '100%', gap: 18 }}>
              <div className="l-vig-title">
                <span className="vt-name">Cloud Bills</span>
                <span className="pill-ok"><span className="d" />Active</span>
              </div>
              <div className="cap-vert">
                <div className="cv-lead">
                  <span className="cs-lab">Spent this month</span>
                  <span className="cs-amt">2,940.00<small>USDC</small></span>
                  <span className="cs-of">of 5,000.00 monthly limit</span>
                </div>
                <div className="cap-meter"><span className="cm-fill" style={{ width: '59%' }} /></div>
                <div className="cv-rows">
                  <div className="cv-row"><span className="cv-k">Remaining</span><span className="cv-v">2,060.00 USDC</span></div>
                  <div className="cv-row"><span className="cv-k">Cap used</span><span className="cv-v">59%</span></div>
                  <div className="cv-row"><span className="cv-k">Per-vendor cap</span><span className="cv-v">2,000.00</span></div>
                  <div className="cv-row"><span className="cv-k">Resets</span><span className="cv-v">May 1</span></div>
                </div>
              </div>
              <div className="l-covers">
                <div className="l-covers-head">
                  <span className="lbl">Covered vendors</span>
                  <span className="l-covers-cap">cap 2,000 each</span>
                </div>
                <div className="l-cover-chips">
                  {['Vercel', 'AWS', 'Cloudflare', 'Datadog', 'GitHub', 'Twilio'].map((c) => (
                    <span className="l-chip" key={c}>{c}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="l-vig">
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '100%', gap: 12 }}>
              <div>
                <div className="l-autopay-label">
                  <BoltMini />AUTO-PAID THIS MONTH
                </div>
                <div className="l-autopay">
                  {AUTOPAY_ROWS.map((r) => (
                    <div className="l-autopay-row" key={r.name}>
                      <span className="ap-v">{r.name}</span>
                      <span className="ap-right">
                        <span className="pill-sl"><BoltMini />SL</span>
                        <span className="ap-amt">{r.amt}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="l-autopay-foot">
                <BoltMini />
                Paid automatically — <b>no team vote needed.</b>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const AUTOPAY_ROWS = [
  { name: 'Vercel', amt: '940.00' },
  { name: 'Amazon Web Services', amt: '610.40' },
  { name: 'Cloudflare', amt: '320.00' },
  { name: 'Datadog', amt: '520.00' },
  { name: 'GitHub', amt: '360.00' },
  { name: 'Twilio', amt: '189.60' },
];

/* ───────────────── How it works (3 animated cards) ───────────────── */

function HowItWorks() {
  const [step, setStep] = useState(0); // 0..2 = active card

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setStep(2);
      return;
    }
    // Loop: card 1 (4.5s) → card 2 (5.5s) → card 3 (4s) → 1.5s pause → repeat
    const order = [0, 1, 2];
    const durations = [4500, 5500, 4000, 1500];
    let i = 0;
    let timeoutId: number | null = null;
    function tick() {
      const idx = i % order.length;
      setStep(order[idx]!);
      timeoutId = window.setTimeout(tick, durations[idx]!);
      i += 1;
    }
    tick();
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, []);

  return (
    <section id="how" className="l-section">
      <div className="l-wrap">
        <div className="l-prod-head">
          <div className="l-kicker">HOW IT WORKS</div>
          <h2>From your inbox to your vendor's bank.</h2>
        </div>
        <div className="l-how-grid">
          <Card1 active={step === 0} />
          <Card2 active={step === 1} />
          <Card3 active={step === 2} />
        </div>
      </div>
    </section>
  );
}

function CardShell({
  active,
  step,
  title,
  dim,
  children,
  panelClass,
}: {
  active: boolean;
  step: string;
  title: string;
  dim?: string;
  children: ReactNode;
  panelClass?: string;
}) {
  return (
    <div className={`l-how-card${active ? ' is-active' : ''}`}>
      <div className="l-how-head">
        <div className="l-how-step">{step}</div>
        <div className="l-how-title">
          {title}
          {dim ? <> <span className="dim">{dim}</span></> : null}
        </div>
      </div>
      <div className={`l-how-panel${panelClass ? ` ${panelClass}` : ''}`}>{children}</div>
    </div>
  );
}

function Card1({ active }: { active: boolean }) {
  // Three internal phases mapped to a single elapsed-time signal so the
  // sequence (upload → scan → extracted fields) restarts every time the
  // card becomes the active one.
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'scanning' | 'done'>('idle');
  const [revealCount, setRevealCount] = useState(0); // 0..3 fields shown
  useEffect(() => {
    if (!active) {
      setPhase('idle');
      setRevealCount(0);
      return;
    }
    setPhase('uploading');
    setRevealCount(0);
    const t1 = window.setTimeout(() => setPhase('scanning'), 1200);
    const t2 = window.setTimeout(() => setPhase('done'), 2200);
    const t3 = window.setTimeout(() => setRevealCount(1), 2600);
    const t4 = window.setTimeout(() => setRevealCount(2), 3000);
    const t5 = window.setTimeout(() => setRevealCount(3), 3400);
    return () => [t1, t2, t3, t4, t5].forEach((t) => window.clearTimeout(t));
  }, [active]);
  return (
    <CardShell active={active} step="01" title="Upload an invoice." dim="The agent reads it." panelClass="c1">
      <div className={`c1-doczone${phase === 'scanning' ? ' scanning' : ''}${phase === 'done' ? ' done' : ''}`}>
        <div className="c1-doc">
          <div className="c1-scan" />
          <div className="dl" />
          <div className="dl s" />
          <div className="dl" />
          <div className="dl s" />
          <div className="dl" />
        </div>
        <div className="c1-upmeta">
          <div className="c1-upname">invoice-2048.pdf</div>
          <div className="c1-upcap">
            {phase === 'uploading' ? 'Uploading…' : phase === 'scanning' ? 'Reading invoice…' : phase === 'done' || revealCount > 0 ? 'Extracted ✓' : '1.2 MB'}
          </div>
          <div className="c1-prog">
            <div className="c1-prog-fill" style={{ width: phase === 'uploading' ? '60%' : phase === 'scanning' || phase === 'done' ? '100%' : '0%' }} />
          </div>
        </div>
      </div>

      <div className={`c1-exlabel${revealCount > 0 ? ' on' : ''}`}>
        <BoltMini />Extracted by agent
      </div>
      <div className="c1-fields">
        {[
          { k: 'Vendor', v: 'Meridian Studio', mono: false },
          { k: 'Amount', v: '2,176.67 USDC', mono: true },
          { k: 'Due date', v: 'Apr 30, 2026', mono: true },
        ].map((f, i) => (
          <div key={f.k} className={`c1-row${revealCount > i ? ' on' : ''}`}>
            <span className="c1-k">{f.k}</span>
            <span className={`c1-val${f.mono ? ' mono' : ''}`}>
              {f.v}
              <span className="c1-chk"><CheckMini /></span>
            </span>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

function Card2({ active }: { active: boolean }) {
  const [voted, setVoted] = useState(0); // 0..2 (JK, then AO)
  const [exec, setExec] = useState<'idle' | 'ready' | 'pressed' | 'done'>('idle');
  useEffect(() => {
    if (!active) {
      setVoted(0);
      setExec('idle');
      return;
    }
    const t1 = window.setTimeout(() => setVoted(1), 900);
    const t2 = window.setTimeout(() => setVoted(2), 1900);
    const t3 = window.setTimeout(() => setExec('ready'), 2700);
    const t4 = window.setTimeout(() => setExec('pressed'), 3700);
    const t5 = window.setTimeout(() => setExec('done'), 4100);
    return () => [t1, t2, t3, t4, t5].forEach((t) => window.clearTimeout(t));
  }, [active]);

  const members = [
    { init: 'JK', name: 'Jordan Keil', voted: voted >= 1 },
    { init: 'AO', name: 'Amara Osei', voted: voted >= 2 },
    { init: 'DP', name: 'Devin Park', voted: false },
  ];
  const meterPct = voted === 0 ? 0 : voted === 1 ? 50 : 100;
  return (
    <CardShell active={active} step="02" title="Your team signs off." panelClass="c2">
      <div className="c2-head">
        <span className="c2-ttl">APPROVALS</span>
        <span className="c2-count">{voted} of 2</span>
      </div>
      <div className="c2-list">
        {members.map((m) => (
          <div key={m.init} className={`c2-row${m.voted ? ' voted' : ''}`}>
            <span className="c2-av">{m.init}</span>
            <span className="c2-nm">{m.name}</span>
            <span className="c2-vt">{m.voted ? 'Approved' : 'Pending'}</span>
            <span className="c2-vstate">
              <span className="pend" />
              <span className="pop"><CheckMini /></span>
            </span>
          </div>
        ))}
      </div>
      <div className="c2-meter"><span className="c2-meter-fill" style={{ width: `${meterPct}%` }} /></div>
      <div className="c2-meta">
        {voted < 2
          ? <>2 of 3 signers required</>
          : <><b>Threshold met</b> — ready to execute</>}
      </div>
      <button type="button" className={`c2-exec${exec === 'ready' ? ' ready' : ''}${exec === 'pressed' ? ' pressed' : ''}${exec === 'done' ? ' done' : ''}`}>
        <BoltMini />
        {exec === 'idle' ? 'Execute' : exec === 'ready' ? 'Execute' : exec === 'pressed' ? 'Executing…' : 'Executed ✓'}
      </button>
    </CardShell>
  );
}

function Card3({ active }: { active: boolean }) {
  const [running, setRunning] = useState(false);
  const [spent, setSpent] = useState(false);
  const [paid, setPaid] = useState(false);
  useEffect(() => {
    if (!active) {
      setRunning(false);
      setSpent(false);
      setPaid(false);
      return;
    }
    const t1 = window.setTimeout(() => setRunning(true), 400);
    const t2 = window.setTimeout(() => setSpent(true), 1400);
    const t3 = window.setTimeout(() => setPaid(true), 2000);
    return () => [t1, t2, t3].forEach((t) => window.clearTimeout(t));
  }, [active]);
  return (
    <CardShell active={active} step="03" title="The vendor gets paid." panelClass="c3">
      <div className={`c3-node trez${spent ? ' spent' : ''}`}>
        <span className="c3-ico"><TreasuryMini /></span>
        <div className="c3-lab">
          <div className="c3-nt">Operating treasury</div>
          <div className="c3-ns">vault · USDC</div>
        </div>
        <div className="c3-bal">{spent ? '126,263.51' : '128,440.18'}</div>
      </div>
      <div className={`c3-track${running ? ' run' : ''}`}>
        <span className="c3-line" />
        <span className="c3-coin"><DownArrowMini /></span>
        <span className="c3-amt">−2,176.67</span>
      </div>
      <div className={`c3-node bank${paid ? ' paid' : ''}`}>
        <span className="c3-ico"><BankMini /></span>
        <div className="c3-lab">
          <div className="c3-nt">Vendor bank account</div>
          <div className="c3-ns">Meridian Studio</div>
        </div>
        <div className="c3-recv">+2,176.67</div>
      </div>
    </CardShell>
  );
}

function CheckMini() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5 10 17 19 6.5" />
    </svg>
  );
}
function TreasuryMini() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9.5 12 4l9 5.5M5 10v8M19 10v8M9 10v8M15 10v8M3.5 20.5h17" />
    </svg>
  );
}
function BankMini() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="9" width="18" height="11" rx="1" />
      <path d="M3 9 12 3l9 6M7 20v-7M12 20v-7M17 20v-7" />
    </svg>
  );
}
function DownArrowMini() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  );
}

/* ───────────────── Closing CTA + Footer ───────────────── */

function ClosingCTA({ googleHref }: { googleHref: string }) {
  return (
    <section className="l-cta">
      <div className="l-wrap">
        <img className="l-cta-mark" src="/decimal-logo.png" alt="" />
        <h2>Run your finance on Decimal.</h2>
        <p>Replace QuickBooks Bill Pay and wires with one surface. Protected by code, controlled by your team.</p>
        <div className="l-cta-actions">
          <a className="l-cta-g" href={googleHref}>
            <span className="gw"><GoogleG /></span>
            Continue with Google
          </a>
          <Link to="/login" className="l-cta-ghost">Sign in</Link>
        </div>
      </div>
    </section>
  );
}

function Foot() {
  return (
    <footer className="l-footer l-footer-min">
      <div className="l-wrap l-foot-row">
        <Link to="/" className="l-brand">
          <img src="/decimal-logo.png" alt="Decimal" />
          <span>Decimal</span>
        </Link>
        <span className="fb-copy">© {new Date().getFullYear()} Decimal</span>
      </div>
    </footer>
  );
}
