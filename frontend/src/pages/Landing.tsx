import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import '../styles/landing.css';

const ACCENT = '#e6005c';

const HERO = {
  eyebrow: 'The finance operator for modern companies',
  line1: 'Finance,',
  line1Tail: 'automated.',
  line2: 'Treasury,',
  line2Tail: 'controlled.',
  lede:
    'Decimal turns the documents your finance team already handles into ready-to-sign payouts on a multisig you control. From document to vendor bank account — without the keying, the wire fees, or the bank cutoffs.',
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
      <Marquee />
      <Pillars />
      <HowItWorks />
      <BuiltOn />
      <WhyDecimal />
      <FAQ />
      <FootCTA googleHref={googleHref} />
      <Foot />
    </>
  );
}

/* ───────────────── Nav ───────────────── */

function Nav({ googleHref }: { googleHref: string }) {
  return (
    <header className="nav">
      <div className="container nav-inner">
        <Link to="/" className="nav-brand">
          <img src="/decimal-logo.png" alt="Decimal" />
          <span>Decimal</span>
        </Link>
        <nav className="nav-links">
          <a href="#how">How it works</a>
          <a href="#built">Built on</a>
          <a href="#why">Why Decimal</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav-cta">
          <Link to="/login" style={{ color: 'var(--ink-2)', textDecoration: 'none', fontSize: 14 }}>
            Sign in
          </Link>
          <a className="btn btn-primary btn-sm" href={googleHref}>
            Continue with Google →
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
                {HERO.line1} <span className="pink">{HERO.line1Tail}</span>
              </span>
              <span className="line">
                {HERO.line2} {HERO.line2Tail}
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

/* ───────────────── Marquee ───────────────── */

function Marquee() {
  const items = [
    { num: '~412 ms', lab: 'Settlement on Solana' },
    { num: '$0.0008', lab: 'Avg fee per payout' },
    { num: 'm-of-n', lab: 'Threshold · you choose' },
    { num: '100%', lab: 'Self-custodial' },
    { num: 'USDC', lab: 'One dollar, always' },
    { num: 'Squads', lab: 'Multisig program' },
    { num: 'Privy', lab: 'Embedded wallets' },
  ];
  const loop = [...items, ...items, ...items];
  return (
    <div className="marquee stat-marquee">
      <div className="marquee-track">
        {loop.map((it, i) => (
          <span className="stat-item" key={i}>
            <span className="sm-num">{it.num}</span>
            <span className="sm-lab">{it.lab}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ───────────────── Pillars ───────────────── */

function Pillars() {
  return (
    <section className="section pillars-section is-pink">
      <div className="container">
        <div className="pillars">
          <div className="pillar">
            <div className="pillar-num">01 / Automation</div>
            <h3>The product that handles the busywork.</h3>
            <p>
              Forward a document, paste a payment request, drop a CSV of vendors. Decimal extracts
              amounts, recipients, due dates, and the right approver — then queues each payout for
              sign-off.
            </p>
            <p>
              No more re-keying numbers from PDFs. No more{' '}
              <em style={{ fontStyle: 'normal' }}>"is this the right account?"</em> Slack threads.
            </p>
          </div>
          <div className="pillar">
            <div className="pillar-num">02 / Treasury</div>
            <h3>A treasury you actually own.</h3>
            <p>
              Decimal accounts are Squads multisigs on Solana — the same program securing the
              largest treasuries in the ecosystem. You set the signers. You set the threshold. We
              never touch your keys.
            </p>
            <p>
              Decimal <em style={{ fontStyle: 'normal' }}>proposes</em>. Your multisig{' '}
              <em style={{ fontStyle: 'normal' }}>disposes</em>.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────── How it works (scroll-driven) ───────────────── */

const HOW_STEPS = [
  {
    n: '01',
    h: 'Invoice in.',
    p: 'Forward a document, paste a payment request, or drop a vendor CSV. Decimal watches the inbox so your AP team doesn’t have to.',
  },
  {
    n: '02',
    h: 'Agent drafts.',
    p: 'The Decimal agent extracts amount, recipient, due date, and memo — then drafts a payout routed to the right multisig.',
  },
  {
    n: '03',
    h: 'Multisig votes.',
    p: 'The proposal lands in your Squads multisig. Signers approve from anywhere. We never touch your keys.',
  },
  {
    n: '04',
    h: 'Vendor paid.',
    p: 'USDC arrives in seconds. Or it converts to a deposit in your vendor’s local bank. Either way — a clean confirmation, no follow-up emails.',
  },
] as const;

function HowItWorks() {
  const trackRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const el = trackRef.current;
      if (!el) return;
      if (window.innerWidth < 1080) {
        setActiveIdx(0);
        return;
      }
      const rect = el.getBoundingClientRect();
      const total = el.offsetHeight - window.innerHeight;
      if (total <= 0) {
        setActiveIdx(0);
        return;
      }
      const scrolled = Math.max(0, Math.min(total, -rect.top));
      const progress = scrolled / total;
      const idx = Math.min(
        HOW_STEPS.length - 1,
        Math.floor(progress * HOW_STEPS.length),
      );
      setActiveIdx(idx);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <section className="section how-section" id="how">
      <div className="container">
        <div className="section-head">
          <div className="eyebrow">
            <span className="dot" />
            How it works
          </div>
          <h2>From document to settlement, in four steps.</h2>
          <p>
            Decimal does the keying. You do the deciding. Scroll through one payout — invoice in
            your inbox to dollars in your vendor's bank.
          </p>
        </div>
      </div>
      <div className="how-pin-track" ref={trackRef}>
        <div className="how-pinned">
          <div className="container">
            <div className="how-grid how-grid-scroll">
              <div className="steps-scroll">
                {HOW_STEPS.map((s, i) => (
                  <div
                    key={s.n}
                    className={`step ${activeIdx === i ? 'active' : 'dim'}`}
                  >
                    <div className="step-n">{s.n}</div>
                    <div>
                      <h4>{s.h}</h4>
                      <p>{s.p}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="how-sticky">
                <PaymentDemo controlledStep={activeIdx} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────── Payment Demo ───────────────── */

const DEMO_STEPS = [
  { key: 'inbox', label: 'Invoice in' },
  { key: 'extract', label: 'Agent drafts' },
  { key: 'sign', label: 'Multisig vote' },
  { key: 'paid', label: 'Paid' },
] as const;

const DEMO_DURATIONS = [2400, 2800, 3200, 2800];

function PaymentDemo({ controlledStep }: { controlledStep: number }) {
  const stepIdx = controlledStep;
  const [parsedKeys, setParsedKeys] = useState(0);
  const [signerCount, setSignerCount] = useState(0);

  useEffect(() => {
    setParsedKeys(0);
    setSignerCount(0);
    if (stepIdx === 1) {
      let n = 0;
      const id = setInterval(() => {
        n += 1;
        setParsedKeys(n);
        if (n >= 5) clearInterval(id);
      }, 380);
      return () => clearInterval(id);
    }
    if (stepIdx === 2) {
      let n = 0;
      const id = setInterval(() => {
        n += 1;
        setSignerCount(n);
        if (n >= 2) clearInterval(id);
      }, 900);
      return () => clearInterval(id);
    }
    return undefined;
  }, [stepIdx]);

  return (
    <div
      className="demo-shell"
      role="img"
      aria-label="Animated demo: invoice received, agent drafts payout, multisig signs, vendor paid."
    >
      <div className="demo-tabs">
        {DEMO_STEPS.map((s, i) => (
          <div
            key={s.key}
            className={`demo-tab ${i === stepIdx ? 'is-active' : ''} ${i < stepIdx ? 'is-done' : ''}`}
          >
            <span style={{ opacity: 0.55, marginRight: 6 }}>0{i + 1}</span>
            {s.label}
            <span
              className="bar"
              style={{
                width: i <= stepIdx ? '100%' : '0%',
                transition:
                  i === stepIdx ? `width ${DEMO_DURATIONS[i]}ms linear` : 'width .25s ease',
              }}
            />
          </div>
        ))}
      </div>

      <div className="demo-stage">
        {/* Step 1 — Inbox */}
        <div className={`demo-frame ${stepIdx === 0 ? 'is-on' : ''}`}>
          <div className="label">Inbox · ap@yourco.com</div>
          <div
            className="idoc"
            style={{ borderColor: stepIdx === 0 ? 'var(--pink)' : 'var(--hair)' }}
          >
            <div className="idoc-row">
              <span className="from">FROM billing@northwind-design.com</span>
              <span className="from">10:42</span>
            </div>
            <div className="subj">Invoice #NW-2049 — October retainer</div>
            <div className="preview">
              Hi team — attached our October invoice. Net-30. Wire to our usual account, or USDC if
              easier this month.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <span
                className="bo-tag"
                style={{
                  background: '#fafafa',
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--hair)',
                }}
              >
                📎 invoice-NW-2049.pdf
              </span>
            </div>
          </div>
          <div className="idoc" style={{ opacity: 0.55 }}>
            <div className="idoc-row">
              <span className="from">FROM hello@cypress-legal.com</span>
              <span className="from">09:18</span>
            </div>
            <div className="subj">Q4 retainer + filing fees</div>
            <div className="preview">Three line items, payable to our trust account…</div>
          </div>
          <div className="idoc" style={{ opacity: 0.32 }}>
            <div className="idoc-row">
              <span className="from">FROM contractors@ledger-payroll.app</span>
              <span className="from">Tue</span>
            </div>
            <div className="subj">14 contractors ready to pay (CSV)</div>
            <div className="preview">Auto-generated batch from this week's timesheets.</div>
          </div>
        </div>

        {/* Step 2 — Agent extracts */}
        <div className={`demo-frame ${stepIdx === 1 ? 'is-on' : ''}`}>
          <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: 'var(--pink)',
                animation: 'demo-pulse 1.2s ease-in-out infinite',
              }}
            />
            Decimal agent · reading invoice-NW-2049.pdf
          </div>
          <div className="parsed">
            <h5>Extracted</h5>
            {(
              [
                ['Vendor', 'Northwind Design Co.'],
                ['Amount', <span className="amount">$8,420.00 USDC</span>],
                ['Due', 'Nov 14, 2025'],
                ['Memo', 'Oct retainer · INV NW-2049'],
                ['Recipient', '7Hk…q9Fz · routes to vendor bank'],
              ] as Array<[string, ReactNode]>
            )
              .slice(0, parsedKeys)
              .map(([k, v]) => (
                <div
                  className="parsed-row"
                  key={k}
                  style={{ animation: 'demo-fade-in .3s ease both' }}
                >
                  <span className="k">{k}</span>
                  <span className={`v ${k === 'Amount' ? 'pink' : ''}`}>{v}</span>
                </div>
              ))}
            {parsedKeys >= 5 && (
              <div
                style={{
                  marginTop: 8,
                  paddingTop: 12,
                  borderTop: '1px solid var(--hair)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span className="bo-tag" style={{ color: 'var(--pink)' }}>
                  ✓ Drafted payout · routed to multisig
                </span>
                <span className="bo-tag">approver: cfo@</span>
              </div>
            )}
          </div>
        </div>

        {/* Step 3 — Multisig vote */}
        <div className={`demo-frame ${stepIdx === 2 ? 'is-on' : ''}`}>
          <div className="label">Squads multisig · proposal #318 · m-of-n</div>
          <div className="parsed" style={{ padding: '12px 14px' }}>
            <div className="parsed-row">
              <span className="k">Send</span>
              <span className="v amount pink">$8,420.00 USDC</span>
            </div>
            <div className="parsed-row">
              <span className="k">To</span>
              <span className="v">Northwind Design Co.</span>
            </div>
          </div>
          <div className="signers">
            {[
              { nm: 'Maya R.', em: 'cfo@yourco.com', ini: 'M' },
              { nm: 'Diego A.', em: 'ceo@yourco.com', ini: 'D' },
              { nm: 'Cold key', em: 'hardware · ledger', ini: '○' },
            ].map((s, i) => (
              <div key={s.nm} className={`signer ${i < signerCount ? 'signed' : ''}`}>
                <div
                  className="avatar"
                  style={{ background: i < signerCount ? 'var(--pink)' : 'var(--ink)' }}
                >
                  {s.ini}
                </div>
                <div style={{ flex: 1, display: 'grid' }}>
                  <span className="nm">{s.nm}</span>
                  <span className="em">{s.em}</span>
                </div>
                <span className="stat">
                  {i < signerCount ? 'Signed' : i === signerCount ? '· · ·' : 'Idle'}
                </span>
              </div>
            ))}
          </div>
          {signerCount >= 2 && (
            <div
              className="bo-tag"
              style={{ textAlign: 'center', color: 'var(--pink)', marginTop: 4 }}
            >
              Threshold reached — broadcasting
            </div>
          )}
        </div>

        {/* Step 4 — Paid */}
        <div
          className={`demo-frame ${stepIdx === 3 ? 'is-on' : ''}`}
          style={{ alignContent: 'center' }}
        >
          <div className="sent-card">
            <div className="sent-check">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 12.5l5 5 11-11" />
              </svg>
            </div>
            <div className="sent-amount">$8,420.00</div>
            <div className="sent-meta">USDC · sent in 412 ms</div>
            <div style={{ height: 1, width: 64, background: 'var(--hair)', margin: '4px 0' }} />
            <div
              className="sent-meta"
              style={{ textTransform: 'none', letterSpacing: 0.02, color: 'var(--ink-2)' }}
            >
              Northwind Design Co. → vendor bank
            </div>
            <div className="sent-link">tx · 5fT…hP9q · solana mainnet</div>
          </div>
        </div>
      </div>

      <div className="demo-foot">
        <span>scroll-driven · {DEMO_STEPS[stepIdx]?.label ?? ''}</span>
      </div>

      <style>{`
        @keyframes demo-pulse { 0%, 100% { opacity: 1; transform: scale(1);} 50% {opacity: 0.4; transform: scale(1.4);} }
        @keyframes demo-fade-in { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: none;} }
      `}</style>
    </div>
  );
}

/* ───────────────── Built on ───────────────── */

function BuiltOn() {
  return (
    <section className="section builton-section is-pink" id="built">
      <div className="container">
        <div className="section-head">
          <div className="eyebrow">
            <span className="dot" />
            Built on
          </div>
          <h2>The strongest infrastructure in stablecoin payments.</h2>
        </div>
        <div className="builton-grid">
          <BuiltOnCell tag="Treasury" name="Squads" mark={<SquadsLogo />}>
            Multisig program securing billions on Solana. Formally verified. The standard the
            largest treasuries trust.
          </BuiltOnCell>
          <BuiltOnCell tag="Wallets" name="Privy" mark={<PrivyLogo />}>
            Embedded wallets so anyone can sign up. No extension, no seed phrase, no friction at
            the door.
          </BuiltOnCell>
          <BuiltOnCell tag="Asset" name="USDC" mark={<USDCLogo />}>
            The most liquid digital dollar. One dollar, always — regulated, fully-reserved,
            portable everywhere.
          </BuiltOnCell>
          <BuiltOnCell tag="Network" name="Solana" mark={<SolanaLogo />}>
            Sub-second settlement. Fees in fractions of a cent. The strongest stablecoin ecosystem
            on-chain.
          </BuiltOnCell>
        </div>
      </div>
    </section>
  );
}

function BuiltOnCell({
  tag,
  name,
  mark,
  children,
}: {
  tag: string;
  name: string;
  mark: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bo-cell">
      <div className="bo-tag">{tag}</div>
      <div className="bo-name">
        {mark}
        {name}
      </div>
      <div className="bo-blurb" style={{ fontSize: 17 }}>
        {children}
      </div>
    </div>
  );
}

function SquadsLogo() {
  return (
    <span className="bo-mark" style={{ background: '#0a0a0a' }}>
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M6 6h9v9H6z" fill="#fff" />
        <path d="M17 6h9v9h-9z" fill="#a78bfa" />
        <path d="M6 17h9v9H6z" fill="#a78bfa" />
        <path d="M17 17h9v9h-9z" fill="#fff" />
      </svg>
    </span>
  );
}

function PrivyLogo() {
  return (
    <span className="bo-mark" style={{ background: '#0a0a0a' }}>
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
        <path
          d="M9 6h9a6 6 0 0 1 0 12h-3v8H9V6z M15 11.2v1.6h2.6a.8.8 0 0 0 0-1.6H15z"
          fill="#9bff85"
        />
      </svg>
    </span>
  );
}

function USDCLogo() {
  return (
    <span className="bo-mark" style={{ background: '#2775CA' }}>
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="13" fill="none" stroke="#fff" strokeWidth="1.6" />
        <text
          x="16"
          y="21"
          textAnchor="middle"
          fontFamily="'Bricolage Grotesque', sans-serif"
          fontWeight="700"
          fontSize="15"
          fill="#fff"
        >
          $
        </text>
        <path d="M16 4v3 M16 25v3" stroke="#fff" strokeWidth="1.4" />
      </svg>
    </span>
  );
}

function SolanaLogo() {
  return (
    <span className="bo-mark" style={{ background: '#0a0a0a' }}>
      <svg width="22" height="18" viewBox="0 0 32 26" aria-hidden="true">
        <defs>
          <linearGradient id="decimal-sol-grad" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#9945FF" />
            <stop offset="1" stopColor="#14F195" />
          </linearGradient>
        </defs>
        <path d="M7 2h22l-4 4H3z" fill="url(#decimal-sol-grad)" />
        <path d="M3 11h22l4 4H7z" fill="url(#decimal-sol-grad)" />
        <path d="M7 20h22l-4 4H3z" fill="url(#decimal-sol-grad)" />
      </svg>
    </span>
  );
}

/* ───────────────── Why Decimal ───────────────── */

function WhyDecimal() {
  return (
    <section className="section" id="why">
      <div className="container">
        <div className="section-head">
          <div className="eyebrow">
            <span className="dot" />
            Why Decimal
          </div>
          <h2>The work runs itself.</h2>
        </div>
        <div className="why-body">
          <p>
            Modern finance teams spend most of their week pushing paper between systems. Invoices
            arrive in email. Numbers get copied into accounting software. Wires get requested from
            bank portals. Statements get reconciled with vendors.
          </p>
          <p>That work is structured, repetitive, and done badly because nobody likes doing it.</p>
          <p>
            Decimal puts AI on top of stablecoin rails so that work runs itself. The product{' '}
            <em className="em">extracts</em> the data. The team <em className="em">approves</em>{' '}
            the decisions. The money moves on-chain — at the speed of software, not the speed of
            bank cutoffs.
          </p>
          <p style={{ color: 'var(--ink-2)' }}>
            No bank branches. No $25 wire fees. No{' '}
            <em style={{ fontStyle: 'normal', color: 'var(--ink)' }}>
              "the system is down for maintenance."
            </em>{' '}
            Just the work, done.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ───────────────── FAQ ───────────────── */

const FAQ_ITEMS = [
  {
    q: 'Do I need to understand crypto?',
    a: 'No. If you can use Mercury or Ramp, you can use Decimal. Privy wallets onboard like a normal email signup — no browser extension, no seed phrase to write down.',
  },
  {
    q: 'Where do my funds actually live?',
    a: 'In a Squads multisig on Solana that you control. Decimal never touches the keys. We propose; your signers dispose.',
  },
  {
    q: 'What happens if Decimal shuts down?',
    a: "Your money is on-chain. You can move it with any Squads-compatible tool. We're a layer on top, not a custodian.",
  },
  {
    q: 'What does Decimal actually do?',
    a: "Reads documents and contracts, extracts payment details, drafts payouts, flags anomalies, and learns your team's approval patterns. It proposes; you and your multisig dispose.",
  },
  {
    q: 'Can my vendors get paid in their local bank account?',
    a: 'Yes. They can receive USDC directly, or you can deliver a bank deposit in their preferred currency.',
  },
  {
    q: 'Why stablecoins?',
    a: "USDC is a digital dollar. It doesn't move in price. It moves faster and costs less than a bank wire — pennies instead of $25, seconds instead of days.",
  },
  {
    q: 'Why Solana?',
    a: 'Sub-second settlement, fees measured in fractions of a cent, and the strongest stablecoin ecosystem on-chain.',
  },
];

function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  const onToggle = useCallback(
    (i: number) => (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      setOpenIdx((current) => (current === i ? null : i));
    },
    [],
  );

  return (
    <section className="section is-pink" id="faq">
      <div className="container">
        <div className="section-head">
          <div className="eyebrow">
            <span className="dot" />
            FAQ
          </div>
          <h2>Questions, asked plainly.</h2>
        </div>
        <div className="faq">
          {FAQ_ITEMS.map((it, i) => {
            const isOpen = openIdx === i;
            return (
              <details key={it.q} open={isOpen}>
                <summary onClick={onToggle(i)}>
                  <span>{it.q}</span>
                  <span className="plus">+</span>
                </summary>
                <div className="ans">{it.a}</div>
              </details>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ───────────────── Foot CTA ───────────────── */

function FootCTA({ googleHref }: { googleHref: string }) {
  return (
    <section className="footcta footcta-pink">
      <div className="container">
        <div className="footcta-grid">
          <div>
            <div className="eyebrow">
              <span className="dot" />
              Get started
            </div>
            <h2 style={{ marginTop: 20 }}>
              Stop pushing paper.
              <br />
              Start <span className="pink">approving</span> it.
            </h2>
            <p className="lede" style={{ marginBottom: 32, maxWidth: '52ch' } as CSSProperties}>
              Decimal is the finance operator for the next generation of companies. Sign up in
              10 seconds. Spin up a self-custodial treasury in one screen.
            </p>
            <div className="footcta-actions">
              <a className="gbtn" href={googleHref} style={{ fontFamily: '"Bricolage Grotesque"' }}>
                <span className="g">
                  <GoogleG />
                </span>
                Continue with Google
              </a>
              <Link to="/login" className="btn btn-ghost">
                Sign in →
              </Link>
            </div>
          </div>
          <div className="footcta-orb-wrap">
            <div className="glow" aria-hidden="true" />
            <img src="/decimal-logo.png" alt="" />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────── Foot ───────────────── */

function Foot() {
  return (
    <footer className="foot">
      <div className="container foot-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#fff' }}>
          <img
            src="/decimal-logo.png"
            alt=""
            style={{ width: 22, height: 22, borderRadius: '50%' }}
          />
          <span style={{ textTransform: 'none', letterSpacing: 0 }}>
            <strong
              style={{
                fontFamily: "'Bricolage Grotesque', sans-serif",
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              Decimal
            </strong>
            <span style={{ color: 'rgba(255,255,255,0.85)' }}>
              {' '}
              — finance, automated. Treasury, in your hands.
            </span>
          </span>
        </div>
        <div style={{ display: 'flex', gap: 24 }}>
          <a
            href="https://twitter.com"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'inherit', textDecoration: 'none' }}
          >
            Twitter
          </a>
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'inherit', textDecoration: 'none' }}
          >
            GitHub
          </a>
          <a href="#how" style={{ color: 'inherit', textDecoration: 'none' }}>
            Docs
          </a>
          <a href="#why" style={{ color: 'inherit', textDecoration: 'none' }}>
            colosseum '25
          </a>
        </div>
      </div>
    </footer>
  );
}
