// Decimal — synthetic invoice set v3: HTML layouts + degradation scenes.
//
// Six visually distinct layouts so the vision model sees real variety, plus
// CSS-only "camera" effects for section C (photo skew/shadow, soft scan,
// stamp overlay) — no image libraries needed; Brave renders, sips converts.

export const money = (n) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const moneyEUR = (n) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  table { border-collapse: collapse; width: 100%; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
`;

// Line rows + totals block shared by the tabular layouts.
function linesTable(spec, fmt, { headBg = '#f2f2f2', rule = '#d8d8d8' } = {}) {
  const rows = spec.lines.map((l) => `
    <tr>
      <td style="padding:7px 8px 7px 0; border-bottom:1px solid ${rule};">${esc(l.desc)}</td>
      <td class="num" style="padding:7px 8px; border-bottom:1px solid ${rule};">${l.qty}</td>
      <td class="num" style="padding:7px 8px; border-bottom:1px solid ${rule};">${fmt(l.unit)}</td>
      <td class="num" style="padding:7px 0 7px 8px; border-bottom:1px solid ${rule};">${fmt(l.qty * l.unit)}</td>
    </tr>`).join('');
  return `
    <table style="font-size:10.5px;">
      <thead><tr style="background:${headBg};">
        <th style="text-align:left; padding:6px 8px 6px 6px; font-size:8.5px; letter-spacing:0.08em;">DESCRIPTION</th>
        <th class="num" style="padding:6px 8px; font-size:8.5px; letter-spacing:0.08em;">QTY</th>
        <th class="num" style="padding:6px 8px; font-size:8.5px; letter-spacing:0.08em;">UNIT PRICE</th>
        <th class="num" style="padding:6px 6px 6px 8px; font-size:8.5px; letter-spacing:0.08em;">AMOUNT</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function totalsBlock(c, fmt, { taxLabel = 'Tax' } = {}) {
  const row = (label, v, strong = false) => `
    <tr>
      <td style="padding:5px 14px 5px 0; ${strong ? 'font-weight:700; font-size:12px;' : 'color:#555;'}">${label}</td>
      <td class="num" style="padding:5px 0; ${strong ? 'font-weight:700; font-size:12px;' : ''}">${fmt(v)}</td>
    </tr>`;
  let out = '<table style="width:auto; margin-left:auto; font-size:10.5px;">';
  out += row('Subtotal', c.shownSubtotal);
  if (c.shownTax != null) out += row(taxLabel, c.shownTax);
  out += row('Total due', c.shownTotal, true);
  out += '</table>';
  return out;
}

const remitFooter = (v, spec) => spec.noRemit ? '' : `
  <div style="margin-top:auto; border-top:1px solid #ccc; padding-top:10px; font-size:9.5px; color:#333;">
    <div style="font-size:8px; letter-spacing:0.1em; color:#888; margin-bottom:4px;">REMIT BY ACH</div>
    ${esc(v.bank)}${v.routing ? ` · Routing ${v.routing}` : ''} · Account ****${v.acct}<br>
    <span style="color:#777;">Questions? ${esc(v.email)} · Thank you for your business.</span>
  </div>`;

const billToBlock = (billTo, label = 'BILL TO') => `
  <div style="font-size:8px; letter-spacing:0.1em; color:#888;">${label}</div>
  <div style="font-weight:700; font-size:12px; margin-top:4px;">${esc(billTo.name)}</div>
  <div style="color:#555; font-size:10px; margin-top:2px;">${esc(billTo.addr)}<br>${esc(billTo.city)}<br>Attn: Accounts Payable</div>`;

const metaRows = (pairs) => pairs.filter(([, v]) => v != null).map(([k, v]) => `
  <tr><td style="font-size:8px; letter-spacing:0.08em; color:#888; padding:3px 16px 3px 0;">${k}</td>
      <td style="font-size:10.5px; text-align:right; padding:3px 0;">${esc(v)}</td></tr>`).join('');

// ---- Layout 1: classic letterhead ------------------------------------------
function letterhead(spec, v, c, fmt) {
  return `
  <div class="paper" style="font-family: Helvetica, Arial, sans-serif; color:#1a1a1a; display:flex; flex-direction:column;">
    <div style="height:8px; background:${v.accent}; margin:-0.6in -0.6in 0.35in;"></div>
    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
      <div>
        <div style="font-family: Georgia, serif; font-size:21px; font-weight:700; color:${v.accent};">${esc(v.name)}</div>
        <div style="color:#666; font-size:9.5px; margin-top:5px;">${esc(v.addr)} · ${esc(v.city)}<br>${esc(v.email)} · ${esc(v.phone)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:26px; letter-spacing:0.18em; color:#2b2b2b; font-weight:300;">INVOICE</div>
      </div>
    </div>
    <div style="display:flex; justify-content:space-between; margin-top:30px;">
      <div>${billToBlock(c.billTo)}</div>
      <table style="width:auto;">${metaRows([
        ['INVOICE NO.', spec.invoiceNo], ['INVOICE DATE', spec.date], ['DUE DATE', spec.due],
        ['TERMS', spec.terms], ['PO NUMBER', spec.po]])}</table>
    </div>
    <div style="margin-top:26px;">${linesTable(spec, fmt)}</div>
    <div style="margin-top:16px;">${totalsBlock(c, fmt)}</div>
    ${remitFooter(v, spec)}
  </div>`;
}

// ---- Layout 2: modern minimal ----------------------------------------------
function minimal(spec, v, c, fmt) {
  return `
  <div class="paper" style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color:#222; display:flex; flex-direction:column;">
    <div style="display:flex; justify-content:space-between; align-items:baseline;">
      <div style="font-size:13px; font-weight:600;">${esc(v.name)}</div>
      <div style="font-size:34px; font-weight:200; color:${v.accent}; letter-spacing:0.04em;">Invoice</div>
    </div>
    <div style="color:#999; font-size:9px; margin-top:2px;">${esc(v.addr)}, ${esc(v.city)} · ${esc(v.email)}</div>
    <div style="display:flex; gap:60px; margin-top:38px;">
      <div>${billToBlock(c.billTo, 'BILLED TO')}</div>
      <table style="width:auto;">${metaRows([
        ['INVOICE', spec.invoiceNo], ['ISSUED', spec.date], ['DUE', spec.due],
        ['TERMS', spec.terms], ['PO', spec.po]])}</table>
    </div>
    <div style="margin-top:34px;">${linesTable(spec, fmt, { headBg: '#fff', rule: '#ececec' })}</div>
    <div style="margin-top:18px;">${totalsBlock(c, fmt)}</div>
    ${remitFooter(v, spec)}
  </div>`;
}

// ---- Layout 3: two-column, remit in the footer (C4) ------------------------
function twocol(spec, v, c, fmt) {
  return `
  <div class="paper" style="font-family: 'Avenir Next', 'Helvetica Neue', sans-serif; color:#20242a; display:flex; flex-direction:column;">
    <div style="display:flex; gap:28px; flex:1;">
      <div style="width:34%; background:#f6f8f7; margin:-0.6in 0 -0.6in -0.6in; padding:0.6in 18px 0.6in 0.6in;">
        <div style="font-size:15px; font-weight:700; color:${v.accent};">${esc(v.name)}</div>
        <div style="color:#667; font-size:9px; margin-top:4px; line-height:1.5;">${esc(v.addr)}<br>${esc(v.city)}<br>${esc(v.email)}<br>${esc(v.phone)}</div>
        <div style="margin-top:34px;">${billToBlock(c.billTo)}</div>
        <div style="margin-top:34px;"><table style="width:100%;">${metaRows([
          ['INVOICE NO.', spec.invoiceNo], ['DATE', spec.date], ['DUE', spec.due], ['TERMS', spec.terms]])}</table></div>
      </div>
      <div style="flex:1; display:flex; flex-direction:column;">
        <div style="font-size:22px; letter-spacing:0.2em; color:#2a2f36; margin-bottom:22px;">INVOICE</div>
        ${linesTable(spec, fmt, { headBg: '#eef2f0' })}
        <div style="margin-top:16px;">${totalsBlock(c, fmt)}</div>
      </div>
    </div>
    <div style="margin:0 -0.6in -0.6in; padding:10px 0.6in 14px; background:#20242a; color:#cfd6d2; font-size:8.5px;">
      Remit to: ${esc(v.name)} · ${esc(v.bank)} · Routing ${v.routing} · Account ****${v.acct} · ${esc(v.email)}
    </div>
  </div>`;
}

// ---- Layout 4: statement of account (B5) -----------------------------------
function statement(spec, v, c, fmt) {
  const rows = spec.statementRows.map((r) => `
    <tr>
      <td style="padding:8px 8px 8px 0; border-bottom:1px solid #ddd;">${esc(r.no)}</td>
      <td style="padding:8px; border-bottom:1px solid #ddd;">${r.date}</td>
      <td class="num" style="padding:8px; border-bottom:1px solid #ddd;">${fmt(r.amount)}</td>
      <td style="padding:8px 0 8px 8px; border-bottom:1px solid #ddd; color:${r.status === 'Open' ? '#8a5a00' : '#3a7d44'};">${r.status}</td>
    </tr>`).join('');
  const balance = spec.statementRows.filter((r) => r.status === 'Open').reduce((s, r) => s + r.amount, 0);
  return `
  <div class="paper" style="font-family: Helvetica, Arial, sans-serif; color:#1a1a1a; display:flex; flex-direction:column;">
    <div style="display:flex; justify-content:space-between;">
      <div>
        <div style="font-size:19px; font-weight:700; color:${v.accent};">${esc(v.name)}</div>
        <div style="color:#666; font-size:9.5px; margin-top:4px;">${esc(v.addr)} · ${esc(v.city)}<br>${esc(v.email)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:19px; letter-spacing:0.14em; font-weight:600;">STATEMENT OF ACCOUNT</div>
        <div style="color:#666; font-size:10px; margin-top:6px;">Statement ${esc(spec.invoiceNo)} · As of ${spec.date}</div>
      </div>
    </div>
    <div style="margin-top:28px;">${billToBlock(c.billTo, 'ACCOUNT')}</div>
    <div style="margin-top:26px;">
      <table style="font-size:10.5px;">
        <thead><tr style="background:#f2f2f2;">
          <th style="text-align:left; padding:6px 8px 6px 6px; font-size:8.5px; letter-spacing:0.08em;">INVOICE NO.</th>
          <th style="text-align:left; padding:6px 8px; font-size:8.5px; letter-spacing:0.08em;">DATE</th>
          <th class="num" style="padding:6px 8px; font-size:8.5px; letter-spacing:0.08em;">AMOUNT</th>
          <th style="text-align:left; padding:6px 6px 6px 8px; font-size:8.5px; letter-spacing:0.08em;">STATUS</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="margin-top:22px; display:flex; justify-content:flex-end; align-items:baseline; gap:18px;">
      <div style="color:#555; font-size:11px;">Balance due</div>
      <div style="font-size:17px; font-weight:700;">${fmt(balance)}</div>
    </div>
    <div style="margin-top:14px; color:#777; font-size:9.5px;">This statement summarizes open and recently paid invoices. Please pay against the individual invoices listed above.</div>
    ${remitFooter(v, spec)}
  </div>`;
}

// ---- Layout 5: credit note (B6) --------------------------------------------
function creditnote(spec, v, c, fmt) {
  return `
  <div class="paper" style="font-family: Georgia, serif; color:#1a1a1a; display:flex; flex-direction:column;">
    <div style="display:flex; justify-content:space-between;">
      <div>
        <div style="font-size:19px; font-weight:700; color:${v.accent};">${esc(v.name)}</div>
        <div style="font-family: Helvetica, sans-serif; color:#666; font-size:9.5px; margin-top:4px;">${esc(v.addr)} · ${esc(v.city)} · ${esc(v.email)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:22px; letter-spacing:0.12em; color:#a03123; font-weight:700;">CREDIT NOTE</div>
        <div style="font-family: Helvetica, sans-serif; color:#666; font-size:10px; margin-top:6px;">${esc(spec.invoiceNo)} · ${spec.date}</div>
      </div>
    </div>
    <div style="font-family: Helvetica, sans-serif; margin-top:26px;">${billToBlock(c.billTo, 'CREDIT TO')}</div>
    <div style="font-family: Helvetica, sans-serif; margin-top:10px; font-size:10px; color:#555;">
      Applies to invoice <b>${esc(spec.creditRef)}</b>.
    </div>
    <div style="font-family: Helvetica, sans-serif; margin-top:20px;">${linesTable(spec, fmt)}</div>
    <div style="font-family: Helvetica, sans-serif; margin-top:16px; display:flex; justify-content:flex-end; align-items:baseline; gap:18px;">
      <div style="color:#555; font-size:11px;">Total credit</div>
      <div style="font-size:16px; font-weight:700; color:#a03123;">${fmt(c.shownTotal)}</div>
    </div>
    <div style="font-family: Helvetica, sans-serif; margin-top:12px; color:#777; font-size:9.5px;">
      Do not pay this document. The credit will be applied against your next invoice or refunded on request.
    </div>
    ${remitFooter(v, spec)}
  </div>`;
}

// ---- Layout 6: German (EUR, D3) --------------------------------------------
function eu(spec, v, c, fmt) {
  return `
  <div class="paper" style="font-family: Arial, Helvetica, sans-serif; color:#1a1a1a; display:flex; flex-direction:column;">
    <div style="font-size:7.5px; color:#888; border-bottom:1px solid #ddd; padding-bottom:3px;">
      ${esc(v.name)} · ${esc(v.addr)} · ${esc(v.city)}
    </div>
    <div style="margin-top:20px; display:flex; justify-content:space-between;">
      <div style="font-size:10.5px; line-height:1.55;">
        <b>${esc(c.billTo.name)}</b><br>${esc(c.billTo.addr)}<br>${esc(c.billTo.city)}<br>USA
      </div>
      <div style="text-align:right; font-size:10px; color:#444;">
        <b style="font-size:14px; color:#000;">${esc(v.name)}</b><br>${esc(v.addr)}<br>${esc(v.city)}<br>${esc(v.email)}<br>${esc(v.phone)}
      </div>
    </div>
    <div style="margin-top:34px; font-size:19px; font-weight:700;">RECHNUNG</div>
    <table style="width:auto; margin-top:10px;">${metaRows([
      ['RECHNUNGSNR.', spec.invoiceNo], ['RECHNUNGSDATUM', spec.date],
      ['FÄLLIG AM', spec.due], ['ZAHLUNGSZIEL', spec.terms]])}</table>
    <div style="margin-top:20px;">
      <table style="font-size:10.5px;">
        <thead><tr style="background:#f2f2f2;">
          <th style="text-align:left; padding:6px 8px 6px 6px; font-size:8.5px; letter-spacing:0.06em;">BESCHREIBUNG</th>
          <th class="num" style="padding:6px 8px; font-size:8.5px;">MENGE</th>
          <th class="num" style="padding:6px 8px; font-size:8.5px;">EINZELPREIS</th>
          <th class="num" style="padding:6px 6px 6px 8px; font-size:8.5px;">BETRAG</th>
        </tr></thead>
        <tbody>${spec.lines.map((l) => `
          <tr>
            <td style="padding:7px 8px 7px 0; border-bottom:1px solid #ddd;">${esc(l.desc)}</td>
            <td class="num" style="padding:7px 8px; border-bottom:1px solid #ddd;">${l.qty}</td>
            <td class="num" style="padding:7px 8px; border-bottom:1px solid #ddd;">${fmt(l.unit)}</td>
            <td class="num" style="padding:7px 0 7px 8px; border-bottom:1px solid #ddd;">${fmt(l.qty * l.unit)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <table style="width:auto; margin-left:auto; margin-top:14px; font-size:10.5px;">
      <tr><td style="padding:5px 14px 5px 0; color:#555;">Zwischensumme</td><td class="num">${fmt(c.shownSubtotal)}</td></tr>
      <tr><td style="padding:5px 14px 5px 0; color:#555;">USt. 0 % (Reverse-Charge, §13b UStG)</td><td class="num">${fmt(0)}</td></tr>
      <tr><td style="padding:5px 14px 5px 0; font-weight:700; font-size:12px;">Gesamtbetrag</td><td class="num" style="font-weight:700; font-size:12px;">${fmt(c.shownTotal)}</td></tr>
    </table>
    <div style="margin-top:auto; border-top:1px solid #ccc; padding-top:10px; font-size:9px; color:#444; line-height:1.6;">
      <b>Bankverbindung:</b> ${esc(v.bankName)} · IBAN ${esc(v.iban)} · BIC ${esc(v.bic)}<br>
      USt-IdNr. DE 812 345 678 · Geschäftsführerin: L. Bergmann · Amtsgericht Charlottenburg HRB 199 442
    </div>
  </div>`;
}

// ---- Multi-page (C3): letterhead with grouped phases, total on last page ---
function multipage(spec, v, c, fmt) {
  const group = (g, i, last) => `
    <div style="${i > 0 ? 'page-break-before: always;' : ''}">
      ${i > 0 ? `<div style="display:flex; justify-content:space-between; color:#888; font-size:9px; padding-bottom:8px; border-bottom:1px solid #ddd; margin-bottom:16px;">
        <span>${esc(v.name)} — Invoice ${esc(spec.invoiceNo)} (continued)</span><span>Page ${i + 1} of ${spec.lineGroups.length}</span></div>` : ''}
      <div style="font-size:11px; font-weight:700; color:${v.accent}; margin:18px 0 8px;">${esc(g.title)}</div>
      ${linesTable({ lines: g.lines }, fmt)}
      ${!last ? `<div style="color:#999; font-size:9px; margin-top:14px; font-style:italic;">Continued on next page — total on final page.</div>` : ''}
    </div>`;
  return `
  <div class="paper" style="font-family: Helvetica, Arial, sans-serif; color:#1a1a1a;">
    <div style="height:8px; background:${v.accent}; margin-bottom:22px;"></div>
    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
      <div>
        <div style="font-family: Georgia, serif; font-size:21px; font-weight:700; color:${v.accent};">${esc(v.name)}</div>
        <div style="color:#666; font-size:9.5px; margin-top:5px;">${esc(v.addr)} · ${esc(v.city)}<br>${esc(v.email)} · ${esc(v.phone)}</div>
      </div>
      <div style="font-size:26px; letter-spacing:0.18em; font-weight:300;">INVOICE</div>
    </div>
    <div style="display:flex; justify-content:space-between; margin-top:24px;">
      <div>${billToBlock(c.billTo)}</div>
      <table style="width:auto;">${metaRows([
        ['INVOICE NO.', spec.invoiceNo], ['INVOICE DATE', spec.date], ['DUE DATE', spec.due],
        ['TERMS', spec.terms], ['PO NUMBER', spec.po], ['PAGES', String(spec.lineGroups.length)]])}</table>
    </div>
    ${spec.lineGroups.map((g, i) => group(g, i, i === spec.lineGroups.length - 1)).join('')}
    <div style="margin-top:20px;">${totalsBlock(c, fmt)}</div>
    <div style="border-top:1px solid #ccc; margin-top:26px; padding-top:10px; font-size:9.5px; color:#333;">
      <div style="font-size:8px; letter-spacing:0.1em; color:#888; margin-bottom:4px;">REMIT BY ACH</div>
      ${esc(v.bank)} · Routing ${v.routing} · Account ****${v.acct}
    </div>
  </div>`;
}

const LAYOUTS = { letterhead, minimal, twocol, statement, creditnote, eu, multipage };

// ---- Degradation scenes (section C screenshots) -----------------------------
function scene(mode, paperHtml, stampDate) {
  if (mode === 'photo') {
    // Paper on a desk: skewed, shadowed corner, footer cropped by the framing.
    return `
    <div style="background:#69594a; padding:52px 64px 0; min-height:1460px; overflow:hidden;">
      <div style="width:900px; margin:0 auto; height:1380px; overflow:hidden; transform: rotate(1.8deg); transform-origin: top center;">
        <div style="background:#fdfcf8; padding:56px 60px; box-shadow: 0 18px 60px rgba(0,0,0,0.55); filter: sepia(0.14) brightness(0.97) contrast(0.96); position:relative;">
          ${paperHtml}
          <div style="position:absolute; inset:0; background: linear-gradient(115deg, rgba(0,0,0,0) 55%, rgba(35,25,10,0.32) 88%); pointer-events:none;"></div>
          <div style="position:absolute; inset:0; background: radial-gradient(ellipse at 18% 8%, rgba(255,255,240,0.28), rgba(0,0,0,0) 45%); pointer-events:none;"></div>
        </div>
      </div>
    </div>`;
  }
  if (mode === 'scan') {
    // Flatbed scan: grayscale, low contrast, slightly soft and misaligned.
    return `
    <div style="background:#e9e9e9; padding:26px;">
      <div style="width:960px; margin:0 auto; background:#fff; padding:60px 64px; transform: rotate(-0.4deg); filter: grayscale(1) contrast(0.8) brightness(1.06) blur(0.45px); box-shadow: 0 0 2px rgba(0,0,0,0.4);">
        ${paperHtml}
      </div>
    </div>`;
  }
  if (mode === 'stamp') {
    // Clean page, but a PAID stamp and a handwritten note overlap the totals.
    return `
    <div style="background:#f4f4f4; padding:26px;">
      <div style="width:960px; margin:0 auto; background:#fff; padding:60px 64px; position:relative; box-shadow: 0 1px 4px rgba(0,0,0,0.2);">
        ${paperHtml}
        <div style="position:absolute; right:70px; top:352px; transform: rotate(-14deg); border: 4px solid rgba(178,34,34,0.72); color: rgba(178,34,34,0.75); font-family: Helvetica, sans-serif; font-weight: 800; font-size: 44px; letter-spacing: 0.22em; padding: 5px 24px; border-radius: 6px;">PAID</div>
        <div style="position:absolute; right:64px; top:438px; transform: rotate(-3deg); font-family: 'Bradley Hand', 'Marker Felt', cursive; color: #1a3a8f; font-size: 23px;">pd ${stampDate} — $3,150.00 ✓</div>
      </div>
    </div>`;
  }
  throw new Error(`unknown degrade mode: ${mode}`);
}

// ---- Entry point ------------------------------------------------------------
// Returns a full HTML document for either print-to-pdf or screenshot capture.
export function buildHtml(spec, vendor, computed) {
  const fmt = spec.currency === 'EUR' ? moneyEUR : money;
  const layoutName = spec.multipage ? 'multipage' : (spec.template ?? vendor.template);
  const layout = LAYOUTS[layoutName];
  if (!layout) throw new Error(`unknown template: ${layoutName}`);
  const paper = layout(spec, vendor, computed, fmt);

  if (spec.degrade) {
    const inner = paper.replace('class="paper"', 'class="paper-inline"'); // sized by the scene wrapper
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      ${BASE_CSS}
      .paper-inline { min-height: 1180px; display: flex; flex-direction: column; }
    </style></head><body>${scene(spec.degrade, inner, spec.stampDate ?? '8/2')}</body></html>`;
  }

  if (spec.multipage) {
    // Real page margins so continuation pages don't start at the paper edge.
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      ${BASE_CSS}
      @page { size: letter; margin: 0.55in; }
      .paper { width: 100%; }
    </style></head><body>${paper}</body></html>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${BASE_CSS}
    @page { size: letter; margin: 0; }
    html, body { width: 8.5in; }
    /* Definite height, not min-height: flex children (sidebar stretch, flex:1
       rows, margin-top:auto footers) get no free space from min-height alone. */
    .paper { width: 8.5in; height: 10.9in; padding: 0.6in; overflow: hidden; }
  </style></head><body>${paper}${spec.renderSalt ? `<!-- ${spec.renderSalt} -->` : ''}</body></html>`;
}
