// Hero (design artboard 20b): nav, marker headline, chart + Slack cards, and the
// product screen with its 18.5s bills-list → review → AI-extraction loop.
import type { CSSProperties, ReactNode } from 'react';
import { AnimField, Cursor, Marker, Shimmer } from './shared';
import { FitScale, M_PAD, useNarrow } from './responsive';

const A = '/landing4/';
const LOOP = '18.5s linear infinite';
// Left/right padding that pins content to the centered 1440 grid while the
// hero itself spans the full viewport (the product frame bleeds to the edge).
const EDGE_L = 'calc(max(0px, 50% - 720px) + 36px)';
const EDGE_R = 'calc(max(0px, 50% - 720px) + 48px)';
const fieldAnim = {
  pulse: `heroFieldPulse ${LOOP}`,
  val: `heroFieldVal ${LOOP}`,
  shimmer: `heroShimmer 18.5s ease-in-out infinite`,
};

/* ——— nav ——— */
export function Nav({ narrow }: { narrow?: boolean }) {
  return (
    <div style={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', padding: narrow ? `16px ${M_PAD}px` : '18px 0', paddingLeft: narrow ? M_PAD : EDGE_L, paddingRight: narrow ? M_PAD : EDGE_R }}>
      <div style={{ font: `var(--dw,600) ${narrow ? 20 : 22}px var(--font-display)`, letterSpacing: '-.01em', color: 'var(--ink)', transform: narrow ? undefined : 'translateX(12px)' }}>
        Decimal<span style={{ color: 'var(--accent)' }}>.</span>
      </div>
      {!narrow && (
        <div style={{ marginLeft: 'auto', marginRight: 0, display: 'flex', gap: 30, fontSize: 14, color: 'var(--text-muted)', paddingRight: 28 }}>
          <a href="#how-it-works" style={{ color: 'inherit' }}>How it works</a>
          <a href="#features" style={{ color: 'inherit' }}>Features</a>
          <a href="#faq" style={{ color: 'inherit' }}>FAQ</a>
        </div>
      )}
      <div style={{ marginLeft: narrow ? 'auto' : undefined, display: 'flex', gap: 10, alignItems: 'center' }}>
        <a className="btn btn-primary" href="/login" style={{ textTransform: 'uppercase', ...(narrow ? { height: 34, padding: '0 14px', fontSize: 11 } : null) }}>Join the waitlist</a>
      </div>
    </div>
  );
}

/* ——— left column: chart card ——— */
function ChartBox() {
  const label: CSSProperties = { fontSize: 9, color: 'var(--text-muted)', lineHeight: 1, fontFamily: 'Geist' };
  const value: CSSProperties = { fontSize: 11, fontWeight: 400, color: 'var(--text-primary)', lineHeight: 1, fontFamily: 'Geist' };
  const chip: CSSProperties = { font: '600 7px var(--font-mono)', background: 'color-mix(in srgb, var(--ink) 9%, var(--bg-surface))', color: 'var(--text-muted)', padding: '1px 3px', fontFamily: 'Geist' };
  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative', background: 'var(--bg-surface)', border: '1px solid var(--bg-canvas)', boxSizing: 'border-box', padding: '16px 12px 6px 14px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 48, left: 14, zIndex: 4, background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 6px 16px rgba(25,12,18,.10)', padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 11, height: 11, background: '#F9C6D0', flex: 'none' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={label}>Cross-border</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
              <span className="mono" style={value}>$961,000</span>
              <span style={chip}>+17%</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 11, height: 11, background: 'var(--ink)', flex: 'none' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={label}>Domestic</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
              <span className="mono" style={value}>$1,355,000</span>
              <span style={chip}>+7%</span>
            </div>
          </div>
        </div>
      </div>
      <div style={{ font: 'var(--dw,600) 13px/1.15 var(--font-display)', letterSpacing: '-.01em', color: 'var(--ink)' }}>What you pay, month by month</div>
      <div style={{ flex: 1, minHeight: 0, margin: '12px -12px 0 -14px' }}>
        <svg viewBox="0 0 210 330" preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
          <path d="M2,304 L2,224.2 C8.9,222.3 29.5,217.4 43.2,212.5 C56.9,207.6 70.7,201.7 84.4,194.9 C98.1,188.2 111.9,178.7 125.6,172 C139.3,165.3 153.1,159.6 166.8,155 C180.5,150.4 201.1,146.2 208,144.4 L208,304 Z" fill="var(--ink)" />
          <path d="M2,224.2 C8.9,222.3 29.5,217.4 43.2,212.5 C56.9,207.6 70.7,201.7 84.4,194.9 C98.1,188.2 111.9,178.7 125.6,172 C139.3,165.3 153.1,159.6 166.8,155 C180.5,150.4 201.1,146.2 208,144.4 L208,13.4 C201.1,18.4 180.5,32.1 166.8,43.3 C153.1,54.5 139.3,67.2 125.6,80.5 C111.9,93.8 98.1,110.7 84.4,123.1 C70.7,135.5 56.9,146.1 43.2,155 C29.5,163.9 8.9,172.8 2,176.3 Z" fill="#F9C6D0" />
          <path d="M2,224.2 C8.9,222.3 29.5,217.4 43.2,212.5 C56.9,207.6 70.7,201.7 84.4,194.9 C98.1,188.2 111.9,178.7 125.6,172 C139.3,165.3 153.1,159.6 166.8,155 C180.5,150.4 201.1,146.2 208,144.4" fill="none" stroke="#FFFFFF" strokeWidth="2" />
          <path d="M2,176.3 C8.9,172.8 29.5,163.9 43.2,155 C56.9,146.1 70.7,135.5 84.4,123.1 C98.1,110.7 111.9,93.8 125.6,80.5 C139.3,67.2 153.1,54.5 166.8,43.3 C180.5,32.1 201.1,18.4 208,13.4" fill="none" stroke="#E58BA1" strokeWidth="1.6" />
          <line x1="166.8" y1="6" x2="166.8" y2="304" stroke="#FFFFFF" strokeWidth="1" />
          <circle cx="166.8" cy="43.3" r="3.6" fill="var(--bg-canvas)" stroke="var(--bg-canvas)" strokeWidth="1.8" />
          <circle cx="166.8" cy="155" r="3.6" fill="var(--bg-canvas)" stroke="var(--bg-canvas)" strokeWidth="1.8" />
          {([['Mar', 2, 'start'], ['Apr', 43.2, 'middle'], ['May', 84.4, 'middle'], ['Jun', 125.6, 'middle'], ['Jul', 166.8, 'middle'], ['Aug', 208, 'end']] as const).map(([m, x, a]) => (
            <text key={m} x={x} y={320} textAnchor={a} fontSize="8.5" fill="var(--text-faint)" fontFamily="var(--font-mono)">{m}</text>
          ))}
        </svg>
      </div>
    </div>
  );
}

