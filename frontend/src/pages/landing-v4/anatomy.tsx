// Anatomy of a bill (design artboard 6a): bridge header + three plates.
// Plate 01 — AI extraction 12s loop · Plate 02 — flow builder (10s) alternating
// with the approval timeline (12s) via state remount · Plate 03 — payment run
// panel + d3 globe, 16s loop phase-locked via --gbd animation delays.
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { AnimField, Av, Cursor, Marker, Shimmer } from './shared';
import { PayGlobe } from './globe';

const A = '/landing4/';

/* ═══════════ bridge header ═══════════ */
function Bridge() {
  return (
    <div style={{ padding: '52px 64px 44px', display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 56, alignItems: 'center' }}>
      <div>
        <h2 style={{ margin: 0, font: 'var(--dw,600) 40px/1.08 var(--font-display)', letterSpacing: '-.02em', color: 'var(--ink)' }}>
          <Marker>Anatomy</Marker> of a bill.
        </h2>
        <p style={{ margin: '14px 0 0', fontSize: 14.5, lineHeight: 1.55, maxWidth: 460, color: 'var(--text-muted)' }}>
          A bill gets read, approved, paid, and booked. Today, every one of them is your team's manual work. Decimal takes all four, and leaves you a single decision: approve it, or don't.
        </p>
      </div>
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', alignSelf: 'stretch', width: 600, height: 161, marginTop: -22 }}>
        <div style={{ width: 454, maxWidth: 360, height: 180, background: 'var(--ink)', WebkitMaskImage: `url('${A}skull-mask.png')`, maskImage: `url('${A}skull-mask.png')`, WebkitMaskSize: 'contain', maskSize: 'contain', WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat', WebkitMaskPosition: 'center', maskPosition: 'center' }} />
      </div>
    </div>
  );
}

/* ═══════════ plate copy blocks ═══════════ */
function PlateCopy({ title, blocks, padding }: { title: string; blocks: Array<{ mark: string; body: string; padTop?: number }>; padding: string }) {
  return (
    <div style={{ padding, display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ margin: 0, font: 'var(--dw,600) 30px/1.12 var(--font-display)', letterSpacing: '-.015em', color: 'var(--ink)' }}>{title}</h3>
      {blocks.map((b) => (
        <div key={b.mark} style={{ marginTop: 'auto', paddingTop: b.padTop ?? 56 }}>
          <div style={{ font: 'var(--dw,600) 21px/1.18 var(--font-display)', letterSpacing: '-.01em', color: 'var(--ink)' }}>
            <Marker>{b.mark}</Marker>
          </div>
          <p style={{ margin: '13px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)' }}>{b.body}</p>
        </div>
      ))}
    </div>
  );
}

/* ═══════════ Plate 01 — AI extraction (12s loop) ═══════════ */
const p1Anim = { pulse: 'loopPulse 12s linear infinite', val: 'fVal1 12s linear infinite', shimmer: 'loopShimmer 12s ease-in-out infinite' };

function P1Cell({ children, right, muted }: { children: ReactNode; right?: boolean; muted?: boolean }) {
  return (
    <td style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)', padding: '4px 8px', textAlign: right ? 'right' : undefined, color: muted ? 'var(--text-muted)' : undefined, position: 'relative', overflow: 'hidden', animation: p1Anim.pulse }}>
      <span style={{ animation: p1Anim.val }}>{children}</span>
      <Shimmer anim={p1Anim.shimmer} />
    </td>
  );
}

function P1CatCell({ children }: { children: ReactNode }) {
  return (
    <td style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)', padding: '4px 8px', position: 'relative', overflow: 'hidden', animation: p1Anim.pulse }}>
      <span style={{ animation: p1Anim.val, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5 }}>
        {children}
        <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
      </span>
      <Shimmer anim={p1Anim.shimmer} />
    </td>
  );
}

function P1Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className="field-label" style={{ fontSize: 8.5, textAlign: right ? 'right' : 'left', border: '1px solid var(--border)', background: 'var(--ink)', color: '#FFFFFF', padding: '4px 8px', fontWeight: 500 }}>{children}</th>;
}

