// The bills workbench + invoice review backend (AP workbench redesign,
// uploads/ap-claude-code-handoff.md).
//
// Workbench: every payment order, grouped into the five operator buckets
// (needs review / in approval / to pay / done / needs attention) with the
// row facts the triage table renders.
//
// Review: one bill's verification packet — the stored document, what was
// read from it (per-field), flags — and the Confirm ceremony, which is the
// call site for submitInvoiceForApproval in the v3 pipeline: verification
// happens BEFORE a bill enters routing.
import type { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';
import { USDC_DECIMALS } from '../solana.js';
import { clearPaymentOrderReview, cancelPaymentOrder, getPaymentOrderDetail } from './orders.js';
import { listChartOfAccounts } from '../accounting/ocr-coding.js';
import { extractPdfTextLayer, refineInvoiceSources, PROVENANCE_VERSION } from './doc-provenance.js';
import { findDuplicateBills, readDuplicateOverride, describeDuplicate } from './duplicate-check.js';
import { readPayableHold, describePayableHold } from './vendor-payable.js';
import { getBillCeilingMinor } from '../approvals/store.js';
import type { ExtractedInvoice } from './document-extract.js';

// Exact field→document boxes for ANY bill, whenever it is reviewed: if this
// order's extraction predates the provenance pass (or the matcher improved),
// re-locate the extracted values in the stored document's text layer now and
// cache the result back onto the order. Needs no model call — just the stored
// PDF plus the values already extracted. Best-effort: on any failure the
// existing (possibly box-less) extraction is returned unchanged.
async function ensureProvenance(order: {
  paymentOrderId: string;
  invoiceDocumentId: string | null;
  metadataJson: unknown;
}): Promise<Record<string, unknown> | null> {
  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const agent = isRecord(metadata.agent) ? metadata.agent : null;
  const extracted = agent && isRecord(agent.extracted) ? agent.extracted : null;
  if (!agent || !extracted) return extracted;
  if (agent.provenanceVersion === PROVENANCE_VERSION) return extracted;
  if (!order.invoiceDocumentId) return extracted;

  try {
    const doc = await prisma.invoiceDocument.findUnique({
      where: { invoiceDocumentId: order.invoiceDocumentId },
      select: { data: true, filename: true, mimeType: true },
    });
    if (!doc) return extracted;

    const pages = await extractPdfTextLayer({
      fileBytes: Buffer.from(doc.data),
      filename: doc.filename,
      mimeType: doc.mimeType,
    });
    const refreshed = structuredClone(extracted);
    if (pages) {
      // The stored extraction is plain JSON with the same field names the
      // refiner reads; missing fields are simply skipped.
      refineInvoiceSources(refreshed as unknown as ExtractedInvoice, pages);
    }
    // Stamp even when there's no text layer (scan/image) so we don't re-run
    // pdftotext on every open.
    await prisma.paymentOrder.update({
      where: { paymentOrderId: order.paymentOrderId },
      data: {
        metadataJson: {
          ...metadata,
          agent: { ...agent, extracted: refreshed, provenanceVersion: PROVENANCE_VERSION },
        } as Prisma.InputJsonValue,
      },
    });
    return refreshed;
  } catch (error) {
    logger.warn('bill_review.provenance_backfill_failed', {
      paymentOrderId: order.paymentOrderId,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
    return extracted;
  }
}

export type BillBucket = 'needs_review' | 'in_approval' | 'to_pay' | 'done' | 'needs_attention';

// Below this per-field read confidence, the review screen marks the field
// "needs a look" instead of "read by AI".
const FIELD_CONFIDENCE_THRESHOLD = 0.85;

type EngineRow = {
  id: string;
  type: string;
  macro_state: string;
  payment_order_id: string | null;
  source_approvable_id: string | null;
};

type OpenTaskRow = {
  approvable_id: string;
  person_name: string;
};

async function loadEngineState(organizationId: string) {
  const approvables = await prisma.$queryRaw<EngineRow[]>`
    SELECT id, type, macro_state,
           attributes->>'paymentOrderId'      AS payment_order_id,
           attributes->>'sourceApprovableId'  AS source_approvable_id
    FROM approval.approvables
    WHERE organization_id = ${organizationId}::uuid
      AND type IN ('invoice', 'payment_run')`;

  const openTasks = await prisma.$queryRaw<OpenTaskRow[]>`
    SELECT plan.approvable_id, p.name AS person_name
    FROM approval.tasks t
    JOIN approval.approval_plans plan ON plan.id = t.plan_id AND plan.superseded_by IS NULL
    JOIN approval.people p ON p.id = t.person_id
    JOIN approval.approvables a ON a.id = plan.approvable_id
    WHERE a.organization_id = ${organizationId}::uuid AND t.state = 'open'
    ORDER BY t.step_index ASC`;

  // paymentOrderId -> invoice approvable; invoice approvable id -> its release run.
  const invoiceByOrder = new Map<string, EngineRow>();
  const releaseBySource = new Map<string, EngineRow>();
  for (const row of approvables) {
    if (row.type === 'invoice' && row.payment_order_id) invoiceByOrder.set(row.payment_order_id, row);
    if (row.type === 'payment_run' && row.source_approvable_id) releaseBySource.set(row.source_approvable_id, row);
  }
  const firstOpenPerson = new Map<string, string>();
  for (const task of openTasks) {
    if (!firstOpenPerson.has(task.approvable_id)) firstOpenPerson.set(task.approvable_id, task.person_name);
  }
  return { invoiceByOrder, releaseBySource, firstOpenPerson };
}

type SubStatus = {
  kind: 'plain' | 'person' | 'loud';
  text: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  blockedBy?: { name: string } | null;
};

function bucketAndStatus(args: {
  state: string;
  invoice: EngineRow | undefined;
  release: EngineRow | undefined;
  firstOpenPerson: Map<string, string>;
}): { bucket: BillBucket; subStatus: SubStatus } {
  const { state, invoice, release, firstOpenPerson } = args;

  if (state === 'needs_review') {
    // An approver sent it back: it's in review again, but with homework.
    if (invoice?.macro_state === 'rejected') {
      return { bucket: 'needs_review', subStatus: { kind: 'loud', text: 'Sent back — needs changes', tone: 'warning' } };
    }
    return { bucket: 'needs_review', subStatus: { kind: 'plain', text: 'Needs a check', tone: 'info' } };
  }
  if (state === 'cancelled') {
    return invoice?.macro_state === 'rejected'
      ? { bucket: 'needs_attention', subStatus: { kind: 'loud', text: 'Rejected in approval', tone: 'danger' } }
      : { bucket: 'needs_attention', subStatus: { kind: 'plain', text: 'Cancelled', tone: 'neutral' } };
  }
  if (state === 'executed') {
    return { bucket: 'done', subStatus: { kind: 'plain', text: 'Paid', tone: 'success' } };
  }
  if (state === 'settled') {
    return { bucket: 'done', subStatus: { kind: 'plain', text: 'Reconciled', tone: 'success' } };
  }

  // draft / proposed — position comes from the approval engine when it's involved.
  if (invoice) {
    if (invoice.macro_state === 'pending_approval') {
      const waitingOn = firstOpenPerson.get(invoice.id) ?? null;
      // FAIL CLOSED: a pending plan is never "ready to pay". The old fallback
      // dropped no-one-to-act plans into To-pay ("the operator pays it
      // directly") — a silent approval bypass on irreversible money
      // (BUG-approval-not-enforced-failopen). The compiler now assigns the
      // owner as approver of last resort, so this branch should be rare;
      // when it does happen, it's a problem to surface, not a green light.
      return waitingOn
        ? {
            bucket: 'in_approval',
            subStatus: { kind: 'person', text: `Waiting on ${waitingOn}`, tone: 'neutral', blockedBy: { name: waitingOn } },
          }
        : { bucket: 'needs_attention', subStatus: { kind: 'loud', text: 'Approval has no one to act — check your flow', tone: 'danger' } };
    }
    if (invoice.macro_state === 'returned_for_info') {
      return { bucket: 'in_approval', subStatus: { kind: 'plain', text: 'Returned — needs info', tone: 'warning' } };
    }
    if (invoice.macro_state === 'on_hold') {
      return { bucket: 'in_approval', subStatus: { kind: 'plain', text: 'On hold', tone: 'neutral' } };
    }
    if (invoice.macro_state === 'approved' || invoice.macro_state === 'auto_approved') {
      if (release && (release.macro_state === 'pending_approval')) {
        const waitingOn = firstOpenPerson.get(release.id) ?? null;
        return {
          bucket: 'to_pay',
          subStatus: waitingOn
            ? { kind: 'person', text: `Release — waiting on ${waitingOn}`, tone: 'neutral', blockedBy: { name: waitingOn } }
            : { kind: 'plain', text: 'Awaiting release', tone: 'neutral' },
        };
      }
      return {
        bucket: 'to_pay',
        subStatus: { kind: 'plain', text: state === 'proposed' ? 'Payment on its way' : 'Approved', tone: 'success' },
      };
    }
    if (invoice.macro_state === 'rejected') {
      return { bucket: 'needs_attention', subStatus: { kind: 'loud', text: 'Rejected in approval', tone: 'danger' } };
    }
  }

  // Legacy path (no engine involvement): draft is ready to route, proposed is moving.
  return state === 'proposed'
    ? { bucket: 'to_pay', subStatus: { kind: 'plain', text: 'Payment on its way', tone: 'success' } }
    : { bucket: 'to_pay', subStatus: { kind: 'plain', text: 'Ready to pay', tone: 'neutral' } };
}

function extractedOf(metadataJson: unknown): Record<string, unknown> | null {
  if (!isRecord(metadataJson)) return null;
  const agent = metadataJson.agent;
  if (!isRecord(agent)) return null;
  return isRecord(agent.extracted) ? agent.extracted : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function usdText(amountRaw: bigint): string {
  return '$' + amountRawToUsd(amountRaw).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function amountRawToUsd(amountRaw: bigint): number {
  return Number(amountRaw) / 10 ** USDC_DECIMALS;
}

// -----------------------------------------------------------------------------
// Workbench
// -----------------------------------------------------------------------------

// Ramp-style split of the review queue: a bill is "ready for approval" when
// the facts an approver needs are present and nothing security-shaped is open;
// otherwise it's "missing information" and the row says what's missing.
const BLOCKING_RULES = new Set([
  'invalid_extracted_wallet_address',
  'known_counterparty_wallet_changed',
  'near_duplicate_address',
]);

// Tier 1 (blocks entering approval): amount + line items to route on.
// Tier 2 (flag, never block): invoice number, due date — fill during approval.
function reviewReadiness(args: {
  amountUsd: number;
  invoiceNumber: string | null;
  dueAt: Date | null;
  hasLineItems: boolean;
  triggeredRules: Array<Record<string, unknown>>;
}): { readiness: 'ready' | 'missing_info'; missing: string[]; laterNeeded: string[]; blocked: boolean } {
  const missing: string[] = [];
  if (!(args.amountUsd > 0)) missing.push('amount');
  if (!args.hasLineItems) missing.push('line items');
  const laterNeeded: string[] = [];
  if (!args.invoiceNumber) laterNeeded.push('invoice number');
  if (!args.dueAt) laterNeeded.push('due date');
  const blocked = args.triggeredRules.some((r) => typeof r.rule === 'string' && BLOCKING_RULES.has(r.rule));
  return { readiness: blocked || missing.length > 0 ? 'missing_info' : 'ready', missing, laterNeeded, blocked };
}

export async function getBillsWorkbench(organizationId: string) {
  const [orders, engine] = await Promise.all([
    prisma.paymentOrder.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      select: {
        paymentOrderId: true,
        state: true,
        amountRaw: true,
        memo: true,
        invoiceNumber: true,
        invoiceDocumentId: true,
        dueAt: true,
        createdAt: true,
        metadataJson: true,
        counterpartyWallet: { select: { label: true } },
        counterparty: { select: { displayName: true } },
      },
    }),
    loadEngineState(organizationId),
  ]);

  const counts: Record<BillBucket, number> = {
    needs_review: 0, in_approval: 0, to_pay: 0, done: 0, needs_attention: 0,
  };

  const bills = orders.map((order) => {
    const invoice = engine.invoiceByOrder.get(order.paymentOrderId);
    const release = invoice ? engine.releaseBySource.get(invoice.id) : undefined;
    let { bucket, subStatus } = bucketAndStatus({
      state: order.state,
      invoice,
      release,
      firstOpenPerson: engine.firstOpenPerson,
    });
    counts[bucket] += 1;

    const extracted = extractedOf(order.metadataJson);
    const metadataRecord = isRecord(order.metadataJson) ? order.metadataJson : {};
    const agentRecord = isRecord(metadataRecord.agent) ? metadataRecord.agent : {};
    const triggeredRules = Array.isArray(agentRecord.triggeredRules)
      ? (agentRecord.triggeredRules as Array<Record<string, unknown>>)
      : [];

    let readiness: 'ready' | 'missing_info' | null = null;
    let missing: string[] = [];
    if (bucket === 'needs_review') {
      const r = reviewReadiness({
        amountUsd: amountRawToUsd(order.amountRaw),
        invoiceNumber: order.invoiceNumber,
        dueAt: order.dueAt,
        hasLineItems: Array.isArray(extracted?.lineItems) && (extracted!.lineItems as unknown[]).length > 0,
        triggeredRules,
      });
      readiness = r.readiness;
      missing = r.missing;
      if (r.blocked) {
        subStatus = { kind: 'loud', text: 'Payment details need a look', tone: 'danger' };
      } else if (r.missing.length > 0) {
        subStatus = { kind: 'plain', text: `Missing ${r.missing.join(', ')}`, tone: 'warning' };
      } else {
        subStatus = { kind: 'plain', text: 'Ready for approval', tone: 'success' };
      }
    }
    const vendorName = order.counterparty?.displayName ?? order.counterpartyWallet.label;
    const lineItems = Array.isArray(extracted?.lineItems) ? (extracted!.lineItems as unknown[]) : [];
    const firstLine = isRecord(lineItems[0]) ? str(lineItems[0].description) : null;
    const originalCurrency = str(extracted?.currency)?.toUpperCase() ?? null;
    const originalAmount = num(extracted?.amount);

    return {
      paymentOrderId: order.paymentOrderId,
      bucket,
      state: order.state,
      vendorName,
      description: firstLine ?? order.memo,
      amountUsd: amountRawToUsd(order.amountRaw),
      amountOriginal:
        originalCurrency && originalCurrency !== 'USD' && originalCurrency !== 'USDC' && originalAmount
          ? { amount: originalAmount, currency: originalCurrency }
          : null,
      invoiceNumber: order.invoiceNumber,
      invoiceDocumentId: order.invoiceDocumentId,
      dueAt: order.dueAt,
      createdAt: order.createdAt,
      discountLabel: str(extracted?.earlyPayDiscount),
      subStatus,
      readiness,
      missing,
      // A cleared duplicate flag must stay VISIBLE on the row — the operator
      // scanning To-pay is the last human checkpoint (testbench 001 §5).
      duplicateCleared: (() => {
        const o = readDuplicateOverride(order.metadataJson);
        return o ? { byName: o.byName, reason: o.reason } : null;
      })(),
    };
  });

  const reviewCounts = {
    ready: bills.filter((b) => b.readiness === 'ready').length,
    missingInfo: bills.filter((b) => b.readiness === 'missing_info').length,
  };

  return { counts, reviewCounts, bills };
}

// -----------------------------------------------------------------------------
// Review packet
// -----------------------------------------------------------------------------

export type ReviewFieldState = 'read' | 'needs_look' | 'not_on_document' | 'confirmed';

function fieldState(args: {
  key: string;
  value: unknown;
  fieldConfidence: Record<string, unknown> | null;
  confirmedKeys: Set<string>;
}): { state: ReviewFieldState; reason: string | null } {
  if (args.confirmedKeys.has(args.key)) return { state: 'confirmed', reason: null };
  const empty = args.value == null || args.value === '';
  if (empty) return { state: 'not_on_document', reason: null };
  const confidence = num(args.fieldConfidence?.[args.key]);
  if (confidence != null && confidence < FIELD_CONFIDENCE_THRESHOLD) {
    return { state: 'needs_look', reason: 'The document was hard to read here' };
  }
  return { state: 'read', reason: null };
}

// The order a bookkeeper expects: spend accounts first, then assets,
// liabilities, and the rest. Within a group, account number order.
const ACCOUNT_TYPE_ORDER = [
  'Expense', 'Cost of Goods Sold', 'Other Expense',
  'Fixed Asset', 'Other Current Asset', 'Other Asset', 'Bank',
  'Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability',
  'Accounts Receivable', 'Income', 'Other Income', 'Equity',
];

function buildChartOptions(chart: Awaited<ReturnType<typeof listChartOfAccounts>>) {
  const orderOf = (t: string) => {
    const i = ACCOUNT_TYPE_ORDER.indexOf(t);
    return i === -1 ? ACCOUNT_TYPE_ORDER.length : i;
  };
  return [...chart]
    .sort((a, b) =>
      orderOf(a.accountType) - orderOf(b.accountType)
      || (a.acctNum ?? '').localeCompare(b.acctNum ?? '', undefined, { numeric: true })
      || a.fullyQualifiedName.localeCompare(b.fullyQualifiedName))
    .map((a) => ({
      value: a.fullyQualifiedName,
      label: a.fullyQualifiedName,
      num: a.acctNum,
      group: a.accountType,
    }));
}

export async function getBillReview(organizationId: string, paymentOrderId: string) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    include: {
      counterpartyWallet: true,
      counterparty: true,
      invoiceDocument: {
        select: { invoiceDocumentId: true, filename: true, mimeType: true, byteSize: true, pageCount: true },
      },
    },
  });
  if (!order) return null;

  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const agent = isRecord(metadata.agent) ? metadata.agent : {};
  // Compute (and cache) exact document boxes on demand, so highlighting works
  // for every bill regardless of when it was read.
  const extracted = (await ensureProvenance(order)) ?? (isRecord(agent.extracted) ? agent.extracted : {});
  const verification = isRecord(metadata.verification) ? metadata.verification : null;
  const triggeredRules = Array.isArray(agent.triggeredRules) ? (agent.triggeredRules as Array<Record<string, unknown>>) : [];
  const fieldConfidence = isRecord(extracted.fieldConfidence) ? extracted.fieldConfidence : null;
  const fieldSources = isRecord(extracted.fieldSources) ? extracted.fieldSources : null;
  // Sanitize a model-reported source box; null when absent or malformed.
  const sourceOf = (key: string): { page: number; box: [number, number, number, number] } | null => {
    const raw = fieldSources?.[key];
    if (!isRecord(raw)) return null;
    const page = num(raw.page);
    const box = Array.isArray(raw.box) ? raw.box.map((v) => num(v)) : null;
    if (!page || page < 1 || !box || box.length !== 4 || box.some((v) => v == null || v < 0 || v > 1)) return null;
    return { page: Math.round(page), box: box as [number, number, number, number] };
  };
  const confirmedKeys = new Set<string>(
    verification && Array.isArray(verification.confirmedFieldKeys)
      ? (verification.confirmedFieldKeys as string[])
      : [],
  );

  // Verified values (post-confirm) win over the raw read for display.
  const verifiedFields = verification && isRecord(verification.fields) ? verification.fields : null;
  const valueOf = (key: string, extractedValue: unknown) =>
    verifiedFields && key in verifiedFields ? verifiedFields[key] : extractedValue;

  const headerFieldDefs: Array<{ key: string; label: string; value: unknown }> = [
    { key: 'invoiceNumber', label: 'Invoice number', value: valueOf('invoiceNumber', str(extracted.invoiceNumber) ?? order.invoiceNumber) },
    { key: 'invoiceDate', label: 'Invoice date', value: valueOf('invoiceDate', str(extracted.invoiceDate)) },
    { key: 'dueDate', label: 'Due date', value: valueOf('dueDate', str(extracted.dueDate) ?? (order.dueAt ? order.dueAt.toISOString().slice(0, 10) : null)) },
    { key: 'terms', label: 'Terms', value: valueOf('terms', str(extracted.terms)) },
    { key: 'poNumber', label: 'PO number', value: valueOf('poNumber', str(extracted.poNumber)) },
    { key: 'discount', label: 'Discount', value: valueOf('discount', str(extracted.earlyPayDiscount)) },
    { key: 'currency', label: 'Currency', value: valueOf('currency', str(extracted.currency)?.toUpperCase() ?? 'USD') },
    { key: 'total', label: 'Total due', value: valueOf('total', num(extracted.amount) ?? amountRawToUsd(order.amountRaw)) },
  ];
  const sourceKeyByField: Record<string, string> = {
    invoiceNumber: 'invoiceNumber', invoiceDate: 'invoiceDate', dueDate: 'dueDate',
    terms: 'terms', poNumber: 'poNumber', discount: 'earlyPayDiscount',
    currency: 'currency', total: 'total',
  };
  const fields = headerFieldDefs.map((f) => ({
    ...f,
    ...fieldState({ key: f.key, value: f.value, fieldConfidence, confirmedKeys }),
    source: sourceOf(sourceKeyByField[f.key] ?? f.key),
  }));

  const remitTo = isRecord(extracted.remitTo) ? extracted.remitTo : {};
  const remitToVerified = verifiedFields && isRecord(verifiedFields.remitTo) ? verifiedFields.remitTo : null;
  const remitPartSourceKey = { street: 'remitStreet', city: 'remitCity', state: 'remitState', zip: 'remitZip' } as const;
  const remitFields = (['street', 'city', 'state', 'zip'] as const).map((part) => {
    const value = remitToVerified ? remitToVerified[part] : str(remitTo[part]);
    return {
      key: `remitTo.${part}`,
      label: part === 'zip' ? 'ZIP code' : part[0]!.toUpperCase() + part.slice(1),
      value,
      ...fieldState({ key: 'remitTo', value, fieldConfidence, confirmedKeys }),
      source: sourceOf(remitPartSourceKey[part]) ?? sourceOf('remitTo'),
    };
  });

  const verifiedLines = verification && Array.isArray(verification.lines) ? verification.lines : null;
  const extractedLines = Array.isArray(extracted.lineItems) ? (extracted.lineItems as unknown[]) : [];
  // Category picker: the org's FULL numbered chart of accounts when QuickBooks
  // is connected ("7410 · Accounting", grouped by account type — a bill line
  // can code to an asset or COGS account, not just Expense), the builtin
  // standard chart otherwise, so the picker is never empty.
  const chart = await listChartOfAccounts(organizationId);
  const { DEFAULT_EXPENSE_ACCOUNTS } = await import('../accounting/default-chart.js');
  const categoryOptions = chart.length > 0
    ? buildChartOptions(chart)
    : DEFAULT_EXPENSE_ACCOUNTS.map((a) => ({ value: a.name, label: a.name, num: null, group: 'Expenses' }));

  // The coding station's ranked GL-account suggestion (memory/rules ran at intake).
  // A suggestion made before the books were connected (builtin chart, or a raw
  // document hint) is STALE once a real chart exists — re-run the matcher against
  // the live chart once and cache the result on the order.
  let ocrCoding: Record<string, unknown> | null = isRecord(metadata.ocrCoding) ? { ...metadata.ocrCoding } : null;
  const chartNames = new Set(chart.flatMap((a) => [a.name, a.fullyQualifiedName]));
  if (chart.length > 0 && order.state === 'needs_review' && metadata.ocrCodingChart !== 'quickbooks') {
    const top = ocrCoding && Array.isArray(ocrCoding.suggestions) && isRecord(ocrCoding.suggestions[0])
      ? (ocrCoding.suggestions[0] as Record<string, unknown>)
      : null;
    const stale = !top
      || (typeof top.accountId === 'string' && top.accountId.startsWith('builtin:'))
      || !chartNames.has(str(top.accountName) ?? '');
    const categoryHint = (ocrCoding ? str(ocrCoding.categoryHint) : null) ?? str(extracted.categoryHint);
    const lineDescriptions = extractedLines.filter(isRecord)
      .map((l) => ({ description: str(l.description) ?? '' }))
      .filter((l) => l.description);
    if (stale && (categoryHint || lineDescriptions.length > 0)) {
      try {
        const { suggestOcrCodings } = await import('../accounting/ocr-coding.js');
        const [fresh] = await suggestOcrCodings(organizationId, [{ categoryHint, lineItems: lineDescriptions }]);
        if (fresh) ocrCoding = fresh as unknown as Record<string, unknown>;
        await prisma.paymentOrder.update({
          where: { paymentOrderId: order.paymentOrderId },
          data: {
            metadataJson: {
              ...metadata,
              ocrCoding: fresh ?? ocrCoding ?? null,
              ocrCodingChart: 'quickbooks',
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        logger.warn('bill_review.suggestion_refresh_failed', {
          paymentOrderId: order.paymentOrderId,
          ...(error instanceof Error ? { message: error.message } : {}),
        });
      }
    }
  }
  // Coding waterfall (GL synthesis D1): the vendor's RULE outranks the
  // document's own signal — resolved against the chart so the picker
  // recognizes it. The source rides along so the UI can say WHY.
  let codingSuggestionSource: { kind: 'rule' | 'ocr'; detail: string } | null = null;
  let ruleSuggestion: string | null = null;
  if (order.counterpartyId) {
    const { getVendorCodingRule } = await import('../accounting/gl-coding.js');
    const rule = await getVendorCodingRule(organizationId, order.counterpartyId).catch(() => null);
    if (rule?.accountName) {
      // Validate against the SAME vocabulary the picker offers — the QBO chart
      // when connected, the builtin categories otherwise. Checking the QBO
      // chart alone made every pre-QBO rule silently fall through to OCR
      // (testbench 007: the Vendors page promised a default the review
      // screen never applied).
      const ruleAccount = chart.find((a) => a.name === rule.accountName || a.fullyQualifiedName === rule.accountName);
      const pickerHasIt = chart.length > 0
        ? (Boolean(ruleAccount) || chartNames.has(rule.accountName))
        : categoryOptions.some((o) => o.value === rule.accountName);
      if (pickerHasIt) {
        ruleSuggestion = ruleAccount?.fullyQualifiedName ?? rule.accountName;
        codingSuggestionSource = {
          kind: 'rule',
          detail: rule.source === 'manual'
            ? 'your team set a coding default for this vendor'
            : `learned from ${rule.learnedFromCount} agreeing bill${rule.learnedFromCount === 1 ? '' : 's'}`,
        };
      }
    }
  }
  const topSuggestion = ocrCoding && Array.isArray(ocrCoding.suggestions) && isRecord(ocrCoding.suggestions[0])
    ? str((ocrCoding.suggestions[0] as Record<string, unknown>).accountName)
    : null;
  // Resolve the suggestion to the chart's canonical (fully qualified) name so
  // the picker recognizes it. With a real chart present, never fall back to a
  // raw document hint — a made-up label the books don't contain helps nobody.
  const suggestionAccount = topSuggestion
    ? chart.find((a) => a.name === topSuggestion || a.fullyQualifiedName === topSuggestion)
    : null;
  const ocrSuggestionResolved = chart.length > 0
    ? (suggestionAccount?.fullyQualifiedName ?? (topSuggestion && chartNames.has(topSuggestion) ? topSuggestion : null))
    : topSuggestion
      ?? (ocrCoding ? str(ocrCoding.categoryHint) : null)
      ?? str(extracted.categoryHint);
  const codingSuggestion = ruleSuggestion ?? ocrSuggestionResolved;
  if (!codingSuggestionSource && codingSuggestion) {
    codingSuggestionSource = { kind: 'ocr', detail: 'read from the invoice' };
  }
  const lineSource = (line: Record<string, unknown>) => {
    if (!isRecord(line.source)) return null;
    const page = num(line.source.page);
    const box = Array.isArray(line.source.box) ? line.source.box.map((v) => num(v)) : null;
    if (!page || page < 1 || !box || box.length !== 4 || box.some((v) => v == null || v < 0 || v > 1)) return null;
    return { page: Math.round(page), box: box as [number, number, number, number] };
  };
  const lines = verifiedLines ?? extractedLines.filter(isRecord).map((line) => ({
    description: str(line.description) ?? '',
    quantity: num(line.quantity),
    unitPrice: num(line.unitPrice),
    amount: num(line.total),
    category: codingSuggestion,
    source: lineSource(line),
  }));

  const taxAmount = verifiedFields && 'taxAmount' in verifiedFields ? num(verifiedFields.taxAmount) : num(extracted.taxAmount);

  // Flags outrank ambers: banner states, derived from the intake rules + reads.
  const flags: Array<{ kind: string; severity: 'danger' | 'warning' | 'info'; message: string; blocking: boolean }> = [];
  const ruleNames = new Set(triggeredRules.map((r) => str(r.rule)).filter(Boolean));
  if (ruleNames.has('known_counterparty_wallet_changed') || ruleNames.has('near_duplicate_address')) {
    flags.push({
      kind: 'payee_mismatch',
      severity: 'danger',
      blocking: true,
      message: `The payment details on this document don't match what's verified for ${order.counterparty?.displayName ?? order.counterpartyWallet.label}. This is how payment fraud usually starts.`,
    });
  }
  if (ruleNames.has('invalid_extracted_wallet_address')) {
    flags.push({
      kind: 'unreadable_payment_details',
      severity: 'danger',
      blocking: true,
      message: 'The payment details on this document could not be read reliably. Check them against the document before sending.',
    });
  }
  if (ruleNames.has('unreviewed_counterparty') || ruleNames.has('new_counterparty_threshold')) {
    flags.push({
      kind: 'new_vendor',
      severity: 'info',
      blocking: false,
      message: `First bill from ${order.counterparty?.displayName ?? order.counterpartyWallet.label}. Their payment details will be verified before anything is sent.`,
    });
  }
  const billToName = str(extracted.billToName);
  if (billToName) {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { organizationId },
      select: { organizationName: true },
    });
    if (!namesLookRelated(billToName, org.organizationName)) {
      flags.push({
        kind: 'addressed_elsewhere',
        severity: 'danger',
        blocking: true,
        message: `This bill is addressed to "${billToName}", not ${org.organizationName}. Make sure it's actually yours to pay.`,
      });
    }
  }

  // Vendor payable gate (policy P0): a held/blocked vendor's bills can't
  // leave Review — policy sits UNDER approvals and always wins. Not
  // overridable per-bill: the hold is released on the VENDOR, where it was set.
  const vendorHold = order.counterparty ? readPayableHold(order.counterparty.metadataJson) : null;
  if (vendorHold) {
    flags.push({
      kind: vendorHold.status === 'blocked' ? 'vendor_blocked' : 'vendor_held',
      severity: 'danger',
      blocking: true,
      message: describePayableHold(order.counterparty?.displayName ?? order.counterpartyWallet.label, vendorHold),
    });
  }

  // Org bill ceiling (policy P1): a hard cap no bill crosses. Not overridable
  // per-bill — the primary admin raises the ceiling itself (Policies page).
  const ceilingMinor = await getBillCeilingMinor(prisma, organizationId);
  if (ceilingMinor !== null && order.amountRaw > ceilingMinor) {
    flags.push({
      kind: 'over_ceiling',
      severity: 'danger',
      blocking: true,
      message: `This bill (${usdText(order.amountRaw)}) is over your organization's bill ceiling of ${usdText(ceilingMinor)}. The primary admin can raise the ceiling on the Policies page.`,
    });
  }

  // Duplicate gate (policy P0): on irreversible rails a duplicate payment is
  // unrecoverable, so this BLOCKS confirm unless an admin explicitly clears
  // it — and the clearance itself becomes the audit record.
  const dupOverride = readDuplicateOverride(metadata);
  const duplicates = await findDuplicateBills(organizationId, {
    excludePaymentOrderId: order.paymentOrderId,
    counterpartyId: order.counterpartyId,
    counterpartyWalletId: order.counterpartyWalletId,
    invoiceNumber: (verifiedFields ? str(verifiedFields.invoiceNumber) : null) ?? str(extracted.invoiceNumber) ?? order.invoiceNumber,
    amountRaw: order.amountRaw,
    createdAt: order.createdAt,
  });
  if (duplicates.length > 0) {
    if (dupOverride) {
      flags.push({
        kind: 'possible_duplicate',
        severity: 'info',
        blocking: false,
        message: `Looked like a duplicate — cleared by ${dupOverride.byName}: “${dupOverride.reason}”.`,
      });
    } else {
      flags.push({
        kind: 'possible_duplicate',
        severity: 'danger',
        blocking: true,
        message: `${describeDuplicate(duplicates[0]!)} If it's genuinely a new bill, an admin can clear this flag.`,
      });
    }
  }

  const sentBackRaw = isRecord(metadata.sentBack) ? metadata.sentBack : null;
  return {
    paymentOrderId: order.paymentOrderId,
    state: order.state,
    readOnly: order.state !== 'needs_review',
    // An approver sent this bill back for changes — the reviewer's homework.
    sentBack: sentBackRaw && order.state === 'needs_review'
      ? { reason: str(sentBackRaw.reason), byName: str(sentBackRaw.byName), at: str(sentBackRaw.at) }
      : null,
    vendor: {
      name: (verifiedFields ? str(verifiedFields.vendorName) : null)
        ?? (order.counterparty?.displayName ?? order.counterpartyWallet.label),
      email: (verifiedFields ? str(verifiedFields.vendorEmail) : null) ?? str(extracted.vendorEmail),
      nameSource: sourceOf('vendorName'),
      emailSource: sourceOf('vendorEmail'),
      isNew: order.counterpartyWallet.trustState === 'unreviewed',
      trustState: order.counterpartyWallet.trustState,
    },
    document: order.invoiceDocument,
    fields,
    remitFields,
    lines,
    categoryOptions,
    codingSuggestionSource,
    // Document anchors for the totals block, so the footer rows highlight too.
    totalsSources: {
      lineItems: sourceOf('subtotal'),
      tax: sourceOf('taxAmount'),
      total: sourceOf('total'),
    },
    taxAmount,
    totalUsd: amountRawToUsd(order.amountRaw),
    paymentBlock: {
      method: isRecord(extracted.paymentDetails) ? str(extracted.paymentDetails.method) : null,
      bankName: isRecord(extracted.paymentDetails) ? str(extracted.paymentDetails.bankName) : null,
      accountLast4: isRecord(extracted.paymentDetails) ? str(extracted.paymentDetails.accountLast4) : null,
      // Where this bill actually routes (resolved at intake) + the account it
      // would be paid from. Approval never waits on either.
      sendToLabel: order.counterpartyWallet.label,
      sourceTreasuryWalletId: order.sourceTreasuryWalletId,
      matchesVerified: order.counterpartyWallet.trustState === 'trusted'
        && !ruleNames.has('known_counterparty_wallet_changed')
        && !ruleNames.has('near_duplicate_address'),
    },
    flags,
    verification: verification
      ? {
          confirmedAt: str(verification.confirmedAt),
          confirmedByUserId: str(verification.confirmedByUserId),
          noteForApprovers: str(verification.noteForApprovers),
        }
      : null,
  };
}

// "Halcyon Labs, Inc." vs "Halcyon Labs" should not fire the addressed-elsewhere
// flag; "Meridian Systems" vs "Halcyon Labs" should. Token overlap, not equality.
function namesLookRelated(a: string, b: string): boolean {
  const tokens = (s: string) =>
    new Set(
      s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter((t) => t.length > 1 && !['inc', 'llc', 'ltd', 'corp', 'co', 'the'].includes(t)),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return true; // nothing to compare — don't alarm
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

// -----------------------------------------------------------------------------
// Confirm & send for approval — the one commit (spec §6)
// -----------------------------------------------------------------------------

export type ConfirmBillInput = {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  fields: {
    vendorName?: string | null;
    vendorEmail?: string | null;
    invoiceNumber?: string | null;
    invoiceDate?: string | null;
    dueDate?: string | null;
    terms?: string | null;
    poNumber?: string | null;
    discount?: string | null;
    currency?: string | null;
    total?: number;
    taxAmount?: number | null;
    remitTo?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null };
  };
  lines: Array<{ description: string; quantity: number | null; unitPrice: number | null; amount: number | null; category?: string | null }>;
  confirmedFieldKeys: string[];
  noteForApprovers?: string | null;
  sourceTreasuryWalletId?: string | null;
};

export async function confirmBillReview(input: ConfirmBillInput) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId: input.organizationId, paymentOrderId: input.paymentOrderId },
    include: { counterpartyWallet: true, counterparty: true, transferRequests: true },
  });
  if (!order) throw new Error('Bill not found');
  if (order.state !== 'needs_review') {
    throw new Error(`This bill is ${order.state} — it has already left verification.`);
  }
  // Payable gate, re-checked at the moment of commitment (the vendor may have
  // been held while this review screen sat open).
  const confirmHold = order.counterparty ? readPayableHold(order.counterparty.metadataJson) : null;
  if (confirmHold) {
    throw new Error(describePayableHold(order.counterparty?.displayName ?? order.counterpartyWallet.label, confirmHold));
  }
  // Org ceiling, same re-check (and against the CONFIRMED total, below).
  const confirmCeiling = await getBillCeilingMinor(prisma, input.organizationId);

  const review = await getBillReview(input.organizationId, input.paymentOrderId);
  const blocking = (review?.flags ?? []).filter((f) => f.blocking);
  if (blocking.length > 0) {
    throw new Error(`Resolve the flagged issue first: ${blocking[0]!.message}`);
  }

  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const agent = isRecord(metadata.agent) ? metadata.agent : {};
  const extracted = isRecord(agent.extracted) ? agent.extracted : {};

  // Correction memory (spec §4): every field where the confirmed value differs
  // from what was read. Silent to the operator; gold for calibration.
  const corrections: Array<{ field: string; readValue: unknown; correctedValue: unknown }> = [];
  const readValues: Record<string, unknown> = {
    vendorName: str(extracted.vendorName),
    vendorEmail: str(extracted.vendorEmail),
    invoiceNumber: str(extracted.invoiceNumber),
    invoiceDate: str(extracted.invoiceDate),
    dueDate: str(extracted.dueDate),
    terms: str(extracted.terms),
    poNumber: str(extracted.poNumber),
    discount: str(extracted.earlyPayDiscount),
    currency: str(extracted.currency)?.toUpperCase() ?? 'USD',
    total: num(extracted.amount),
    taxAmount: num(extracted.taxAmount),
  };
  for (const [key, readValue] of Object.entries(readValues)) {
    if (!(key in input.fields)) continue;
    const corrected = (input.fields as Record<string, unknown>)[key] ?? null;
    if (corrected !== (readValue ?? null)) {
      corrections.push({ field: key, readValue: readValue ?? null, correctedValue: corrected });
    }
  }

  const confirmedTotal = input.fields.total ?? num(extracted.amount) ?? amountRawToUsd(order.amountRaw);
  if (!Number.isFinite(confirmedTotal) || confirmedTotal <= 0) {
    throw new Error('Total must be a positive amount.');
  }

  // Tier-1 gate: approval routes on amounts — a plan compiled without them is
  // a wrong plan, silently. Categories are DIFFERENT (GL synthesis: coding
  // uncertainty never blocks a bill): an uncoded line parks in the catch-all
  // the accountant sweeps before close, and category splits correctly read it
  // as "not coded to X".
  const realLines = input.lines.filter((l) => l.description.trim());
  if (realLines.length === 0) {
    throw new Error('Add at least one line item before sending for approval.');
  }
  const { UNCATEGORIZED_ACCOUNT } = await import('../accounting/default-chart.js');
  let uncategorizedLines = 0;
  for (const [i, line] of realLines.entries()) {
    if (line.amount == null) throw new Error(`Add an amount to line ${i + 1} before sending for approval.`);
    if (!line.category || !line.category.trim()) {
      line.category = UNCATEGORIZED_ACCOUNT.name;
      uncategorizedLines += 1;
    }
  }
  const confirmedAmountRaw = BigInt(Math.round(confirmedTotal * 10 ** USDC_DECIMALS));
  if (confirmCeiling !== null && confirmedAmountRaw > confirmCeiling) {
    throw new Error(`This bill (${usdText(confirmedAmountRaw)}) is over your organization's bill ceiling of ${usdText(confirmCeiling)}. The primary admin can raise the ceiling on the Policies page.`);
  }
  // Re-run the duplicate gate against the CONFIRMED values — the reviewer may
  // have just edited the invoice number or total, and the review-time flag
  // only saw the extracted ones.
  if (!readDuplicateOverride(metadata)) {
    const confirmedDuplicates = await findDuplicateBills(input.organizationId, {
      excludePaymentOrderId: order.paymentOrderId,
      counterpartyId: order.counterpartyId,
      counterpartyWalletId: order.counterpartyWalletId,
      invoiceNumber: str(input.fields.invoiceNumber ?? null) ?? order.invoiceNumber,
      amountRaw: confirmedAmountRaw,
      createdAt: order.createdAt,
    });
    if (confirmedDuplicates.length > 0) {
      throw new Error(`${describeDuplicate(confirmedDuplicates[0]!)} An admin can clear this flag if it's genuinely a new bill.`);
    }
  }
  const dueAt = input.fields.dueDate ? new Date(input.fields.dueDate) : order.dueAt;

  // Pay-from choice (optional): must be one of the org's active treasury accounts.
  let sourceTreasuryWalletId: string | null | undefined;
  if (input.sourceTreasuryWalletId !== undefined) {
    if (input.sourceTreasuryWalletId === null) {
      sourceTreasuryWalletId = null;
    } else {
      const wallet = await prisma.treasuryWallet.findFirst({
        where: { organizationId: input.organizationId, treasuryWalletId: input.sourceTreasuryWalletId, isActive: true },
        select: { treasuryWalletId: true },
      });
      if (!wallet) throw new Error('That treasury account was not found.');
      sourceTreasuryWalletId = wallet.treasuryWalletId;
    }
  }

  const verification = {
    fields: input.fields,
    lines: input.lines,
    confirmedFieldKeys: input.confirmedFieldKeys,
    corrections,
    noteForApprovers: str(input.noteForApprovers ?? null),
    confirmedByUserId: input.actorUserId,
    confirmedAt: new Date().toISOString(),
    modelId: isRecord(agent.sourceDocument) ? agent.sourceDocument.modelId ?? null : null,
  };

  await prisma.$transaction(async (tx) => {
    // Confirming closes the fix round — drop the sent-back note so the fresh
    // submission starts clean.
    const { sentBack: _sentBack, ...metadataRest } = metadata;
    await tx.paymentOrder.update({
      where: { paymentOrderId: order.paymentOrderId },
      data: {
        amountRaw: order.transferRequests.length === 0 ? confirmedAmountRaw : undefined,
        invoiceNumber: str(input.fields.invoiceNumber ?? null) ?? order.invoiceNumber,
        dueAt: dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : order.dueAt,
        sourceTreasuryWalletId,
        metadataJson: { ...metadataRest, verification } as Prisma.InputJsonValue,
      },
    });
  });

  // Clears review, trusts the wallet (the operator just verified the document's
  // payment details — the R7 payment-method ceremony replaces this later), and
  // emits the review-cleared event.
  await clearPaymentOrderReview({
    organizationId: input.organizationId,
    paymentOrderId: input.paymentOrderId,
    actorUserId: input.actorUserId,
    actorType: 'user',
    reviewNote: 'Confirmed on the review screen',
  });

  // THE call site (spec §6): verification done, now the bill enters routing.
  let approvableId: string | null = null;
  try {
    const { submitInvoiceForApproval } = await import('../approvals/wiring.js');
    // Vendor + line categories ride along so vendor/category splits can route.
    const lineCategories = [...new Set(input.lines.map((l) => l.category).filter((c): c is string => Boolean(c)))];
    // First bill from this vendor? (fuels the first-bill split + new-vendor scrutiny)
    const priorCount = await prisma.paymentOrder.count({
      where: {
        organizationId: input.organizationId,
        paymentOrderId: { not: input.paymentOrderId },
        state: { not: 'cancelled' },
        ...(order.counterpartyId ? { counterpartyId: order.counterpartyId } : { counterpartyWalletId: order.counterpartyWalletId }),
      },
    });
    const submitted = await submitInvoiceForApproval({
      organizationId: input.organizationId,
      requesterUserId: input.actorUserId,
      totalMinorBase: confirmedAmountRaw,
      vendorId: order.counterpartyId,
      attributes: {
        paymentOrderId: input.paymentOrderId,
        inputSource: 'invoice_upload',
        // Pinned payout destination (policy P0): approvers authorize paying
        // THIS destination. If the vendor's rail changes after approval, the
        // release gate refuses until the bill is re-approved — on irreversible
        // rails, "pay Acme" must mean "pay Acme at the address you saw".
        approvedDestination: {
          counterpartyWalletId: order.counterpartyWalletId,
          walletAddress: order.counterpartyWallet.walletAddress,
        },
        vendor_is_first_invoice: priorCount === 0,
        ...(lineCategories.length ? { categories: lineCategories } : {}),
        ...(verification.noteForApprovers ? { noteForApprovers: verification.noteForApprovers } : {}),
      },
      lines: input.lines.length > 0
        ? input.lines.map((line) => ({
            amountMinor: BigInt(Math.round((line.amount ?? 0) * 10 ** USDC_DECIMALS)),
            currency: 'USD',
            description: line.description || null,
          }))
        : [{ amountMinor: confirmedAmountRaw, currency: 'USD', description: order.memo }],
    });
    approvableId = submitted.approvableId;
  } catch (error) {
    logger.warn('bill_confirm.approval_submit_failed', {
      organizationId: input.organizationId,
      paymentOrderId: input.paymentOrderId,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }

  logger.info('bill_confirm.completed', {
    organizationId: input.organizationId,
    paymentOrderId: input.paymentOrderId,
    corrections: corrections.length,
    approvableId,
  });

  return { detail: await getPaymentOrderDetail(input.organizationId, input.paymentOrderId), approvableId };
}

export async function markNotABill(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  reason: 'duplicate' | 'statement' | 'not_ours' | 'unreadable' | 'other';
  note?: string | null;
}) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    select: { paymentOrderId: true, state: true, metadataJson: true },
  });
  if (!order) throw new Error('Bill not found');
  if (order.state !== 'needs_review' && order.state !== 'draft') {
    throw new Error(`This bill is ${order.state} — it can no longer be dismissed here.`);
  }

  // Each dismissal reason is a classification-eval datapoint (spec §6).
  await prisma.paymentOrder.update({
    where: { paymentOrderId: order.paymentOrderId },
    data: {
      metadataJson: {
        ...(isRecord(order.metadataJson) ? order.metadataJson : {}),
        notABill: {
          reason: args.reason,
          note: str(args.note ?? null),
          markedByUserId: args.actorUserId,
          markedAt: new Date().toISOString(),
        },
      } as Prisma.InputJsonValue,
    },
  });

  return cancelPaymentOrder({
    organizationId: args.organizationId,
    paymentOrderId: args.paymentOrderId,
    actorUserId: args.actorUserId,
    actorType: 'user',
  });
}

