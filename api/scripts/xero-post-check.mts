// Bench only. Posts real bills to Xero the way a team does: a PDF addressed to the team
// is uploaded and read, confirmed with Categories from the Xero chart, approved by the
// approver, and posted at approval. Then each bill is read back from Xero, with its file.
//
// The team is a seeded one with Xero set up and Go pressed. Its seed response (with the
// sessions, never printed) is the JSON file XERO_POST_TEAM names. Run from api/:
//   XERO_POST_TEAM=/path/to/team.json DATABASE_URL=postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_bench \
//     npx tsx scripts/xero-post-check.mts <scenario...>
// Scenarios: fresh known

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const requestedDb = process.env.DATABASE_URL;
try { process.loadEnvFile(join(import.meta.dirname, '..', '.env')); } catch { /* rely on the environment */ }
process.env.DATABASE_URL = requestedDb;
if (!/\/usdc_ops_bench(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing to run: DATABASE_URL must point at usdc_ops_bench.');
  process.exit(2);
}

const API = process.env.SETUP_CHAT_API ?? 'http://127.0.0.1:3200';
const STATE = process.env.XERO_POST_TEAM;
if (!STATE) { console.error('Set XERO_POST_TEAM to the seeded team file.'); process.exit(2); }
const seeded = JSON.parse(readFileSync(STATE, 'utf8')) as {
  organizationId: string; organizationName: string; users: Array<{ access: string; roles: string[]; sessionToken: string }>;
};
const team = {
  organizationName: seeded.organizationName,
  owner: { token: seeded.users.find((u) => u.access === 'primary_admin')!.sessionToken },
  approver: { token: seeded.users.find((u) => u.roles.includes('approver'))!.sessionToken },
};
const org = seeded.organizationId;

const { prisma } = await import('../src/infra/prisma.js');
const { xeroWriteClientFor } = await import('../src/integrations/xero-connector.js');
const { listChartOfAccounts } = await import('../src/accounting/ocr-coding.js');

type Line = { description: string; qty: number; unit: number; category: string };
type Scenario = { vendor: string; address: string[]; number: string; date: string; due: string; lines: Line[]; tax: number; expect: string };

const xero = await xeroWriteClientFor(org);
if (!xero) { console.error('This team has no live Xero connection.'); process.exit(1); }
const chart = await listChartOfAccounts(org);
/** The first of these the chart has, so a reset Demo Company still works. */
const category = (...names: string[]) => {
  const found = names.find((n) => chart.some((a) => a.name === n));
  if (!found) throw new Error(`None of ${names.join(', ')} is in the chart. It has: ${chart.map((a) => a.name).join(', ')}`);
  return found;
};
/** A supplier the Demo Company has already: its contact is found, not made. */
const known = await prisma.booksRecord.findFirst({ where: { organizationId: org, kind: 'vendor' }, orderBy: { name: 'asc' }, select: { name: true } });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const n = () => 1000 + Math.floor(Math.random() * 9000);

const SCENARIOS: Record<string, () => Scenario> = {
  fresh: () => ({
    vendor: 'Harbor Light Electric', address: ['18 Pier Road', 'Oakland, CA 94607'], number: `HLE-${n()}`, date: day(-2), due: day(28),
    lines: [
      { description: 'Lighting repair, warehouse bay 2', qty: 1, unit: 340, category: category('Repairs and Maintenance', 'General Expenses') },
      { description: 'Replacement LED panels, 6', qty: 1, unit: 186.5, category: category('Office Expenses', 'General Expenses') },
    ],
    tax: 42.12,
    expect: 'a new contact; two lines, tax 42.12 on the larger line\'s account; total 568.62; awaiting payment; the PDF attached',
  }),
  known: () => ({
    vendor: known?.name ?? 'none', address: ['1 Supplier Way', 'Portland, OR 97201'], number: `KN-${n()}`, date: day(-1), due: day(29),
    lines: [{ description: 'Monthly service', qty: 1, unit: 95.4, category: category('General Expenses', 'Office Expenses') }],
    tax: 0,
    expect: `the Demo Company's own contact "${known?.name}", found by name, not a second one`,
  }),
};

async function call(path: string, token: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => null) as any;
  if (!res.ok) throw new Error(`${path.replace(org, ':org')}: ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── A one-page invoice, by hand: Helvetica text at fixed places ───
function pdf(rows: Array<{ x: number; y: number; text: string; bold?: boolean; size?: number }>): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = ['BT', ...rows.map((r) => `/${r.bold ? 'F2' : 'F1'} ${r.size ?? 10} Tf 1 0 0 1 ${r.x} ${r.y} Tm (${esc(r.text)}) Tj`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function invoice(s: Scenario): Buffer {
  const rows: Array<{ x: number; y: number; text: string; bold?: boolean; size?: number }> = [];
  rows.push({ x: 50, y: 740, text: s.vendor, bold: true, size: 16 });
  s.address.forEach((a, i) => rows.push({ x: 50, y: 722 - i * 13, text: a }));
  rows.push({ x: 440, y: 740, text: 'INVOICE', bold: true, size: 20 });
  rows.push({ x: 380, y: 712, text: `Invoice number: ${s.number}` });
  rows.push({ x: 380, y: 698, text: `Invoice date: ${longDate(s.date)}` });
  rows.push({ x: 380, y: 684, text: `Due date: ${longDate(s.due)}` });
  rows.push({ x: 380, y: 670, text: 'Terms: Net 30' });
  rows.push({ x: 50, y: 640, text: 'Bill to', bold: true });
  rows.push({ x: 50, y: 626, text: team.organizationName });
  rows.push({ x: 50, y: 613, text: '500 Market Street, Suite 400' });
  rows.push({ x: 50, y: 600, text: 'San Francisco, CA 94105' });
  let y = 560;
  rows.push({ x: 50, y, text: 'Description', bold: true }, { x: 330, y, text: 'Qty', bold: true }, { x: 390, y, text: 'Unit price', bold: true }, { x: 490, y, text: 'Amount', bold: true });
  for (const l of s.lines) {
    y -= 18;
    rows.push({ x: 50, y, text: l.description }, { x: 330, y, text: String(l.qty) }, { x: 390, y, text: money(l.unit) }, { x: 490, y, text: money(l.qty * l.unit) });
  }
  const subtotal = s.lines.reduce((n, l) => n + l.qty * l.unit, 0);
  y -= 34;
  rows.push({ x: 390, y, text: 'Subtotal' }, { x: 490, y, text: money(subtotal) });
  y -= 15;
  rows.push({ x: 390, y, text: s.tax > 0 ? 'Sales tax (8%)' : 'Sales tax' }, { x: 490, y, text: money(s.tax) });
  y -= 18;
  rows.push({ x: 390, y, text: 'Total due (USD)', bold: true }, { x: 490, y, text: money(subtotal + s.tax), bold: true });
  rows.push({ x: 50, y: 120, text: 'Thank you for your business.' });
  return pdf(rows);
}


async function draftOf(billId: string) {
  for (let i = 0; i < 90; i += 1) {
    const d = await call(`/organizations/${org}/bills/${billId}/draft`, team.owner.token);
    if ((d.lines ?? []).length > 0) return d;
    await sleep(2000);
  }
  throw new Error('The bill was not read within three minutes.');
}

async function approve(billId: string) {
  for (let i = 0; i < 15; i += 1) {
    for (const [who, token] of [['approver', team.approver.token], ['owner', team.owner.token]] as const) {
      const box = await call(`/organizations/${org}/bills/approvals-inbox`, token);
      const mine = (box.waitingOnYou ?? []).find((x: { paymentOrderId: string }) => x.paymentOrderId === billId);
      if (mine) {
        await call(`/organizations/${org}/approvals/tasks/${mine.taskId}/command`, token, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() });
        return who;
      }
    }
    await sleep(1000);
  }
  throw new Error('Nobody on the team had an approval waiting for this bill.');
}



async function syncOf(billId: string) {
  for (let i = 0; i < 40; i += 1) {
    const row = await prisma.accountingSync.findUnique({ where: { paymentOrderId_provider: { paymentOrderId: billId, provider: 'xero' } } });
    if (row && (row.externalBillId || row.error || row.status === 'held')) return row;
    await sleep(1500);
  }
  return prisma.accountingSync.findUnique({ where: { paymentOrderId_provider: { paymentOrderId: billId, provider: 'xero' } } });
}

const keys = process.argv.slice(2);
if (keys.length === 0 || keys.some((k) => !SCENARIOS[k])) {
  console.error(`usage: xero-post-check.mts <${Object.keys(SCENARIOS).join('|')}>...`);
  process.exit(2);
}

for (const key of keys) {
  const s = SCENARIOS[key]!();
  console.log(`\n== ${key}: ${s.vendor} ${s.number}\nexpect: ${s.expect}`);
  const up = await call(`/organizations/${org}/invoices/upload`, team.owner.token, {
    filename: `${s.number}.pdf`, mimeType: 'application/pdf', dataBase64: invoice(s).toString('base64'), autoAdvance: false,
  });
  const billId: string = up.paymentOrders[0].paymentOrder.paymentOrderId;
  const draft = await draftOf(billId);
  console.log('read:', JSON.stringify({
    bill: billId,
    lines: (draft.lines ?? []).map((l: any) => [l.description, l.amount, l.category]),
    flags: (draft.flags ?? []).map((f: any) => `${f.kind}${f.blocking ? ' (blocking)' : ''}`),
  }));

  const subtotal = s.lines.reduce((t, l) => t + l.qty * l.unit, 0);
  await call(`/organizations/${org}/bills/${billId}/confirm`, team.owner.token, {
    fields: { vendorName: s.vendor, invoiceNumber: s.number, invoiceDate: s.date, dueDate: s.due, terms: 'Net 30', currency: 'USD', total: Math.round((subtotal + s.tax) * 100) / 100, taxAmount: s.tax },
    lines: s.lines.map((l) => ({ description: l.description, quantity: l.qty, unitPrice: l.unit, amount: Math.round(l.qty * l.unit * 100) / 100, category: l.category, categoryConfirmed: true })),
    confirmedFieldKeys: ['vendorName', 'invoiceNumber', 'invoiceDate', 'dueDate', 'terms', 'currency', 'total', 'taxAmount', 'subtotal', 'poNumber', 'discount', 'vendorEmail', 'remitTo'],
  });
  const by = await approve(billId);
  const sync = await syncOf(billId);
  console.log('decimal:', JSON.stringify({ approvedBy: by, status: sync?.status, contact: sync?.externalVendorId, bill: sync?.externalBillId, error: sync?.error, attempts: sync?.attempts }));
  if (sync?.externalBillId) {
    const b = ((await xero.get(`Invoices/${sync.externalBillId}`)) as any).Invoices[0];
    console.log('xero:', JSON.stringify({
      id: b.InvoiceID, type: b.Type, status: b.Status, contact: b.Contact?.Name, reference: b.InvoiceNumber, date: b.DateString, due: b.DueDateString,
      amounts: b.LineAmountTypes, currency: b.CurrencyCode, total: b.Total, due_now: b.AmountDue, files: b.HasAttachments,
      lines: (b.LineItems ?? []).map((l: any) => [l.LineAmount, l.AccountCode, l.TaxType, l.Description]),
    }));
    let meta: { attachmentId?: string; attachmentFailed?: string } = {};
    for (let i = 0; i < 20 && !meta.attachmentId && !meta.attachmentFailed; i += 1) {
      meta = ((await syncOf(billId))?.metadataJson ?? {}) as typeof meta;
      if (!meta.attachmentId && !meta.attachmentFailed) await sleep(1000);
    }
    if (meta.attachmentId) {
      const files = ((await xero.get(`Invoices/${sync.externalBillId}/Attachments`)) as any).Attachments ?? [];
      const doc = await prisma.paymentOrder.findUnique({ where: { paymentOrderId: billId }, select: { invoiceDocument: { select: { byteSize: true, filename: true } } } });
      console.log('attachment:', JSON.stringify({ kept: meta.attachmentId, inXero: files.map((f: any) => ({ id: f.AttachmentID, file: f.FileName, type: f.MimeType, size: f.ContentLength })), uploaded: doc?.invoiceDocument?.byteSize, uploadedAs: doc?.invoiceDocument?.filename }));
    } else {
      console.log('attachment:', JSON.stringify(meta));
    }
  }
}
await prisma.$disconnect();
