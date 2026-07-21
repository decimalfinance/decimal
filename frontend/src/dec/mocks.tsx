// Reference product-screen mocks for the design system.
//
// design-sync ONLY — this file is exported via ds-entry.ts and is NOT imported
// anywhere in the app. Each export is a static, seeded composition of the real
// .dec class vocabulary, lifted from the live pages (Bills, InvoiceReview,
// FlowBuilder, PaymentDetail) so the landing-page design agent can copy and
// fork real product screens instead of inventing them.
//
// No hooks, no data, no routing — realistic hardcoded content only.
import React from 'react';
import { Ico } from './icons';
import { PageHead, Pill, OriginPill } from './primitives';

// ─── 1. Bills workbench — the bill list/table ───────────────────────────────
export function BillList() {
  return (
    <div className="page page-wide">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Operations"
          title="Bills"
          desc="Everything you've received, from first look to paid."
          actions={<button type="button" className="btn btn-primary"><Ico.upload w={15} /> Upload a bill</button>}
        />

        <div className="metrics" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="metric is-alert">
            <div className="m-label">Waiting on you</div>
            <div className="m-value">3</div>
            <div className="m-sub">2 ready for approval · 1 missing info</div>
          </div>
          <div className="metric">
            <div className="m-label">In approval</div>
            <div className="m-value">5</div>
            <div className="m-sub">with the approvers</div>
          </div>
          <div className="metric">
            <div className="m-label">To pay</div>
            <div className="m-value">2</div>
            <div className="m-sub">cleared and queued</div>
          </div>
          <div className="metric">
            <div className="m-label">Needs attention</div>
            <div className="m-value">1</div>
            <div className="m-sub">stuck or wrong</div>
          </div>
        </div>

        <div className="filterbar">
          <div className="tabs">
            <button type="button" className="tab on">Needs review<span className="tab-count">3</span></button>
            <button type="button" className="tab">In approval<span className="tab-count">5</span></button>
            <button type="button" className="tab">To pay<span className="tab-count">2</span></button>
            <button type="button" className="tab">Done<span className="tab-count">18</span></button>
            <button type="button" className="tab">Needs attention<span className="tab-count">1</span></button>
          </div>
          <div className="filter-right">
            <input className="input input-search" placeholder="Search vendor or invoice #" style={{ width: 220 }} readOnly />
            <div className="select">
              <select defaultValue="urgent" aria-label="Sort">
                <option value="urgent">Most urgent</option>
                <option value="due">Due date</option>
                <option value="newest">Newest</option>
              </select>
            </div>
          </div>
        </div>

        <div className="tbl-card">
          <table className="tbl">
            <thead>
              <tr>
                <th>Vendor</th><th>Invoice</th><th>Description</th>
                <th className="num">Amount</th><th>Due</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ cursor: 'pointer' }}>
                <td><span className="v-name">Hanoi Textile Works</span></td>
                <td className="cell-mono">INV-2214</td>
                <td style={{ color: 'var(--text-muted)' }}>Cotton fabric, 400 rolls</td>
                <td className="td-num">$18,420.00<div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>448,000,000 VND</div></td>
                <td style={{ whiteSpace: 'nowrap' }}><span style={{ fontSize: 13 }}>Feb 12, 2026</span></td>
                <td><span className="dot-status tone-warning"><span className="ds-dot" /><span className="ds-avatar">PR</span>Waiting on Priya</span></td>
              </tr>
              <tr style={{ cursor: 'pointer' }}>
                <td><span className="v-name">Lumen Cloud</span></td>
                <td className="cell-mono">LC-90455</td>
                <td style={{ color: 'var(--text-muted)' }}>Cloud hosting — January</td>
                <td className="td-num">$2,940.00</td>
                <td style={{ whiteSpace: 'nowrap' }}><span style={{ fontSize: 13 }}>Feb 9, 2026</span></td>
                <td><span className="dot-status tone-info"><span className="ds-dot" />Reading complete</span></td>
              </tr>
              <tr style={{ cursor: 'pointer' }}>
                <td><span className="v-name">Shenzhen Kiro Electronics</span></td>
                <td className="cell-mono">8871</td>
                <td style={{ color: 'var(--text-muted)' }}>USB-C hubs, 1,200 units</td>
                <td className="td-num">$33,750.00</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span className="due-overdue" style={{ fontSize: 13 }}>Feb 5, 2026</span>
                  <span className="due-overdue" style={{ fontSize: 12, marginLeft: 8 }}>· 2 days overdue</span>
                </td>
                <td><span className="dot-status tone-danger"><span className="ds-dot" />Possible duplicate</span></td>
              </tr>
              <tr style={{ cursor: 'pointer' }}>
                <td><span className="v-name">Meridian Print Co.</span></td>
                <td className="cell-mono">4021</td>
                <td style={{ color: 'var(--text-muted)' }}>Catalog printing, spring run</td>
                <td className="td-num">$6,442.46</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: 13 }}>Feb 20, 2026</span>
                  <span className="due-chip" style={{ marginLeft: 8 }}>2% if paid by Feb 12</span>
                </td>
                <td><span className="dot-status tone-success"><span className="ds-dot" />Ready to pay</span></td>
              </tr>
              <tr style={{ cursor: 'pointer' }}>
                <td><span className="v-name">Anders Freight</span></td>
                <td className="cell-mono">AF-1180</td>
                <td style={{ color: 'var(--text-muted)' }}>Ocean freight, 1 container</td>
                <td className="td-num">$4,210.00</td>
                <td style={{ whiteSpace: 'nowrap' }}><span style={{ fontSize: 13 }}>Feb 18, 2026</span></td>
                <td><span className="dot-status tone-neutral"><span className="ds-dot" />Draft</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── 2. Bill review — document + extracted fields + GL coding ────────────────