// Clear the duplicate flag: an ADMIN asserts this is genuinely a new bill.
// The override is a structured, logged policy event — never a silent bypass
// (SYNTHESIS-decimal-policies.md D4).
export async function overrideDuplicateFlag(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  actorName: string;
  reason: string;
}) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    select: { paymentOrderId: true, state: true, metadataJson: true },
  });
  if (!order) throw new Error('Bill not found');

  const override = {
    byUserId: args.actorUserId,
    byName: args.actorName,
    reason: args.reason,
    at: new Date().toISOString(),
  };
  await prisma.$transaction([
    prisma.paymentOrder.update({
      where: { paymentOrderId: order.paymentOrderId },
      data: {
        metadataJson: {
          ...(isRecord(order.metadataJson) ? order.metadataJson : {}),
          duplicateOverride: override,
        } as Prisma.InputJsonValue,
      },
    }),
    prisma.paymentOrderEvent.create({
      data: {
        organizationId: args.organizationId,
        paymentOrderId: order.paymentOrderId,
        eventType: 'policy_overridden',
        actorType: 'user',
        actorId: args.actorUserId,
        beforeState: order.state,
        afterState: order.state,
        payloadJson: { rule: 'duplicate_bill', reason: args.reason },
      },
    }),
  ]);
  return getBillReview(args.organizationId, args.paymentOrderId);
}

