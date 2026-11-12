// The arithmetic investigator (exceptions/arithmetic.ts): when a bill's figures
// don't add up, it reads the document for why, and "Correct the figures" applies
// what it found. The sums and the checks are code's, tested directly; the model
// is scripted, and the PDF is real, so poppler reads it as it would any upload.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { drainBackgroundWork } from '../src/infra/background.js';
import { setExceptionAgentRuntimeForTests } from '../src/exceptions/agent.js';
import {
  ARITHMETIC_FINDING_SCHEMA, amountsIn, docLines, figuresContext, figuresFingerprint, figuresFinding, gapOf,
  judgeFinding, needsCheck, unaccounted, type ArithmeticCheck, type BillFigures,
} from '../src/exceptions/arithmetic.js';
import { strictSchemaViolations } from '../src/payments/document-extract.js';
import { setInvoiceIntakeRuntimeForTests } from '../src/payments/invoice-intake.js';
import { get, makeWorld, post, raw } from './helpers/companion-harness.js';

afterEach(() => {
  setExceptionAgentRuntimeForTests(null);
  setInvoiceIntakeRuntimeForTests(null);
});

// A freight charge in the totals block that a reading of the lines and tax leaves out.
const R1_PAGE = [
  'ALDERBROOK FIXINGS LTD',
  'INVOICE AF-7721',
  'Hex bolts M10      200    4.50      900.00',
  'Anchor plates       50   22.00    1,100.00',
  'Subtotal                          2,000.00',
  'Freight                              85.00',
  'Sales tax                           160.00',
  'Total due                        $2,245.00',
];
const R1: BillFigures = {
  lines: [
    { description: 'Hex bolts M10', quantity: 200, unitPrice: 4.5, amount: 900 },
    { description: 'Anchor plates', quantity: 50, unitPrice: 22, amount: 1100 },
  ],
  subtotal: 2000,
  tax: 160,
  total: 2245,
};
// Lump sums, one read wrong: 1,836.00 printed, 1,386.00 on the bill.
const R6_PAGE = ['SANDPIPER SURVEYING', 'Site survey   1,836.00', 'Drawings   1,200.00', 'Permit filing   415.00', 'Total   3,451.00'];
const R6: BillFigures = {
  lines: [
    { description: 'Site survey', quantity: null, unitPrice: null, amount: 1386 },
    { description: 'Drawings', quantity: null, unitPrice: null, amount: 1200 },
    { description: 'Permit filing', quantity: null, unitPrice: null, amount: 415 },
  ],
  subtotal: null,
  tax: null,
  total: 3451,
};

const check = (over: Partial<ArithmeticCheck>): ArithmeticCheck => ({
  fingerprint: 'f', at: new Date().toISOString(), status: 'ready', verdict: 'unsure', missing: [], misread: [], reason: '',
  dropped: null, source: 'text', model: 'm', latencyMs: 1, costUsd: 0, suggestionId: null, ...over,
});

test('amounts on a line are read as printed, in cents, and nothing that only looks like one', () => {
  assert.deepEqual(amountsIn('Anchor plates 50 22.00 1,100.00'), [2200, 110000]);
  assert.deepEqual(amountsIn('Less deposit received 2026-09-02 (1,000.00)'), [100000]);
  assert.deepEqual(amountsIn('Total due $2,245.00'), [224500]);
  assert.deepEqual(amountsIn('Less 10% trade discount -300.00'), [30000]);
  assert.deepEqual(amountsIn('Phone 555.123.4567, 10% off, 4.5 kg, ref 20,815'), []);
});

test('the gap is the total less the lines and tax, and none without a total or with a line unpriced', () => {
  assert.equal(gapOf(R1), 8500);
  assert.equal(gapOf({ lines: [{ description: 'Tile', quantity: null, unitPrice: null, amount: 3000 }], subtotal: null, tax: null, total: 2700 }), -30000);
  assert.equal(gapOf({ ...R1, total: null }), null);
  assert.equal(gapOf({ ...R1, lines: [...R1.lines, { description: 'Pallet', quantity: 1, unitPrice: null, amount: null }] }), null);
});

test('before the model looks, code lists what the document prints that the bill lacks, and the reverse', () => {
  const r1 = unaccounted(docLines([R1_PAGE]), R1);
  assert.deepEqual(r1.notOnBill.map((l) => [l.ref, l.text]), [['p1.L6', 'Freight 85.00']]);
  assert.deepEqual(r1.notPrinted, []);
  const r6 = unaccounted(docLines([R6_PAGE]), R6);
  assert.deepEqual(r6.notOnBill.map((l) => l.ref), ['p1.L2']);
  assert.deepEqual(r6.notPrinted, [{ ref: 'line.1', label: 'Site survey', amount: 1386 }]);
});

