// Bench only. Posts real bills to Xero the way a team does: a PDF addressed to the team
// is uploaded and read, confirmed with Categories from the Xero chart, approved by the
// approver, and posted at approval. Then each bill is read back from Xero, with its file.
//
// The team is a seeded one with Xero set up and Go pressed. Its seed response (with the
// sessions, never printed) is the JSON file XERO_POST_TEAM names. Run from api/:
//   XERO_POST_TEAM=/path/to/team.json DATABASE_URL=postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_bench \
//     npx tsx scripts/xero-post-check.mts <scenario...>
// Scenarios, run in the order given:
//   fresh     a new vendor: a contact is made; two Categories and tax
//   known     a vendor the books have: its contact is found, not made again
//   locked    dated on or before Xero's lock date: posts dated the first open day, due when it was
//   archived  its contact is archived in Xero (made and archived here first): refused, no second contact
//   replay    one bill sent twice with one key, a minute apart, as a retry does when an answer is lost
//   inbooks   after replay: that bill uploaded to Decimal is held as already in Xero; "Same bill" links it
//   late      after replay: sent again with the key 9.5 minutes after the first send, the edge of Decimal's window
//   discount  a trade discount as a negative line, as "Correct the figures" adds it (exceptions/arithmetic.ts)
// With STOP_AT_REVIEW=1 a bill is left in review instead, every line given its Category,
// for a person to work on (a test brief): nothing is confirmed, approved or sent.
// With STOP_IN_APPROVAL=1 it is sent for approval and left waiting there, for a look at
// the page the approvers see: nothing is approved or sent to Xero.

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncablePayment } from '../src/accounting/sync.js';

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
const { xeroBooks } = await import('../src/accounting/xero-books.js');
const { xeroReader } = await import('../src/integrations/xero-reader.js');

type Line = { description: string; qty: number; unit: number; category: string };
type Scenario = {
  vendor: string; address: string[]; number: string; date: string; due: string; lines: Line[]; tax: number; expect: string;
  /** Set up in Xero first. */
  before?: () => Promise<void>;
  /** Looked at in Xero after. */
  after?: () => Promise<void>;
};

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
  discount: () => ({
    vendor: 'Tamarack Tile & Stone', address: ['77 Quarry Road', 'Fresno, CA 93721'], number: `TTS-${n()}`, date: day(-2), due: day(28),
    lines: [
      { description: 'Porcelain floor tile, 40 boxes', qty: 1, unit: 3000, category: category('General Expenses', 'Office Expenses') },
      { description: 'Less 10% trade discount', qty: 1, unit: -300, category: category('General Expenses', 'Office Expenses') },
    ],
    tax: 0,
    expect: 'a bill for 2,700.00 with a 3,000.00 line and a -300.00 discount line; awaiting payment; the PDF attached',
  }),
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
  locked: () => {
    const number = `HLE-${n()}`;
    return {
      vendor: 'Harbor Light Electric', address: ['18 Pier Road', 'Oakland, CA 94607'], number, date: '2008-09-15', due: '2008-10-15',
      lines: [{ description: 'Emergency call-out, September 2008', qty: 1, unit: 180, category: category('Repairs and Maintenance', 'General Expenses') }],
      tax: 0,
      expect: 'dated on or before Xero\'s lock date, so it posts dated the first open day after it (1 Oct 2008 on the Demo Company), still due 15 Oct 2008',
      before: async () => console.log('lock date, read live:', await xeroBooks(xero!).closedThrough(null)),
      after: async () => console.log('in xero:', JSON.stringify({ bills: await billsNumbered(number) })),
    };
  },
  archived: () => {
    const name = 'Lantern Row Supplies';
    const number = `LRS-${n()}`;
    return {
      vendor: name, address: ['44 Lantern Row', 'Boise, ID 83702'], number, date: day(-2), due: day(28),
      lines: [{ description: 'Shelving brackets, 24', qty: 1, unit: 133.2, category: category('Office Expenses', 'General Expenses') }],
      tax: 0,
      expect: `refused in words: "${name}" is archived in Xero; no second contact, and no bill`,
      before: async () => {
        let same = await contactsNamed(name);
        if (same.length === 0) {
          const made = ((await xero!.put('Contacts', { Contacts: [{ Name: name }] }, `check_contact_${crypto.randomUUID()}`)) as any).Contacts?.[0];
          same = [{ id: made.ContactID, status: made.ContactStatus }];
        }
        for (const c of same.filter((c) => c.status !== 'ARCHIVED')) {
          await xeroPost('Contacts', { Contacts: [{ ContactID: c.id, ContactStatus: 'ARCHIVED' }] }, `check_archive_${crypto.randomUUID()}`);
        }
        console.log('contact before:', JSON.stringify(await contactsNamed(name)));
      },
      after: async () => console.log('in xero:', JSON.stringify({ contacts: await contactsNamed(name), bills: await billsNumbered(number) })),
    };
  },
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