// Send an already-APPROVED (but unpaid) bill back to Review — the recovery
// path when release is refused (pinned destination, ceiling) or the approval
// simply needs redoing. Unwinds the approval: the invoice approvable and any
// pending release run are cancelled; re-confirming starts a fresh run under
// current policy. Admin-tier only (route enforces); impossible once money moves.
export async function sendApprovedBillBackToReview(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  actorName: string;
  reason: string;
}) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    select: { paymentOrderId: true, state: true, metadataJson: true, transferRequests: { select: { transferRequestId: true }, take: 1 } },
  });
  if (!order) throw new Error('Bill not found');
  if (order.state !== 'draft' || order.transferRequests.length > 0) {
    throw new Error(`This bill is ${order.state} — it can only be sent back before any payment starts moving.`);
  }

  const sentBackAt = new Date().toISOString();
  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  await prisma.$transaction(async (tx) => {
    const cancelled = await tx.$queryRaw<{ id: string }[]>`
      UPDATE approval.approvables SET macro_state = 'cancelled'
      WHERE organization_id = ${args.organizationId}::uuid AND type = 'invoice'
        AND attributes->>'paymentOrderId' = ${order.paymentOrderId}
        AND macro_state IN ('approved', 'auto_approved')
      RETURNING id`;
    for (const row of cancelled) {
      await tx.$executeRaw`
        UPDATE approval.approvables SET macro_state = 'cancelled'
        WHERE organization_id = ${args.organizationId}::uuid AND type = 'payment_run'
          AND attributes->>'sourceApprovableId' = ${row.id}
          AND macro_state IN ('draft', 'pending_approval')`;
    }
    await tx.paymentOrder.update({
      where: { paymentOrderId: order.paymentOrderId },
      data: {
        state: 'needs_review',
        metadataJson: {
          ...metadata,
          sentBack: { reason: args.reason, byName: args.actorName, at: sentBackAt, afterApproval: true },
        } as Prisma.InputJsonValue,
      },
    });
    await tx.paymentOrderEvent.create({
      data: {
        organizationId: args.organizationId,
        paymentOrderId: order.paymentOrderId,
        eventType: 'payment_order_sent_back',
        actorType: 'user',
        actorId: args.actorUserId,
        beforeState: 'draft',
        afterState: 'needs_review',
        payloadJson: { reason: args.reason, byName: args.actorName, afterApproval: true },
      },
    });
  });
  return getBillReview(args.organizationId, args.paymentOrderId);
}

