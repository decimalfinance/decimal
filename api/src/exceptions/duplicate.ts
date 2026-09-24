// The duplicate investigator.
//
// Given two bills the duplicate gate paired up, it reads both, compares them,
// looks at the vendor's history and the documents themselves, and returns a
// verdict with evidence. It does not act. What the verdict means for each bill
// is decided in code (`recommendationFor`), and the person confirms.
import { prisma } from '../infra/prisma.js';
import { extractPdfLayoutText } from '../payments/doc-provenance.js';
import { runAgent, type AgentRun, type AgentTool } from './agent.js';
import {
  billFactsFrom, compareBills, validateFinding, VERDICTS,
  type BillComparison, type BillFacts, type BillRow, type ValidatedFinding,
} from './duplicate-logic.js';

export const DUPLICATE_PRODUCER = 'exception-agent/duplicate/v1';

type Which = 'this' | 'other';

export type DuplicateInvestigation = {
  run: AgentRun;
  finding: ValidatedFinding | null;
  comparison: BillComparison;
  facts: { this: BillFacts; other: BillFacts };
};

const SYSTEM = `You investigate possible duplicate bills for an accounts-payable team.

Two bills from the same vendor were flagged because they share an invoice number, or share an exact amount and were uploaded within 14 days of each other when one has no number. Your job is to work out what they really are, from evidence, before a person looks.

Decide exactly one verdict:
- duplicate: the same bill captured twice. Same work, same figures. A resend, a copy, a second upload.
- replacement: one bill corrects or reissues the other. Usually the same invoice number with a fixed figure, often saying "corrected", "revised", "reissued" or "replaces". Paying both would pay twice.
- not_duplicate: two genuinely different obligations. Different work, a different service period, a different order, even if the number or amount collides.
- unsure: the evidence does not settle it. Choose this rather than guess.

How to work:
- Call get_bill for both bills and compare_bills before deciding. Read the documents with read_document when the figures alone do not settle it, for example to find a service period or a note saying the bill was corrected. Call vendor_history when the same amount recurs, to see whether this vendor bills that amount regularly.
- Every finding must cite the refs of the evidence it rests on, exactly as the tools returned them. A claim with no ref will be discarded.
- Never do arithmetic yourself. compare_bills has already computed every difference.
- confidence: high only when the evidence leaves no reasonable doubt; medium when it points one way but something is missing; low otherwise.
- headline: one plain sentence a finance person reads first, under 120 characters, for example "Corrected reissue of HCI-20931: tax fixed from $0 to $8,336". Say "bill", never "payment order".
- reason: one or two sentences, written as the reason a person would record for their decision. It is shown to them to confirm or edit.
- checked: short phrases for what you verified. couldNotCheck: anything you could not verify.

Finish by calling submit_finding. Do not reply in prose.`;

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    headline: { type: 'string' },
    reason: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { claim: { type: 'string' }, refs: { type: 'array', items: { type: 'string' } } },
        required: ['claim', 'refs'],
      },
    },
    checked: { type: 'array', items: { type: 'string' } },
    couldNotCheck: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'confidence', 'headline', 'reason', 'findings', 'checked', 'couldNotCheck'],
} as const;

export const SUBMIT_FINDING_SCHEMA: Record<string, unknown> = FINDING_SCHEMA as unknown as Record<string, unknown>;

const WHICH_PARAM = {
  type: 'object',
  additionalProperties: false,
  properties: { which: { type: 'string', enum: ['this', 'other'] } },
  required: ['which'],
};

async function loadBill(organizationId: string, paymentOrderId: string) {
  // organizationId in the WHERE, always: the pairing came from an org-scoped
  // query, but a tool must not trust that transitively.
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    select: {
      paymentOrderId: true, invoiceNumber: true, amountRaw: true, state: true, createdAt: true, metadataJson: true,
      counterpartyId: true, counterpartyWalletId: true, invoiceDocumentId: true,
      counterparty: { select: { displayName: true } },
      invoiceDocument: { select: { filename: true } },
    },
  });
  if (!order) throw new Error('bill not found');
  return order;
}

/** Facts as the model sees them, every value carrying the ref it can cite. */
function withRefs(which: Which, f: BillFacts, seen: Set<string>) {
  const ref = (key: string) => { const r = `${which}.${key}`; seen.add(r); return r; };
  return {
    vendor: f.vendorName,
    invoiceNumber: { value: f.invoiceNumber, ref: ref('invoiceNumber') },
    invoiceDate: { value: f.invoiceDate, ref: ref('invoiceDate') },
    dueDate: { value: f.dueDate, ref: ref('dueDate') },
    poNumber: { value: f.poNumber, ref: ref('poNumber') },
    currency: f.currency,
    subtotal: { value: f.subtotal, ref: ref('subtotal') },
    tax: { value: f.tax, ref: ref('tax') },
    total: { value: f.total, ref: ref('total') },
    lines: f.lines.map((l, i) => ({ ...l, ref: ref(`line.${i}`) })),
    state: f.state,
    uploadedAt: f.uploadedAt,
    confirmedByAPerson: f.confirmed,
    document: f.documentFilename,
  };
}