export function BillReview() {
  const codeCell = (account: string) => (
    <span className="picker-trigger" style={{ display: 'inline-flex' }}>{account}</span>
  );
  return (
    <div className="rev-shell" style={{ height: 864, display: 'flex', flexDirection: 'column' }}>
      <div className="topbar">
        <div className="tb-context">
          <button type="button" className="btn btn-ghost tb-back"><Ico.chevLeft w={15} /> Bills</button>
        </div>
      </div>
      <div className="rev-split" style={{ flex: 1, minHeight: 0 }}>
        {/* Left: extracted fields + GL coding */}
        <div className="rev-panel" style={{ width: '58%' }}>
          <div className="stack stack-20">
            <div className="rev-head">
              <div>
                <h1>INV-2214</h1>
                <div className="rh-sub">Hanoi Textile Works</div>
              </div>
              <div className="rh-amount">$18,420.00</div>
            </div>

            <div className="callout callout-info">
              <Ico.shield w={16} />
              <span>Categories pre-filled from this vendor's history. Change any that look wrong.</span>
            </div>

            <section>
              <div className="sec-head"><div className="sh-titles">
                <h2>Vendor</h2>
                <p className="sh-desc">First bill from this vendor — payment details go through verification.</p>
              </div></div>
              <div className="rev-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="rev-field"><span className="field-label">Vendor name</span><input className="input" defaultValue="Hanoi Textile Works" /></div>
                <div className="rev-field"><span className="field-label">Email</span><input className="input" defaultValue="ap@hanoitextile.vn" /></div>
              </div>
            </section>

            <section>
              <div className="sec-head"><div className="sh-titles">
                <h2>Bill details</h2>
                <p className="sh-desc">Everything checks out.</p>
              </div></div>
              <div className="rev-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                <div className="rev-field"><span className="field-label">Invoice number</span><input className="input" defaultValue="INV-2214" /></div>
                <div className="rev-field"><span className="field-label">Invoice date</span><input className="input" defaultValue="Jan 28, 2026" /></div>
                <div className="rev-field"><span className="field-label">Due date</span><input className="input" defaultValue="Feb 12, 2026" /></div>
              </div>
            </section>

            <section>
              <div className="sec-head"><div className="sh-titles">
                <h2>Line items</h2>
                <p className="sh-desc">Categories pre-filled — from this vendor's history. Change any that look wrong.</p>
              </div></div>
              <div className="tbl-card">
                <table className="tbl tbl-slim">
                  <thead><tr>
                    <th>Description</th>
                    <th className="num" style={{ width: 52 }}>Qty</th>
                    <th className="num" style={{ width: 110 }}>Amount</th>
                    <th style={{ width: 210 }}>Category</th>
                  </tr></thead>
                  <tbody>
                    <tr>
                      <td>Cotton fabric, 400 rolls</td>
                      <td className="td-num">400</td>
                      <td className="td-num">$16,000.00</td>
                      <td>{codeCell('Cost of goods sold')}</td>
                    </tr>
                    <tr>
                      <td>Dyeing and finishing</td>
                      <td className="td-num">1</td>
                      <td className="td-num">$1,900.00</td>
                      <td>{codeCell('Cost of goods sold')}</td>
                    </tr>
                    <tr>
                      <td>Export packaging</td>
                      <td className="td-num">1</td>
                      <td className="td-num">$520.00</td>
                      <td>{codeCell('Freight & packaging')}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>

        {/* Right: the bill document */}
        <div className="rev-doc-wrap" style={{ width: '42%' }}>
          <div className="doc-head">
            <div className="dh-file">
              <Ico.doc w={15} />
              <span className="dh-name">hanoi-textile-INV-2214.pdf</span>
              <span className="kbd">1 page</span>
            </div>
            <div className="dh-zoom">
              <button type="button" className="btn btn-icon btn-sm" aria-label="Zoom out"><Ico.minus w={13} /></button>
              <span className="dh-pct">100%</span>
              <button type="button" className="btn btn-icon btn-sm" aria-label="Zoom in"><Ico.plus w={13} /></button>
            </div>
          </div>
          <div className="rev-doc">
            <div className="doc-page" style={{ width: '92%', background: '#fff', border: '1px solid var(--border)', borderRadius: 6, padding: 28, color: '#1a1a1a', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, fontFamily: 'var(--font-display)' }}>Hanoi Textile Works</div>
                  <div style={{ color: '#666' }}>12 Bạch Đằng, Hà Nội, Vietnam</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700 }}>INVOICE</div>
                  <div style={{ color: '#666' }}>INV-2214</div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18, color: '#444' }}>
                <div>Bill to: Northwind Trading Co.<br />Invoice date: Jan 28, 2026<br />Due date: Feb 12, 2026</div>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                  <th style={{ padding: '5px 0' }}>Item</th><th style={{ textAlign: 'right' }}>Amount</th>
                </tr></thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '5px 0' }}>Cotton fabric, 400 rolls</td><td style={{ textAlign: 'right' }}>16,000.00</td></tr>
                  <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '5px 0' }}>Dyeing and finishing</td><td style={{ textAlign: 'right' }}>1,900.00</td></tr>
                  <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '5px 0' }}>Export packaging</td><td style={{ textAlign: 'right' }}>520.00</td></tr>
                </tbody>
              </table>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14, fontWeight: 700, fontSize: 13 }}>
                Total due: $18,420.00
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="commit-bar">
        <span className="commit-spacer" />
        <button type="button" className="btn btn-primary">Confirm and send to approval</button>
      </div>
    </div>
  );
}