/* ——— left column: Slack card ——— */
function SlackLogo() {
  return (
    <svg width="9" height="9" viewBox="-4 -4 130.8 130.8" style={{ flex: 'none', overflow: 'visible' }}>
      <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9z" fill="#E01E5A" />
      <path d="M32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
      <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36C5F0" />
      <path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
      <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2z" fill="#2EB67D" />
      <path d="M90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
      <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9z" fill="#ECB22E" />
      <path d="M77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
    </svg>
  );
}

function SlackBill({ vendor, amount, sub, last }: { vendor: string; amount: string; sub: string; last?: boolean }) {
  return (
    <div style={{ padding: '6px 9px', borderBottom: last ? undefined : '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 8, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{vendor}</span>
        <span className="mono" style={{ fontSize: 8, color: 'var(--text-primary)', fontFamily: 'Geist', flex: 'none' }}>{amount}</span>
      </div>
      <div style={{ marginTop: 2, fontSize: 8, lineHeight: 1.5, color: 'var(--text-faint)' }}>{sub}</div>
    </div>
  );
}

function SlackBox() {
  const tag: CSSProperties = { font: '500 7.5px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--solid)', padding: '2px 7px' };
  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5, marginBottom: 8, padding: '0 14px' }}>
        <div style={{ display: 'flex', gap: 5 }}>
          <span style={{ ...tag, display: 'inline-flex', alignItems: 'center', gap: 4, border: '0.65px solid #EAE8E4', backgroundColor: '#EAE8E4' }}><SlackLogo />Slack</span>
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          <span style={{ ...tag, padding: '3px 7px', backgroundColor: '#D9EAD9' }}>Active</span>
          <span style={{ ...tag, display: 'inline-flex', alignItems: 'center', gap: 4, border: '0.65px solid #DCE5EE', backgroundColor: '#DCE5EE' }}># ap-approvals</span>
        </div>
      </div>
      <div style={{ border: '1px solid var(--bg-canvas)', boxSizing: 'border-box', padding: '15px 14px', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-canvas)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <img src={A + 'demo-girl.jpg'} alt="Lena" style={{ width: 16, height: 16, border: '0.65px solid var(--bg-canvas)', objectFit: 'cover', flex: 'none' }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 10, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 400 }}>Lena Cortez</div>
          </div>
          <span style={{ fontSize: 8, color: 'var(--text-faint)', flex: 'none' }}>Aug 1, 9:37</span>
        </div>
        <div style={{ marginTop: 8, fontSize: 8, lineHeight: 1.55, color: 'var(--text-primary)' }}>
          Hey @decimal, what's still open to pay this week? Pull up the bills with amounts and due dates so I can approve them in one go.
        </div>
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ width: 13, height: 13, boxSizing: 'border-box', border: '0.65px solid var(--bg-canvas)', background: 'var(--accent)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', font: '700 7.5px var(--font-display)', flex: 'none' }}>D</span>
          <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ fontSize: 8, fontWeight: 400, color: 'var(--text-primary)' }}>Decimal</div>
            <span style={{ font: '600 6px var(--font-mono)', letterSpacing: '.04em', background: 'var(--band)', color: 'var(--text-faint)', padding: '1px 3px', borderRadius: 2 }}>APP</span>
          </div>
          <span style={{ fontSize: 8, color: 'var(--text-faint)', flex: 'none' }}>Aug 1, 9:37</span>
        </div>
        <div style={{ marginTop: 8, fontSize: 8, lineHeight: 1.55, color: 'var(--text-primary)' }}>
          Morning Lena, 4 bills are open this week, <b style={{ color: 'var(--text-primary)', fontWeight: 500 }}>$59,460</b> total. All four are coded to your books and passed checks, so they're ready to approve:
        </div>
        <div style={{ marginTop: 9, border: '1px solid var(--border)' }}>
          <SlackBill vendor="Hanoi Textile Works" amount="$18,420" sub="Fabric order INV-2214, due Tuesday." />
          <SlackBill vendor="Anvil Works" amount="$29,743" sub="Office furniture INV-2481, due Tuesday." />
          <SlackBill vendor="Meridian Freight" amount="$6,497" sub="July shipping INV-1187, due Friday." />
          <SlackBill vendor="Kestrel Studio" amount="$4,800" sub="Design retainer INV-0331, due Thursday." last />
        </div>
        <div style={{ marginTop: 10, display: 'flex' }}>
          <button className="btn btn-primary" style={{ flex: 1, height: 22, padding: '0 10px', fontSize: 8, textTransform: 'uppercase', justifyContent: 'center', pointerEvents: 'none' }}>Approve all · $59,460</button>
        </div>
      </div>
    </div>
  );
}