/** Every bill in Xero with this number: one, where Decimal must never have made two. */
async function billsNumbered(number: string) {
  const rows = ((await xero!.get('Invoices', { where: 'Type=="ACCPAY"', InvoiceNumbers: number })) as any).Invoices ?? [];
  return rows.map((b: any) => ({ id: b.InvoiceID, status: b.Status, total: b.Total, contact: b.Contact?.Name }));
}

/** Every contact with exactly this name, archived ones too. */
async function contactsNamed(name: string): Promise<Array<{ id: string; status: string }>> {
  const rows = ((await xero!.get('Contacts', { searchTerm: name, includeArchived: 'true' })) as any).Contacts ?? [];
  return rows
    .filter((c: any) => (c.Name ?? '').trim().toLowerCase() === name.toLowerCase())
    .map((c: any) => ({ id: c.ContactID, status: c.ContactStatus }));
}

/** A change Decimal never makes itself, such as archiving a contact, sent on the team's sign-in. The token is never printed. */
async function xeroPost(endpoint: string, json: unknown, key: string) {
  await xero!.get('Organisation'); // renews the sign-in through the app's own store, if it's due
  const row = await prisma.accountingConnection.findFirst({ where: { organizationId: org, provider: 'xero' }, select: { accessToken: true, realmId: true } });
  if (!row) throw new Error('This team has no Xero connection.');
  const res = await fetch(`https://api.xero.com/api.xro/2.0/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${row.accessToken}`, 'xero-tenant-id': String(row.realmId), Accept: 'application/json',
      'Content-Type': 'application/json', 'Idempotency-Key': key,
    },
    body: JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** The bill as Xero has it, with its file. */
async function showInXero(billId: string, xeroBillId: string) {
  const b = ((await xero!.get(`Invoices/${xeroBillId}`)) as any).Invoices[0];
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
    const files = ((await xero!.get(`Invoices/${xeroBillId}/Attachments`)) as any).Attachments ?? [];
    const doc = await prisma.paymentOrder.findUnique({ where: { paymentOrderId: billId }, select: { invoiceDocument: { select: { byteSize: true, filename: true } } } });
    console.log('attachment:', JSON.stringify({ kept: meta.attachmentId, inXero: files.map((f: any) => ({ id: f.AttachmentID, file: f.FileName, type: f.MimeType, size: f.ContentLength })), uploaded: doc?.invoiceDocument?.byteSize, uploadedAs: doc?.invoiceDocument?.filename }));
  } else {
    console.log('attachment:', JSON.stringify(meta));
  }
}