test('a figure the document prints, cited where it is printed, that closes the gap, is a finding', () => {
  const ctx = figuresContext(docLines([R1_PAGE]), R1)!;
  const judged = judgeFinding({ verdict: 'missed', missing: [{ description: 'Freight', amount: 85, page: 1, ref: 'p1.L6' }], misread: [], reason: 'Freight is in the totals block.' }, ctx, false);
  assert.ok(judged.ok);
  assert.equal(judged.verdict, 'missed');
  assert.deepEqual(judged.missing, [{ description: 'Freight', amount: 85, page: 1, printed: 'Freight 85.00' }]);
});

test('an amount not on the line cited, or figures that leave a gap, are sent back with why', () => {
  const ctx = figuresContext(docLines([R1_PAGE]), R1)!;
  const elsewhere = judgeFinding({ verdict: 'missed', missing: [{ description: 'Freight', amount: 85, page: 1, ref: 'p1.L5' }], misread: [], reason: '' }, ctx, false);
  assert.equal(elsewhere.ok, false);
  assert.match((elsewhere as { problem: string }).problem, /\$85\.00 isn't printed on p1\.L5 \("Subtotal 2,000\.00"\)/);
  const invented = judgeFinding({ verdict: 'missed', missing: [{ description: 'Freight', amount: 80, page: 1, ref: 'p1.L6' }], misread: [], reason: '' }, ctx, false);
  assert.equal(invented.ok, false);
  const short = judgeFinding({ verdict: 'missed', missing: [{ description: 'Anchor plates', amount: 1100, page: 1, ref: 'p1.L4' }], misread: [], reason: '' }, ctx, false);
  assert.equal(short.ok, false);
  assert.match((short as { problem: string }).problem, /still \$1,015\.00 over/);
  const nowhere = judgeFinding({ verdict: 'missed', missing: [{ description: 'Freight', amount: 85, page: 1, ref: 'p9.L1' }], misread: [], reason: '' }, ctx, false);
  assert.match((nowhere as { problem: string }).problem, /p9\.L1 isn't a line of the document/);
});

test('"the document disagrees with itself" is questioned while the gap is printed on it, and accepted in the end', () => {
  const ctx = figuresContext(docLines([R1_PAGE]), R1)!;
  const steered = judgeFinding({ verdict: 'document_error', missing: [], misread: [], reason: '' }, ctx, true);
  assert.equal(steered.ok, false);
  assert.match((steered as { problem: string }).problem, /prints \$85\.00 on p1\.L6 \("Freight 85\.00"\), exactly the gap/);
  assert.ok(judgeFinding({ verdict: 'document_error', missing: [], misread: [], reason: '' }, ctx, false).ok);
  assert.ok(judgeFinding({ verdict: 'unsure', missing: [], misread: [], reason: '' }, ctx, true).ok);
});

test('a misread names the bill figure as it stands and what the document prints for it', () => {
  const ctx = figuresContext(docLines([R6_PAGE]), R6)!;
  const judged = judgeFinding({ verdict: 'misread', missing: [], misread: [{ target: 'line.1', billHas: 1386, printed: 1836, page: 1, ref: 'p1.L2' }], reason: '' }, ctx, true);
  assert.ok(judged.ok);
  assert.deepEqual(judged.misread, [{ target: 'line', line: 0, label: 'Site survey', from: 1386, to: 1836, page: 1, printed: 'Site survey 1,836.00' }]);
  const wrongNow = judgeFinding({ verdict: 'misread', missing: [], misread: [{ target: 'line.1', billHas: 1300, printed: 1836, page: 1, ref: 'p1.L2' }], reason: '' }, ctx, false);
  assert.match((wrongNow as { problem: string }).problem, /The bill has \$1,386\.00 for line\.1/);
});

test('the finding schema is strict: every property required', () => {
  assert.deepEqual(strictSchemaViolations(ARITHMETIC_FINDING_SCHEMA), []);
});

test('a check is current for the figures it was made on, and a failed one is made again after a while', () => {
  const fp = figuresFingerprint('doc', R1);
  assert.equal(figuresFingerprint('doc', { ...R1, lines: R1.lines.map((l) => ({ ...l })) }), fp);
  assert.notEqual(figuresFingerprint('doc', { ...R1, lines: [{ ...R1.lines[0]!, amount: 950 }, R1.lines[1]!] }), fp);
  assert.notEqual(figuresFingerprint('other-doc', R1), fp);
  assert.equal(needsCheck(null, fp), true);
  assert.equal(needsCheck(check({ fingerprint: fp }), fp), false);
  assert.equal(needsCheck(check({ fingerprint: 'old' }), fp), true);
  const failedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  assert.equal(needsCheck(check({ fingerprint: fp, status: 'failed', at: failedAt }), fp), true);
  assert.equal(needsCheck(check({ fingerprint: fp, status: 'failed' }), fp), false);
});

test('the finding says what is missing or wrong, where, what the bill comes to, and recommends correcting it', () => {
  const plain = { status: 'ready' as const, headline: 'The total doesn\'t match.', points: [], recommended: { action: 'ask_someone', reason: 'Which is right?' } };
  const missed = figuresFinding({
    check: check({ verdict: 'missed', missing: [{ description: 'Freight', amount: 85, page: 1, printed: 'Freight 85.00' }] }),
    checking: false, f: R1, vendorName: 'Alderbrook Fixings Ltd', plain,
  })!;
  assert.equal(missed.headline, '“Freight”, $85.00, is on the document (page 1) but not on the bill. With it, the bill comes to $2,245.00, the document’s total.');
  assert.deepEqual(missed.recommended, { action: 'fix_fields', reason: 'Add “Freight”, $85.00, from page 1.' });
  assert.deepEqual(missed.correction, { fingerprint: 'f', add: [{ description: 'Freight', amount: 85, page: 1 }], change: [], total: 2245 });

  const misread = figuresFinding({
    check: check({ verdict: 'misread', misread: [{ target: 'line', line: 0, label: 'Site survey', from: 1386, to: 1836, page: 1, printed: 'Site survey 1,836.00' }] }),
    checking: false, f: R6, vendorName: 'Sandpiper Surveying', plain,
  })!;
  assert.equal(misread.headline, '“Site survey” is $1,386.00 on the bill, but the document prints $1,836.00 (page 1). With that, the bill comes to $3,451.00, the document’s total.');
  assert.equal(misread.recommended?.reason, 'Change “Site survey” from $1,386.00 to $1,836.00, as page 1 prints it.');

  const disagrees = figuresFinding({ check: check({ verdict: 'document_error' }), checking: false, f: R1, vendorName: 'Alderbrook Fixings Ltd', plain })!;
  assert.match(disagrees.headline, /^Every figure was read as printed: the document disagrees with itself\. Its lines and tax come to \$2,160\.00, but its total says \$2,245\.00\. Ask Alderbrook Fixings Ltd which is right\.$/);
  assert.equal(disagrees.recommended?.action, 'ask_someone');
  assert.equal(disagrees.correction, undefined);

  const nothing = figuresFinding({ check: check({ verdict: 'unsure' }), checking: false, f: R1, vendorName: 'x', plain })!;
  assert.equal(nothing.headline, plain.headline);
  assert.equal(nothing.points.at(-1)?.text, 'Decimal read the document and found nothing on it that explains the gap.');

  const reading = figuresFinding({ check: null, checking: true, f: R1, vendorName: 'x', plain })!;
  assert.equal(reading.status, 'running');
  assert.equal(reading.headline, 'The lines and tax are $85.00 short of the total. Reading the document to find out why…');
  assert.equal(figuresFinding({ check: null, checking: false, f: R1, vendorName: 'x', plain }), plain);
});

// ─── Through the API ────────────────────────────────────────────────────────

/** A real PDF, one page, each line where pdftotext will find it. */
function pdfOf(lines: string[]): Buffer {
  const content = `BT /F1 11 Tf 60 740 Td ${lines.map((l, k) => `${k ? '0 -20 Td ' : ''}(${l}) Tj`).join(' ')} ET`;
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
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

/** The reading leaves the freight out: lines $2,000.00, tax $160.00, total $2,245.00. */
function readsWithoutFreight(billTo: string) {
  setInvoiceIntakeRuntimeForTests({
    extractRowsFromDocument: async () => ({
      rows: [{
        counterparty: 'Alderbrook Fixings Ltd', amount: 2245, currency: 'USD', reference: 'AF-7721',
        due_date: '2026-12-01', wallet_address: null, notes: null,
        source_invoice: {
          vendorName: 'Alderbrook Fixings Ltd', vendorAddress: null, vendorEmail: null, amount: 2245, currency: 'USD',
          invoiceNumber: 'AF-7721', invoiceDate: '2026-11-01', dueDate: '2026-12-01', terms: 'Net 30',
          poNumber: null, earlyPayDiscount: null, subtotal: 2000, taxAmount: 160, billToName: billTo,
          remitTo: null, paymentDetails: null, walletAddress: null,
          lineItems: [
            { description: 'Hex bolts M10', quantity: 200, unitPrice: 4.5, total: 900 },
            { description: 'Anchor plates', quantity: 50, unitPrice: 22, total: 1100 },
          ],
          categoryHint: 'Supplies', confidence: { vendor: 1, amount: 1, overall: 1 }, fieldConfidence: null, fieldSources: null,
        },
      }],
      modelLatencyMs: 1, pageCount: 1,
    }),
  });
}

/** The investigator's model, scripted: it answers from the prompt it is given. Other agents get nothing. */
function investigatorAnswers(answer: (prompt: string) => Record<string, unknown>) {
  const prompts: string[] = [];
  setExceptionAgentRuntimeForTests({
    isConfigured: () => true,
    callModel: async ({ messages }) => {
      const prompt = String(messages.find((m) => m.role === 'user')?.content ?? '');
      if (!prompt.startsWith('The bill from ')) throw new Error('not scripted');
      prompts.push(prompt);
      return {
        message: { role: 'assistant', content: null, tool_calls: [{ id: `c${prompts.length}`, type: 'function', function: { name: 'submit_finding', arguments: JSON.stringify(answer(prompt)) } }] },
        usage: { promptTokens: 100, completionTokens: 20 },
      };
    },
  });
  return prompts;
}

const refOf = (prompt: string, text: string) => new RegExp(`^(p\\d+\\.L\\d+)  ${text.replace(/[.$]/g, '\\$&')}$`, 'm').exec(prompt)?.[1] ?? 'missing';

async function uploadR1(w: Awaited<ReturnType<typeof makeWorld>>) {
  readsWithoutFreight(w.orgName);
  const up = await post(`/organizations/${w.orgId}/invoices/upload`, {
    filename: 'af-7721.pdf', mimeType: 'application/pdf', dataBase64: pdfOf(R1_PAGE).toString('base64'), autoAdvance: false,
  }, w.owner.token);
  const billId = (up.paymentOrders as Array<{ paymentOrder: { paymentOrderId: string } }>)[0]!.paymentOrder.paymentOrderId;
  await drainBackgroundWork();
  return billId;
}

const arithmeticFlag = (draft: any) => draft.flags.find((f: { kind: string }) => f.kind === 'total_does_not_reconcile' || f.kind === 'lines_do_not_sum');

test('the freight a reading missed is found on the document as the bill arrives, and one click adds it', async () => {
  const w = await makeWorld();
  const prompts = investigatorAnswers((p) => ({ verdict: 'missed', missing: [{ description: 'Freight', amount: 85, page: 1, ref: refOf(p, 'Freight 85.00') }], misread: [], reason: 'Freight sits in the totals block.' }));
  const billId = await uploadR1(w);
  assert.equal(prompts.length, 1, 'checked once, as it arrived');
  assert.match(prompts[0]!, /The gap: the lines plus tax come to \$2,160\.00, \$85\.00 short of the total\./);
  assert.match(prompts[0]!, /Amounts printed on the document that are not on the bill:\np1\.L\d+  Freight 85\.00\n/);

  const draft = await get(`/organizations/${w.orgId}/bills/${billId}/draft`, w.owner.token);
  const flag = arithmeticFlag(draft);
  assert.equal(flag.kind, 'total_does_not_reconcile');
  assert.equal(flag.finding.status, 'ready');
  assert.equal(flag.finding.headline, '“Freight”, $85.00, is on the document (page 1) but not on the bill. With it, the bill comes to $2,245.00, the document’s total.');
  assert.deepEqual(flag.finding.recommended, { action: 'fix_fields', reason: 'Add “Freight”, $85.00, from page 1.' });
  assert.deepEqual(flag.finding.correction.add, [{ description: 'Freight', amount: 85, page: 1 }]);
  assert.equal(prompts.length, 1, 'opening the bill does not check it again');

  const after = await post(`/organizations/${w.orgId}/bills/${billId}/correct-figures`, {}, w.owner.token);
  assert.equal(arithmeticFlag(after), undefined, 'the figures add up');
  assert.deepEqual(after.lines.map((l: { description: string; amount: number; category: string | null }) => [l.description, l.amount]), [['Hex bolts M10', 900], ['Anchor plates', 1100], ['Freight', 85]]);
  assert.equal(after.lines[2].category, null, 'a line added has no category until someone picks one');
  assert.equal(after.fields.find((f: { key: string }) => f.key === 'total').value, 2245);
  assert.ok(after.workLog.some((e: { text: string }) => e.text === 'Corrected the figures from the document “added “Freight”, $85.00, from page 1”'));

  const suggestion = await prisma.aiSuggestion.findFirst({ where: { organizationId: w.orgId, subjectId: billId, stage: 'exception_brief' }, include: { outcomes: true } });
  assert.equal(suggestion?.producer.startsWith('arithmetic@'), true);
  assert.deepEqual(suggestion?.outcomes.map((o) => o.outcome), ['accepted']);
});

test('a correction made on figures that have changed since is refused, and the document is read again', async () => {
  const w = await makeWorld();
  // On the new figures the freight no longer closes the gap, so it answers unsure there.
  const prompts = investigatorAnswers((p) => (p.includes('$35.00 short')
    ? { verdict: 'unsure', missing: [], misread: [], reason: '' }
    : { verdict: 'missed', missing: [{ description: 'Freight', amount: 85, page: 1, ref: refOf(p, 'Freight 85.00') }], misread: [], reason: '' }));
  const billId = await uploadR1(w);
  await post(`/organizations/${w.orgId}/bills/${billId}/save`, {
    fields: { invoiceNumber: 'AF-7721', currency: 'USD', total: 2245, taxAmount: 160 },
    lines: [
      { description: 'Hex bolts M10', quantity: 200, unitPrice: 4.5, amount: 900, category: null },
      { description: 'Anchor plates', quantity: 50, unitPrice: 22, amount: 1150, category: null },
    ],
    confirmedFieldKeys: [],
  }, w.owner.token);

  const refused = await raw('POST', `/organizations/${w.orgId}/bills/${billId}/correct-figures`, w.owner.token, {});
  assert.equal(refused.status, 409);
  assert.match(refused.text, /The figures have changed since Decimal read the document/);

  const reading = await get(`/organizations/${w.orgId}/bills/${billId}/draft`, w.owner.token);
  assert.equal(arithmeticFlag(reading).finding.status, 'running');
  assert.equal(arithmeticFlag(reading).finding.headline, 'The lines and tax are $35.00 short of the total. Reading the document to find out why…');
  await drainBackgroundWork();
  assert.equal(prompts.length, 2, 'checked again on the new figures');
});

test('an answer that never closes the gap is sent back twice, then dropped, and the plain finding stands', async () => {
  const w = await makeWorld();
  const prompts = investigatorAnswers((p) => ({ verdict: 'missed', missing: [{ description: 'Anchor plates', amount: 1100, page: 1, ref: refOf(p, 'Anchor plates 50 22.00 1,100.00') }], misread: [], reason: '' }));
  const billId = await uploadR1(w);
  assert.equal(prompts.length, 3, 'asked, then sent back twice');
  const stored = await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: billId }, select: { metadataJson: true } });
  const kept = (stored.metadataJson as any).arithmeticCheck;
  assert.equal(kept.verdict, 'unsure');
  assert.match(kept.dropped, /still \$1,015\.00 over/);

  const draft = await get(`/organizations/${w.orgId}/bills/${billId}/draft`, w.owner.token);
  const finding = arithmeticFlag(draft).finding;
  assert.equal(finding.correction, undefined);
  assert.match(finding.headline, /^The total doesn't match/);
  assert.equal(finding.points.at(-1).text, 'Decimal read the document and found nothing on it that explains the gap.');
  const refused = await raw('POST', `/organizations/${w.orgId}/bills/${billId}/correct-figures`, w.owner.token, {});
  assert.equal(refused.status, 409);
});

test('with no model to ask, nothing is checked and the plain finding stands', async () => {
  const w = await makeWorld();
  setExceptionAgentRuntimeForTests({ isConfigured: () => false });
  const billId = await uploadR1(w);
  const draft = await get(`/organizations/${w.orgId}/bills/${billId}/draft`, w.owner.token);
  await drainBackgroundWork();
  const finding = arithmeticFlag(draft).finding;
  assert.equal(finding.status, 'ready');
  assert.equal(finding.correction, undefined);
  const stored = await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: billId }, select: { metadataJson: true } });
  assert.equal((stored.metadataJson as any).arithmeticCheck, undefined);
});
