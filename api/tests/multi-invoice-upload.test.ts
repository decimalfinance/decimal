// One upload holding several invoices: one bill each, and each bill its own pages
// (split-pages.ts). The model is scripted; the PDF is real, so poppler reads it, finds
// where each invoice's number is printed, and cuts the pages out.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { prisma } from '../src/infra/prisma.js';
import { setInvoiceIntakeRuntimeForTests } from '../src/payments/invoice-intake.js';
import { baseUrl, get, makeWorld, post } from './helpers/companion-harness.js';

const execFileAsync = promisify(execFile);

/** A real PDF, a page per entry, each line of text where pdftotext will find it. */
function pdfOf(pages: string[][]): Buffer {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, i) => {
    const content = `BT /F1 14 Tf 72 720 Td ${lines.map((l, k) => `${k ? '0 -24 Td ' : ''}(${l}) Tj`).join(' ')} ET`;
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function textOf(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'split-test-'));
  try {
    await writeFile(join(dir, 'f.pdf'), bytes);
    return (await execFileAsync('pdftotext', [join(dir, 'f.pdf'), '-'])).stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Invoice = { vendor: string; number: string; amount: number; hintPage?: number };

/** The model, scripted: one row per invoice, with the page it says each number is on. */
function readsAs(billTo: string, invoices: Invoice[], pageCount: number) {
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: invoices.map((inv) => ({
        counterparty: inv.vendor, amount: inv.amount, currency: 'USD', reference: inv.number,
        due_date: '2026-12-01', wallet_address: null, notes: null,
        source_invoice: {
          vendorName: inv.vendor, vendorAddress: null, vendorEmail: null, amount: inv.amount, currency: 'USD',
          invoiceNumber: inv.number, invoiceDate: '2026-11-01', dueDate: '2026-12-01', terms: 'Net 30',
          poNumber: null, earlyPayDiscount: null, subtotal: inv.amount, taxAmount: 0, billToName: billTo,
          remitTo: null, paymentDetails: null, walletAddress: null,
          lineItems: [{ description: 'Services', quantity: 1, unitPrice: inv.amount, total: inv.amount }],
          categoryHint: 'Services', confidence: { vendor: 1, amount: 1, overall: 1 }, fieldConfidence: null,
          fieldSources: { invoiceNumber: { page: inv.hintPage ?? 1, box: [0.1, 0.1, 0.2, 0.03] } },
        },
      })),
      modelLatencyMs: 1, pageCount,
    }),
  });
}

async function uploadFile(orgId: string, token: string, filename: string, bytes: Buffer) {
  const up = await post(`/organizations/${orgId}/invoices/upload`, {
    filename, mimeType: 'application/pdf', dataBase64: bytes.toString('base64'), autoAdvance: false,
  }, token);
  return {
    uploadId: up.invoiceDocumentId as string,
    billIds: (up.paymentOrders as Array<{ paymentOrder: { paymentOrderId: string } }>).map((o) => o.paymentOrder.paymentOrderId),
  };
}

const THREE = [
  { vendor: 'Linden Pest Control', number: 'LPC-5501', amount: 680 },
  { vendor: 'Marrow Street Bakery Supply', number: 'MSB-3120', amount: 1215 },
  { vendor: 'Corvid IT Services', number: 'CIT-9047', amount: 2340 },
];

test('three invoices in one upload make three bills, each with its own page, its boxes on it, and the others named', async () => {
  const w = await makeWorld();
  // The model puts every number on page 1: the pages come from where the numbers are printed.
  readsAs(w.orgName, THREE.map((inv) => ({ ...inv, hintPage: 1 })), 3);
  const file = pdfOf(THREE.map((inv) => [`INVOICE ${inv.number}`, inv.vendor, `Total due ${inv.amount.toFixed(2)}`]));
  const { uploadId, billIds } = await uploadFile(w.orgId, w.owner.token, 'three-bills.pdf', file);
  assert.equal(billIds.length, 3);

  for (const [i, billId] of billIds.entries()) {
    const draft = await get(`/organizations/${w.orgId}/bills/${billId}/draft`, w.owner.token);
    const number = THREE[i]!.number;
    assert.equal(draft.document.pageCount, 1, `${number} shows one page`);
    assert.equal(draft.document.filename, `three-bills (page ${i + 1}).pdf`);
    assert.notEqual(draft.document.invoiceDocumentId, uploadId);
    assert.deepEqual(draft.upload.pages, { from: i + 1, to: i + 1 });
    assert.equal(draft.upload.invoiceDocumentId, uploadId);
    assert.deepEqual(draft.upload.otherBills.map((b: { invoiceNumber: string }) => b.invoiceNumber), THREE.map((x) => x.number).filter((n) => n !== number));

    // Its file is its page alone, and the page image is there to show.
    const res = await fetch(`${baseUrl}/organizations/${w.orgId}/invoice-documents/${draft.document.invoiceDocumentId}`, { headers: { authorization: `Bearer ${w.owner.token}` } });
    const text = await textOf(Buffer.from(await res.arrayBuffer()));
    assert.match(text, new RegExp(number));
    assert.equal(THREE.filter((x) => x.number !== number).some((x) => text.includes(x.number)), false, `${number}'s file holds no other invoice`);
    const image = await fetch(`${baseUrl}/organizations/${w.orgId}/invoice-documents/${draft.document.invoiceDocumentId}/pages/0`, { headers: { authorization: `Bearer ${w.owner.token}` } });
    assert.equal(image.status, 200);

    // Its boxes are measured on its own page, which is page 1 of its document.
    const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: billId }, select: { invoiceDocumentId: true, metadataJson: true } });
    assert.equal(order.invoiceDocumentId, uploadId, 'the bill still belongs to the upload it came from');
    const sources = (order.metadataJson as any).agent.extracted.fieldSources;
    assert.equal(sources.invoiceNumber.page, 1);
  }

  const split = await prisma.companionStep.findFirst({ where: { organizationId: w.orgId, invoiceDocumentId: uploadId, kind: 'split' }, select: { text: true, detail: true } });
  assert.equal(split?.text, 'Gave each bill its own pages');
  assert.equal(split?.detail, 'LPC-5501: page 1. MSB-3120: page 2. CIT-9047: page 3.');
  // Each bill's categories are its own, and say which bill they are.
  const categories = await prisma.companionStep.findFirst({ where: { organizationId: w.orgId, invoiceDocumentId: uploadId, kind: 'categories' }, select: { text: true, detail: true } });
  assert.equal(categories?.text, 'Categorised 3 bills');
  assert.match(String(categories?.detail), /^LPC-5501: [a-z].*\. MSB-3120: [a-z].*\. CIT-9047: [a-z].*\.$/);

  // The status the reading page follows still lists every bill the upload made.
  const status = await get(`/organizations/${w.orgId}/invoice-documents/${uploadId}/status`, w.owner.token);
  assert.equal(status.paymentOrders.length, 3);
});