export async function investigateDuplicatePair(args: {
  organizationId: string;
  thisId: string;
  otherId: string;
  matchKind: 'same_invoice_number' | 'same_amount_near_date';
  fallbackHeadline: string;
}): Promise<DuplicateInvestigation> {
  const [thisOrder, otherOrder] = await Promise.all([
    loadBill(args.organizationId, args.thisId),
    loadBill(args.organizationId, args.otherId),
  ]);
  const orders: Record<Which, typeof thisOrder> = { this: thisOrder, other: otherOrder };
  const facts: Record<Which, BillFacts> = {
    this: billFactsFrom(thisOrder as BillRow),
    other: billFactsFrom(otherOrder as BillRow),
  };
  const comparison = compareBills(facts.this, facts.other);
  const seen = new Set<string>();
  const docText = new Map<Which, string | null>();

  const tools: AgentTool[] = [
    {
      name: 'get_bill',
      description: 'The bill as the review screen shows it: vendor, invoice number, dates, PO, subtotal, tax, total and every line. Values a person confirmed win over what was read from the document.',
      parameters: WHICH_PARAM,
      run: async (a) => {
        const which: Which = a.which === 'other' ? 'other' : 'this';
        return withRefs(which, facts[which], seen);
      },
    },
    {
      name: 'compare_bills',
      description: 'A computed, exact comparison of the two bills: which figures and lines differ, by how much, and whether tax, subtotal or lines account for the whole difference in totals. identical is true only when every figure, line and date agrees.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        for (const r of ['compare.totals', 'compare.tax', 'compare.lines', 'compare.identical', 'compare.dates']) seen.add(r);
        // The line refs it hands out are citable too, even if get_bill was
        // never called for that side.
        for (const m of comparison.lines.matched) { seen.add(`this.line.${m.a}`); seen.add(`other.line.${m.b}`); }
        for (const i of comparison.lines.onlyInA) seen.add(`this.line.${i}`);
        for (const j of comparison.lines.onlyInB) seen.add(`other.line.${j}`);
        return {
          ...comparison,
          lines: {
            matched: comparison.lines.matched.map((m) => ({ ...m, thisRef: `this.line.${m.a}`, otherRef: `other.line.${m.b}` })),
            onlyOnThis: comparison.lines.onlyInA.map((i) => `this.line.${i}`),
            onlyOnOther: comparison.lines.onlyInB.map((j) => `other.line.${j}`),
          },
          refs: { totals: 'compare.totals', tax: 'compare.tax', lines: 'compare.lines', identical: 'compare.identical', dates: 'compare.dates' },
        };
      },
    },
    {
      name: 'vendor_history',
      description: 'The last bills from this vendor, other than these two: invoice number, total, invoice date, upload date and state. Use it to tell a recurring charge from a repeated one.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        const vendorWhere = thisOrder.counterpartyId
          ? { counterpartyId: thisOrder.counterpartyId }
          : { counterpartyWalletId: thisOrder.counterpartyWalletId };
        const rows = await prisma.paymentOrder.findMany({
          where: { organizationId: args.organizationId, ...vendorWhere, paymentOrderId: { notIn: [args.thisId, args.otherId] } },
          orderBy: { createdAt: 'desc' },
          take: 12,
          select: { paymentOrderId: true, invoiceNumber: true, amountRaw: true, state: true, createdAt: true, metadataJson: true },
        });
        return {
          bills: rows.map((r, i) => {
            const f = billFactsFrom(r as BillRow);
            const ref = `history.${i}`; seen.add(ref);
            return { ref, invoiceNumber: f.invoiceNumber, total: f.total, invoiceDate: f.invoiceDate, uploadedAt: f.uploadedAt, state: f.state, firstLine: f.lines[0]?.description ?? null };
          }),
        };
      },
    },
    {
      name: 'read_document',
      description: 'The text of the original document, line by line, for notes the extracted fields miss: "corrected", "copy", "replaces", a service period. Scanned documents and photos have no text layer.',
      parameters: WHICH_PARAM,
      run: async (a) => {
        const which: Which = a.which === 'other' ? 'other' : 'this';
        if (!docText.has(which)) {
          const docId = orders[which].invoiceDocumentId;
          const doc = docId
            ? await prisma.invoiceDocument.findFirst({
              where: { invoiceDocumentId: docId, organizationId: args.organizationId },
              select: { data: true, filename: true, mimeType: true },
            })
            : null;
          docText.set(which, doc ? await extractPdfLayoutText({ fileBytes: Buffer.from(doc.data), filename: doc.filename, mimeType: doc.mimeType }) : null);
        }
        const text = docText.get(which);
        if (!text) return { textLayer: false, note: 'This document has no text layer (a scan or photo). Rely on get_bill.' };
        const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 80);
        return {
          textLayer: true,
          lines: lines.map((l, n) => { const ref = `${which}.doc.L${n + 1}`; seen.add(ref); return { ref, text: l.slice(0, 200) }; }),
        };
      },
    },
    {
      name: 'submit_finding',
      description: 'Finish. Your verdict, confidence, a headline, the reason a person would record, findings that each cite refs, what you checked and what you could not.',
      terminal: true,
      parameters: SUBMIT_FINDING_SCHEMA,
    },
  ];

  const why = args.matchKind === 'same_invoice_number'
    ? 'they share an invoice number'
    : 'they are for exactly the same amount and were uploaded within 14 days of each other, and at least one has no invoice number';
  const user = `Bill "this" (${facts.this.invoiceNumber ?? 'no number'}, total ${facts.this.total} ${facts.this.currency}, uploaded ${facts.this.uploadedAt}) `
    + `and bill "other" (${facts.other.invoiceNumber ?? 'no number'}, total ${facts.other.total} ${facts.other.currency}, uploaded ${facts.other.uploadedAt}) `
    + `from ${facts.this.vendorName ?? 'the same vendor'} were flagged as a possible duplicate because ${why}. Investigate and submit your finding.`;

  const run = await runAgent({ label: 'duplicate', system: SYSTEM, user, tools });
  const finding = run.ok
    ? validateFinding(run.terminal.args, seen, comparison, args.fallbackHeadline)
    : null;
  return { run, finding, comparison, facts };
}