/** A bill as a team makes one: uploaded, read, confirmed and approved. Then what Decimal and Xero did with it. */
async function runBill(key: string, s: Scenario) {
  console.log(`\n== ${key}: ${s.vendor} ${s.number}\nexpect: ${s.expect}`);
  await s.before?.();
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
  if (process.env.STOP_AT_REVIEW) {
    await call(`/organizations/${org}/bills/${billId}/save`, team.owner.token, {
      fields: { vendorName: s.vendor, invoiceNumber: s.number, invoiceDate: s.date, dueDate: s.due, terms: 'Net 30', currency: 'USD', total: Math.round((subtotal + s.tax) * 100) / 100, taxAmount: s.tax },
      lines: s.lines.map((l) => ({ description: l.description, quantity: l.qty, unitPrice: l.unit, amount: Math.round(l.qty * l.unit * 100) / 100, category: l.category, categoryConfirmed: true })),
      confirmedFieldKeys: [],
    });
    console.log('left in review:', JSON.stringify({ bill: billId, number: s.number, page: `http://127.0.0.1:5274/organizations/${org}/bills/${billId}` }));
    return { billId, sync: null };
  }
  await call(`/organizations/${org}/bills/${billId}/confirm`, team.owner.token, {
    fields: { vendorName: s.vendor, invoiceNumber: s.number, invoiceDate: s.date, dueDate: s.due, terms: 'Net 30', currency: 'USD', total: Math.round((subtotal + s.tax) * 100) / 100, taxAmount: s.tax },
    lines: s.lines.map((l) => ({ description: l.description, quantity: l.qty, unitPrice: l.unit, amount: Math.round(l.qty * l.unit * 100) / 100, category: l.category, categoryConfirmed: true })),
    confirmedFieldKeys: ['vendorName', 'invoiceNumber', 'invoiceDate', 'dueDate', 'terms', 'currency', 'total', 'taxAmount', 'subtotal', 'poNumber', 'discount', 'vendorEmail', 'remitTo'],
  });
  if (process.env.STOP_IN_APPROVAL) {
    console.log('left in approval:', JSON.stringify({ bill: billId, number: s.number, page: `http://127.0.0.1:5274/organizations/${org}/bills/${billId}` }));
    return { billId, sync: null };
  }
  const by = await approve(billId);
  const sync = await syncOf(billId);
  console.log('decimal:', JSON.stringify({ approvedBy: by, status: sync?.status, contact: sync?.externalVendorId, bill: sync?.externalBillId, error: sync?.error, attempts: sync?.attempts }));
  if (sync?.externalBillId) await showInXero(billId, sync.externalBillId);
  await s.after?.();
  return { billId, sync };
}

// ─── A send whose answer was lost, and what comes of it ───

/** The replay's bill: sent by Decimal's own poster but recorded on no Decimal bill, as when an answer is lost. */
let replayed: { vendor: string; number: string; key: string; payment: SyncablePayment; billId: string; at: number; date: string; due: string; lines: Line[] } | null = null;

async function replay() {
  // A vendor Xero doesn't have yet, so the first send makes its contact and no Decimal bill knows it.
  const names = ['Quayside Paper Co.', 'Harbour Mill Paper', 'Tidewater Office Supply', 'Bellwether Print Co.', 'Kestrel Stationers'];
  let vendor = '';
  for (const candidate of names) if (!vendor && (await contactsNamed(candidate)).length === 0) vendor = candidate;
  if (!vendor) throw new Error('Every replay vendor is in Xero already: add a name to the list.');
  const name = category('Office Expenses', 'General Expenses');
  const account = (await xeroReader(xero!).accounts()).records.find((a) => a.name === name);
  if (!account) throw new Error(`${name} isn't in Xero's chart.`);
  const number = `QP-${n()}`;
  const date = day(-3);
  const due = day(27);
  const lines: Line[] = [{ description: 'Copier paper, 40 reams', qty: 1, unit: 212.4, category: name }];
  const payment: SyncablePayment = {
    id: `check_${number}`, vendorLabel: vendor, vendorId: null, amountUsdc: 212.4, invoiceNumber: number, reference: null,
    codedLines: [{ accountId: account.id, amount: 212.4, description: lines[0]!.description }],
    taxAmount: null, docNumber: number, txnDate: date, dueDate: due,
  };
  // Made the way account-sync.ts makes a send's key.
  const key = `check_${number}_bill_${Date.now().toString(36)}`;
  console.log(`\n== replay: ${vendor} ${number}\nexpect: one key sent twice, a minute apart, brings back the same bill and contact, and Xero has one bill`);
  const books = xeroBooks(xero!);
  const at = Date.now();
  const first = await books.post(payment, key);
  console.log('first send:', JSON.stringify({ bill: first.billId, contact: first.vendorId, total: first.billTotal }));
  console.log('the new contact, looked for by name at once:', JSON.stringify(await books.vendorNamed(vendor)));
  await sleep(60_000);
  const again = await books.post(payment, key);
  console.log('sent again a minute later:', JSON.stringify({ bill: again.billId, sameBill: again.billId === first.billId, sameContact: again.vendorId === first.vendorId }));
  console.log('in xero:', JSON.stringify({ bills: await billsNumbered(number), contacts: await contactsNamed(vendor) }));
  replayed = { vendor, number, key, payment, billId: first.billId, at, date, due, lines };
}

