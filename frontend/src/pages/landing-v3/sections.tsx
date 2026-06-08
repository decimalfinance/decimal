// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import './sections.css';

/* global React */
/* Decimal — landing sections as components, for the design canvas */

const S = {
  shield:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"/><path d="M9.5 12l2 2 3.5-3.5"/></svg>,
  code:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 8 5 12l4 4M15 8l4 4-4 4"/></svg>,
  noflo: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.5 5.5l13 13"/></svg>,
  lock:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>,
  bank:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10h16M5 10l7-5 7 5M6 10v8M10 10v8M14 10v8M18 10v8M4 18h16"/></svg>,
  ok:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 10 17 19 6.5"/></svg>,
};

/* dotted disc with a single magenta keyhole — same dot language as the hero globe */
function KeyDisc({ dark }) {
  const rgb = dark ? "255,255,255" : "11,11,11";
  const dots = [];
  for (let r = 46; r <= 168; r += 14) {
    const n = Math.round((2 * Math.PI * r) / 14);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      dots.push({ x: 200 + Math.cos(a) * r, y: 200 + Math.sin(a) * r, o: (dark ? 0.62 : 0.5) - (r - 46) / 320 });
    }
  }
  return (
    <svg className="keydisc" viewBox="0 0 400 400" fill="none">
      <circle cx="200" cy="200" r="184" stroke={"rgb(" + rgb + ")"} strokeWidth="1" opacity={dark ? "0.14" : "0.10"} />
      <g className="keydisc-dots">
        {dots.map((d, i) => <circle key={i} cx={d.x.toFixed(1)} cy={d.y.toFixed(1)} r="1.7" fill={"rgb(" + rgb + ")"} opacity={Math.max(0.16, d.o).toFixed(2)} />)}
      </g>
      <g className="keydisc-eye">
        <circle cx="200" cy="200" r="34" fill={dark ? "#0B0B0B" : "#FFFFFF"} />
        <circle cx="200" cy="200" r="34" stroke="#E6005C" strokeWidth="1.5" opacity="0.5" />
        <circle cx="200" cy="193" r="11" fill="#E6005C" />
        <path d="M200 200 l-7 24 h14 z" fill="#E6005C" />
      </g>
    </svg>
  );
}

