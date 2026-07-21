// Features (16a "specimen plates"), FAQ (18b two-column dossier),
// final CTA (19a Monk-simple), and a minimal footer (not designed — kept simple).
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Marker, PersonIcon } from './shared';

const A = '/landing4/';
const monoLabel: CSSProperties = { font: '400 9px/1 var(--font-mono)', letterSpacing: '.16em', color: 'var(--text-muted)' };

/* ═══════════ features ═══════════ */
function MiniRow({ left, right, first }: { left: ReactNode; right?: ReactNode; first?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderTop: first ? undefined : '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>{left}</div>
      {right}
    </div>
  );
}

function MiniButton({ children }: { children: ReactNode }) {
  return (
    <button className="btn" style={{ width: '100%', height: 34, padding: '0 16px', fontSize: 11, borderRadius: 0, textTransform: 'uppercase', letterSpacing: '.04em', background: 'var(--ink)', color: '#FFFFFF', border: 'none', fontWeight: 600, pointerEvents: 'none' }}>
      {children}
    </button>
  );
}

function SignerAv({ bg, fg }: { bg: string; fg: string }) {
  return (
    <span style={{ width: 16, height: 16, background: bg, color: fg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flex: 'none' }}>
      <PersonIcon w={11} />
    </span>
  );
}