/* ——— right visual: icon sidebar ——— */
function SideIcon({ children, active, mt }: { children: ReactNode; active?: boolean; mt?: number }) {
  return (
    <span style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: active ? 'var(--accent)' : 'var(--text-faint)', background: active ? 'var(--bg-surface-2)' : undefined, marginTop: mt }}>
      {children}
    </span>
  );
}

function Sidebar() {
  return (
    <div style={{ borderRight: '1px solid var(--border)', background: 'var(--band)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '12px 0' }}>
      <span style={{ width: 26, height: 26, background: 'var(--accent)', color: 'var(--accent-contrast)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', font: 'var(--dw,600) 14px var(--font-display)', marginBottom: 22 }}>D</span>
      <SideIcon><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></svg></SideIcon>
      <SideIcon active><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M6 2a1.6 1.6 0 0 0-1.6 1.6v16.8A1.6 1.6 0 0 0 6 22h12a1.6 1.6 0 0 0 1.6-1.6V8l-6-6H6zm2.5 10.2h7v1.8h-7v-1.8zm0 3.8h7v1.8h-7V16z" /></svg></SideIcon>
      <SideIcon mt={12}><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5 21.5 8.2h-19L12 2.5zM4.2 9.6h3v8.2h-3V9.6zm6.3 0h3v8.2h-3V9.6zm6.3 0h3v8.2h-3V9.6zM3 19.2h18v2.6H3v-2.6z" /></svg></SideIcon>
      <SideIcon><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M4 5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H4zm-2 4h20v3H2V9z" /></svg></SideIcon>
      <SideIcon><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7.5.4a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3.3 3.1-5.4 7-5.4s7 2.1 7 5.4v1H2v-1zm16.1 1H22v-1c0-2.3-1.6-4-3.9-4.6.7 1 1.1 2.2 1.1 3.6v2z" /></svg></SideIcon>
      <SideIcon mt={12}><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm-1.2-5.8-4.2-4.2 1.7-1.7 2.5 2.5 5.9-5.9 1.7 1.7-7.6 7.6z" /></svg></SideIcon>
      <SideIcon><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M14 3.2l6.8 4.8L14 12.8V10H8V6h6V3.2zM10 11.2 3.2 16l6.8 4.8V18h6v-4h-6v-2.8z" /></svg></SideIcon>
      <SideIcon><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M12 2 4 5.5V11c0 5 3.4 8.6 8 10.5 4.6-1.9 8-5.5 8-10.5V5.5L12 2zm-1.3 13.4-3.2-3.2 1.6-1.6 1.6 1.6 4.2-4.2 1.6 1.6-5.8 5.8z" /></svg></SideIcon>
      <SideIcon mt={12}><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M6.5 2A2.5 2.5 0 0 0 4 4.5v15A2.5 2.5 0 0 0 6.5 22H20v-3.4H7.6v-1.8H20V2H6.5z" /></svg></SideIcon>
      <span style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', marginTop: 'auto', marginBottom: 0 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M10.2 2.2h3.6l.5 2.5 2.2 1 2.1-1.5 2.5 2.5-1.4 2.1.9 2.2 2.5.5v3.6l-2.5.5-.9 2.2 1.4 2.1-2.5 2.5-2.1-1.4-2.2.9-.5 2.5h-3.6l-.5-2.5-2.2-.9-2.1 1.4-2.5-2.5 1.4-2.1-.9-2.2-2.5-.5v-3.6l2.5-.5.9-2.2-1.4-2.1 2.5-2.5 2.1 1.5 2.2-1 .5-2.5zM12 15.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8z" /></svg>
      </span>
      <img src={A + 'demo-girl.jpg'} alt="profile" style={{ width: 26, height: 26, borderRadius: 99, border: '1px solid var(--border)', objectFit: 'cover', marginTop: 6 }} />
    </div>
  );
}

/* ——— right visual: review screen (under the overlay) ——— */
function CategoryChip({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', padding: '2px 6px', fontSize: 9, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
      {children}
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
    </span>
  );
}

function LineRow({ desc, qty, unit, cat, amount }: { desc: string; qty: string; unit: string; cat: string; amount: string }) {
  return (
    <tr style={{ borderTop: '1px solid var(--border)', animation: `heroFieldVal ${LOOP}` }}>
      <td style={{ padding: '4px 0' }}>{desc}</td>
      <td className="mono" style={{ textAlign: 'right', padding: '4px 5px' }}>{qty}</td>
      <td className="mono" style={{ textAlign: 'right', padding: '4px 5px' }}>{unit}</td>
      <td style={{ padding: '4px 5px 4px 16px' }}><CategoryChip>{cat}</CategoryChip></td>
      <td className="mono" style={{ textAlign: 'right', padding: '7px 0' }}>{amount}</td>
    </tr>
  );
}

function PdfFlash({ children, anim = 'heroPdfFlash' }: { children: ReactNode; anim?: string }) {
  return <span style={{ animation: `${anim} ${LOOP}`, padding: '0 1px', borderRadius: 1 }}>{children}</span>;
}

function InvoicePdf() {
  return (
    <div className="rev-doc-wrap" style={{ flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', font: '500 10.5px var(--font-mono)', color: 'var(--text-muted)' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>Anvil-Works_INV-2481.pdf</span>
        <span style={{ flex: 'none', background: 'var(--bg-surface-2)', padding: '1px 6px', color: 'var(--text-faint)' }}>1 page</span>
        <span style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-faint)' }}>
          <span style={{ width: 18, height: 18, border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>−</span>
          <span>100%</span>
          <span style={{ width: 18, height: 18, border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>+</span>
          <span style={{ width: 18, height: 18, border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>⤢</span>
        </span>
      </div>
      <div className="rev-doc" style={{ padding: 8, alignItems: 'center', overflow: 'hidden' }}>
        <div className="doc-page" style={{ background: '#FFFFFF', boxShadow: '0 1px 8px rgba(10,10,10,.12)', padding: '26px 22px', boxSizing: 'border-box', fontFamily: 'Arial,Helvetica,sans-serif', fontSize: 9, color: '#1A1A1A', lineHeight: 1.55, width: '100%', aspectRatio: '1/1.414', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 11 }}><PdfFlash anim="heroVendorFlash">Anvil Works</PdfFlash></div>
              <div style={{ color: '#8A8A8A', fontSize: 8.5, lineHeight: 1.6 }}>
                <PdfFlash anim="heroEmailFlash">billing@anvilworks.com</PdfFlash><br />
                <PdfFlash>112 Foundry Ave</PdfFlash><br />
                <PdfFlash>Cleveland, OH 44113</PdfFlash>
              </div>
            </div>
            <div style={{ font: '700 14px Arial,Helvetica,sans-serif', letterSpacing: '.03em', color: '#1A1A1A' }}>INVOICE</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18, paddingTop: 14, borderTop: '1px solid #DDD', gap: 10 }}>
            <div>
              <div style={{ font: '600 8.5px Arial, Helvetica, sans-serif', letterSpacing: '.08em', color: '#B0B0B0' }}>BILL TO</div>
              <div style={{ fontWeight: 600, marginTop: 2 }}>Decimal Labs</div>
              <div style={{ color: '#8A8A8A', fontSize: 8.5, lineHeight: 1.6 }}>2211 Elliott Ave, Suite 400<br />Seattle, WA 98121</div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 8.5, color: '#B0B0B0', lineHeight: 1.9 }}>
              <div>Invoice no. <b style={{ color: '#1A1A1A', fontWeight: 500, marginLeft: 6, animation: `heroPdfFlash ${LOOP}`, padding: '0 1px', borderRadius: 1 }}>INV-2481</b></div>
              <div>Invoice date <b style={{ color: '#1A1A1A', fontWeight: 500, marginLeft: 6, animation: `heroPdfFlash ${LOOP}`, padding: '0 1px', borderRadius: 1 }}>2026-07-03</b></div>
              <div>Due date <b style={{ color: '#1A1A1A', fontWeight: 500, marginLeft: 6, animation: `heroPdfFlash ${LOOP}`, padding: '0 1px', borderRadius: 1 }}>2026-08-02</b></div>
              <div>Terms <b style={{ color: '#1A1A1A', fontWeight: 500, marginLeft: 6, animation: `heroPdfFlash ${LOOP}`, padding: '0 1px', borderRadius: 1 }}>Net 30</b></div>
            </div>
          </div>
          <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 9, flex: 1 }}>
            <div style={{ display: 'flex', color: '#B0B0B0', font: '600 8.5px Arial, Helvetica, sans-serif', letterSpacing: '.08em', borderBottom: '1px solid #DDD', paddingBottom: 4 }}>
              <span style={{ flex: 1 }}>DESCRIPTION</span><span style={{ width: 34, textAlign: 'right' }}>QTY</span><span style={{ width: 64, textAlign: 'right' }}>UNIT</span><span style={{ width: 70, textAlign: 'right' }}>AMOUNT</span>
            </div>
            {([['Standing desks', '24', '$640.00', '$15,360.00'], ['Office chairs', '36', '$340.00', '$12,240.00'], ['Delivery & assembly', '1', '$2,143.00', '$2,143.00']] as const).map(([d, q, u, a]) => (
              <div key={d} style={{ display: 'flex', animation: `heroPdfFlash ${LOOP}` }}>
                <span style={{ flex: 1 }}>{d}</span><span style={{ width: 34, textAlign: 'right' }}>{q}</span><span style={{ width: 64, textAlign: 'right' }}>{u}</span><span style={{ width: 70, textAlign: 'right' }}>{a}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid #DDD', display: 'flex', flexDirection: 'column', gap: 5, fontSize: 8.5 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, color: '#8A8A8A' }}><span>Subtotal</span><span style={{ width: 80, textAlign: 'right' }}>$29,743.00</span></div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, color: '#8A8A8A' }}><span>Tax</span><span style={{ width: 80, textAlign: 'right' }}>$0.00</span></div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, fontWeight: 700, fontSize: 10, animation: `heroPdfFlash ${LOOP}` }}><span>Total due</span><span style={{ width: 80, textAlign: 'right' }}>$29,743.00</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionBlock({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div style={{ margin: '14px -18px 0', borderTop: '1px solid var(--border)', padding: '12px 18px 0' }}>
      <div style={{ font: 'var(--dw,600) 15.5px var(--font-display)', color: 'var(--text-primary)' }}>{title}</div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 1 }}>{sub}</div>
      {children}
    </div>
  );
}

function ReviewScreen() {
  return (
    <div className="rev-shell" style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
        <span style={{ fontSize: 14 }}><span style={{ color: 'var(--text-muted)', fontSize: 12, animation: `b2CrumbHi ${LOOP}` }}>Bills</span></span>
        <span style={{ color: 'var(--text-faint)' }}>/</span><span>Review</span>
        <span style={{ color: 'var(--text-faint)' }}>/</span><span className="mono" style={{ fontSize: 11 }}>INV-2481</span>
      </div>
      <div className="rev-split">
        <div className="rev-panel" style={{ minWidth: 0, overflow: 'visible', flex: '0 0 56%', boxSizing: 'border-box', padding: '14px 18px 16px' }}>
          <div className="rev-head" style={{ margin: '0 -18px', padding: '0 18px 0', borderBottom: 'none' }}>
            <div>
              <h1 style={{ fontSize: 17 }}>INV-2481</h1>
              <div className="rh-sub" style={{ marginTop: 2 }}>Anvil Works</div>
            </div>
            <div className="rh-amount" style={{ fontSize: 16 }}>$29,743.00</div>
          </div>
          <SectionBlock title="Vendor" sub="First bill — payment details verified.">
            <div className="rev-grid" style={{ marginTop: 8, gridTemplateColumns: '1.4fr 1fr', gap: '8px 10px' }}>
              <AnimField label="Vendor name" value="Anvil Works" {...fieldAnim} pulse={`heroVendorPulse ${LOOP}`} />
              <AnimField label="Email" value="billing@anvilworks.com" {...fieldAnim} pulse={`heroEmailPulse ${LOOP}`} />
            </div>
            <div className="rev-grid" style={{ marginTop: 8, gridTemplateColumns: '1.5fr 1fr 0.7fr 0.9fr', gap: '8px 10px' }}>
              <AnimField label="Street" value="112 Foundry Ave" {...fieldAnim} />
              <AnimField label="City" value="Cleveland" {...fieldAnim} />
              <AnimField label="State" value="OH" {...fieldAnim} />
              <AnimField label="ZIP code" value="44113" {...fieldAnim} />
            </div>
          </SectionBlock>
          <SectionBlock title="Bill details" sub="Everything checks out.">
            <div className="rev-grid" style={{ marginTop: 8, gridTemplateColumns: '1fr 1fr 1fr', gap: '8px 10px' }}>
              <AnimField label="Invoice number" value="INV-2481" mono {...fieldAnim} />
              <AnimField label="Invoice date" value="2026-07-03" mono {...fieldAnim} />
              <AnimField label="Due date" value="2026-08-02" mono {...fieldAnim} />
              <AnimField label="Terms" value="Net 30" {...fieldAnim} />
              <AnimField label="Currency" value="USD" {...fieldAnim} />
              <AnimField label="Total due" value="29,743.00" mono {...fieldAnim} />
            </div>
          </SectionBlock>
          <div style={{ margin: '14px -18px 0', borderTop: '1px solid var(--border)', padding: '12px 18px 0' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <div style={{ font: 'var(--dw,600) 15.5px var(--font-display)', color: 'var(--text-primary)' }}>Line items</div>
              <span style={{ font: '600 9.5px var(--btn-font)', letterSpacing: '.06em', textTransform: 'uppercase', background: 'var(--primary)', color: 'var(--primary-contrast)', padding: '5px 10px', borderRadius: 2 }}>+ Add a line</span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 1 }}>Categories read from the invoice.</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, fontSize: 9.5 }}>
              <thead>
                <tr style={{ color: 'var(--text-faint)', font: '600 8px var(--font-mono)', letterSpacing: '.06em' }}>
                  <td style={{ padding: '4px 0' }}>DESCRIPTION</td>
                  <td style={{ textAlign: 'right', padding: '4px 6px' }}>QTY</td>
                  <td style={{ textAlign: 'right', padding: '4px 6px' }}>UNIT</td>
                  <td style={{ padding: '4px 6px 4px 16px' }}>CATEGORY</td>
                  <td style={{ textAlign: 'right', padding: '4px 0' }}>AMOUNT</td>
                </tr>
              </thead>
              <tbody>
                <LineRow desc="Standing desks" qty="24" unit="$640.00" cat="Office furniture" amount="$15,360.00" />
                <LineRow desc="Office chairs" qty="36" unit="$340.00" cat="Office furniture" amount="$12,240.00" />
                <LineRow desc="Delivery & assembly" qty="1" unit="$2,143.00" cat="Delivery" amount="$2,143.00" />
              </tbody>
            </table>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', animation: `heroCheckIn ${LOOP}` }}>
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)', fontWeight: 500 }}>✓ Adds up to the document's total</span>
              <span style={{ fontSize: 11, fontWeight: 600 }}>Total <span className="mono" style={{ marginLeft: 10 }}>$29,743.00</span></span>
            </div>
          </div>
        </div>
        <div style={{ width: 1, background: 'var(--border)', flex: 'none' }} />
        <InvoicePdf />
      </div>
      <div className="commit-bar" style={{ padding: '9px 16px' }}>
        <span className="commit-spacer" />
        <button className="btn btn-primary btn-sm" style={{ animation: 'pulseRing 2.4s ease 1.5s infinite', textTransform: 'uppercase', pointerEvents: 'none' }}>Confirm &amp; send for approval</button>
      </div>
    </div>
  );
}

/* ——— right visual: bills-list overlay ——— */
type BillRow = { vendor: string; country: string; inv: string; amount: string; due: string; dueRed?: boolean; status: string; statusBg: string; anim?: number };
const BILL_ROWS: BillRow[] = [
  { vendor: 'Anvil Works', country: 'United States', inv: 'INV-2481', amount: '$29,743', due: 'Aug 12', status: 'Needs review', statusBg: '#EFE9DD', anim: 1 },
  { vendor: 'Hanoi Textile Works', country: 'Vietnam', inv: 'INV-2214', amount: '$18,420', due: 'Aug 9', status: 'Waiting on Priya', statusBg: '#DCE5EE', anim: 2 },
  { vendor: 'Shenzhen Kiro Electronics', country: 'China', inv: '8871', amount: '$33,750', due: 'Jul 30', dueRed: true, status: 'Overdue · 2 days', statusBg: '#F6DAD5', anim: 3 },
  { vendor: 'Meridian Freight', country: 'United Kingdom', inv: 'INV-4021', amount: '$6,442', due: 'Aug 5', status: 'Ready to pay', statusBg: '#D9EAD9', anim: 4 },
  { vendor: 'Lumen Cloud', country: 'United States', inv: 'LC-90455', amount: '$2,940', due: 'Aug 8', status: 'In approval', statusBg: '#F4E6C6', anim: 5 },
  { vendor: 'Otavo Packaging', country: 'Mexico', inv: 'OT-118', amount: '$6,210', due: 'Aug 14', status: 'Waiting on Rohan', statusBg: '#DCE5EE', anim: 6 },
  { vendor: 'Möbel Braun', country: 'Germany', inv: 'MB-2207', amount: '$12,900', due: 'Aug 18', status: 'Needs review', statusBg: '#EFE9DD', anim: 7 },
  { vendor: 'Brightwave', country: 'United States', inv: 'BW-6', amount: '$4,518', due: 'Jul 22', status: 'Paid Jul 24', statusBg: '#E9E9E4' },
  { vendor: 'Northwind', country: 'United States', inv: 'NW-3391', amount: '$8,120', due: 'Aug 6', status: 'Possible duplicate', statusBg: '#F6DAD5' },
  { vendor: 'Nord Supply', country: 'Netherlands', inv: 'NS-77', amount: '$33,750', due: 'Aug 20', status: 'In approval', statusBg: '#F4E6C6' },
  { vendor: 'Toolbox Supply', country: 'United States', inv: 'TS-88', amount: '$960', due: 'Aug 3', status: 'Ready to pay', statusBg: '#D9EAD9' },
  { vendor: 'Copperline Mfg', country: 'United States', inv: 'CL-5567', amount: '$14,230', due: 'Aug 22', status: 'In approval', statusBg: '#F4E6C6' },
  { vendor: 'Cedar Grove Supply', country: 'United States', inv: 'CG-4410', amount: '$5,230', due: 'Aug 25', status: 'Needs review', statusBg: '#EFE9DD' },
  { vendor: 'Baltic Freight', country: 'Estonia', inv: 'BF-99', amount: '$9,840', due: 'Aug 15', status: 'In approval', statusBg: '#F4E6C6' },
  { vendor: 'Aurora Labs', country: 'United States', inv: 'AL-771', amount: '$3,120', due: 'Aug 11', status: 'Ready to pay', statusBg: '#D9EAD9' },
];

const cellBase: CSSProperties = { height: 30, verticalAlign: 'middle', borderTop: '1px solid var(--border)', lineHeight: 1, whiteSpace: 'nowrap' };

function StatTile({ label, n, sub }: { label: string; n: string; sub: string }) {
  return (
    <div style={{ flex: 1, background: 'var(--band)', padding: '11px 13px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ font: '400 25px var(--font-body)', color: '#1A1A1A', marginTop: 4, lineHeight: 1 }}>{n}</div>
      <div style={{ fontSize: 9, color: 'var(--text-faint)', marginTop: 5 }}>{sub}</div>
    </div>
  );
}

function Tab({ label, n, active }: { label: string; n: string; active?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', padding: '0 0 9px', font: `${active ? 600 : 500} 11px var(--font-body)`, color: active ? 'var(--ink)' : 'var(--text-muted)', borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`, marginBottom: -1 }}>
      {label} <span className="mono" style={{ fontSize: 9, color: active ? 'var(--text-muted)' : 'var(--text-faint)' }}>{n}</span>
    </span>
  );
}

function BillsOverlay() {
  const th: CSSProperties = { padding: '0 22px 7px 22px', textAlign: 'left', font: '600 8px var(--font-mono)', letterSpacing: '.08em', color: 'var(--text-faint)' };
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--bg-surface)', zIndex: 5, overflow: 'hidden', animation: `b2Overlay ${LOOP}` }}>
      <div className="rev-shell" style={{ minWidth: 0, height: 711, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '15px 30px 13px' }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: '3px 0 0', font: 'var(--dw,600) 23px var(--font-display)', color: 'var(--ink)', letterSpacing: '-.01em' }}>Bills</h1>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>Every incoming bill, from inbox to paid. You review and approve; Decimal does the rest.</div>
          </div>
          <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto', flex: 'none', textTransform: 'uppercase', fontSize: 11, whiteSpace: 'nowrap', pointerEvents: 'none' }}>+ Upload a bill</button>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '2px 30px 6px' }}>
          <StatTile label="Waiting on you" n="3" sub="Needs your review today" />
          <StatTile label="In approval" n="5" sub="Moving through sign-off" />
          <StatTile label="To pay" n="2" sub="Approved, ready to send" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '9px 30px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, borderBottom: '1px solid var(--border)' }}>
            <Tab label="All" n="22" active />
            <Tab label="Needs review" n="3" />
            <Tab label="In approval" n="5" />
            <Tab label="To pay" n="2" />
            <Tab label="Done" n="12" />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', padding: '4px 8px', color: 'var(--text-faint)', background: 'var(--bg-surface)' }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>Search vendor or invoice</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', padding: '4px 8px', background: 'var(--bg-surface)', fontSize: 10, color: 'var(--text-muted)' }}>
              Sort: Due date
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
            </div>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', padding: '6px 30px 0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
            <thead>
              <tr>
                <th style={{ ...th, padding: '0 22px 7px 4px' }}>VENDOR</th>
                <th style={th}>COUNTRY</th>
                <th style={th}>INVOICE</th>
                <th style={{ ...th, textAlign: 'right' }}>AMOUNT</th>
                <th style={th}>DUE</th>
                <th style={{ ...th, padding: '0 0 7px 22px' }}>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {BILL_ROWS.map((r) => (
                <tr key={r.inv} style={r.anim ? { animation: `b2RowH${r.anim} ${LOOP}` } : undefined}>
                  <td style={{ ...cellBase, padding: '0 22px 0 4px', fontSize: 11, fontWeight: 400, color: 'var(--text-primary)' }}>{r.vendor}</td>
                  <td style={{ ...cellBase, padding: '0 22px', fontSize: 10.5, color: 'var(--text-muted)' }}>{r.country}</td>
                  <td className="mono" style={{ ...cellBase, padding: '0 22px', fontSize: 10.5, color: 'var(--text-faint)' }}>{r.inv}</td>
                  <td className="mono" style={{ ...cellBase, padding: '0 22px', textAlign: 'right', fontWeight: 400, fontSize: 11, color: 'var(--text-primary)' }}>{r.amount}</td>
                  <td className="mono" style={{ ...cellBase, padding: '0 22px', fontSize: 10.5, color: r.dueRed ? 'var(--danger)' : 'var(--text-muted)' }}>{r.due}</td>
                  <td style={{ ...cellBase, padding: '0 0 0 22px' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', background: r.statusBg, color: '#1A1A1A', font: '500 9px var(--font-body)', letterSpacing: '.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{r.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ——— hero section ——— */
/* ——— hero copy + cards (shared) ——— */
function HeroCopy({ narrow }: { narrow: boolean }) {
  return (
    <div style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', padding: narrow ? 0 : '0 0 28px', transform: narrow ? undefined : 'translateX(12px)' }}>
      <h1 style={{ margin: 0, font: `var(--dw,600) ${narrow ? 38 : 48}px/1.05 var(--font-display)`, letterSpacing: '-.02em', color: 'var(--ink)', animation: 'fadeUp .6s ease both' }}>
        <Marker>Self-driving</Marker> <br />Accounts Payable.
      </h1>
      <p style={{ margin: '14px 0 0', fontSize: narrow ? 16 : 15.5, lineHeight: 1.55, maxWidth: narrow ? undefined : 400, color: 'var(--text-muted)', animation: 'fadeUp .6s ease .15s both' }}>
        Get your vendor bills read, coded to your books, and paid on time, anywhere in the world. You just approve.
      </p>
      <div style={{ display: 'flex', gap: 12, marginTop: 22, animation: 'fadeUp .6s ease .3s both' }}>
        <a className="btn btn-primary" href="/login" style={{ height: 40, padding: '0 20px', fontSize: 13, textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center' }}>Join the waitlist</a>
      </div>
      <div style={{ marginTop: narrow ? 28 : 36, flex: 1, display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: 18, alignItems: 'stretch', paddingRight: narrow ? 0 : 10 }}>
        <ChartBox />
        <SlackBox />
      </div>
    </div>
  );
}

/* ——— the product screen (mask + frame) ——— */
function ProductFrame() {
  return (
    <div style={{ position: 'relative', minWidth: 0, alignSelf: 'start', padding: '11px 0 0 11px', boxSizing: 'border-box', animation: 'fadeUp .7s ease .4s both' }}>
      {/* Art ends flush with the product frame's bottom edge (top overhang only). */}
      <div style={{ position: 'absolute', top: -17, left: -20, width: 'calc(100% + 35px)', height: 'calc(100% + 17px)', background: 'var(--ink)', WebkitMaskImage: `url('${A}art2-hatch.png')`, maskImage: `url('${A}art2-hatch.png')`, WebkitMaskSize: '100% 100%', maskSize: '100% 100%', pointerEvents: 'none' }} />
      <div style={{ position: 'relative', boxSizing: 'border-box', background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: '0 24px 70px rgba(10,10,10,.10)', overflow: 'hidden', display: 'grid', gridTemplateColumns: '50px 1fr' }}>
        <Sidebar />
        <div style={{ position: 'relative', minWidth: 0 }}>
          <ReviewScreen />
          <BillsOverlay />
          <Cursor style={{ position: 'absolute', top: 14, left: 24, zIndex: 20, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.3))', animation: `b2Cur ${LOOP}` }} />
        </div>
      </div>
    </div>
  );
}

export function Hero() {
  const narrow = useNarrow();

  if (narrow) {
    return (
      <div style={{ position: 'relative', background: '#FFFFFF', overflow: 'hidden', paddingBottom: 48 }}>
        <Nav narrow />
        <div style={{ padding: `28px ${M_PAD}px 0` }}>
          <HeroCopy narrow />
        </div>
        {/* product screen as a scaled, full-width preview (natural width 900) */}
        <div style={{ marginTop: 36, padding: `0 ${M_PAD}px` }}>
          <FitScale w={900}>
            <ProductFrame />
          </FitScale>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', background: '#FFFFFF', overflow: 'hidden', paddingBottom: 88 }}>
      <Nav />
      <div style={{ position: 'relative', zIndex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 476px) minmax(0, 1fr)', gap: 44, alignItems: 'start', padding: '64px 0 0', paddingLeft: EDGE_L, boxSizing: 'border-box' }}>
        <HeroCopy narrow={false} />
        <ProductFrame />
      </div>
    </div>
  );
}

export { Shimmer };
