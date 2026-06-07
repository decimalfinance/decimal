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

function SecuritySection() {
  const A = "landing/assets/";
  return (
    <section className="sec sec-security">
      <div className="sec-wrap secgrid2">
        <div className="sec-copy">
          <h2 className="sec-title">Your money never leaves <em>your control.</em></h2>
          <p className="sec-lead">Decimal pays your bills from an account only your team can move — it can never hold, freeze, or divert a dollar.</p>
          <ul className="code-points cp-rich">
            <li><span className="ck">{S.ok}</span><span className="cp-tx"><b>Self-custodial.</b> The money sits in your own account, not ours.</span></li>
            <li><span className="ck">{S.ok}</span><span className="cp-tx"><b>Un-overridable.</b> The rules live in code, not a setting someone can flip.</span></li>
            <li><span className="ck">{S.ok}</span><span className="cp-tx"><b>No float.</b> We never hold your money, so we never earn on it.</span></li>
          </ul>
        </div>
        <div className="codepanel">
          <div className="acct-card">
            <div className="ac-head">
              <span className="ac-bank">{S.bank}</span>
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

function ApprovalsSection() {
  const A = "landing/assets/";
  return (
    <section className="sec sec-approvals">
      <div className="sec-wrap secgrid2 approvals-grid">
        <div className="codepanel">
          <div className="acct-card">
            <div className="ac-head">
              <span className="ac-bank">{S.lock}</span>
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
          <p className="sec-lead">You set who signs off, and how many. Decimal enforces it on every payment — the AI can prepare a bill, but it can never release one.</p>
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
  doc:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>,
  spark:<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.5 6L20 9.5 13.5 11 12 17l-1.5-6L4 9.5 10.5 8 12 2Z"/></svg>,
  check:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 10 17 19 6.5"/></svg>,
  sync: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4 5 7l3 3M5 7h11a3 3 0 0 1 3 3M16 20l3-3-3-3M19 17H8a3 3 0 0 1-3-3"/></svg>,
};

function CodingSection() {
  return (
    <section className="sec sec-coding">
      <div className="sec-wrap secgrid2">
        <div className="sec-copy">
          <h2 className="sec-title">Invoices code <em>themselves.</em></h2>
          <p className="sec-lead">Forward a bill and AI handles the rest — it is on the books before anyone touches it.</p>
          <ul className="code-points">
            <li><span className="ck">{CI.check}</span>Reads the bill the moment it lands</li>
            <li><span className="ck">{CI.check}</span>Pulls the vendor, amount, and due date</li>
            <li><span className="ck">{CI.check}</span>Codes it to the right account in QuickBooks</li>
          </ul>
        </div>
        <div className="codepanel">
          <div className="ccard">
            <div className="ch"><span className="cicn pink">{CI.doc}</span><span className="ct">Invoice · INV-2048</span><span className="cchip ai">{CI.spark} Coded by AI</span></div>
            <div className="crow"><span className="k">Vendor</span><span className="v">{CI.check} Meridian Studio</span></div>
            <div className="crow"><span className="k">Amount</span><span className="v mono">{CI.check} $2,176.67</span></div>
            <div className="crow"><span className="k">GL account</span><span className="v">{CI.check} Contractors · 6010</span></div>
          </div>
          <div className="csync">{CI.sync}</div>
          <div className="ccard">
            <div className="ch"><span className="qbicon">qb</span><span className="ct">QuickBooks</span><span className="cchip ok">{CI.check} Posted</span></div>
            <div className="crow"><span className="k">Bill · Meridian Studio</span><span className="v mono">$2,176.67</span></div>
            <div className="crow"><span className="k">Contractors · 6010</span><span className="v">On the books</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}

const XBI = {
  bolt:  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"/></svg>,
  globe: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/></svg>,
  pin:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>,
};
const XB_CHIPS = [
  ["🇺🇸", "$50,432"], ["🇪🇺", "€24,850"], ["🇬🇧", "£36,490"], ["🇳🇬", "₦890,400"], ["🇧🇷", "R$8,901"],
  ["🇸🇬", "S$15,890"], ["🇮🇳", "₹2,40,000"], ["🇯🇵", "¥1,016,190"], ["🇲🇽", "MX$48,200"], ["🇨🇦", "C$22,300"],
];
const XB_RAILS = ["USDC", "ACH", "SEPA", "SWIFT", "Wire", "Local rails"];
const XB_ROWS = [
  XB_CHIPS,
  [...XB_CHIPS.slice(5), ...XB_CHIPS.slice(0, 5)],
  [...XB_CHIPS.slice(3), ...XB_CHIPS.slice(0, 3)],
];

function CrossBorderSection() {
  return (
    <section className="sec sec-xborder">
      <div className="sec-wrap">
        <header className="sec-head center">
          <h2 className="sec-title">Pay any vendor, <em>anywhere on earth.</em></h2>
          <p className="sec-lead">Pay a contractor in Lagos as fast as one across the street. Decimal settles in USDC in seconds, or in local currency where you need it — no multi-day wires, no correspondent banks, no three percent FX buried in the rate.</p>
        </header>
      </div>
      <div className="xb-box">
        <div className="xb-marquee">
          {XB_ROWS.map((row, ri) => (
            <div className={"xb-row " + (ri === 1 ? "right" : "left")} key={ri}>
              {[...row, ...row].map(([f, a], i) => <div className="fchip" key={i}><span className="flag">{f}</span><span className="fa">{a}</span></div>)}
            </div>
          ))}
        </div>
      </div>
      <div className="xb-stats">
        <div className="xb-stat">
          <div className="st-viz st-speed"><span className="big">1.8s</span><span className="vs">vs <s>3–5 day wires</s></span></div>
          <h4>Seconds, not days</h4>
          <p>USDC settles the moment it is approved.</p>
        </div>
        <div className="xb-stat">
          <div className="st-viz st-flags">{["🇺🇸", "🇳🇬", "🇪🇺", "🇧🇷", "🇸🇬", "🇯🇵"].map((f, i) => <span key={i}>{f}</span>)}</div>
          <h4>Anywhere USDC reaches</h4>
          <p>Pay vendors around the world.</p>
        </div>
        <div className="xb-stat">
          <div className="st-viz st-cur">{["₦", "R$", "€", "£", "¥"].map((c, i) => <span key={i}>{c}</span>)}</div>
          <h4>Local currency too</h4>
          <p>Or settle in their local currency.</p>
        </div>
      </div>
    </section>
  );
}

function SpendingLimitsSection() {
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

function PaymentsSection() {
  return (
    <section className="sec sec-pay">
      <div className="sec-wrap pay-head">
        <h2 className="sec-title">Paid and reconciled, <em>anywhere.</em></h2>
        <p className="sec-lead">Approved bills get paid in USDC instantly, or local currency where supported, straight from your own account. Every payment is matched back to its invoice in QuickBooks — so your books close themselves.</p>
      </div>
      <div className="pay-stage">
        <div className="pay-browser">
          <div className="pay-bar"><span className="pay-dots"><i /><i /><i /></span><span className="pay-url">app.decimal.com/payments</span></div>
          <iframe className="pay-frame" src="landing/explore/payments-embed.html" title="Decimal — all payments"></iframe>
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
  ["Global payments", "USDC or local rails, 130+ countries.", "globe"],
  ["QuickBooks sync", "Two-way, real time.", "sync"],
  ["Audit trail", "Every action logged and exportable.", "list"],
  ["Role-based access", "The right eyes on the right things.", "key"],
  ["Self-custody", "Your money, your keys, always.", "lock"],
];
const FG_ICON = {
  doc:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>,
  spark:<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.5 6L20 9.5 13.5 11 12 17l-1.5-6L4 9.5 10.5 8 12 2Z"/></svg>,
  flow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="12" r="2.4"/><path d="M8 6h4a3.5 3.5 0 0 1 3.5 3.5M8 18h4a3.5 3.5 0 0 0 3.5-3.5"/></svg>,
  gauge:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18a8 8 0 0 1 16 0"/><path d="M12 18l4-5"/></svg>,
  globe:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/></svg>,
  sync: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4 5 7l3 3M5 7h11a3 3 0 0 1 3 3M16 20l3-3-3-3M19 17H8a3 3 0 0 1-3-3"/></svg>,
  list: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>,
  key:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="4"/><path d="M11 11l8 8M16 16l2-2M19 19l2-2"/></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>,
};

function FeatureGridSection({ scheme }) {
  return (
    <section className={"sec sec-features" + (scheme ? " fg-" + scheme : "")}>
      <div className="sec-wrap">
        <header className="sec-head"><h2 className="sec-title">Everything accounts <em>payable needs.</em></h2></header>
        <div className="fg-grid">
          {FEATURES.map(([t, d, ic], i) => (
            <div className={"fg-cell c" + (i % 3)} key={i}>
              <span className="fg-ic">{FG_ICON[ic]}</span>
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
  ["What does it cost?", "A flat monthly subscription, never a percentage of what you pay out. We never hold your money, so we never earn float on it."],
];

function DotWave() {
  // rolling-hills dot field (ascii-art texture), in our dot language
  const W = 60, H = 13, cells = [];
  for (let x = 0; x < W; x++) {
    const t = x / W;
    const hill = 0.5 + 0.30 * Math.sin(t * Math.PI * 4 + 0.6) + 0.16 * Math.sin(t * Math.PI * 9 + 1.4);
    const horizon = Math.round((1 - hill) * H);
    for (let y = 0; y < H; y++) {
      if (y < horizon) continue;
      const depth = (y - horizon) / Math.max(1, H - horizon); // 0 at crest -> 1 at base
      const op = (0.12 + depth * 0.6).toFixed(2);
      cells.push(<circle key={x + "-" + y} cx={x * 7 + 4} cy={y * 7 + 4} r="1.5" fill="var(--pink)" opacity={op} />);
    }
  }
  return <svg className="faq-wave" viewBox={"0 0 " + (W * 7) + " " + (H * 7)} preserveAspectRatio="xMidYMax slice" aria-hidden="true">{cells}</svg>;
}

function FaqSection() {
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
              <div className="faq-a"><div className="faq-a-inner"><p>{a}</p><DotWave /></div></div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ClosingCTASection() {
  return (
    <section className="sec sec-cta">
      <div className="cta-dots" aria-hidden="true"></div>
      <div className="cta-inner">
        <h2 className="cta-title">Let Decimal <em>pay your bills.</em></h2>
        <p className="cta-lead">Connect QuickBooks, forward your first invoice, and watch it get coded, approved, and paid, from an account only you control.</p>
        <div className="cta-actions">
          <a className="cta-primary" href="#">Get started <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
          <a className="cta-secondary" href="#">See it in action</a>
        </div>
      </div>
    </section>
  );
}

function FooterSection() {
  return (
    <footer className="sec-footer">
      <div className="ft-top">
        <span className="ft-mark"><img src="landing/assets/decimal-logo.png" alt="" /><span>Decimal</span></span>
        <nav className="ft-links">
          <a href="#sec-payments">Payments</a><a href="#sec-xborder">Cross-border</a><a href="#sec-security">Security</a><a href="#sec-faq">FAQ</a><a href="#">Sign in</a>
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
  ["100%", "Self-custodial", "usdc"],
];
const TRUST_MARK = {
  solana: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 7.5h11L14.5 10H3.5zM6 16.5h11L14.5 14H3.5z" fill="currentColor" stroke="none"/></svg>,
  squads: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>,
  qb: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M9.5 8a3 3 0 0 0 0 8M14.5 16a3 3 0 0 0 0-8"/></svg>,
  usdc: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.2a2.5 2.2 0 0 1 5 .3M14.5 14.8a2.5 2.2 0 0 1-5-.3"/></svg>,
};

function TrustStrip({ variant }) {
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