function SelfCustodyCard() {
  const signers: Array<[string, string, string, string]> = [
    ['Maya R.', 'CFO', '#CCD6DD', '#5B7083'],
    ['Lena T.', 'CONTROLLER', '#D4DCC9', '#6B7A55'],
    ['Rohan K.', 'TREASURER', '#E3D3C2', '#8A6A4F'],
    ['Priya N.', 'AP LEAD', '#D9CCE3', '#7A5B8A'],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: '16px 18px 14px', boxSizing: 'border-box' }}>
      <div style={monoLabel}>OPERATING ACCOUNT</div>
      <div style={{ marginTop: 9, font: '500 20px/1.18 Geist', letterSpacing: '-.01em', color: 'var(--ink)' }}>Self-custodial</div>
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ font: '600 25px/1 var(--font-mono)', letterSpacing: '-.01em', color: 'var(--ink)' }}>$482,190.34</span>
      </div>
      <div style={{ marginTop: 'auto' }}>
        <div style={{ font: '400 13px/1.28 Geist', color: 'var(--ink)', marginBottom: 9 }}>Money moves only when 2&nbsp;of&nbsp;4 sign.</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {signers.map(([name, role, bg, fg], i) => (
            <MiniRow
              key={name}
              first={i === 0}
              left={<><SignerAv bg={bg} fg={fg} /><span style={{ font: '400 10.5px/1 var(--font-body)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>{name}</span></>}
              right={<span style={{ font: '400 10px/1 var(--font-mono)', color: 'var(--text-muted)' }}>{role}</span>}
            />
          ))}
        </div>
        <div style={{ marginTop: 11 }}><MiniButton>Decimal holds no key</MiniButton></div>
      </div>
    </div>
  );
}

function VendorPortalCard() {
  const vendors: Array<[string, string]> = [
    ['HG', 'Hourglass'], ['BW', 'Brightwave'], ['SC', 'Summit Creative'], ['NW', 'Northwind'], ['OK', 'Oakline'], ['MV', 'Meridian'],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: '16px 18px 14px', boxSizing: 'border-box' }}>
      <div style={monoLabel}>VENDOR ONBOARDING</div>
      <div style={{ marginTop: 9, font: '500 20px/1.18 Geist', letterSpacing: '-.01em', color: 'var(--ink)' }}>Dedicated vendor portal</div>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column' }}>
        {vendors.map(([tag, name], i) => (
          <MiniRow
            key={tag}
            first={i === 0}
            left={<><span style={{ font: '400 8px/1 var(--font-mono)', letterSpacing: '.04em', color: 'var(--text-muted)', background: '#F1EDE8', padding: '3px 4px', flex: 'none' }}>{tag}</span><span style={{ font: '400 10.5px/1 var(--font-body)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>{name}</span></>}
          />
        ))}
        <MiniRow
          left={<><span style={{ font: '400 8px/1 var(--font-mono)', letterSpacing: '.04em', color: 'var(--text-muted)', background: '#F1EDE8', padding: '3px 4px', flex: 'none' }}>CV</span><span style={{ font: '400 10.5px/1 var(--font-body)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>Coppervale</span></>}
          right={<span style={{ font: '400 10px/1 var(--font-mono)', color: 'var(--text-muted)' }}>ACH ••3390</span>}
        />
      </div>
      <div style={{ marginTop: 'auto', position: 'relative', paddingTop: 12 }}><MiniButton>Request their details</MiniButton></div>
    </div>
  );
}

function LedgerSyncCard() {
  const rows: Array<[string, string, string]> = [
    ['6400', 'Software', '$2,400'], ['6100', 'Advertising', '$1,600'], ['6820', 'Subscriptions', '$518'],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: '16px 18px 14px', boxSizing: 'border-box' }}>
      <div style={monoLabel}>GENERAL LEDGER</div>
      <div style={{ marginTop: 9, font: '500 20px/1.18 Geist', letterSpacing: '-.01em', color: 'var(--ink)' }}>Two-way sync</div>
      <div style={{ marginTop: 'auto', paddingTop: 7, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ font: '400 8px/1 var(--font-mono)', letterSpacing: '.12em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>BRIGHTWAVE · JUN 6</span>
        <span style={{ font: '500 13px/1 Geist', letterSpacing: '-.01em', color: 'var(--ink)' }}>$4,518</span>
      </div>
      <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column' }}>
        {rows.map(([code, name, amt]) => (
          <MiniRow
            key={code}
            left={<><span style={{ font: '400 8px/1 var(--font-mono)', letterSpacing: '.04em', color: 'var(--text-muted)', background: '#F1EDE8', padding: '2px 4px' }}>{code}</span><span style={{ font: '400 10.5px/1 var(--font-body)', color: 'var(--ink)' }}>{name}</span></>}
            right={<span style={{ font: '400 10.5px/1 var(--font-mono)', color: 'var(--ink)' }}>{amt}</span>}
          />
        ))}
      </div>
      <div style={{ marginTop: 16, position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 0 }}>
        <div style={{ border: '1px solid #0A0A0A', padding: '9px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#F7F4F0' }}>
          <span style={{ font: '400 7.5px/1 var(--font-mono)', letterSpacing: '.12em', color: 'var(--solid)' }}>BILL TOTAL</span>
          <span style={{ font: '500 13px/1 Geist', letterSpacing: '-.01em', color: 'var(--ink)' }}>$4,518</span>
        </div>
        <div style={{ height: 22, margin: '-7px 0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ width: 36, height: 36, borderRadius: 99, background: 'var(--ink)', color: 'var(--bg-canvas)', border: '0.5px solid var(--solid)', boxShadow: '0 1px 5px rgba(69,23,38,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 2 }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(90deg)' }}><path d="M17 3l4 4-4 4M21 7H9M7 21l-4-4 4-4M3 17h12" /></svg>
          </span>
        </div>
        <div style={{ border: '1px solid #0A0A0A', padding: '9px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'var(--bg-surface-2, #F7F4F0)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 16, height: 16, borderRadius: 3, background: '#2CA01C', color: '#fff', font: '700 8px/1 var(--font-mono)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>qb</span>
            <span style={{ font: '500 11px/1 Geist', color: 'var(--ink)' }}>QuickBooks</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 13, height: 13, borderRadius: 99, background: '#3F7A57', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            </span>
            <span style={{ font: '400 9px/1 var(--font-mono)', letterSpacing: '.08em', color: 'var(--solid)' }}>SYNCED</span>
          </span>
        </div>
      </div>
      <div style={{ marginTop: 'auto', paddingTop: 12 }}><MiniButton>Nothing to re-key</MiniButton></div>
    </div>
  );
}

function FeatureCard({ img, imgScale, card, title, body }: { img: string; imgScale?: number; card: ReactNode; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)', border: '1px solid #0A0A0A' }}>
      <div style={{ position: 'relative', height: 405, overflow: 'hidden', background: 'var(--bg-surface)' }}>
        <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: imgScale ? `scale(${imgScale})` : undefined }} />
        <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: '80%', height: '75%', background: '#FFFFFF', border: '1px solid #0A0A0A', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {card}
        </div>
      </div>
      <div style={{ flex: 1, background: 'var(--bg-surface)', borderTop: '1px solid #0A0A0A', padding: '20px 22px 24px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <h3 style={{ margin: 0, font: 'var(--dw,600) 25px/1.2 var(--font-display)', letterSpacing: '-.01em', color: 'var(--ink)' }}>{title}</h3>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--text-muted)', textWrap: 'pretty' } as CSSProperties}>{body}</p>
      </div>
    </div>
  );
}

export function Features() {
  return (
    <div id="features" style={{ padding: '56px 64px', backgroundColor: 'var(--bg-surface)' }}>
      <div style={{ maxWidth: 1240, margin: '0 auto' }}>
        <h2 style={{ margin: 0, font: 'var(--dw,600) 40px/1.08 var(--font-display)', letterSpacing: '-.02em', color: 'var(--ink)' }}>
          More than <Marker side="right">payments.</Marker>
        </h2>
        <div style={{ marginTop: 40 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 25 }}>
            <FeatureCard
              img={A + 'purplecheck.jpg'} card={<SelfCustodyCard />} title="Self-custodial funds"
              body="Your funds stay in an account only you control. Decimal prepares every payment, but it can't move a dollar on its own, and no one can override that."
            />
            <FeatureCard
              img={A + 'water2.jpg'} imgScale={1.18} card={<VendorPortalCard />} title="Verified vendor onboarding"
              body="Payment details come straight from the vendor through a secure link, and Decimal verifies them before a cent goes out. Set up once, they stay on file for every bill after."
            />
            <FeatureCard
              img={A + 'sky1.jpg'} card={<LedgerSyncCard />} title="Two-way ledger sync"
              body="Every line is coded to your chart of accounts, and posted bills land in QuickBooks Online on their own. Nothing left to re-key at close."
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════ FAQ ═══════════ */
const FAQ_ITEMS: Array<{ q: string; a: string }> = [
  { q: 'What is Decimal?', a: 'Decimal is AI-powered accounts payable. It reads every vendor bill, codes it to your books, routes it through the approval flow you build, and pays your vendors, at home or overseas. You review and approve; the rest runs itself.' },
  { q: 'Can Decimal move money without my approval?', a: 'No. Your funds stay in a self-custodial account only your team controls. Decimal prepares and codes every payment, but nothing moves until your approval flow clears it, and no one, inside your company or at Decimal, can override that.' },
  { q: 'Can I pay vendors in other countries?', a: 'Yes. Pay a vendor in any country, in their own currency, at an exchange rate shown in the open. Send one payment or a whole run at once, with no correspondent banks and no week-long wire.' },
  { q: 'How do roles and permissions work?', a: 'Decimal ships with prebuilt roles: reviewer, approver, payer, and viewer, so each person sees and does only what their job needs. Separation of duties is enforced, and you set the rest to match your team.' },
  { q: 'Does Decimal work with my accounting software?', a: "Decimal syncs two ways with QuickBooks Online, so every coded, approved, and paid bill posts itself and there's nothing to re-key at close. More integrations are on the way." },
  { q: 'How do I get access?', a: "Decimal is onboarding its first customers now. Join the waitlist and we'll reach out as we open access, starting with teams that pay vendors across borders." },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div id="faq" style={{ padding: '56px 64px', backgroundColor: 'var(--bg-surface)' }}>
      <div style={{ maxWidth: 1240, margin: '0 auto', display: 'grid', gridTemplateColumns: '0.9fr 1.3fr', gap: 72, alignItems: 'start' }}>
        <div>
          <h2 style={{ margin: 0, font: 'var(--dw,600) 38px/1.1 var(--font-display)', letterSpacing: '-.02em', color: 'var(--ink)' }}>
            Frequently asked <Marker side="right">questions.</Marker>
          </h2>
        </div>
        <div style={{ borderBottom: '1px solid var(--border)' }}>
          {FAQ_ITEMS.map((item, i) => (
            <div key={item.q} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
              <button
                onClick={() => setOpen((o) => (o === i ? null : i))}
                style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 22px', gap: 20, alignItems: 'center', padding: '20px 0', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
              >
                <span style={{ font: 'var(--dw,600) 18px/1.3 var(--font-display)', letterSpacing: '-.01em', color: 'var(--ink)' }}>{item.q}</span>
                <span style={{ justifySelf: 'end', color: 'var(--ink)', display: 'inline-flex', transition: 'transform .22s ease', transform: open === i ? 'rotate(135deg)' : 'none' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                </span>
              </button>
              {open === i && (
                <p style={{ margin: 0, padding: '0 0 22px', maxWidth: 520, fontSize: 14, lineHeight: 1.62, color: '#5E5B57', textWrap: 'pretty' } as CSSProperties}>{item.a}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════ final CTA ═══════════ */
export function FinalCta() {
  return (
    <div style={{ padding: '104px 64px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', backgroundColor: '#5C1F33' }}>
      <h2 style={{ margin: 0, maxWidth: 820, font: 'var(--dw,600) 56px/1.08 var(--font-display)', letterSpacing: '-.02em', color: 'var(--bg-canvas)' }}>
        Put your accounts payable on autopilot.
      </h2>
      <p style={{ margin: '10px 0 0', fontSize: 16, lineHeight: 1.55, color: 'var(--bg-canvas)' }}>
        Decimal reads, codes, and pays every vendor bill, at home or overseas. You just approve.
      </p>
      <a
        href="/login"
        style={{ marginTop: 38, display: 'inline-flex', alignItems: 'center', gap: 12, height: 52, padding: '0 28px', color: '#5C1F33', border: 'none', borderRadius: 2, font: '600 13px var(--btn-font)', textTransform: 'uppercase', letterSpacing: '.08em', cursor: 'pointer', backgroundColor: '#FFFFFF' }}
      >
        Join the waitlist
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </a>
    </div>
  );
}

/* ═══════════ footer — one slim row, no CTA ═══════════ */
export function Footer() {
  return (
    <div style={{ padding: '14px 48px', background: '#FFFFFF', display: 'flex', alignItems: 'center', gap: 24 }}>
      <div style={{ font: 'var(--dw,600) 15px var(--font-display)', letterSpacing: '-.01em', color: 'var(--ink)' }}>
        Decimal<span style={{ color: 'var(--accent)' }}>.</span>
      </div>
      <div style={{ display: 'flex', gap: 20, fontSize: 12.5, color: 'var(--text-muted)' }}>
        <a href="#how-it-works" style={{ color: 'inherit' }}>How it works</a>
        <a href="#features" style={{ color: 'inherit' }}>Features</a>
        <a href="#faq" style={{ color: 'inherit' }}>FAQ</a>
      </div>
      <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-faint)' }}>© {new Date().getFullYear()} Decimal. All rights reserved.</span>
    </div>
  );
}