// -----------------------------------------------------------------------------
// Bill detail (Screen 3/4) — the approval story, rendered from the real engine:
// the pinned plan (with each step's plain-words purpose), task states, the
// event log (timestamps, reject reasons, info-request threads), SoD outcomes,
// and the review corrections. Nothing here is hardcoded narrative.
// -----------------------------------------------------------------------------

type DetailEventRow = { seq: bigint; at: Date; actor_id: string | null; task_id: string | null; payload: unknown };
type PersonRow = { id: string; name: string; email: string; user_id: string | null; avatar_url: string | null };
type TaskRow = { id: string; step_index: number; person_id: string; state: string };

const MACRO_RANK: Record<string, number> = {
  pending_approval: 0, returned_for_info: 1, on_hold: 2,
  approved: 3, auto_approved: 3, rejected: 4, cancelled: 5, draft: 6,
};

export async function getBillDetail(organizationId: string, paymentOrderId: string, viewerUserId: string) {
  const review = await getBillReview(organizationId, paymentOrderId);
  if (!review) return null;

  const order = await prisma.paymentOrder.findFirstOrThrow({
    where: { organizationId, paymentOrderId },
    select: { state: true, amountRaw: true, dueAt: true, invoiceNumber: true, metadataJson: true, createdAt: true, counterpartyId: true, counterpartyWalletId: true },
  });
  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const verification = isRecord(metadata.verification) ? metadata.verification : null;

  // Corrections (the honesty layer), with each corrector's real name — review
  // confirms and later fill-ins both land here.
  const correctionRows: Record<string, unknown>[] = (verification && Array.isArray(verification.corrections)
    ? (verification.corrections as unknown[])
    : []).filter(isRecord);
  const confirmerId = verification && typeof verification.confirmedByUserId === 'string' ? verification.confirmedByUserId : null;
  const correctorIds = [...new Set([confirmerId, ...correctionRows.map((c) => str(c.byUserId))].filter((v): v is string => Boolean(v)))];
  const correctorUsers = correctorIds.length > 0
    ? await prisma.user.findMany({ where: { userId: { in: correctorIds } }, select: { userId: true, displayName: true } })
    : [];
  const nameOfUser = new Map(correctorUsers.map((u) => [u.userId, u.displayName]));
  const corrections = correctionRows
    .map((c) => ({
      field: str(c.field) ?? '',
      from: c.readValue == null || c.readValue === '' ? 'not on document' : String(c.readValue),
      to: c.correctedValue == null || c.correctedValue === '' ? 'removed' : String(c.correctedValue),
      by: nameOfUser.get(str(c.byUserId) ?? '') ?? (confirmerId ? nameOfUser.get(confirmerId) ?? null : null),
    }))
    .filter((c) => c.field);

  // The order's invoice approvable — prefer the live one over dead history
  // (a recalled bill that was resubmitted has several).
  const approvables = await prisma.$queryRaw<{ id: string; macro_state: string; requester_id: string }[]>`
    SELECT id, macro_state, requester_id FROM approval.approvables
    WHERE organization_id = ${organizationId}::uuid AND type = 'invoice'
      AND attributes->>'paymentOrderId' = ${paymentOrderId}`;
  approvables.sort((a, b) => (MACRO_RANK[a.macro_state] ?? 9) - (MACRO_RANK[b.macro_state] ?? 9));
  const approvable = approvables[0] ?? null;

  const engine = await loadEngineState(organizationId);
  const invoiceRow = engine.invoiceByOrder.get(paymentOrderId);
  const releaseRow = invoiceRow ? engine.releaseBySource.get(invoiceRow.id) : undefined;
  const { subStatus } = bucketAndStatus({
    state: order.state,
    invoice: invoiceRow,
    release: releaseRow,
    firstOpenPerson: engine.firstOpenPerson,
  });

  if (!approvable) {
    return {
      review,
      corrections,
      status: { macroState: null, subStatus },
      approval: null,
      viewer: { personId: null, name: null, isRequester: false, openTaskId: null, anyTaskId: null },
      requester: null,
    };
  }

  const { getActivePlan } = await import('../approvals/store.js');
  const plan = await getActivePlan(prisma, approvable.id);
  const tasks = plan
    ? await prisma.$queryRaw<TaskRow[]>`
        SELECT id, step_index, person_id, state FROM approval.tasks WHERE plan_id = ${plan.id}::uuid`
    : [];
  const events = await prisma.$queryRaw<DetailEventRow[]>`
    SELECT seq, at, actor_id, task_id, payload FROM approval.approval_events
    WHERE organization_id = ${organizationId}::uuid AND approvable_id = ${approvable.id}::uuid
    ORDER BY seq`;
  const people = await prisma.$queryRaw<PersonRow[]>`
    SELECT p.id, p.name, p.email, p.user_id, u.avatar_url
    FROM approval.people p LEFT JOIN users u ON u.user_id = p.user_id
    WHERE p.organization_id = ${organizationId}::uuid`;
  const personOf = new Map(people.map((p) => [p.id, p]));
  const personView = (id: string | null | undefined) => {
    const p = id ? personOf.get(id) : null;
    return p ? { personId: p.id, name: p.name, avatarUrl: p.avatar_url } : null;
  };

  // Command events grouped per task.
  const commandsByTask = new Map<string, Array<{ at: Date; actorId: string | null; command: Record<string, unknown> }>>();
  for (const e of events) {
    const payload = isRecord(e.payload) ? e.payload : {};
    if (payload.kind !== 'command' || !e.task_id || !isRecord(payload.command)) continue;
    const list = commandsByTask.get(e.task_id) ?? [];
    list.push({ at: e.at, actorId: e.actor_id, command: payload.command });
    commandsByTask.set(e.task_id, list);
  }

  type StepNode = {
    stepIndex: number;
    person: { personId: string; name: string; avatarUrl: string | null } | null;
    purpose: string | null;
    mode: string;
    state: 'done' | 'current' | 'upcoming' | 'declined' | 'stopped' | 'delegated';
    actedAt: string | null;
    declineReason: string | null;
    thread: {
      open: boolean;
      waitingOn: string | null;
      messages: Array<{ person: { personId: string; name: string; avatarUrl: string | null } | null; body: string; at: string }>;
    } | null;
  };

  const planSteps: Array<{ index: number; step: Record<string, unknown>; approvers: Array<{ personId: string }>; purpose: string | null }> =
    Array.isArray(plan?.steps) ? (plan!.steps as never) : [];

  const nodes: StepNode[] = [];
  for (const step of planSteps) {
    const mode = isRecord(step.step) && typeof step.step.mode === 'string' ? step.step.mode : 'all';
    for (const approver of step.approvers) {
      const task = tasks.find((t) => t.step_index === step.index && t.person_id === approver.personId);
      const commands = task ? (commandsByTask.get(task.id) ?? []) : [];
      const approveEvent = commands.find((c) => c.command.kind === 'approve');
      const rejectEvent = commands.find((c) => c.command.kind === 'reject');
      const questions = commands.filter((c) => c.command.kind === 'request_info');
      const answers = commands.filter((c) => c.command.kind === 'provide_info');

      let state: StepNode['state'] = 'upcoming';
      switch (task?.state) {
        case 'approved': state = 'done'; break;
        case 'rejected':
        case 'vetoed': state = 'declined'; break;
        case 'open':
        case 'info_requested':
        case 'pushed_back': state = 'current'; break;
        case 'delegated': state = 'delegated'; break;
        case 'obsolete': state = approvable.macro_state === 'rejected' || approvable.macro_state === 'cancelled' ? 'stopped' : 'upcoming'; break;
        default: state = 'upcoming';
      }

      const messages = [...questions, ...answers]
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map((c) => ({
          person: personView(c.actorId),
          body: str(c.command.question) ?? str(c.command.answer) ?? '',
          at: c.at.toISOString(),
        }))
        .filter((m) => m.body);
      const openQuestion = questions.length > answers.length;
      const waitingOnId = openQuestion ? str(questions[questions.length - 1]!.command.from) : null;

      nodes.push({
        stepIndex: step.index,
        person: personView(approver.personId),
        purpose: step.purpose,
        mode,
        state,
        actedAt: approveEvent?.at.toISOString() ?? rejectEvent?.at.toISOString() ?? null,
        declineReason: rejectEvent ? str(rejectEvent.command.reason) : null,
        thread: messages.length > 0
          ? { open: openQuestion, waitingOn: personView(waitingOnId)?.name ?? null, messages }
          : null,
      });
    }
  }

  // Protection callout: an SoD outcome that removed/rerouted the requester from
  // the route — R1 rendered as a sentence.
  const sodOutcomes = Array.isArray(plan?.sod_outcomes) ? (plan!.sod_outcomes as Array<Record<string, unknown>>) : [];
  const requesterExcluded = sodOutcomes.find((o) =>
    (o.kind === 'veto_removed' || o.kind === 'veto_rerouted')
    && (o.removed === approvable.requester_id));
  const requesterView = personView(approvable.requester_id);
  const firstApprover = nodes[0]?.person?.name ?? null;

  const viewerPerson = people.find((p) => p.user_id === viewerUserId) ?? null;
  const viewerOpenTask = viewerPerson
    ? tasks.find((t) => t.person_id === viewerPerson.id && (t.state === 'open' || t.state === 'info_requested')) ?? null
    : null;
  // An info request the viewer must answer (they were named as `from`).
  const openAskForViewer = viewerPerson
    ? nodes.find((n) => n.thread?.open && n.thread.waitingOn === viewerPerson.name)
    : null;
  const openAskTask = openAskForViewer
    ? tasks.find((t) => t.step_index === openAskForViewer.stepIndex && t.person_id === openAskForViewer.person?.personId) ?? null
    : null;

  // The advisory signal (same classifier as the inbox): routine vs worth-a-look,
  // shown to the approver next to their decision. Advisory only — never acts.
  const signal = classifySignal({
    amountUsd: amountRawToUsd(order.amountRaw),
    vendorName: review.vendor.name,
    history: await vendorHistory(organizationId, { counterpartyId: order.counterpartyId, counterpartyWalletId: order.counterpartyWalletId, paymentOrderId }),
    corrections,
  });

  return {
    review,
    corrections,
    signal,
    status: { macroState: approvable.macro_state, subStatus },
    approval: {
      approvableId: approvable.id,
      macroState: approvable.macro_state,
      steps: nodes,
      // Provenance: which published version of the approval flow routed this
      // bill — flow edits are never retroactive, so this stays true forever.
      flowVersion: plan?.policy_version ?? null,
      protectionNote: requesterExcluded && requesterView && firstApprover
        ? `This bill skipped ${requesterView.name} and started with ${firstApprover}. The person who asks for a bill can't be its first approver — a second set of eyes always goes first.`
        : null,
      release: releaseRow ? { macroState: releaseRow.macro_state } : null,
    },
    viewer: {
      personId: viewerPerson?.id ?? null,
      name: viewerPerson?.name ?? null,
      isRequester: viewerPerson != null && viewerPerson.id === approvable.requester_id,
      openTaskId: viewerOpenTask?.id ?? null,
      viewerHasOpenAsk: Boolean(openAskTask),
      openAskTaskId: openAskTask?.id ?? null,
      anyTaskId: tasks[0]?.id ?? null,
    },
    requester: requesterView,
  };
}