// ─── 3. Approval flow-builder canvas — nodes, branches, conditions ──────────
export function FlowCanvas() {
  const Avatars = ({ people }: { people: Array<[string, string]> }) => (
    <span style={{ display: 'flex', flex: 'none', paddingTop: 2 }}>
      {people.map(([initials, color], idx) => (
        <span key={initials} className="p-av"
          style={{ width: 20, height: 20, fontSize: 7.5, background: color, marginLeft: idx ? -6 : 0, border: '1.5px solid var(--bg-surface)' }}>
          {initials}
        </span>
      ))}
    </span>
  );
  return (
    <div className="pc" style={{ position: 'relative', height: 560, overflow: 'hidden', backgroundColor: 'var(--bg-surface-2)', backgroundImage: 'radial-gradient(circle at center, color-mix(in srgb, var(--text-faint) 20%, transparent) 1px, transparent 1px)', backgroundSize: '22px 22px' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, display: 'flex', flexDirection: 'row', alignItems: 'stretch', gap: 44, padding: '18px 24px' }}>
        <div className="spine" />
        <div className="received" style={{ position: 'relative', alignSelf: 'flex-start' }}><Ico.doc w={14} />Bill received</div>

        {/* Review stage */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="stage-div s-review" style={{ marginTop: 4 }}><Ico.search w={13} /> Review <span className="tipico"><Ico.info w={12} /></span></div>
          <div className="conn" />
          <div className="qcard">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span className="qc-sent" style={{ flex: 1, minWidth: 0 }}>Someone on Finance confirms the bill</span>
              <Avatars people={[['LT', '#6b7cff'], ['MW', '#e6845c']]} />
            </div>
            <span className="qc-cap">Either can confirm</span>
          </div>
          <div className="conn" style={{ height: 10 }} />
          <span className="lane-end to-approve" style={{ flex: 'none' }}>Reviewed — forwarded for approval</span>
        </div>

        {/* Approve stage — with a condition/branch */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="stage-div s-approve" style={{ marginTop: 4 }}><Ico.check w={13} /> Approve <span className="tipico"><Ico.info w={12} /></span></div>
          <div className="conn" />
          <div className="qcard decision">
            <span className="qc-sent">
              <Ico.arrowRight w={12} style={{ color: 'var(--text-faint)', flex: 'none', position: 'relative', top: 1 }} />
              <span>Bill amount is over <b>$10,000</b></span>
            </span>
          </div>
          <div className="conn" />
          <div className="tree-branches">
            <div className="branch">
              <span className="q-yes"><Ico.checkSm w={10} /> Yes</span>
              <div className="conn" style={{ height: 10 }} />
              <div className="qcard">
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span className="qc-sent" style={{ flex: 1, minWidth: 0 }}>Priya and Marcus both approve</span>
                  <Avatars people={[['PR', '#3fb27f'], ['MC', '#c0508f']]} />
                </div>
                <span className="qc-cap">Both must sign</span>
              </div>
            </div>
            <div className="branch">
              <span className="q-no"><Ico.x w={9} /> No</span>
              <div className="conn" style={{ height: 10 }} />
              <div className="qcard">
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span className="qc-sent" style={{ flex: 1, minWidth: 0 }}>Marcus approves</span>
                  <Avatars people={[['MC', '#c0508f']]} />
                </div>
              </div>
            </div>
          </div>
          <div className="conn" style={{ height: 10 }} />
          <span className="lane-end to-payment" style={{ flex: 'none' }}>Approved — forwarded for payment</span>
        </div>

        {/* Pay stage */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="stage-div s-payment" style={{ marginTop: 4 }}><Ico.payments w={13} /> Pay <span className="tipico"><Ico.info w={12} /></span></div>
          <div className="conn" />
          <div className="qcard">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span className="qc-sent" style={{ flex: 1, minWidth: 0 }}>Dana releases the payment</span>
              <Avatars people={[['DA', '#4b8bd6']]} />
            </div>
          </div>
          <div className="conn" style={{ height: 10 }} />
          <span className="lane-end to-done" style={{ flex: 'none' }}>Payment released</span>
        </div>

        <div className="terminal" style={{ alignSelf: 'flex-start' }}><span className="tcheck"><Ico.checkSm w={11} /></span>Money leaves the account</div>
      </div>

      <div className="zoom-tools" style={{ position: 'absolute', bottom: 18, right: 18 }}>
        <button type="button" className="zbtn" aria-label="Zoom out"><Ico.minus w={15} /></button>
        <button type="button" className="zoom-pct">100%</button>
        <button type="button" className="zbtn" aria-label="Zoom in"><Ico.plus w={15} /></button>
        <span className="zdiv" />
        <button type="button" className="zbtn" aria-label="Fit to view"><Ico.reset w={14} /></button>
      </div>
    </div>
  );
}

// ─── 4. Payment tracker — Scheduled → Initiated → Delivered + FX ────────────
export function PaymentTracker() {
  const RAIL: Array<[string, string, 'done' | 'current' | '']> = [
    ['Approved', 'all sign-offs in', 'done'],
    ['Scheduled', 'queued to send', 'done'],
    ['Initiated', 'on the rail', 'done'],
    ['Delivered', 'arrived in minutes', 'current'],
  ];
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="stack stack-16">
        <div className="rail">
          {RAIL.map(([label, sub, state], i) => (
            <div className={['rail-stage', state].filter(Boolean).join(' ')} key={label}>
              <div className="rs-top">
                <span className="rs-node">{state === 'done' ? <Ico.checkSm w={12} /> : i + 1}</span>
                <span className="rs-line" />
              </div>
              <span className="rs-label">{label}</span>
              <span className="rs-sub">{sub}</span>
            </div>
          ))}
        </div>

        <div className="pay-summary">
          <div className="ps-amount-row">
            <div>
              <div className="ps-lab">Amount</div>
              <div className="ps-amount">18,420<small>USD</small></div>
            </div>
            <OriginPill>Cross-border</OriginPill>
          </div>

          <div className="ps-route">
            <div className="ps-endpoint">
              <span className="pe-lab">From</span>
              <span className="pe-name">Operating treasury</span>
              <span className="pe-sub">•••4f2a</span>
            </div>
            <Ico.arrowRight w={18} />
            <div className="ps-endpoint">
              <span className="pe-lab">To</span>
              <span className="pe-name">Hanoi Textile Works</span>
              <span className="pe-sub">Invoice INV-2214</span>
            </div>
          </div>

          <div className="ps-defs">
            <div className="ps-def">
              <span className="pd-lab">Trust</span>
              <span style={{ width: 'fit-content' }}><Pill tone="success">Trusted</Pill></span>
            </div>
            <div className="ps-def">
              <span className="pd-lab">Signature</span>
              <span style={{ width: 'fit-content' }}><Pill tone="info">Auto-paid</Pill></span>
            </div>
            <div className="ps-def">
              <span className="pd-lab">Cleared in</span>
              <span className="pd-val mono">1 min 48 sec</span>
            </div>
            <div className="ps-def full">
              <span className="pd-lab">Exchange rate</span>
              <span className="pd-val" style={{ fontWeight: 400 }}>1 USD = 24,150 VND · the mid-market rate, no markup. You saved about $520 versus a bank wire.</span>
            </div>
          </div>
        </div>

        <div className="timeline">
          <div className="tl-event done">
            <div className="tl-rail"><span className="tl-dot" /><span className="tl-line" /></div>
            <div className="tl-body">
              <div className="tl-title">Payment delivered</div>
              <div className="tl-meta">Feb 9, 2026 · 2:14 PM · confirmed on-chain</div>
            </div>
          </div>
          <div className="tl-event done">
            <div className="tl-rail"><span className="tl-dot" /><span className="tl-line" /></div>
            <div className="tl-body">
              <div className="tl-title">Payment initiated</div>
              <div className="tl-meta">Feb 9, 2026 · 2:12 PM · signed by the auto-pay agent</div>
            </div>
          </div>
          <div className="tl-event done">
            <div className="tl-rail"><span className="tl-dot" /></div>
            <div className="tl-body">
              <div className="tl-title">Scheduled to send</div>
              <div className="tl-meta">Feb 9, 2026 · 2:11 PM · cleared all approvals</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