function Plate01Visual() {
  return (
    <div style={{ position: 'relative', background: 'var(--band)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', margin: '36px 36px 36px 140px', padding: '40px 36px' }}>
      <div style={{ position: 'relative', width: '64%', border: 'none', backgroundColor: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', minHeight: 205 }}>
        <svg aria-hidden="true" style={{ position: 'absolute', inset: 1, width: 'calc(100% - 2px)', height: 'calc(100% - 2px)', pointerEvents: 'none', overflow: 'visible' }} stroke="color-mix(in srgb, var(--ink) 70%, #FFFFFF)" strokeWidth="2" strokeLinecap="square">
          <line x1="0%" y1="0%" x2="100%" y2="0%" pathLength={608} strokeDasharray="8 4" />
          <line x1="0%" y1="100%" x2="100%" y2="100%" pathLength={608} strokeDasharray="8 4" />
          <line x1="0%" y1="0%" x2="0%" y2="100%" pathLength={308} strokeDasharray="8 4" />
          <line x1="100%" y1="0%" x2="100%" y2="100%" pathLength={308} strokeDasharray="8 4" />
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'zoneFade 12s linear infinite' }}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="var(--ink)">
            <path d="M12 4.5c2.6 0 4.8 1.8 5.4 4.2 2 .3 3.6 2 3.6 4.1 0 2.3-1.9 4.2-4.2 4.2h-2.3v-2h2.3c1.2 0 2.2-1 2.2-2.2 0-1.2-1-2.2-2.2-2.2h-.9l-.2-.9c-.4-1.7-1.9-3.2-3.7-3.2-1.8 0-3.3 1.5-3.7 3.2l-.2.9h-.9c-1.2 0-2.2 1-2.2 2.2 0 1.2 1 2.2 2.2 2.2h2.3v2H7.2C4.9 17 3 15.1 3 12.8c0-2.1 1.6-3.8 3.6-4.1.6-2.4 2.8-4.2 5.4-4.2z" />
            <path d="M12 10.2l3.2 3.4h-2.2V20h-2v-6.4H8.8z" />
          </svg>
          <div aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', animation: 'dragPath 12s ease-in-out infinite' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, transform: 'translate(-50%,-50%)' }}>
              <div style={{ position: 'relative', background: '#FFFFFF', border: '1px solid var(--border-strong)', boxShadow: '0 10px 26px rgba(10,10,10,.16)', width: 138, height: 196, boxSizing: 'border-box', padding: '16px 15px', animation: 'invTilt 12s ease-in-out infinite' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ font: '700 7.5px Arial,Helvetica,sans-serif', letterSpacing: '.06em', color: '#1A1A1A' }}>INVOICE</span>
                  <span style={{ font: '600 6px Arial,Helvetica,sans-serif', color: '#B0B0B0' }}>INV-2481</span>
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {['82%', '64%', '74%', '58%'].map((w, i) => <span key={i} style={{ display: 'block', height: 2.5, width: w, background: '#DBDBDB' }} />)}
                </div>
                <div style={{ marginTop: 12, borderTop: '1px solid #E6E6E6', paddingTop: 7, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {[0, 1, 2].map((i) => <span key={i} style={{ display: 'block', height: 2.5, width: '88%', background: '#EBEBEB' }} />)}
                </div>
                <div style={{ marginTop: 11, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 5 }}>
                  <span style={{ font: '600 5.5px Arial,Helvetica,sans-serif', color: '#B0B0B0' }}>TOTAL</span>
                  <span style={{ display: 'block', height: 4, width: '30%', background: 'var(--ink)' }} />
                </div>
              </div>
              <Cursor w={23} style={{ position: 'absolute', left: '50%', top: 14, marginLeft: -11, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.3))', animation: 'cursorGrab 12s ease-in-out infinite' }} />
            </div>
          </div>
          <div style={{ fontSize: 15, fontWeight: 400, marginTop: 16 }}>Choose a file or drag &amp; drop it here</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 7 }}>PDFs and photos, up to 10 at once</div>
        </div>
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, animation: 'procIn 12s linear infinite' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
            <span className="mono" style={{ fontSize: 11, fontWeight: 500 }}>Anvil-Works_INV-2481.pdf</span>
          </div>
          <div style={{ width: 150, height: 3, background: 'color-mix(in srgb, var(--ink) 12%, transparent)', marginTop: 14, overflow: 'hidden', animation: 'procTrack 12s linear infinite' }}>
            <div style={{ height: '100%', background: 'var(--ink)', animation: 'procBar 12s linear infinite' }} />
          </div>
          <button className="btn btn-primary" style={{ marginTop: 14, height: 32, padding: '0 18px', fontSize: 11, borderRadius: 0, animation: 'revealBtn 12s linear infinite', pointerEvents: 'none' }}>Review bill</button>
          <Cursor w={23} style={{ position: 'absolute', left: '50%', top: '50%', margin: '26px 0 0 2px', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.3))', animation: 'clickCursor 12s linear infinite' }} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 14, fontSize: 13, color: 'var(--text-muted)' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
        <span>Or forward the bill to <span className="mono" style={{ color: 'var(--ink)', fontWeight: 500 }}>ap@decimal.finance</span></span>
      </div>
      {/* review overlay — fades in at 48% of the 12s loop */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'var(--band)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 34px', pointerEvents: 'none', opacity: 0, animation: 'reviewIn 12s linear infinite' }}>
        <div style={{ width: '100%', textAlign: 'left' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
            <div>
              <div style={{ font: 'var(--dw,600) 13px var(--font-display)', color: 'var(--ink)' }}>Vendor</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: '6px 8px', marginTop: 6 }}>
                <AnimField label="Vendor name" value="Anvil Works" {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
                <AnimField label="Email" value="billing@anvilworks.com" {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.6fr 0.8fr', gap: '6px 8px', marginTop: 6 }}>
                <AnimField label="Street" value="112 Foundry Ave" {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
                <AnimField label="City" value="Cleveland" {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
                <AnimField label="State" value="OH" {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
                <AnimField label="ZIP" value="44113" {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
              </div>
            </div>
            <div>
              <div style={{ font: 'var(--dw,600) 13px var(--font-display)', color: 'var(--ink)' }}>Bill details</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px 8px', marginTop: 6 }}>
                <AnimField label="Invoice number" value="INV-2481" mono {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
                <AnimField label="Invoice date" value="2026-07-03" mono {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
                <AnimField label="Due date" value="2026-08-02" mono {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
                <AnimField label="Terms" value="Net 30" {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
                <AnimField label="Currency" value="USD" {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
                <AnimField label="Total due" value="29,743.00" mono {...p1Anim} minHeight={24} fontSize={10} labelSize={8.5} />
              </div>
            </div>
          </div>
          <div style={{ font: 'var(--dw,600) 13px var(--font-display)', color: 'var(--ink)', marginTop: 14 }}>Line items</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6, fontSize: 10 }}>
            <thead>
              <tr><P1Th>Description</P1Th><P1Th right>Qty</P1Th><P1Th right>Unit price</P1Th><P1Th>Category</P1Th><P1Th right>Amount</P1Th></tr>
            </thead>
            <tbody>
              <tr><P1Cell>Standing desks</P1Cell><P1Cell right muted>24</P1Cell><P1Cell right muted>$640.00</P1Cell><P1CatCell>Office furniture</P1CatCell><P1Cell right>$15,360.00</P1Cell></tr>
              <tr><P1Cell>Office chairs</P1Cell><P1Cell right muted>36</P1Cell><P1Cell right muted>$340.00</P1Cell><P1CatCell>Office furniture</P1CatCell><P1Cell right>$12,240.00</P1Cell></tr>
              <tr><P1Cell>Delivery &amp; assembly</P1Cell><P1Cell right muted>1</P1Cell><P1Cell right muted>$2,143.00</P1Cell><P1CatCell>Delivery</P1CatCell><P1Cell right>$2,143.00</P1Cell></tr>
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <span style={{ fontSize: 9.5, color: 'var(--ink)', fontWeight: 500, animation: p1Anim.val }}>✓ Adds up to the document's total</span>
            <span style={{ fontSize: 10, fontWeight: 600 }}>Total <span className="mono" style={{ marginLeft: 8, animation: p1Anim.val }}>$29,743.00</span></span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════ Plate 02 — flow builder (10s) ═══════════ */
const FLOW_WIRES: Array<[string, number]> = [
  ['382,45 382,56', 1], ['382,100 382,112', 2],
  ['382,145 382,158 200,158 200,204', 4], ['382,145 382,158 560,158 560,204', 4],
  ['200,248 200,260', 6], ['200,293 200,306 105,306 105,352', 6], ['200,293 200,306 320,306 320,352', 6],
  ['105,396 105,508', 7], ['320,385 320,398 250,398 250,444', 7], ['320,385 320,398 390,398 390,508', 7], ['250,488 250,508', 7],
  ['560,237 560,250 480,250 480,296', 5], ['560,237 560,250 660,250 660,356', 5],
  ['480,340 480,508', 7], ['660,400 660,508', 7],
  ['105,508 660,508', 8], ['382,508 382,522', 8],
];

function YesNo({ left, top, yes, aw }: { left: number; top: number; yes: boolean; aw: number }) {
  return (
    <span style={{ position: 'absolute', left, top, transform: 'translateX(-50%)', display: 'inline-flex', alignItems: 'center', gap: 5, background: yes ? '#2E7D43' : '#B3261E', color: '#FFFFFF', padding: '2px 9px', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap', animation: `aw${aw} 10s linear 1 both`, opacity: 0 }}>
      {yes ? (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      )}
      {yes ? 'Yes' : 'No'}
    </span>
  );
}

function StepCard({ left, top, width, aw, title, sub, avatars, dashed, bolt }: { left: number; top: number; width?: number; aw: number; title: string; sub: string; avatars?: Array<[string, string]>; dashed?: boolean; bolt?: boolean }) {
  return (
    <div style={{ position: 'absolute', left, top, width, transform: 'translateX(-50%)', boxSizing: 'border-box', background: 'var(--bg-surface)', border: dashed ? '1px dashed var(--border-strong)' : '1px solid var(--border)', padding: '8px 10px', animation: `aw${aw} 10s linear 1 both`, opacity: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 10.5, lineHeight: 1.3, fontWeight: 500 }}>{title}</span>
          <span style={{ display: 'block', fontSize: 8.5, lineHeight: 1.3, color: 'var(--text-faint)', marginTop: 1 }}>{sub}</span>
        </span>
        <span style={{ display: 'flex', flex: 'none' }}>
          {bolt ? (
            <span style={{ width: 22, height: 22, borderRadius: 99, background: 'var(--ink)', color: '#FFFFFF', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
            </span>
          ) : (
            avatars?.map(([bg, fg], i) => <Av key={i} bg={bg} fg={fg} ml={i ? -6 : 0} />)
          )}
        </span>
      </div>
    </div>
  );
}

function CondCard({ left, top, aw, children }: { left: number; top: number; aw: number; children: ReactNode }) {
  return (
    <div style={{ position: 'absolute', left, top, transform: 'translateX(-50%)', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, whiteSpace: 'nowrap', animation: `aw${aw} 10s linear 1 both`, opacity: 0 }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
      <span>{children}</span>
    </div>
  );
}

function AiPromptBar() {
  const btn: CSSProperties = { width: 28, height: 28, border: 'none', background: 'var(--ink)', color: '#FFFFFF', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', position: 'absolute', right: 0, top: '50%', padding: 0 };
  return (
    <div style={{ marginTop: 14, background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: '12px 16px', display: 'flex', alignItems: 'flex-end', gap: 12, position: 'relative', boxSizing: 'border-box', flex: 'none' }}>
      <span className="mono" style={{ fontSize: 11, lineHeight: 1.6, flex: 1, minWidth: 0, position: 'relative', paddingRight: 48 }}>
        <span style={{ display: 'block', animation: 'aiPrompt 10s linear 1 both' }}>
          <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', animation: 'aiL1 10s steps(79) infinite', maxWidth: '100%' }}>I want Daniel to double-check the coding on every bill before it goes anywhere.</span>
          <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', animation: 'aiL2 10s steps(87) infinite', maxWidth: '100%' }}>If a bill is over $25,000, Maya and Lena should both sign it, and if it's equipment or</span>
          <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', animation: 'aiL3 10s steps(96) infinite', maxWidth: '100%' }}>software, Priya too. Overseas vendors go through Rohan. Anything under $5,000 just auto-approve.</span>
        </span>
      </span>
      <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28, display: 'inline-block' }}>
        <button style={{ ...btn, transform: 'translateY(-50%) scale(1)', animation: 'aiBtnLay 10s linear 1 both' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
        </button>
        <button style={{ ...btn, transform: 'translateY(-50%)', animation: 'aiGenBtn 10s linear 1 both', opacity: 0 }}>
          <span style={{ width: 9, height: 9, background: '#FFFFFF', display: 'inline-block', animation: 'aiDot 1.2s linear infinite' }} />
        </button>
        <button style={{ ...btn, transform: 'translateY(-50%)', animation: 'aiSaveBtn 10s linear 1 both', opacity: 0 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
        </button>
        <button style={{ ...btn, transform: 'translateY(-50%)', animation: 'aiSavedBtn 10s linear 1 both', opacity: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
        </button>
      </span>
      <span style={{ position: 'absolute', right: 11, bottom: 3, zIndex: 2 }}><Cursor w={20} style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.3))', animation: 'aiCursorA 10s linear 1 both', opacity: 0 }} /></span>
      <span style={{ position: 'absolute', right: 11, bottom: 3, zIndex: 2 }}><Cursor w={20} style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.3))', animation: 'aiCursorB 10s linear 1 both', opacity: 0 }} /></span>
    </div>
  );
}

const AV = {
  daniel: ['#C9D8DD', '#4F7383'] as [string, string],
  maya: ['#CCD6DD', '#5B7083'] as [string, string],
  lena: ['#D4DCC9', '#6B7A55'] as [string, string],
  rohan: ['#E3D3C2', '#8A6A4F'] as [string, string],
  priya: ['#D9CCE3', '#7A5B8A'] as [string, string],
};

function FlowBuilder() {
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--band)', padding: '20px 34px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxSizing: 'border-box' }}>
      <div style={{ position: 'relative', border: '1px solid var(--border)', backgroundColor: 'var(--bg-surface-2)', backgroundImage: 'radial-gradient(circle at center, color-mix(in srgb, var(--text-faint) 20%, transparent) 1px, transparent 1px)', backgroundSize: '22px 22px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <svg aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {FLOW_WIRES.map(([pts, aw], i) => (
            <polyline key={i} points={pts} stroke="var(--border-strong)" strokeWidth="1.5" fill="none" style={{ animation: `aw${aw} 10s linear 1 both`, opacity: 0 }} />
          ))}
        </svg>
        <div style={{ position: 'absolute', left: 382, top: 12, transform: 'translateX(-50%)', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--ink)', color: '#FFFFFF', padding: '8px 14px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', animation: 'aw1 10s linear 1 both', opacity: 0 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
          Bill received for approval
        </div>
        <StepCard left={382} top={56} width={250} aw={2} title="Daniel Okafor reviews the coding" sub="A second set of eyes before anything routes" avatars={[AV.daniel]} />
        <CondCard left={382} top={112} aw={3}>Bill amount is over <b>$25,000</b></CondCard>
        <YesNo left={200} top={170} yes aw={4} />
        <YesNo left={560} top={170} yes={false} aw={4} />
        <StepCard left={200} top={204} width={235} aw={4} title="Maya and Lena both approve" sub="Both must sign" avatars={[AV.maya, AV.lena]} />
        <CondCard left={200} top={260} aw={6}>Coded to <b>equipment or software</b></CondCard>
        <YesNo left={105} top={318} yes aw={6} />
        <YesNo left={320} top={318} yes={false} aw={6} />
        <StepCard left={105} top={352} width={185} aw={6} title="Priya Nair signs off" sub="CFO sign-off on capital spend" avatars={[AV.priya]} />
        <CondCard left={320} top={352} aw={6}>Vendor is <b>overseas</b></CondCard>
        <YesNo left={250} top={410} yes aw={7} />
        <YesNo left={390} top={410} yes={false} aw={7} />
        <StepCard left={250} top={444} width={200} aw={7} title="Rohan clears the payment" sub="Treasury check on cross-border" avatars={[AV.rohan]} />
        <CondCard left={560} top={204} aw={4}>Bill amount is over <b>$5,000</b></CondCard>
        <YesNo left={480} top={262} yes aw={5} />
        <YesNo left={660} top={322} yes={false} aw={5} />
        <StepCard left={480} top={296} width={205} aw={5} title="Maya, Rohan, or Lena" sub="Any one signs" avatars={[AV.maya, AV.rohan, AV.lena]} />
        <StepCard left={660} top={356} width={180} aw={5} title="Auto-approved" sub="No sign-off under $5,000" dashed bolt />
        <div style={{ position: 'absolute', left: 382, top: 522, transform: 'translateX(-50%)', background: 'var(--ink)', color: '#FFFFFF', padding: '9px 18px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', animation: 'aw8 10s linear 1 both', opacity: 0 }}>Bill sent for payment</div>
      </div>
      <AiPromptBar />
    </div>
  );
}

/* ═══════════ Plate 02 — approval timeline (12s window, 9s anim) ═══════════ */
function TlAvatarCol({ avatars, tail = true, ink }: { avatars?: Array<[string, string]>; tail?: boolean; ink?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none', width: 32 }}>
      {ink ? (
        <span style={{ width: 32, height: 32, borderRadius: 99, background: 'var(--ink)', color: '#FFFFFF', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
        </span>
      ) : avatars!.length === 1 ? (
        <Av bg={avatars![0][0]} fg={avatars![0][1]} size={32} iconW={23} />
      ) : (
        <span style={{ display: 'flex', flex: 'none' }}>
          <Av bg={avatars![0][0]} fg={avatars![0][1]} size={32} iconW={23} />
          <span style={{ marginLeft: -10 }}><Av bg={avatars![1][0]} fg={avatars![1][1]} size={32} iconW={23} /></span>
        </span>
      )}
      {tail && <span style={{ flex: 1, width: 1.5, background: 'var(--border-strong)', minHeight: 16 }} />}
    </div>
  );
}

function TlCheck({ anim }: { anim: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 99, background: '#2E7D43', animation: anim }}>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
    </span>
  );
}

function TlBubble({ name, time, anim, children }: { name: string; time: string; anim: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 7, animation: anim }}>
      <div style={{ minWidth: 0, maxWidth: 440, background: 'var(--band)', padding: '6px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 10.5, fontWeight: 600 }}>{name}</span>
          <span className="mono" style={{ fontSize: 8.5, color: 'var(--text-faint)' }}>{time}</span>
        </div>
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-primary)', marginTop: 2 }}>{children}</div>
      </div>
    </div>
  );
}

function ApprovalTimeline() {
  const at = (n: string) => `${n} 9s linear 1 both`;
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--band)', padding: '20px 34px', display: 'flex', boxSizing: 'border-box' }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '11px 16px', background: 'var(--ink)', color: '#FFFFFF' }}>
          <div style={{ font: 'var(--dw,600) 17px var(--font-display)' }}>Approving INV-2481 · Anvil Works</div>
          <div className="mono" style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 600 }}>$29,743.00</div>
        </div>
        <div style={{ padding: '16px 22px 26px', display: 'flex', flexDirection: 'column', flex: 1 }}>
          <div style={{ display: 'flex', gap: 14, animation: at('tl1') }}>
            <TlAvatarCol avatars={[AV.daniel]} />
            <div style={{ paddingBottom: 13, minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 32 }}>
                <span style={{ fontSize: 13 }}><b style={{ fontWeight: 600 }}>Daniel Okafor</b> reviewed the coding</span>
                <TlCheck anim={at('tlChk1')} />
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-faint)' }}>Mon 9:02 AM</span>
              </div>
              <div style={{ animation: at('tlChk1') }}>
                <TlBubble name="Daniel Okafor" time="9:02 AM" anim="none">This was sitting in office supplies, so I recoded it to 6410 · Office furniture &amp; equipment. Looks right now, sending it up the chain.</TlBubble>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, animation: at('tl2') }}>
            <TlAvatarCol avatars={[AV.maya, AV.lena]} />
            <div style={{ paddingBottom: 13, minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 32 }}>
                <span style={{ fontSize: 13 }}><b style={{ fontWeight: 600 }}>Maya Krishnan</b> and <b style={{ fontWeight: 600 }}>Lena Cortez</b> approved <span style={{ color: 'var(--text-faint)' }}>· over $25,000, both must sign</span></span>
                <TlCheck anim={at('tlChk2')} />
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-faint)' }}>Mon 10:12 AM</span>
              </div>
              <TlBubble name="Maya Krishnan" time="9:41 AM" anim={at('tlBubA')}>Austin fit-out. This is the vendor Ops picked last month, and the numbers match the PO. Approved.</TlBubble>
              <TlBubble name="Lena Cortez" time="9:58 AM" anim={at('tlBubQ')}><span style={{ color: 'var(--ink)', fontWeight: 600 }}>@Maya</span> the quote we signed had delivery folded into the unit price. Why is it a separate $2,143 line here?</TlBubble>
              <TlBubble name="Maya Krishnan" time="10:04 AM" anim={at('tlBubR')}><span style={{ color: 'var(--ink)', fontWeight: 600 }}>@Lena</span> they re-quoted after we added the assembly work. The total is still under what we budgeted, and the invoice matches the revised quote.</TlBubble>
              <TlBubble name="Lena Cortez" time="10:12 AM" anim={at('tlBubB')}>Checked the revised quote line by line and it matches. Approved.</TlBubble>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, animation: at('tl3') }}>
            <TlAvatarCol avatars={[AV.priya]} />
            <div style={{ paddingBottom: 13, minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 32 }}>
                <span style={{ fontSize: 13 }}><b style={{ fontWeight: 600 }}>Priya Nair</b> signed off <span style={{ color: 'var(--text-faint)' }}>· equipment, CFO signs capex</span></span>
                <TlCheck anim={at('tlChk3')} />
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-faint)' }}>Mon 11:05 AM</span>
              </div>
              <TlBubble name="Priya Nair" time="11:05 AM" anim={at('tlBubC')}>Capitalizing the desks and chairs over five years. Daniel's coding makes that clean. Clear to pay.</TlBubble>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, animation: at('tl4') }}>
            <TlAvatarCol tail={false} ink />
            <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ fontSize: 13 }}><b style={{ fontWeight: 600 }}>Approved, sent for payment.</b> <span style={{ color: 'var(--text-muted)' }}>Reviewed by Daniel, approved by Maya, Lena &amp; Priya.</span></span>
              <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-faint)' }}>Mon 11:05 AM</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Plate02Visual() {
  const [phase, setPhase] = useState<'flow' | 'timeline'>('flow');
  useEffect(() => {
    // flow (10s) -> timeline (12s) -> loop, no blank gap
    const t = setTimeout(() => setPhase((p) => (p === 'flow' ? 'timeline' : 'flow')), phase === 'flow' ? 10000 : 12000);
    return () => clearTimeout(t);
  }, [phase]);
  return (
    <div style={{ position: 'relative', width: 832, height: 703, margin: '36px auto 36px 64px' }}>
      {phase === 'flow' ? <FlowBuilder key="flow" /> : <ApprovalTimeline key="timeline" />}
    </div>
  );
}