// -----------------------------------------------------------------------------
// Fill-later facts (Tier 2/3): fields that never block approval can be added or
// corrected while the bill is already routing — logged into the same correction
// trail the review screen feeds. Material fields (total, currency, lines,
// categories) are NOT accepted here: changing what the route was compiled on
// goes through recall/push-back so the plan re-forms, never a silent edit.
export type BillFactsInput = {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  facts: {
    invoiceNumber?: string | null;
    invoiceDate?: string | null;
    dueDate?: string | null;
    terms?: string | null;
    poNumber?: string | null;
    discount?: string | null;
    vendorEmail?: string | null;
    taxAmount?: number | null;
    remitTo?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null };
  };
};

export async function updateBillFacts(input: BillFactsInput) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId: input.organizationId, paymentOrderId: input.paymentOrderId },
    select: { paymentOrderId: true, state: true, invoiceNumber: true, dueAt: true, metadataJson: true },
  });
  if (!order) throw new Error('Bill not found');
  if (order.state !== 'needs_review' && order.state !== 'draft') {
    throw new Error(`This bill is ${order.state} — its details are settled.`);
  }

  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const verification = isRecord(metadata.verification) ? { ...metadata.verification } : {};
  const fields = isRecord(verification.fields) ? { ...verification.fields } : {};
  const corrections: unknown[] = Array.isArray(verification.corrections) ? [...verification.corrections] : [];

  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  const applyText = (key: keyof BillFactsInput['facts'] & string, label: string) => {
    const next = input.facts[key];
    if (next === undefined) return;
    const prev = (fields[key] as unknown) ?? null;
    const value = typeof next === 'string' ? (next.trim() || null) : next;
    if (value === prev) return;
    fields[key] = value;
    changes.push({ field: label, from: prev, to: value });
  };
  applyText('invoiceNumber', 'Invoice number');
  applyText('invoiceDate', 'Invoice date');
  applyText('dueDate', 'Due date');
  applyText('terms', 'Terms');
  applyText('poNumber', 'PO number');
  applyText('discount', 'Discount');
  applyText('vendorEmail', 'Vendor email');
  applyText('taxAmount', 'Tax');
  if (input.facts.remitTo !== undefined) {
    const prev = isRecord(fields.remitTo) ? fields.remitTo : {};
    const next = { ...prev, ...input.facts.remitTo };
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      fields.remitTo = next;
      changes.push({ field: 'Remit-to address', from: prev, to: next });
    }
  }
  if (changes.length === 0) return { changed: 0 };

  for (const c of changes) {
    corrections.push({
      field: c.field,
      readValue: c.from,
      correctedValue: c.to,
      byUserId: input.actorUserId,
      phase: order.state === 'draft' ? 'approval' : 'review',
      at: new Date().toISOString(),
    });
  }

  const dueDateInput = input.facts.dueDate;
  const nextDueAt = dueDateInput !== undefined && dueDateInput
    ? new Date(dueDateInput)
    : undefined;

  await prisma.$transaction([
    prisma.paymentOrder.update({
      where: { paymentOrderId: order.paymentOrderId },
      data: {
        invoiceNumber: input.facts.invoiceNumber !== undefined
          ? (input.facts.invoiceNumber?.trim() || null)
          : undefined,
        dueAt: nextDueAt && !Number.isNaN(nextDueAt.getTime()) ? nextDueAt : undefined,
        metadataJson: {
          ...metadata,
          verification: { ...verification, fields, corrections },
        } as Prisma.InputJsonValue,
      },
    }),
    prisma.paymentOrderEvent.create({
      data: {
        organizationId: input.organizationId,
        paymentOrderId: order.paymentOrderId,
        eventType: 'bill_facts_updated',
        actorType: 'user',
        actorId: input.actorUserId,
        beforeState: order.state,
        afterState: order.state,
        payloadJson: { changes } as Prisma.InputJsonValue,
      },
    }),
  ]);

  return { changed: changes.length };
}