test('an invoice running onto a second page keeps both pages, and a cover sheet goes to the first', async () => {
  const w = await makeWorld();
  const pair = [
    { vendor: 'Ravensworth Signage', number: 'RS-3382', amount: 2640 },
    { vendor: 'Thistledown Catering Co', number: 'TC-1190', amount: 975 },
  ];
  readsAs(w.orgName, pair, 4);
  const file = pdfOf([
    ['Parcelpost Document Forwarding', 'Enclosed: RS-3382 and TC-1190'],
    ['INVOICE RS-3382', 'Ravensworth Signage'],
    ['RS-3382 continued', 'Total due 2640.00'],
    ['INVOICE TC-1190', 'Thistledown Catering Co', 'Total due 975.00'],
  ]);
  const { billIds } = await uploadFile(w.orgId, w.owner.token, 'forwarded.pdf', file);
  const ranges = await Promise.all(billIds.map(async (id) => (await get(`/organizations/${w.orgId}/bills/${id}/draft`, w.owner.token)).upload.pages));
  assert.deepEqual(ranges, [{ from: 1, to: 3 }, { from: 4, to: 4 }]);
});

test('two invoices on one page aren\'t split: both bills show the whole upload, and the job says why', async () => {
  const w = await makeWorld();
  const pair = [
    { vendor: 'Fairweather Janitorial', number: 'FJ-2031', amount: 1100 },
    { vendor: 'Goldfinch Staffing Group', number: 'GSG-7714', amount: 1196 },
  ];
  readsAs(w.orgName, pair, 1);
  const { uploadId, billIds } = await uploadFile(w.orgId, w.owner.token, 'two-up.pdf', pdfOf([['INVOICE FJ-2031', 'INVOICE GSG-7714']]));
  for (const id of billIds) {
    const draft = await get(`/organizations/${w.orgId}/bills/${id}/draft`, w.owner.token);
    assert.equal(draft.document.invoiceDocumentId, uploadId);
    assert.equal(draft.upload.pages, null);
    assert.equal(draft.upload.otherBills.length, 1);
  }
  const split = await prisma.companionStep.findFirst({ where: { organizationId: w.orgId, invoiceDocumentId: uploadId, kind: 'split' }, select: { text: true } });
  assert.equal(split?.text, 'Kept the pages together');
});

test('a bill\'s own pages, uploaded later as a file, are read as a new upload', async () => {
  const w = await makeWorld();
  readsAs(w.orgName, THREE.slice(0, 2), 2);
  const { billIds } = await uploadFile(w.orgId, w.owner.token, 'pair.pdf', pdfOf(THREE.slice(0, 2).map((inv) => [`INVOICE ${inv.number}`])));
  const draft = await get(`/organizations/${w.orgId}/bills/${billIds[1]}/draft`, w.owner.token);
  const res = await fetch(`${baseUrl}/organizations/${w.orgId}/invoice-documents/${draft.document.invoiceDocumentId}`, { headers: { authorization: `Bearer ${w.owner.token}` } });
  const pageFile = Buffer.from(await res.arrayBuffer());

  readsAs(w.orgName, [THREE[1]!], 1);
  const again = await uploadFile(w.orgId, w.owner.token, 'pair (page 2).pdf', pageFile);
  assert.notEqual(again.uploadId, draft.document.invoiceDocumentId);
  assert.equal(again.billIds.length, 1, 'read, and a bill made');
  assert.equal((await get(`/organizations/${w.orgId}/bills/${again.billIds[0]}/draft`, w.owner.token)).upload, null);
});