async function inbooks() {
  if (!replayed) throw new Error('inbooks needs replay first, in the same run.');
  const r = replayed;
  const { billId, sync } = await runBill('inbooks', {
    vendor: r.vendor, address: ['7 Quay Street', 'Seattle, WA 98101'], number: r.number, date: r.date, due: r.due, lines: r.lines, tax: 0,
    expect: `held: ${r.number} is in Xero already; the bill's page offers "Same bill" for it at once, which links to it, and Xero still has one`,
  });
  if (sync?.status !== 'held') return;
  // What the bill's page shows as it opens, and answers from.
  const detail = await call(`/organizations/${org}/bills/${billId}/detail`, team.owner.token);
  const flag = (detail.draft?.flags ?? []).find((f: any) => f.kind === 'in_books');
  console.log('page:', JSON.stringify({ short: flag?.short, choices: (flag?.resolutions ?? []).map((x: any) => [x.label, x.targetId]), look: detail.draft?.booksCheck?.status }));
  const target = (flag?.resolutions ?? []).find((x: any) => x.action === 'same_bill')?.targetId;
  if (target !== r.billId) {
    console.log(`the page offers no "Same bill" for ${r.billId}: nothing to answer`);
    return;
  }
  const answered = await call(`/organizations/${org}/bills/${billId}/in-books`, team.owner.token, { recordId: target, same: true });
  console.log('answered "Same bill":', JSON.stringify({ posting: answered.posting, linked: answered.linked }));
  const after = await prisma.accountingSync.findUnique({ where: { paymentOrderId_provider: { paymentOrderId: billId, provider: 'xero' } } });
  console.log('decimal:', JSON.stringify({ status: after?.status, bill: after?.externalBillId, theOneInXero: after?.externalBillId === r.billId, error: after?.error, meta: after?.metadataJson }));
  if (after?.externalBillId) await showInXero(billId, after.externalBillId);
  console.log('in xero:', JSON.stringify({ bills: await billsNumbered(r.number) }));
}

async function late() {
  if (!replayed) throw new Error('late needs replay first, in the same run.');
  const r = replayed;
  console.log(`\n== late: ${r.number}, sent again with its key 9.5 minutes after the first send\nexpect: the same bill back, and still one in Xero`);
  const wait = r.at + 9.5 * 60_000 - Date.now();
  if (wait > 0) await sleep(wait);
  const again = await xeroBooks(xero!).post(r.payment, r.key);
  console.log('sent again:', JSON.stringify({ minutesAfter: Math.round((Date.now() - r.at) / 6000) / 10, bill: again.billId, sameBill: again.billId === r.billId }));
  if (again.billId !== r.billId) {
    // Xero forgot the key sooner: the second bill is a test's leftover, so it's voided.
    await xeroPost('Invoices', { Invoices: [{ InvoiceID: again.billId, Status: 'VOIDED' }] }, `check_void_${crypto.randomUUID()}`);
    console.log('voided the second bill:', again.billId);
  }
  console.log('in xero:', JSON.stringify({ bills: await billsNumbered(r.number) }));
}

const SENDS: Record<string, () => Promise<void>> = { replay, inbooks, late };
const keys = process.argv.slice(2);
if (keys.length === 0 || keys.some((k) => !SCENARIOS[k] && !SENDS[k])) {
  console.error(`usage: xero-post-check.mts <${[...Object.keys(SCENARIOS), ...Object.keys(SENDS)].join('|')}>...`);
  process.exit(2);
}
for (const key of keys) {
  if (SENDS[key]) await SENDS[key]!();
  else await runBill(key, SCENARIOS[key]!());
}
await prisma.$disconnect();