// -----------------------------------------------------------------------------
// Approvals inbox (Screen 4) — the approver's worklist. The star is the SIGNAL:
// each bill waiting on me is classified clean-vs-flagged with a specific
// plain-language reason, derived from the review corrections (what a human
// changed after the read) + this vendor's own spend history. No competitor can
// show this because no one else has the correction trail.
// -----------------------------------------------------------------------------

type InboxTaskRow = {
  task_id: string; state: string; step_index: number; sla_deadline: Date | null;
  approvable_id: string; macro_state: string; requester_id: string; payment_order_id: string | null;
};

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

// Vendor's usual spend, from prior bills for the same counterparty in this org.
async function vendorHistory(organizationId: string, order: { counterpartyId: string | null; counterpartyWalletId: string; paymentOrderId: string }) {
  const priors = await prisma.paymentOrder.findMany({
    where: {
      organizationId,
      paymentOrderId: { not: order.paymentOrderId },
      state: { not: 'cancelled' },
      ...(order.counterpartyId
        ? { counterpartyId: order.counterpartyId }
        : { counterpartyWalletId: order.counterpartyWalletId }),
    },
    select: { amountRaw: true },
    take: 200,
  });
  const amounts = priors.map((p) => amountRawToUsd(p.amountRaw)).filter((n) => n > 0).sort((a, b) => a - b);
  if (amounts.length === 0) return { count: 0, max: 0, median: 0 };
  const median = amounts[Math.floor(amounts.length / 2)]!;
  return { count: amounts.length, max: amounts[amounts.length - 1]!, median };
}