/* ═══════════ Plate 03 — payment run + globe (16s phase-locked) ═══════════ */
type RunRow = { flag: string; vendor: string; country: string; amount: string; chk: number };
const RUN_ROWS: RunRow[] = [
  { flag: 'us', vendor: 'Anvil Works', country: 'United States', amount: '$29,743', chk: 0 },
  { flag: 'gb', vendor: 'Meridian Freight', country: 'United Kingdom', amount: '£5,089', chk: 1 },
  { flag: 'br', vendor: 'Móveis Braga', country: 'Brazil', amount: 'R$69,918', chk: 2 },
  { flag: 'mx', vendor: 'Otavo Packaging', country: 'Mexico', amount: 'MX$115,506', chk: 3 },
  { flag: 'ca', vendor: 'Maple Fabrication', country: 'Canada', amount: 'C$25,235', chk: 4 },
  { flag: 'is', vendor: 'Nordvik Marine', country: 'Iceland', amount: 'kr4,657,500', chk: 5 },
  { flag: 'us', vendor: 'Lumen Cloud', country: 'United States', amount: '$2,940', chk: 6 },
];

function Plate03Visual() {
  // Phase-lock: animation position ≡ document time mod 16s, matching the globe.
  const gbd = useMemo(() => `-${Math.round(((document.timeline?.currentTime as number) || 0) % 16000)}ms`, []);
  const d = (name: string) => ({ animation: `${name} 16s linear infinite`, animationDelay: gbd });
  return (
    <div style={{ position: 'relative', background: 'var(--band)', padding: '20px 24px', width: 810, boxSizing: 'border-box', margin: '36px auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 450px', gap: 0, background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', background: 'var(--ink)', color: '#fff' }}>
            <span style={{ font: 'var(--dw,600) 13px var(--font-display)', whiteSpace: 'nowrap' }}>Payment run</span>
            <span style={{ marginLeft: 'auto', position: 'relative' }}>
              <button style={{ position: 'relative', border: 'none', background: '#fff', color: 'var(--ink)', font: '600 9.5px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', padding: '6px 14px', pointerEvents: 'none', whiteSpace: 'nowrap', animation: `gbBtn 16s linear infinite, gbBtnBg 16s linear infinite`, animationDelay: gbd }}>
                <span style={{ opacity: 0 }}>Release payments</span>
                <span style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', ...d('gbBtnA') }}>Release payments</span>
                <span style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, ...d('gbBtnB'), opacity: 0 }}>
                  <svg style={{ animation: 'gbSpin .8s linear infinite' }} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="9" strokeOpacity=".25" /><path d="M12 3a9 9 0 0 1 9 9" /></svg>
                  Releasing
                </span>
                <span style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, ...d('gbBtnC'), opacity: 0 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  Released
                </span>
              </button>
              <Cursor w={18} style={{ position: 'absolute', right: 6, bottom: -8, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))', ...d('gbCur'), opacity: 0 }} />
            </span>
          </div>
          {RUN_ROWS.map((r) => (
            <div key={r.vendor} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--border)' }}>
              <img src={`${A}flags/${r.flag}.png`} alt="" style={{ width: 20, height: 20, borderRadius: 99, objectFit: 'cover', flex: 'none', display: 'inline-block', boxShadow: '0 1px 2px rgba(0,0,0,.18)' }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 11, fontWeight: 500, lineHeight: 1.2, whiteSpace: 'nowrap' }}>{r.vendor}</span>
                <span style={{ fontSize: 9, color: 'var(--text-faint)', lineHeight: 1.2, whiteSpace: 'nowrap' }}>{r.country}</span>
              </span>
              <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{r.amount}</span>
              <span style={{ position: 'relative', width: 15, height: 15, flex: 'none' }}>
                <span style={{ position: 'absolute', inset: 0, borderRadius: 99, border: '1.5px dashed var(--border-strong)', boxSizing: 'border-box' }} />
                <span style={{ width: 15, height: 15, borderRadius: 99, background: '#2E7D43', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', ...d(`gbChk${r.chk}`), opacity: 0, position: 'absolute', inset: 0 }}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                </span>
              </span>
            </div>
          ))}
          <div style={{ position: 'relative', padding: '10px 14px', fontSize: 11, color: 'var(--text-muted)', marginTop: 'auto' }}>
            <span style={{ ...d('gbFootA') }}><b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Pay 7 bills across 6 countries</b> in one batch</span>
            <span style={{ position: 'absolute', left: 14, top: 10, whiteSpace: 'nowrap', ...d('gbFootB'), opacity: 0 }}>Cleared in one batch payment · <b className="mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>$110,405</b></span>
          </div>
        </div>
        <div style={{ position: 'relative', overflow: 'hidden', minHeight: 410, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <PayGlobe gbd={gbd} />
        </div>
      </div>
    </div>
  );
}

/* ═══════════ section ═══════════ */
export function Anatomy() {
  return (
    <div id="how-it-works" style={{ background: '#FFFFFF' }}>
      <Bridge />
      <div style={{ borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '30fr 70fr' }}>
        <PlateCopy
          title="AI extraction and coding"
          padding="40px 48px 40px 64px"
          blocks={[{
            mark: 'Zero manual entry',
            body: "Forward a bill or drop in a PDF. A vision model reads it the way a person would, pulling every field and every line item into structured data and checking it against the document's own totals. Each line is coded to your chart of accounts, and it learns every vendor as it goes, so the next bill lands already coded.",
          }]}
        />
        <Plate01Visual />
      </div>
      <div style={{ borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '65fr 35fr' }}>
        <Plate02Visual />
        <PlateCopy
          title="Approval workflows, built and enforced"
          padding="40px 64px 40px 40px"
          blocks={[
            {
              mark: 'Any complexity', padTop: 40,
              body: 'Build the exact path each bill takes: route by amount, vendor, or category, branch on conditions, require two signatures or any one of a group, enforce separation of duties. However your company approves a bill, the engine runs it. Changing the policy later? Describe it in plain words and Decimal redraws the flow.',
            },
            {
              mark: 'Routed and recorded', padTop: 40,
              body: 'Once your flow is set, every bill runs it automatically: routed to the right people, in the right order, and chased until it clears. Every comment, question, and sign-off is captured on the bill and kept, so months later you can see exactly who approved what, and why.',
            },
          ]}
        />
      </div>
      <div style={{ borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '34fr 66fr' }}>
        <PlateCopy
          title="Cross-border payments"
          padding="40px 48px 40px 64px"
          blocks={[{
            mark: 'In their currency', padTop: 40,
            body: 'Pay a vendor in any country, or a whole run of them at once, each in their own currency at a rate you can see. No correspondent banks, no week-long wire, no hidden markup.',
          }]}
        />
        <Plate03Visual />
      </div>
    </div>
  );
}