export function SecuritySection() {
  const A = "/";
  return (
    <section className="sec sec-security">
      <div className="sec-wrap secgrid2">
        <div className="sec-copy">
          <h2 className="sec-title">Your money never leaves <em>your control.</em></h2>
          <p className="sec-lead">Decimal pays your bills from an account only your team can move. It can never hold, freeze, or divert a dollar.</p>
          <ul className="code-points cp-rich">
            <li><span className="ck">{S.ok}</span><span className="cp-tx"><b>Self-custodial.</b> The money sits in your own account, not ours.</span></li>
            <li><span className="ck">{S.ok}</span><span className="cp-tx"><b>Un-overridable.</b> The rules live in code, not a setting someone can flip.</span></li>
            <li><span className="ck">{S.ok}</span><span className="cp-tx"><b>No float.</b> We never hold your money, so we never earn on it.</span></li>
          </ul>
        </div>
        <div className="codepanel">
          <div className="acct-card">
            <div className="ac-head">
              <img className="ac-icn" src="/icons/bank.svg" alt="" />
              <div className="ac-id"><span className="ac-name">Operating account</span><span className="ac-sub">Self-custodial · your bank</span></div>
              <span className="ac-pill">{S.lock} Yours</span>
            </div>
            <div className="ac-bal"><span className="ac-bal-l">Balance</span><span className="ac-bal-v mono">$284,920.00</span></div>
            <div className="ac-block">
              <div className="ac-block-l">Who can move this money</div>
              <div className="ac-movers">
                <span className="ac-avs"><img src={A + "avatar-1.png"} alt="" /><img src={A + "avatar-2.png"} alt="" /></span>
                <span className="ac-movers-t">Your team only · <b>enforced by code</b></span>
              </div>
            </div>
            <div className="ac-rule">{S.lock}<span>Decimal can never move these funds. Not the AI, not us.</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ApprovalsSection() {
  const A = "/";
  return (
    <section className="sec sec-approvals">
      <div className="sec-wrap secgrid2 approvals-grid">
        <div className="codepanel">
          <div className="acct-card">
            <div className="ac-head">
              <img className="ac-icn" src="/icons/lock.svg" alt="" />
              <div className="ac-id"><span className="ac-name">Release approval</span><span className="ac-sub">Meridian Studio · INV-2048</span></div>
              <span className="ac-amt mono">$2,176.67</span>
            </div>
            <div className="ac-block">
              <div className="ac-block-l">Approvers · 2 of 3 required</div>
              <div className="ac-approvers">
                <div className="apv done"><img src={A + "avatar-1.png"} alt="" /><span className="apv-n">Jordan Keil</span><span className="apv-s">{S.ok} Approved</span></div>
                <div className="apv done"><img src={A + "avatar-2.png"} alt="" /><span className="apv-n">Amara Osei</span><span className="apv-s">{S.ok} Approved</span></div>
                <div className="apv wait"><img src={A + "avatar-3.png"} alt="" /><span className="apv-n">Priya Nair</span><span className="apv-s muted">Not needed</span></div>
              </div>
            </div>
            <div className="ac-status">{S.ok}<span><b>Threshold met.</b> Releasing from your account.</span></div>
            <div className="ac-rule">{S.lock}<span>The 2-of-3 rule is enforced by code. No one can override it.</span></div>
          </div>
        </div>
        <div className="sec-copy">
          <h2 className="sec-title">Nothing moves without <em>your say-so.</em></h2>
          <p className="sec-lead">You set who signs off, and how many. Decimal enforces it on every payment. The AI can prepare a bill, but it can never release one.</p>
          <ul className="code-points cp-rich">
            <li><span className="ck">{S.ok}</span><span className="cp-tx"><b>Your approvers, your thresholds.</b> Route by amount, vendor, or entity.</span></li>
            <li><span className="ck">{S.ok}</span><span className="cp-tx"><b>Enforced in code.</b> Not a toggle someone can quietly flip.</span></li>
            <li><span className="ck">{S.ok}</span><span className="cp-tx"><b>AI proposes, you dispose.</b> It readies the payment; releasing it is always yours.</span></li>
          </ul>
        </div>
      </div>
    </section>
  );
}

const CI = {
  doc:  <img className="cicn-img" src="/icons/invoice.svg" alt="" />,
  spark:<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.5 6L20 9.5 13.5 11 12 17l-1.5-6L4 9.5 10.5 8 12 2Z"/></svg>,
  check:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 10 17 19 6.5"/></svg>,
  sync: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4 5 7l3 3M5 7h11a3 3 0 0 1 3 3M16 20l3-3-3-3M19 17H8a3 3 0 0 1-3-3"/></svg>,
};

export function CodingSection() {
  return (
    <section className="sec sec-coding">
      <div className="sec-wrap secgrid2">
        <div className="sec-copy">
          <h2 className="sec-title">Invoices code <em>themselves.</em></h2>
          <p className="sec-lead">Forward a bill and AI handles the rest. It is on the books before anyone touches it.</p>
          <ul className="code-points">
            <li><span className="ck">{CI.check}</span>Reads the bill the moment it lands</li>
            <li><span className="ck">{CI.check}</span>Pulls the vendor, amount, and due date</li>
            <li><span className="ck">{CI.check}</span>Codes it to the right account in QuickBooks</li>
          </ul>
        </div>
        <div className="codepanel">
          <div className="ccard">
            <div className="ch">{CI.doc}<span className="ct">Invoice · INV-2048</span></div>
            <div className="crow"><span className="k">Vendor</span><span className="v">{CI.check} Meridian Studio</span></div>
            <div className="crow"><span className="k">Amount</span><span className="v mono">{CI.check} $2,176.67</span></div>
            <div className="crow"><span className="k">GL account</span><span className="v">{CI.check} Contractors · 6010</span></div>
          </div>
          <div className="csync">{CI.sync}</div>
          <div className="ccard">
            <div className="ch"><img className="qblogo" src="/quickbooks.svg" alt="QuickBooks" /><span className="ct">QuickBooks</span><span className="cchip ok">{CI.check} Posted</span></div>
            <div className="crow"><span className="k">Bill · Meridian Studio</span><span className="v mono">$2,176.67</span></div>
            <div className="crow"><span className="k">Contractors · 6010</span><span className="v">On the books</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}

// three distinct rows — different countries per row so no strip repeats.
// first item is a circle-flags filename in /public/flags/.
const XB_ROWS = [
  // Americas + Western Europe
  [
    ["us", "$50,432"], ["ca", "C$22,300"], ["mx", "MX$48,200"], ["br", "R$8,901"], ["european_union", "€24,850"],
    ["gb", "£36,490"], ["ch", "CHF 19,400"], ["co", "COP$210K"], ["cl", "CLP 980K"], ["ar", "AR$120K"],
  ],
  // Asia-Pacific
  [
    ["in", "₹2,40,000"], ["jp", "¥1,016,190"], ["sg", "S$15,890"], ["cn", "RMB 186,500"], ["kr", "₩32,400,000"],
    ["id", "Rp 680,000"], ["ph", "₱58,000"], ["th", "฿41,200"], ["my", "RM 18,900"], ["hk", "HK$94,000"],
  ],
  // Africa, Middle East + Oceania
  [
    ["ng", "₦890,400"], ["za", "R142,000"], ["ke", "KSh 820,000"], ["eg", "E£186,000"], ["gh", "₵54,000"],
    ["ae", "AED 38,500"], ["sa", "SAR 45,000"], ["tr", "₺128,000"], ["au", "A$31,200"], ["nz", "NZ$28,900"],
  ],
];

// payment rails — uniform line-glyphs (bank / euro / transfer / Solana bars) so they read as a set
const RAILS = [
  ["ACH", <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9.5l9-5 9 5" /><path d="M5 9.5v8M19 9.5v8M9.5 9.5v8M14.5 9.5v8" /><path d="M3.5 18h17" /></svg>],
  ["SEPA", <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M18 7.2a6.3 6.3 0 1 0 0 9.6" /><path d="M4 11h10M4 13.6h9" /></svg>],
  ["Wire", <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9h13M13 5.5 16.5 9 13 12.5" /><path d="M21 15H8M11 11.5 7.5 15 11 18.5" /></svg>],
  ["Solana", <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5h12l-3 2.6H5z" /><path d="M5 9.7h12l3 2.6H8z" /><path d="M8 14.4h12l-3 2.6H5z" /></svg>],
];

export function CrossBorderSection() {
  return (
    <section className="sec sec-xborder">
      <div className="sec-wrap">
        <header className="sec-head center">
          <h2 className="sec-title">Pay vendors across <em>100+ countries.</em></h2>
          <p className="sec-lead">Pay vendors in their own currency, straight to their own bank. No correspondent banks, no three percent FX buried in the rate.</p>
        </header>
      </div>
      <div className="xb-box">
        <div className="xb-marquee">
          {XB_ROWS.map((row, ri) => (
            <div className={"xb-row " + (ri === 1 ? "right" : "left")} key={ri}>
              {[...row, ...row].map(([f, a], i) => <div className="fchip" key={i}><img className="fimg" src={"/flags-sq/" + f + ".svg"} alt="" /><span className="fa">{a}</span></div>)}
            </div>
          ))}
        </div>
      </div>
      <div className="xb-stats">
        <div className="xb-stat">
          <div className="st-viz st-proof">
            <span className="pf-chip">
              <svg className="pf-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              <span className="pf-sig">5Ub3…q7Fk</span>
            </span>
            <span className="vs">verified on-chain</span>
          </div>
          <h4>Settlement you can prove</h4>
          <p>Every payment has an on-chain receipt.</p>
        </div>
        <div className="xb-stat">
          <div className="st-viz st-rails">{RAILS.map(([r, ic], i) => <span className="rail-pill" key={i}>{ic}{r}</span>)}</div>
          <h4>Every major rail</h4>
          <p>Settles over ACH, SEPA, Wire, and Solana.</p>
        </div>
        <div className="xb-stat">
          <div className="st-viz st-flags">{["ng", "in", "br", "european_union", "jp", "gb"].map((f, i) => <img key={i} src={"/flags-sq/" + f + ".svg"} alt="" />)}</div>
          <h4>Paid in their currency</h4>
          <p>Your vendor receives local currency in their bank.</p>
        </div>
      </div>
    </section>
  );
}

export function SpendingLimitsSection() {
  return (
    <section className="sec sec-limits">
      <div className="sec-wrap secgrid2 limits-grid">
        <div className="limit-panel">
          <div className="budget-card">
            <div className="bc-head">
              <div className="bc-id">
                <span className="bc-name">Amazon Web Services</span>
                <span className="bc-sub">June 2026</span>
              </div>
              <span className="bc-recur">Recurs monthly</span>
            </div>
            <div className="bc-legend">
              <div className="lg"><span className="lg-k"><i className="dot paid" />Paid</span><span className="lg-v mono">$4,120</span></div>
              <div className="lg"><span className="lg-k"><i className="dot queued" />Queued</span><span className="lg-v mono">$1,280</span></div>
              <div className="lg"><span className="lg-k"><i className="dot left" />Left</span><span className="lg-v mono">$600</span></div>
            </div>
            <div className="bc-bar"><span className="seg paid" style={{ width: "69%" }} /><span className="seg queued" style={{ width: "21%" }} /><span className="seg left" style={{ width: "10%" }} /></div>
            <div className="bc-foot"><span className="mono">Monthly limit · $6,000</span><span className="bc-status">{CI.check} Auto-paid within limit</span></div>
          </div>
        </div>
        <div className="sec-copy">
          <h2 className="sec-title">Approve once, <em>pay every month.</em></h2>
          <p className="sec-lead">Set a limit for a vendor and Decimal pays every invoice that fits, automatically.</p>
          <ul className="code-points">
            <li><span className="ck">{CI.check}</span>Recurring bills within the limit run themselves</li>
            <li><span className="ck">{CI.check}</span>Anything over the line waits for your sign-off</li>
            <li><span className="ck">{CI.check}</span>A new vendor always comes to you first</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export function PaymentsSection() {
  return (
    <section className="sec sec-pay">
      <div className="sec-wrap pay-head">
        <h2 className="sec-title">Paid and reconciled, <em>anywhere.</em></h2>
        <p className="sec-lead">Approved bills get paid in USDC instantly, or local currency where supported, straight from your own account. Every payment is matched back to its invoice in QuickBooks, so your books close themselves.</p>
      </div>
      <div className="pay-stage">
        <div className="pay-browser">
          <div className="pay-bar"><span className="pay-dots"><i /><i /><i /></span><span className="pay-url">app.decimal.com/payments</span></div>
          <iframe className="pay-frame" src="/landing-embed/explore/payments-embed.html" title="Decimal — all payments"></iframe>
        </div>
        <div className="anno a1">
          <div className="at">Paid from your own account</div>
          <div className="as">Decimal pays out, never holds the money.</div>
          <div className="amono">from: Operating · <span className="g">USDC</span></div>
        </div>
        <div className="anno a2">
          <div className="at">Settles in seconds</div>
          <div className="as">USDC now, or local currency where needed.</div>
          <div className="amono">settled · <span className="g">1.8s</span></div>
        </div>
        <div className="anno a3">
          <div className="at">Reconciled in QuickBooks</div>
          <div className="as">Matched back to its invoice automatically.</div>
          <div className="amono">quickbooks · <span className="g">posted ✓</span></div>
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  ["Bill capture", "Email, upload, or forward. We read it all.", "doc"],
  ["AI coding", "Vendor, GL, and amount, filled in automatically.", "spark"],
  ["Approval flows", "Route by amount, vendor, or entity.", "flow"],
  ["Spending limits", "Set a cap, let the rest run.", "gauge"],
  ["Global payments", "USDC or local rails, 100+ countries.", "globe"],
  ["QuickBooks sync", "Two-way, real time.", "sync"],
  ["Audit trail", "Every action logged and exportable.", "list"],
  ["Role-based access", "The right eyes on the right things.", "key"],
  ["Self-custody", "Your money, your control, always.", "lock"],
];

export function FeatureGridSection({ scheme }) {
  return (
    <section id="sec-features" className={"sec sec-features" + (scheme ? " fg-" + scheme : "")}>
      <div className="sec-wrap">
        <header className="sec-head"><h2 className="sec-title">Everything accounts <em>payable needs.</em></h2></header>
        <div className="fg-grid">
          {FEATURES.map(([t, d, ic], i) => (
            <div className={"fg-cell c" + (i % 3)} key={i}>
              <span className="fg-ic"><img src={"/icons/feat/" + ic + ".svg"} alt="" /></span>
              <h3 className="fg-t">{t}</h3>
              <p className="fg-d">{d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const FAQS = [
  ["Does Decimal ever hold my money?", "No. Your cash stays in an account only your team can move. Decimal pays bills from it, but it can never hold, freeze, or divert a dollar."],
  ["Can the AI pay the wrong vendor or amount?", "Every payment runs against your limits and approvers, enforced in code. Anything over the line, or to someone new, waits for your sign-off before it moves."],
  ["Does it work with my accounting software?", "Decimal syncs two-way with QuickBooks in real time, so every bill and payment lands on your books automatically. More integrations are on the way."],
  ["How fast do payments arrive?", "USDC settles in seconds, any day of the week. Local-currency payouts follow normal banking times where they apply."],
  ["Do my vendors need to know about crypto?", "No. Vendors get paid in their own currency, to their own bank account. USDC is just the rail underneath, invisible to them."],
  ["What happens if Decimal goes away?", "Your money sits in your own account the entire time, so it stays yours and accessible no matter what happens to us. Decimal is the software on top, never the custodian."],
];

function DitherWave() {
  // dithered mountain range: layered ridges (back/mid/front) with ordered (Bayer) dithering,
  // each fading darker toward its base for depth
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext("2d");
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(c.clientWidth || (c.parentElement && c.parentElement.clientWidth) || 680);
    const H = 96;
    c.width = W * DPR; c.height = H * DPR;
    c.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 1D fractal noise -> ridged (sharp peaks) silhouette
    const fbm = (x, seed) => {
      let n = 0, amp = 1, f = 1, norm = 0;
      for (let o = 0; o < 4; o++) {
        n += amp * Math.sin(x * f * 0.012 + seed + o * 2.1);
        norm += amp; amp *= 0.5; f *= 2.0;
      }
      return n / norm; // ~ -1..1
    };
    const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
    const cell = 3;
    const layers = [
      { base: H * 0.52, amp: 30, freq: 0.8, seed: 0.4, maxA: 0.34 }, // back range (high, light)
      { base: H * 0.68, amp: 34, freq: 1.3, seed: 2.9, maxA: 0.55 }, // mid range
      { base: H * 0.86, amp: 40, freq: 2.0, seed: 5.6, maxA: 0.85 }, // front range (low, dark)
    ];
    ctx.fillStyle = "#E6005C";
    for (const L of layers) {
      for (let x = 0; x < W; x += cell) {
        const peak = 1 - Math.abs(fbm(x * L.freq, L.seed)); // 0..1, sharp ridges
        const ridge = L.base - L.amp * peak;                // ridge y (smaller = higher)
        const y0 = Math.max(0, Math.floor(ridge / cell) * cell);
        for (let y = y0; y < H; y += cell) {
          const below = (y - ridge) / (H - ridge + 0.001);  // 0 at ridge -> 1 at base
          const dens = 0.22 + below * 0.95;                 // denser lower down the slope
          const th = (bayer[((y / cell) | 0) % 4][((x / cell) | 0) % 4] + 0.5) / 16;
          if (dens > th) {
            ctx.globalAlpha = Math.min(L.maxA, 0.1 + below * L.maxA);
            ctx.fillRect(x, y, 1.7, 1.7);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }, []);
  return <canvas ref={ref} className="faq-wave" aria-hidden="true" />;
}

export function FaqSection() {
  const [open, setOpen] = React.useState(0);
  return (
    <section className="sec sec-faq">
      <div className="faq-wrap">
        <h2 className="faq-title">Questions, <em>answered.</em></h2>
        <div className="faq-box">
          {FAQS.map(([q, a], i) => (
            <div className={"faq-item" + (open === i ? " open" : "")} key={i}>
              <button className="faq-q" onClick={() => setOpen(open === i ? -1 : i)}>
                <span className="faq-n">{String(i + 1).padStart(2, "0")}</span>
                <span className="faq-qt">{q}</span>
                <span className="faq-chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
              </button>
              <div className="faq-a"><div className="faq-a-inner"><p>{a}</p><DitherWave /></div></div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ClosingCTASection() {
  return (
    <section className="sec sec-cta">
      <div className="cta-inner">
        <img className="cta-logo" src="/decimal-logo.png" alt="Decimal" />
        <h2 className="cta-title">Run your accounts payable on Decimal.</h2>
        <p className="cta-lead">Connect QuickBooks, forward your first invoice, and watch it get coded, approved, and paid, from an account only you control.</p>
        <div className="cta-actions">
          <a className="cta-primary" href="/login">Get started <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
          <a className="cta-secondary" href="#">See it in action</a>
        </div>
      </div>
    </section>
  );
}

export function FooterSection() {
  return (
    <footer className="sec-footer">
      <div className="ft-grid">
        <div className="ft-brand">
          <span className="ft-mark"><img src="/decimal-logo.png" alt="" /><span>Decimal</span></span>
          <p className="ft-desc">AI-powered accounts payable for teams paying vendors worldwide.</p>
        </div>
        <nav className="ft-col">
          <h5>Product</h5>
          <a href="#sec-payments">Payments</a>
          <a href="#sec-xborder">Cross-border</a>
          <a href="#sec-security">Security</a>
          <a href="#sec-features">Features</a>
          <a href="#sec-faq">FAQ</a>
        </nav>
        <nav className="ft-col">
          <h5>Get started</h5>
          <a href="/login">Create account</a>
          <a href="/login">Sign in</a>
          <a href="#">Book a demo</a>
        </nav>
      </div>
      <div className="ft-bottom">
        <span className="ft-copy">© 2026 Decimal, Inc.</span>
        <span className="ft-meta">Built on Solana · Settles in USDC</span>
      </div>
    </footer>
  );
}

const TRUST = [
  ["Built on", "Solana", "solana"],
  ["Secured by", "Squads", "squads"],
  ["Syncs with", "QuickBooks", "qb"],
  ["100%", "Self-custodial", "lock"],
];
const TRUST_MARK = {
  solana: <img src="/logos/solana.svg" alt="" />,
  squads: <img src="/logos/squads.png" alt="" />,
  qb: <img src="/quickbooks.svg" alt="" />,
  // self-custodial is a property, not a brand — a lock glyph (pink, currentColor)
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>,
};

export function TrustStrip({ variant }) {
  const items = TRUST.map(([pre, name, mark], i) => (
    <div className="trust-item" key={i}>
      <span className="trust-mark">{TRUST_MARK[mark]}</span>
      <span className="trust-txt"><span className="trust-pre">{pre}</span> <span className="trust-name">{name}</span></span>
    </div>
  ));
  const run = [0, 1, 2, 3].flatMap((c) => items.map((el) => React.cloneElement(el, { key: c + "-" + el.key })));
  return (
    <section className={"sec-trust grad" + (variant ? " " + variant : "")}>
      <div className="trust-marquee"><div className="trust-track">{run}</div></div>
    </section>
  );
}

Object.assign(window, { SecuritySection, ApprovalsSection, CodingSection, CrossBorderSection, PaymentsSection, SpendingLimitsSection, FeatureGridSection, FaqSection, ClosingCTASection, FooterSection, TrustStrip });