type Signal = {
  clean: boolean;
  label: string;
  detail: string | null;
};

function classifySignal(args: {
  amountUsd: number;
  vendorName: string;
  history: { count: number; max: number; median: number };
  corrections: Array<{ field: string; from: string; to: string; by: string | null }>;
}): Signal {
  const { amountUsd, vendorName, history, corrections } = args;
  const shortDollar = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);

  // Is the bill notably above what this vendor usually costs?
  const aboveUsual = history.count > 0 && amountUsd > history.max * 1.15;
  const overBy = aboveUsual ? amountUsd - history.max : 0;

  // A correction to the money is the loudest flag — a human moved the number
  // after the machine read it.
  const moneyCorrection = corrections.find((c) =>
    /total|amount|tax/i.test(c.field));

  if (moneyCorrection) {
    const aboveTxt = aboveUsual ? ` · ${shortDollar(overBy)} above ${vendorName}'s usual` : '';
    return {
      clean: false,
      label: 'Total changed after reading',
      detail: `${moneyCorrection.by ?? 'Someone'} corrected ${moneyCorrection.from} → ${moneyCorrection.to}${aboveTxt}`,
    };
  }
  if (history.count === 0) {
    return { clean: false, label: 'First bill from this vendor', detail: 'No history to compare against yet' };
  }
  if (aboveUsual) {
    const pct = Math.round(((amountUsd - history.max) / history.max) * 100);
    return {
      clean: false,
      label: `${shortDollar(overBy)} above ${vendorName}'s usual`,
      detail: `${pct}% above the most you've paid ${vendorName}`,
    };
  }
  return { clean: true, label: 'Looks normal', detail: `Within ${vendorName}'s usual range · nothing changed after reading` };
}

export async function getApprovalsInbox(organizationId: string, viewerUserId: string) {
  const person = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM approval.people WHERE organization_id = ${organizationId}::uuid AND user_id = ${viewerUserId}::uuid LIMIT 1`;
  const personId = person[0]?.id ?? null;
  if (!personId) return { waitingOnYou: [], inFlight: [], summary: { flagCount: 0, cleanCount: 0, totalWaitingUsd: 0 } };

  // Tasks that are mine and still need me (waiting-on-you), plus tasks I already
  // approved on approvables that are still moving (in-flight).
  const tasks = await prisma.$queryRaw<InboxTaskRow[]>`
    SELECT t.id AS task_id, t.state, t.step_index, t.sla_deadline,
           a.id AS approvable_id, a.macro_state, a.requester_id,
           a.attributes->>'paymentOrderId' AS payment_order_id
    FROM approval.tasks t
    JOIN approval.approval_plans p ON p.id = t.plan_id AND p.superseded_by IS NULL
    JOIN approval.approvables a ON a.id = p.approvable_id
    WHERE a.organization_id = ${organizationId}::uuid AND a.type = 'invoice'
      AND t.person_id = ${personId}::uuid
      AND ((t.state IN ('open', 'info_requested'))
           OR (t.state = 'approved' AND a.macro_state IN ('pending_approval', 'returned_for_info', 'on_hold')))`;

  const people = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM approval.people WHERE organization_id = ${organizationId}::uuid`;
  const nameOf = new Map(people.map((p) => [p.id, p.name]));

  const openTaskByApprovable = new Map<string, InboxTaskRow>();
  const approvedTaskByApprovable = new Map<string, InboxTaskRow>();
  for (const t of tasks) {
    if (t.state === 'open' || t.state === 'info_requested') openTaskByApprovable.set(t.approvable_id, t);
    else if (t.state === 'approved') approvedTaskByApprovable.set(t.approvable_id, t);
  }

  const { getActivePlan } = await import('../approvals/store.js');

  const buildChain = async (approvableId: string) => {
    const plan = await getActivePlan(prisma, approvableId);
    const steps = Array.isArray(plan?.steps) ? (plan!.steps as Array<Record<string, unknown>>) : [];
    const planTasks = plan
      ? await prisma.$queryRaw<{ step_index: number; person_id: string; state: string }[]>`
          SELECT step_index, person_id, state FROM approval.tasks WHERE plan_id = ${plan.id}::uuid`
      : [];
    const nodes: Array<{ personId: string; state: string }> = [];
    for (const step of steps) {
      const approvers = Array.isArray(step.approvers) ? step.approvers : [];
      for (const ap of approvers as Array<Record<string, unknown>>) {
        const pid = String(ap.personId);
        const task = planTasks.find((t) => t.step_index === Number(step.index) && t.person_id === pid);
        nodes.push({ personId: pid, state: task?.state ?? 'scheduled' });
      }
    }
    return nodes;
  };

  const waitingOnYou: unknown[] = [];
  const inFlight: unknown[] = [];
  let totalWaitingUsd = 0;
  let flagCount = 0;
  let cleanCount = 0;

  const now = new Date();

  for (const task of [...openTaskByApprovable.values(), ...approvedTaskByApprovable.values()]) {
    if (!task.payment_order_id) continue;
    const order = await prisma.paymentOrder.findFirst({
      where: { organizationId, paymentOrderId: task.payment_order_id },
      select: {
        paymentOrderId: true, amountRaw: true, memo: true, invoiceNumber: true, dueAt: true, createdAt: true,
        metadataJson: true, counterpartyId: true, counterpartyWalletId: true,
        counterparty: { select: { displayName: true } }, counterpartyWallet: { select: { label: true } },
      },
    });
    if (!order) continue;

    const vendorName = order.counterparty?.displayName ?? order.counterpartyWallet.label;
    const amountUsd = amountRawToUsd(order.amountRaw);
    const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
    const agent = isRecord(metadata.agent) ? metadata.agent : {};
    const extracted = isRecord(agent.extracted) ? agent.extracted : {};
    const firstLine = Array.isArray(extracted.lineItems) && isRecord((extracted.lineItems as unknown[])[0])
      ? str(((extracted.lineItems as unknown[])[0] as Record<string, unknown>).description) : null;
    const what = firstLine ?? str(order.memo) ?? 'Bill';

    const nodes = await buildChain(task.approvable_id);
    const myIndex = nodes.findIndex((n) => n.personId === personId);
    const total = nodes.length;
    const doneNames = nodes.filter((n) => n.state === 'approved').map((n) => nameOf.get(n.personId)?.split(' ')[0]).filter(Boolean);
    const afterMe = nodes.slice(myIndex + 1).map((n) => nameOf.get(n.personId)).filter(Boolean);

    const overdueDays = order.dueAt ? daysBetween(now, order.dueAt) : 0;

    if (task.state === 'open' || task.state === 'info_requested') {
      // Signal — the moat, computed live.
      const verification = isRecord(metadata.verification) ? metadata.verification : null;
      const correctionRows = (verification && Array.isArray(verification.corrections) ? (verification.corrections as unknown[]) : []).filter(isRecord);
      const correctorIds = [...new Set(correctionRows.map((c) => str(c.byUserId)).filter((v): v is string => Boolean(v)))];
      const correctorUsers = correctorIds.length
        ? await prisma.user.findMany({ where: { userId: { in: correctorIds } }, select: { userId: true, displayName: true } })
        : [];
      const nameById = new Map(correctorUsers.map((u) => [u.userId, u.displayName]));
      const corrections = correctionRows.map((c) => ({
        field: str(c.field) ?? '',
        from: c.readValue == null || c.readValue === '' ? 'not on document' : String(c.readValue),
        to: c.correctedValue == null || c.correctedValue === '' ? 'removed' : String(c.correctedValue),
        by: nameById.get(str(c.byUserId) ?? '') ?? null,
      }));
      const history = await vendorHistory(organizationId, order);
      const signal = classifySignal({ amountUsd, vendorName, history, corrections });

      if (signal.clean) cleanCount += 1; else flagCount += 1;
      totalWaitingUsd += amountUsd;

      const progText = myIndex <= 0
        ? 'You start the chain'
        : `${myIndex + 1} of ${total} · your turn now`;
      const hintParts: string[] = [];
      if (doneNames.length) hintParts.push(`${doneNames.join(', ')} approved`);
      if (afterMe.length) hintParts.push(`then ${afterMe.join(', ')}`);

      waitingOnYou.push({
        taskId: task.task_id,
        paymentOrderId: order.paymentOrderId,
        vendor: vendorName,
        what,
        invoice: order.invoiceNumber,
        amountUsd,
        overdueDays: overdueDays > 0 ? overdueDays : null,
        dueSoonDays: overdueDays <= 0 && order.dueAt && daysBetween(order.dueAt, now) <= 5 ? Math.max(0, daysBetween(order.dueAt, now)) : null,
        progText,
        hint: hintParts.join(' · ') || null,
        signal,
        blocked: task.state === 'info_requested',
      });
    } else {
      // In-flight: I approved, it's still moving. Where is it now?
      const openNode = nodes.find((n) => n.state === 'open' || n.state === 'info_requested');
      const nowWith = openNode ? nameOf.get(openNode.personId) ?? null : null;
      inFlight.push({
        taskId: task.task_id,
        paymentOrderId: order.paymentOrderId,
        vendor: vendorName,
        what,
        invoice: order.invoiceNumber,
        amountUsd,
        nowWith,
        stalledDays: overdueDays > 0 ? overdueDays : null,
      });
    }
  }

  const urgencyRank = (r: { overdueDays: number | null; signal: Signal }) =>
    (r.overdueDays ? -1000 - r.overdueDays : 0) + (r.signal.clean ? 0 : -100);
  waitingOnYou.sort((a, b) => urgencyRank(a as never) - urgencyRank(b as never));

  return {
    waitingOnYou,
    inFlight,
    summary: { flagCount, cleanCount, totalWaitingUsd },
  };
}
