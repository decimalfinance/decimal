// The bills workbench + bill draft backend (AP workbench redesign,
// uploads/ap-claude-code-handoff.md).
//
// Workbench: every payment order, grouped into the five operator buckets
// (draft / in approval / to pay / done / needs attention) with the
// row facts the triage table renders.
//
// Draft: one bill's verification packet — the stored document, what was
// read from it (per-field), flags — and the Confirm ceremony, which is the
// call site for submitInvoiceForApproval in the v3 pipeline: verification
// happens BEFORE a bill enters routing.
import type { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';
import { USDC_DECIMALS } from '../solana.js';
import { markBillSubmitted, cancelPaymentOrder, getPaymentOrderDetail } from './orders.js';
import { listChartOfAccounts } from '../accounting/ocr-coding.js';
import { extractPdfTextLayer, refineInvoiceSources, PROVENANCE_VERSION } from './doc-provenance.js';
import { findDuplicateBills, readDuplicateOverride, describeDuplicate, matchDuplicates } from './duplicate-check.js';
import { readPayableHold, describePayableHold } from './vendor-payable.js';
import { evaluateBillFlags, summarizeBillFlags, displayOrgName } from './bill-flags.js';
import type { BillFlag } from './bill-flags.js';
import { getBillCeilingMinor } from '../approvals/store.js';
import { involvedBillIds } from './bill-visibility.js';
import type { ExtractedInvoice } from './document-extract.js';

// Exact field→document boxes for ANY bill, whenever it is opened: if this
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
    logger.warn('bill_draft.provenance_backfill_failed', {
      paymentOrderId: order.paymentOrderId,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
    return extracted;
  }
}

export type BillBucket = 'draft' | 'in_approval' | 'to_pay' | 'done' | 'needs_attention';

// Below this per-field read confidence, the draft screen marks the field
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

  if (state === 'draft') {
    // An approver sent it back: it's a draft again, but with homework.
    if (invoice?.macro_state === 'rejected') {
      return { bucket: 'draft', subStatus: { kind: 'loud', text: 'Sent back — needs changes', tone: 'warning' } };
    }
    return { bucket: 'draft', subStatus: { kind: 'plain', text: 'Needs a check', tone: 'info' } };
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

/**
 * How this bill arrived, and who brought it. `intakeChannel` is stamped by
 * invoice intake when the door was email; everything else is an ordinary
 * upload. Both name the person, because it tells an approver who to ask —
 * "Forwarded by Priya" beats "Forwarded in", and an upload with no name at all
 * beats nothing.
 */
function billSource(
  metadataJson: unknown,
  createdByName: string | null,
): { source: 'email' | 'upload'; sourceLabel: string | null } {
  const channel = isRecord(metadataJson) ? metadataJson.intakeChannel : null;
  const emailed = isRecord(channel) && channel.kind === 'email';

  // An upload used to return no label at all, so a bill that somebody dragged
  // in showed nothing about where it came from. Both doors name the person:
  // every bill in the system was put there by a colleague, and which colleague
  // is the first thing anyone asks when a figure looks wrong.
  if (!emailed) {
    return {
      source: 'upload',
      sourceLabel: createdByName ? `Uploaded by ${createdByName}` : 'Uploaded',
    };
  }
  return {
    source: 'email',
    sourceLabel: createdByName ? `Forwarded by ${createdByName}` : 'Forwarded in',
  };
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

// Ramp-style split of the draft queue: a bill is "ready for approval" when
// the facts an approver needs are present and nothing security-shaped is open;
// otherwise it's "missing information" and the row says what's missing.
// Tier 1 (blocks entering approval): amount + line items to route on.
// Tier 2 (flag, never block): invoice number, due date — fill during approval.
//
// Which RULES block is no longer decided here. That list used to live in a
// local BLOCKING_RULES set, which was a third copy of knowledge already held by
// the flag definitions — so a flag could be marked blocking and this function
// would still call the bill ready. Blocking-ness now has exactly one owner:
// bill-flags.ts. This only asks whether something is missing.
function draftReadiness(args: {
  amountUsd: number;
  invoiceNumber: string | null;
  dueAt: Date | null;
  hasLineItems: boolean;
  /** Any flag that blocks the bill leaving draft, per bill-flags.ts. */
  blockedByFlag: boolean;
}): { readiness: 'ready' | 'missing_info'; missing: string[]; laterNeeded: string[]; blocked: boolean } {
  const missing: string[] = [];
  if (!(args.amountUsd > 0)) missing.push('amount');
  if (!args.hasLineItems) missing.push('line items');
  const laterNeeded: string[] = [];
  if (!args.invoiceNumber) laterNeeded.push('invoice number');
  if (!args.dueAt) laterNeeded.push('due date');
  const blocked = args.blockedByFlag;
  return { readiness: blocked || missing.length > 0 ? 'missing_info' : 'ready', missing, laterNeeded, blocked };
}

// The document's own figures, for the arithmetic gates. Line totals are summed
// from what was extracted; a line with no total contributes nothing rather than
// silently counting as zero, because "we could not read this line" and "this
// line is worth nothing" are different facts and only one of them is safe.
// Compile-time warnings for a bill's routing, read from the engine's event log
// — the only place they are recorded. Chiefly a quorum the engine had to lower
// because separation-of-duties left too few eligible approvers: correct
// behaviour, but a weakening of a control the org set, and it must not stay
// invisible just because it lives in an append-only log nobody reads.
async function planAlertsByOrder(organizationId: string, paymentOrderIds: string[]) {
  const byOrder = new Map<string, string[]>();
  if (paymentOrderIds.length === 0) return byOrder;
  const rows = await prisma.$queryRaw<{ payment_order_id: string; alerts: unknown }[]>`
    SELECT DISTINCT ON (a.attributes->>'paymentOrderId')
           a.attributes->>'paymentOrderId' AS payment_order_id,
           e.payload->'alerts'             AS alerts
      FROM approval.approval_events e
      JOIN approval.approvables a ON a.id = e.approvable_id
     WHERE a.organization_id = ${organizationId}::uuid
       AND a.attributes->>'paymentOrderId' = ANY(${paymentOrderIds})
       AND e.payload->>'kind' = 'plan_compiled'
     ORDER BY a.attributes->>'paymentOrderId', e.seq DESC`;
  for (const r of rows) {
    if (Array.isArray(r.alerts)) byOrder.set(r.payment_order_id, r.alerts.filter((a): a is string => typeof a === 'string'));
  }
  return byOrder;
}

// Stored as objects carrying who added the name and when, because an identity
// claim about the organization should say who made it. The matcher only needs
// the names.
export function readTradingNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => (typeof e === 'string' ? e : isRecord(e) ? str(e.name) : null))
    .filter((n): n is string => Boolean(n));
}

// What the document calls itself. A real invoice carries exactly one invoice
// number, referring to itself; a statement lists many. Pulled from the line
// items rather than a new model call — the references are already extracted,
// they were simply never read as a signal about the document's TYPE.
function documentTypeSignals(extracted: Record<string, unknown> | null, invoiceNumber: string | null) {
  // What the document says it is, asked directly. The regex below stays as a
  // backstop for extractions made before the question was asked.
  const kind = str(extracted?.documentKind);
  const statementRows = Array.isArray(extracted?.statementRows)
    ? (extracted!.statementRows as unknown[]).filter(isRecord)
    : [];

  const refs: string[] = [];
  for (const row of statementRows) {
    const ref = str(row.reference);
    if (ref) refs.push(ref);
  }

  if (refs.length === 0) {
    // The old inference, corrected. It used to accept \d{4,}-\d{2,}, which on
    // the Meridian statement matched the DATES — 2026-06, 2026-07, 2026-08 —
    // and never MER-8801 at all. The flag fired for the right document by
    // accident, told the reader it had found three invoice numbers that were
    // not invoice numbers, and would have missed a statement whose rows carry
    // no ISO dates.
    //
    // A reference is letters-then-digits (MER-8801, INV-2044, VP-3390). A date
    // is explicitly not one.
    //
    // The separator matters more than it looks. Allowing a SPACE after any
    // two-to-six letters made "dated 2026" a reference, so the Meridian
    // statement reported four invoice numbers, one of which was "DATED 2026".
    // Any-letters therefore requires a dash, a hash, or nothing between the
    // letters and the digits; only the words that actually announce a
    // reference — INV, BILL, INVOICE — may be followed by a space.
    const lines = Array.isArray(extracted?.lineItems) ? (extracted!.lineItems as unknown[]) : [];
    const INVOICE_REF = /\b[A-Z]{2,6}[-#]?\d{3,}\b|\b(?:INV|BILL|INVOICE)[-\s#]?\d{2,}\b/gi;
    const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?$/;
    for (const line of lines) {
      if (!isRecord(line)) continue;
      for (const field of [str(line.description), str(line.reference)]) {
        for (const m of (field ?? '').matchAll(INVOICE_REF)) {
          if (!ISO_DATE.test(m[0])) refs.push(m[0]);
        }
      }
    }
  }

  return {
    invoiceNumber: str(extracted?.invoiceNumber) ?? invoiceNumber,
    lineInvoiceRefs: refs,
    // A document that names itself is worth believing over an inference.
    declaredKind: kind && kind !== 'invoice' ? kind : null,
  };
}

/** Which confidence answers "how well did we read the value on screen?". */
export function pickAddressConfidenceKey(usedVendorAddress: boolean): 'vendorAddress' | 'remitTo' {
  return usedVendorAddress ? 'vendorAddress' : 'remitTo';
}

/**
 * The approval chain, flattened to what a progress strip needs: who, in order,
 * and where each of them stands.
 *
 * Deliberately not the full chain getBillDetail builds — that carries threads,
 * decline reasons and per-step rules, which a strip has no room for and no use
 * for. This exists so a bill clerk can see how far a bill has come and how far is
 * left BEFORE they act on it: three people having already signed is a reason to
 * move, and a bill that has not started is a different kind of ask.
 */
async function approvalRouteFor(organizationId: string, paymentOrderId: string) {
  const rows = await prisma.$queryRaw<{ name: string; state: string; step_index: number }[]>`
    SELECT p2.name, t.state, t.step_index
      FROM approval.tasks t
      JOIN approval.approval_plans pl ON pl.id = t.plan_id AND pl.superseded_by IS NULL
      JOIN approval.approvables a ON a.id = pl.approvable_id
      JOIN approval.people p2 ON p2.id = t.person_id
     WHERE a.organization_id = ${organizationId}::uuid
       AND a.type = 'invoice'
       AND a.attributes->>'paymentOrderId' = ${paymentOrderId}
     ORDER BY t.step_index, p2.name`;
  return rows.map((r) => ({
    name: r.name,
    stepIndex: r.step_index,
    // Collapsed to three words a strip can render. 'waiting' is the one that
    // matters — it is where the bill actually is.
    state: r.state === 'approved' ? 'done'
      : r.state === 'rejected' ? 'declined'
      : ['open', 'info_requested', 'escalated'].includes(r.state) ? 'waiting'
      : 'upcoming',
  }));
}

/**
 * A recorded decision to pay what a bill itemises rather than the figure
 * printed on it. Stored beside the duplicate override and read the same way —
 * a judgement somebody made, kept with the bill so it travels to the approvers
 * instead of arriving as an unexplained number.
 */
function readShortPay(metadata: unknown): {
  byName: string;
  reason: string;
  itemisedTotal: number;
  documentTotal: number | null;
} | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata.shortPay;
  if (!isRecord(raw)) return null;
  const itemised = num(raw.itemisedTotal);
  if (typeof raw.reason !== 'string' || itemised === null) return null;
  return {
    byName: typeof raw.byName === 'string' ? raw.byName : 'somebody',
    reason: raw.reason,
    itemisedTotal: itemised,
    documentTotal: num(raw.documentTotal),
  };
}

// Sum a set of line rows, refusing to guess. Every row that says anything at
// all must carry a readable amount; one that doesn't makes the sum unknown
// rather than smaller, because a total quietly missing a line is worse than no
// total. Entirely blank rows are ignored — an empty row at the bottom of the
// table is somewhere to type, not a line worth nothing.
function sumLineAmounts(rows: unknown[], amountKey: string): number | null {
  const present = rows.filter(isRecord).filter(
    (l) => (typeof l.description === 'string' && l.description.trim() !== '') || num(l[amountKey]) !== null,
  );
  if (present.length === 0) return null;
  const amounts = present.map((l) => num(l[amountKey]));
  if (amounts.some((a) => a === null)) return null;
  return (amounts as number[]).reduce((a, b) => a + b, 0);
}

/**
 * The figures the arithmetic gate should be satisfied with.
 *
 * Until somebody edits the bill, that is the document as it was read: the gate
 * is asking "does this invoice hold together, and did we read it correctly?"
 *
 * Once somebody edits it, it is THEIR figures — because theirs are the ones
 * that will be paid. This used to read the raw extraction always, which made
 * the flag permanent: correcting the lines, the tax or the total changed
 * nothing the gate looked at, so "Correct the figures" was an instruction that
 * could not work and the bill could never leave review. A blocking flag with no
 * reachable resolution is a dead end, which is exactly what this file's own
 * rules say must not exist.
 *
 * The printed subtotal is not kept once corrections exist. No screen offers a
 * way to edit it, so judging a corrected bill against it would be the same dead
 * end in a smaller room. But it is replaced rather than dropped: a subtotal IS
 * what the lines come to, and once a person owns the lines, theirs is the
 * subtotal.
 *
 * Dropping it outright looked equivalent and was not. With no subtotal the
 * lines get compared against the total with tax taken off, so the same single
 * discrepancy changed its NAME the moment anybody saved — "total does not
 * reconcile" became "lines do not add up", quoting $4,500, a figure printed
 * nowhere on the document and arrived at by subtracting tax from a total the
 * person was in the middle of correcting. The history then read as one problem
 * being resolved and a different one appearing in the same second.
 */
/**
 * The flags on a bill as things currently stand, gathered from scratch.
 *
 * getBillDraft already does this, but it also loads the document, the chart of
 * accounts, the question thread and the approval route — far too much to run
 * twice around a save just to find out what changed. This gathers only what the
 * rules read.
 *
 * `verification` can be overridden to ask a counterfactual: what were the flags
 * BEFORE this save? Passing null answers "as the document arrived", which is
 * how the first save on a bill gets a truthful baseline without anything having
 * been written at intake.
 */
export async function flagsForOrder(
  organizationId: string,
  paymentOrderId: string,
  opts?: { verification?: Record<string, unknown> | null },
): Promise<BillFlag[]> {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    include: { counterparty: true, counterpartyWallet: true },
  });
  if (!order) return [];

  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const agent = isRecord(metadata.agent) ? metadata.agent : {};
  const extracted = isRecord(agent.extracted) ? agent.extracted : {};
  const verification = opts && 'verification' in opts
    ? opts.verification ?? null
    : (isRecord(metadata.verification) ? metadata.verification : null);
  const verifiedFields = verification && isRecord(verification.fields) ? verification.fields : null;
  const triggeredRules = Array.isArray(agent.triggeredRules)
    ? (agent.triggeredRules as Array<Record<string, unknown>>)
    : [];

  const [org, ceilingMinor, duplicates, alerts] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { organizationId },
      select: { organizationName: true, tradingNames: true },
    }),
    getBillCeilingMinor(prisma, organizationId),
    findDuplicateBills(organizationId, {
      excludePaymentOrderId: order.paymentOrderId,
      counterpartyId: order.counterpartyId,
      counterpartyWalletId: order.counterpartyWalletId,
      invoiceNumber: (verifiedFields ? str(verifiedFields.invoiceNumber) : null)
        ?? str(extracted.invoiceNumber) ?? order.invoiceNumber,
      amountRaw: order.amountRaw,
      createdAt: order.createdAt,
    }),
    planAlertsByOrder(organizationId, [order.paymentOrderId]),
  ]);

  return evaluateBillFlags({
    vendorName: order.counterparty?.displayName ?? order.counterpartyWallet.label,
    organizationName: displayOrgName(org.organizationName),
    tradingNames: readTradingNames(org.tradingNames),
    amountRaw: order.amountRaw,
    billToName: str(extracted.billToName),
    triggeredRules: triggeredRules.map((r) => str(r.rule)).filter((r): r is string => Boolean(r)),
    vendorHold: order.counterparty ? readPayableHold(order.counterparty.metadataJson) : null,
    ceilingMinor,
    duplicates,
    duplicateOverride: readDuplicateOverride(metadata),
    shortPay: readShortPay(metadata),
    amounts: documentAmounts(extracted, verification),
    planAlerts: alerts.get(order.paymentOrderId) ?? [],
    documentType: documentTypeSignals(extracted, order.invoiceNumber),
  });
}

/**
 * Write down what changed about a bill's flags, so the history can say a check
 * was raised and later cleared rather than silently ceasing to be true.
 *
 * Flags are derived — recomputed from the current facts on every read — which
 * is right, but it means a flag that stops applying leaves no trace at all. A
 * bill that was blocked and then fixed became indistinguishable from one that
 * was never flagged, so "was this ever questioned?" had no answer.
 *
 * Deliberately called only where a person changed something, never on read.
 * Recording a flag every time somebody opens a bill would bury the real events
 * under page loads.
 */
/**
 * A bill's opening flags, written down the moment it exists.
 *
 * Without this the history is half a sentence. Everything a person does
 * afterwards can be compared against something, but the flags a document
 * arrives carrying were never raised by anybody — so a bill that came in
 * broken and was fixed recorded the fix and not the fault, and the log read
 * "Resolved: lines do not add up" with nothing ever having said they didn't.
 *
 * Best-effort: a bill that has been ingested must not be lost because its
 * history could not be written.
 */
export async function recordOpeningFlags(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string | null;
}) {
  try {
    await recordFlagChanges({
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
      actorUserId: args.actorUserId,
      before: [],
      after: await flagsForOrder(args.organizationId, args.paymentOrderId),
      state: 'draft',
    });
  } catch (error) {
    logger.warn('bill_opening_flags.failed', {
      paymentOrderId: args.paymentOrderId,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }
}

async function recordFlagChanges(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string | null;
  before: BillFlag[];
  after: BillFlag[];
  state: string;
  /** Stamp several writes from one action with one instant. */
  at?: Date;
}) {
  // Only the flags that actually stop a bill. An informational one — "first
  // bill from this vendor" — never held anything up, so recording it as raised
  // and later resolved describes an event that did not happen, and buries the
  // ones that did under context nobody was ever asked to act on.
  const was = new Map(args.before.filter((f) => f.blocking).map((f) => [f.kind, f]));
  const now = new Map(args.after.filter((f) => f.blocking).map((f) => [f.kind, f]));

  const rows: Array<{ eventType: string; flag: BillFlag }> = [];
  for (const [kind, flag] of now) if (!was.has(kind)) rows.push({ eventType: 'bill_flag_raised', flag });
  for (const [kind, flag] of was) if (!now.has(kind)) rows.push({ eventType: 'bill_flag_cleared', flag });
  if (rows.length === 0) return;

  await prisma.paymentOrderEvent.createMany({
    data: rows.map(({ eventType, flag }) => ({
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
      eventType,
      actorType: 'user' as const,
      actorId: args.actorUserId,
      beforeState: args.state,
      afterState: args.state,
      payloadJson: {
        kind: flag.kind,
        short: flag.short,
        severity: flag.severity,
        blocking: flag.blocking,
        // The whole sentence, not just the label. "Lines do not add up" says
        // which check fired; it does not say that they came to $4,000 against a
        // document reading $4,820, which is the part somebody reading the
        // history afterwards actually needs.
        message: flag.message,
      },
      ...(args.at ? { createdAt: args.at } : {}),
    })),
  });
}

/**
 * Everything that has been done to a bill, in order.
 *
 * The record was always kept — bill_field_changes is append-only and carries
 * who, what and when — but the only screen that rendered any of it was the
 * post-confirm detail page. So for the whole time a bill is being WORKED,
 * which is the only time the question "what has been changed on this?" is
 * live, the answer was on screen nowhere.
 *
 * Reads the table rather than the corrections blob on the bill: the blob is
 * recomputed on every save and carries no timestamps, so it can tell you the
 * tax ended up at 820 but not that Priya put it there at 8:49pm.
 */
export async function billWorkLog(organizationId: string, paymentOrderId: string) {
  const [changes, events] = await Promise.all([
    prisma.billFieldChange.findMany({
      where: { organizationId, paymentOrderId },
      orderBy: { changedAt: 'asc' },
      select: {
        billFieldChangeId: true, fieldKey: true, previousValue: true, newValue: true,
        changedByUserId: true, actorType: true, changedAt: true,
      },
    }),
    prisma.paymentOrderEvent.findMany({
      where: { organizationId, paymentOrderId, eventType: { in: [...BILL_LOG_EVENT_TYPES] } },
      orderBy: { createdAt: 'asc' },
      select: { paymentOrderEventId: true, eventType: true, actorId: true, payloadJson: true, createdAt: true },
    }),
  ]);

  const userIds = [...new Set([
    ...changes.map((c) => c.changedByUserId),
    ...events.map((e) => e.actorId),
  ].filter((v): v is string => Boolean(v)))];
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { userId: { in: userIds } }, select: { userId: true, displayName: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.userId, u.displayName]));

  type Entry = {
    id: string;
    kind: 'field_changed' | 'flag_raised' | 'flag_cleared' | 'policy_overridden';
    at: Date;
    byName: string | null;
    /** One line, already written out — the screen renders, it does not phrase. */
    text: string;
    /** Present on a field change, so the screen can point at the field. */
    field: string | null;
    /** The long form, when there is one worth reading under the headline. */
    detail: string | null;
  };

  const entries: Entry[] = [];

  for (const c of changes) {
    const label = BILL_FIELD_LABELS[c.fieldKey] ?? c.fieldKey;
    const from = c.previousValue === null || c.previousValue === '' ? 'nothing' : formatLoggedValue(c.fieldKey, c.previousValue);
    const to = c.newValue === null || c.newValue === '' ? 'nothing' : formatLoggedValue(c.fieldKey, c.newValue);
    entries.push({
      id: c.billFieldChangeId,
      kind: 'field_changed',
      at: c.changedAt,
      byName: c.changedByUserId ? nameOf.get(c.changedByUserId) ?? null : (c.actorType === 'user' ? null : 'Decimal'),
      text: `${label} changed from ${from} to ${to}`,
      field: c.fieldKey,
      detail: null,
    });
  }

  for (const e of events) {
    const payload = isRecord(e.payloadJson) ? e.payloadJson : {};
    // `rule` is a wire identifier. It reached the screen as the headline of an
    // entry — "pay_the_itemised_total" sitting above somebody's sentence about
    // a vendor — which is the same leak the field keys had.
    const short = str(payload.short)
      ?? OVERRIDE_LABELS[str(payload.rule) ?? '']
      ?? 'A check was overridden';
    const reason = str(payload.reason);
    entries.push({
      id: e.paymentOrderEventId,
      kind: e.eventType === 'bill_flag_raised' ? 'flag_raised'
        : e.eventType === 'bill_flag_cleared' ? 'flag_cleared'
        : 'policy_overridden',
      at: e.createdAt,
      byName: e.actorId ? nameOf.get(e.actorId) ?? null : null,
      text: e.eventType === 'bill_flag_raised' ? `Flagged: ${short}`
        : e.eventType === 'bill_flag_cleared' ? `Resolved: ${short}`
        : `${short}${reason ? ` \u201c${reason}\u201d` : ''}`,
      field: null,
      detail: str(payload.message),
    });
  }

  entries.sort((a, b) =>
    a.at.getTime() - b.at.getTime()
    || (ENTRY_ORDER[a.kind] ?? 9) - (ENTRY_ORDER[b.kind] ?? 9));
  return entries.map((e) => ({ ...e, at: e.at.toISOString() }));
}

/** Event types that belong on a bill's work log. */
const BILL_LOG_EVENT_TYPES = ['bill_flag_raised', 'bill_flag_cleared', 'policy_overridden'] as const;

// Field keys are wire identifiers; a person reading a history wants the label
// they saw on the form.
const BILL_FIELD_LABELS: Record<string, string> = {
  vendorName: 'Vendor',
  vendorEmail: 'Email',
  invoiceNumber: 'Invoice number',
  invoiceDate: 'Invoice date',
  dueDate: 'Due date',
  terms: 'Terms',
  poNumber: 'PO number',
  discount: 'Discount',
  currency: 'Currency',
  total: 'Total due',
  taxAmount: 'Tax',
  lineItems: 'Line items',
};

// What each policy override is called in a sentence. Keyed by the rule the
// engine records, which is not a phrase anybody should have to read.
const OVERRIDE_LABELS: Record<string, string> = {
  pay_the_itemised_total: 'Paying the itemised total',
  duplicate_bill: 'Duplicate flag cleared',
};

// Several rows can share a timestamp, because one thing a person did writes a
// change, a decision and a resolution together. Sorted by time alone the three
// come back in whatever order the database felt like, and the account reads
// backwards — the flag resolved above the edit that resolved it. So a fixed
// order within the same instant: what was changed, what was decided, then what
// that did to the checks.
const ENTRY_ORDER: Record<string, number> = {
  field_changed: 0,
  policy_overridden: 1,
  flag_raised: 2,
  flag_cleared: 3,
};

// Money reads as money. "Tax changed from 0 to 820" is a worse sentence than
// "Tax changed from $0.00 to $820.00", and the second is checkable against the
// document at a glance.
const MONEY_FIELDS = new Set(['total', 'taxAmount']);
function formatLoggedValue(fieldKey: string, value: string): string {
  if (!MONEY_FIELDS.has(fieldKey)) return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function documentAmounts(
  extracted: Record<string, unknown> | null,
  verification: Record<string, unknown> | null,
) {
  const extractedLines = Array.isArray(extracted?.lineItems) ? (extracted!.lineItems as unknown[]) : [];
  const verifiedFields = verification && isRecord(verification.fields) ? verification.fields : null;
  const verifiedLines = verification && Array.isArray(verification.lines)
    ? (verification.lines as unknown[])
    : null;

  if (!verifiedFields && !verifiedLines) {
    return {
      lineItemsTotal: sumLineAmounts(extractedLines, 'total'),
      subtotal: num(extracted?.subtotal),
      tax: num(extracted?.taxAmount),
      total: num(extracted?.amount),
    };
  }

  const correctedLines = verifiedLines
    ? sumLineAmounts(verifiedLines, 'amount')
    : sumLineAmounts(extractedLines, 'total');
  return {
    lineItemsTotal: correctedLines,
    subtotal: correctedLines,
    tax: verifiedFields && 'taxAmount' in verifiedFields
      ? num(verifiedFields.taxAmount)
      : num(extracted?.taxAmount),
    total: verifiedFields && 'total' in verifiedFields
      ? num(verifiedFields.total)
      : num(extracted?.amount),
  };
}

export async function getBillsWorkbench(organizationId: string, viewerUserId: string) {
  // An approver's queue is the bills they are involved in, not the company's.
  // null means "entitled to all of them", which is every other job here.
  const visible = await involvedBillIds(organizationId, viewerUserId);
  const [orders, engine, org, ceilingMinor] = await Promise.all([
    prisma.paymentOrder.findMany({
      where: {
        organizationId,
        ...(visible === null ? {} : { paymentOrderId: { in: [...visible] } }),
      },
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
        externalReference: true,
        counterpartyId: true,
        counterpartyWalletId: true,
        counterpartyWallet: { select: { label: true } },
        counterparty: { select: { displayName: true, metadataJson: true } },
        createdByUser: { select: { displayName: true } },
      },
    }),
    loadEngineState(organizationId),
    prisma.organization.findUniqueOrThrow({
      where: { organizationId },
      select: { organizationName: true, tradingNames: true },
    }),
    getBillCeilingMinor(prisma, organizationId),
  ]);

  // Questions waiting on this reader, per bill.
  //
  // The only surface for these was the Approvals page, which is where
  // DECISIONS live. So a question asked about a bill still in DRAFT — the most
  // useful moment to ask one, since the figures can still be fixed — had
  // nowhere to appear on the screen where drafts are. It was raised, stored,
  // routed, and invisible to the person it was routed to unless they happened
  // to open a tab about approvals for a bill that had not reached approval.
  const openQuestions = orders.length === 0 ? [] : await prisma.billQuestion.findMany({
    where: {
      organizationId,
      askedOfUserId: viewerUserId,
      answeredAt: null,
      paymentOrderId: { in: orders.map((o) => o.paymentOrderId) },
    },
    orderBy: { createdAt: 'asc' },
    select: { billQuestionId: true, paymentOrderId: true, question: true, askedByUserId: true },
  });
  const askerNames = new Map<string, string>();
  if (openQuestions.length > 0) {
    const askers = await prisma.user.findMany({
      where: { userId: { in: [...new Set(openQuestions.map((q) => q.askedByUserId))] } },
      select: { userId: true, displayName: true },
    });
    for (const u of askers) askerNames.set(u.userId, u.displayName);
  }
  // Oldest first, so the one that has been waiting longest is the one shown.
  const questionByOrder = new Map<string, { billQuestionId: string; question: string; askedByName: string | null }>();
  for (const q of openQuestions) {
    if (questionByOrder.has(q.paymentOrderId)) continue;
    questionByOrder.set(q.paymentOrderId, {
      billQuestionId: q.billQuestionId,
      question: q.question,
      askedByName: askerNames.get(q.askedByUserId) ?? null,
    });
  }

  // Duplicate detection over rows we already hold. findDuplicateBills would be
  // one query per bill; matchDuplicates is the same rules against the same
  // candidate set, in memory. Grouped by vendor because that is how the query
  // scopes candidates, and cancelled orders are excluded for the same reason.
  const alertsByOrder = await planAlertsByOrder(organizationId, orders.map((o) => o.paymentOrderId));
  const liveOrders = orders.filter((o) => o.state !== 'cancelled');
  const byVendor = new Map<string, typeof liveOrders>();
  for (const o of liveOrders) {
    const key = o.counterpartyId ?? `wallet:${o.counterpartyWalletId}`;
    const list = byVendor.get(key);
    if (list) list.push(o); else byVendor.set(key, [o]);
  }

  const counts: Record<BillBucket, number> = {
    draft: 0, in_approval: 0, to_pay: 0, done: 0, needs_attention: 0,
  };

  // Documents we hold but have not finished reading.
  //
  // A bill row is a payment order, and a payment order is only created once
  // extraction produces figures — so between dropping six PDFs in and the model
  // getting through them, the list said nothing at all. The upload had visibly
  // worked and the queue was empty, which reads as the file having gone
  // nowhere. The document exists from the moment it is stored; showing it is
  // just telling the truth earlier.
  //
  // Deliberately NOT a payment order with empty fields. Everything downstream
  // assumes an order has a vendor and an amount, and inventing a hollow one to
  // win a row on a list would put a half-formed bill into routing, duplicate
  // detection and the approval engine. These are documents, and they say so.
  const pendingDocs = await prisma.invoiceDocument.findMany({
    where: {
      organizationId,
      status: { in: ['processing', 'failed'] },
      paymentOrders: { none: {} },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      invoiceDocumentId: true, filename: true, status: true, processingError: true,
      createdAt: true, uploadedByUser: { select: { displayName: true } },
    },
  });
  const pending = pendingDocs.map((d) => ({
    invoiceDocumentId: d.invoiceDocumentId,
    filename: d.filename,
    status: d.status as 'processing' | 'failed',
    error: d.processingError,
    createdAt: d.createdAt,
    uploadedByName: d.uploadedByUser?.displayName ?? null,
  }));

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

    // The SAME evaluator the draft screen uses. A bill made out to another
    // company used to read "Ready for approval" here, because this row had its
    // own idea of "ready" that never consulted the flags. It no longer has one.
    const vendorKey = order.counterpartyId ?? `wallet:${order.counterpartyWalletId}`;
    const flags = evaluateBillFlags({
      vendorName: order.counterparty?.displayName ?? order.counterpartyWallet.label,
      organizationName: org.organizationName,
      tradingNames: readTradingNames(org.tradingNames),
      amountRaw: order.amountRaw,
      billToName: str(extracted?.billToName),
      triggeredRules: triggeredRules.map((r) => str(r.rule)).filter((r): r is string => Boolean(r)),
      vendorHold: order.counterparty ? readPayableHold(order.counterparty.metadataJson) : null,
      ceilingMinor,
      duplicates: matchDuplicates(
        (byVendor.get(vendorKey) ?? []).filter((c) => c.paymentOrderId !== order.paymentOrderId),
        {
          invoiceNumber: order.invoiceNumber,
          externalReference: order.externalReference,
          amountRaw: order.amountRaw,
          createdAt: order.createdAt,
        },
      ),
      duplicateOverride: readDuplicateOverride(order.metadataJson),
      shortPay: readShortPay(order.metadataJson),
      amounts: documentAmounts(extracted, isRecord(metadataRecord.verification) ? metadataRecord.verification : null),
      planAlerts: alertsByOrder.get(order.paymentOrderId) ?? [],
      documentType: documentTypeSignals(extracted, order.invoiceNumber),
    });
    const flagSummary = summarizeBillFlags(flags);

    let readiness: 'ready' | 'missing_info' | null = null;
    let missing: string[] = [];
    if (bucket === 'draft') {
      const r = draftReadiness({
        amountUsd: amountRawToUsd(order.amountRaw),
        invoiceNumber: order.invoiceNumber,
        dueAt: order.dueAt,
        hasLineItems: Array.isArray(extracted?.lineItems) && (extracted!.lineItems as unknown[]).length > 0,
        blockedByFlag: flagSummary.blocking,
      });
      readiness = r.readiness;
      missing = r.missing;
      if (flagSummary.worst && flagSummary.worst.severity === 'danger') {
        subStatus = { kind: 'loud', text: flagSummary.worst.short, tone: 'danger' };
      } else if (r.missing.length > 0) {
        subStatus = { kind: 'plain', text: `Missing ${r.missing.join(', ')}`, tone: 'warning' };
      } else {
        subStatus = { kind: 'plain', text: 'Ready for approval', tone: 'success' };
      }
    } else if (flagSummary.worst?.severity === 'danger' && bucket !== 'done') {
      // A danger flag does not stop mattering once a bill leaves draft. A bill
      // sitting in approval or queued to pay while addressed to another company
      // is the same failure, one stage later and with less scrutiny left. Paid
      // bills are excluded: the warning is spent, and the row is now history.
      subStatus = { kind: 'loud', text: flagSummary.worst.short, tone: 'danger' };
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
      ...billSource(order.metadataJson, order.createdByUser?.displayName ?? null),
      discountLabel: str(extracted?.earlyPayDiscount),
      flags,
      blocking: flagSummary.blocking,
      subStatus,
      readiness,
      missing,
      // A cleared duplicate flag must stay VISIBLE on the row — the operator
      // scanning To-pay is the last human checkpoint (testbench 001 §5).
      duplicateCleared: (() => {
        const o = readDuplicateOverride(order.metadataJson);
        return o ? { byName: o.byName, reason: o.reason } : null;
      })(),
      // Somebody is waiting on this reader for an answer about THIS bill.
      questionForYou: questionByOrder.get(order.paymentOrderId) ?? null,
    };
  });

  const draftCounts = {
    ready: bills.filter((b) => b.readiness === 'ready').length,
    missingInfo: bills.filter((b) => b.readiness === 'missing_info').length,
  };

  // They are on their way to the draft pile, so the tab that says how much work
  // is waiting should count them.
  counts.draft += pending.length;

  return {
    counts,
    draftCounts,
    pending,
    bills,
    // So the page can say it at the top as well as on the row — a question is
    // work assigned to a person, not a property of a bill they may not scroll to.
    questionsForYou: questionByOrder.size,
  };
}

// -----------------------------------------------------------------------------
// Review packet
// -----------------------------------------------------------------------------

// Invoices print the vendor address as one line ("450 Westlake Ave N, Seattle,
// WA 98109"); the draft screen wants it in four boxes. Anything this can't
// confidently split stays whole in `street` — showing the address in the wrong
// box is recoverable, showing "Not on document" is not.
export function splitPostalAddress(address: string | null): {
  street: string | null; city: string | null; state: string | null; zip: string | null;
} {
  const empty = { street: null, city: null, state: null, zip: null };
  if (!address) return empty;
  // Letterheads separate address parts typographically as often as they use a
  // comma: "500 Howard St · San Francisco, CA 94105". Splitting on commas alone
  // left the middle dot inside the street, so the street read "500 Howard St ·
  // San Francisco" and the city read Not on document — a wrong box AND an empty
  // one, on two of the six B-series invoices.
  const parts = address
    .replace(/[·•|]/g, ',')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return empty;
  if (parts.length === 1) return { ...empty, street: parts[0]! };

  let state: string | null = null;
  let zip: string | null = null;
  const tail = parts[parts.length - 1]!;
  const stateZip = /^([A-Za-z][A-Za-z. ]*?)\s+(\d{5}(?:-\d{4})?)$/.exec(tail);
  if (stateZip) {
    state = stateZip[1]!.trim();
    zip = stateZip[2]!;
    parts.pop();
  } else if (/^\d{5}(?:-\d{4})?$/.test(tail)) {
    zip = tail;
    parts.pop();
  } else if (/^[A-Za-z][A-Za-z. ]*$/.test(tail) && tail.length <= 20 && parts.length > 2) {
    state = tail;
    parts.pop();
  }

  const city = parts.length > 1 ? parts.pop()! : null;
  return { street: parts.join(', ') || null, city, state, zip };
}

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
    // Written to be read on HOVER, not printed under every field. The tag says
    // "Check"; this explains why, and says whose uncertainty it is — the reader
    // was not there when we read the document, so "hard to read here" told them
    // nothing they could act on.
    return { state: 'needs_look', reason: 'We were not confident reading this off the document — check it against the page' };
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

export async function getBillDraft(organizationId: string, paymentOrderId: string, viewerUserId?: string) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId, paymentOrderId },
    include: {
      counterpartyWallet: true,
      counterparty: true,
      createdByUser: { select: { displayName: true } },
      invoiceDocument: {
        select: { invoiceDocumentId: true, filename: true, mimeType: true, byteSize: true, pageCount: true },
      },
    },
  });
  if (!order) return null;

  // Same source of truth the capability middleware uses to refuse the save, so
  // the screen and the server cannot disagree about who may prepare a bill.
  // Without a viewer (internal callers) nothing is being rendered to anybody,
  // so there is no one to mislead — treat it as editable and let the route
  // enforce.
  let viewerCanEdit = true;
  if (viewerUserId) {
    const { getOrgAccess } = await import('../approvals/permissions.js');
    const access = await getOrgAccess(organizationId, viewerUserId);
    viewerCanEdit = Boolean(access?.capabilities.includes('bills.edit'));
  }

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

  const remitToRaw = isRecord(extracted.remitTo) ? extracted.remitTo : {};
  // These four inputs live inside the Vendor block and read as "the vendor's
  // address", but remitTo only fills when the invoice prints an explicit
  // "Remit To" panel. Most invoices just carry the address on the letterhead,
  // which extraction puts in the flat `vendorAddress` string — so the fields
  // rendered "Not on document" about an address plainly on the page. Fall back
  // to the letterhead address rather than tell the bill clerk it isn't there.
  const remitTo = (['street', 'city', 'state', 'zip'] as const).some((p) => str(remitToRaw[p]))
    ? remitToRaw
    : splitPostalAddress(str(extracted.vendorAddress));
  const usedVendorAddress = remitTo !== remitToRaw;
  const remitToVerified = verifiedFields && isRecord(verifiedFields.remitTo) ? verifiedFields.remitTo : null;
  const remitPartSourceKey = { street: 'remitStreet', city: 'remitCity', state: 'remitState', zip: 'remitZip' } as const;
  const remitFields = (['street', 'city', 'state', 'zip'] as const).map((part) => {
    const value = remitToVerified ? remitToVerified[part] : str(remitTo[part]);
    return {
      key: `remitTo.${part}`,
      label: part === 'zip' ? 'ZIP code' : part[0]!.toUpperCase() + part.slice(1),
      value,
      // Judge the value we are actually SHOWING. When these boxes fall back to
      // the letterhead address, the model's remitTo confidence is about a
      // remit-to panel that is not on the document — it hedges at 0.8 for the
      // absence, and every bill came up amber for a value it had read cleanly.
      // "We could not read this" and "this section does not exist" are
      // different statements, and only one of them is the reader's problem.
      ...fieldState({ key: pickAddressConfidenceKey(usedVendorAddress), value, fieldConfidence, confirmedKeys }),
      source: usedVendorAddress
        ? sourceOf('vendorAddress')
        : sourceOf(remitPartSourceKey[part]) ?? sourceOf('remitTo'),
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
  // A suggestion made before per-line coding existed has no `lines` key at all.
  // Those bills would otherwise keep the one-account-for-everything answer for
  // the rest of their draft life, since the refresh below only ever fired when
  // QuickBooks arrived. Asking once fixes them; the answer is written back with
  // a `lines` array either way, so it is asked once and not on every view.
  const missingLineCoding = ocrCoding != null && !Array.isArray(ocrCoding.lines);
  const chartArrived = chart.length > 0 && metadata.ocrCodingChart !== 'quickbooks';
  if (order.state === 'draft' && (chartArrived || missingLineCoding)) {
    const top = ocrCoding && Array.isArray(ocrCoding.suggestions) && isRecord(ocrCoding.suggestions[0])
      ? (ocrCoding.suggestions[0] as Record<string, unknown>)
      : null;
    const stale = missingLineCoding
      || !top
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
        // Always leave a `lines` key behind, even when the model was
        // unavailable and there is nothing to put in it. Without one the
        // "never asked" test above stays true and every view of this draft
        // asks again.
        const settled = (fresh ?? ocrCoding) as Record<string, unknown> | null;
        await prisma.paymentOrder.update({
          where: { paymentOrderId: order.paymentOrderId },
          data: {
            metadataJson: {
              ...metadata,
              ocrCoding: settled ? { lines: [], ...settled } : { categoryHint: null, rationale: null, suggestions: [], lines: [] },
              // Only claim the suggestion came from the real chart when it did.
              ...(chartArrived ? { ocrCodingChart: 'quickbooks' } : {}),
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        logger.warn('bill_draft.suggestion_refresh_failed', {
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
      // (testbench 007: the Vendors page promised a default the draft
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
  // Each line carries its own category when the document supports one.
  //
  // Every line used to inherit ONE bill-level suggestion, so an invoice with
  // ocean freight and a documentation fee coded both as freight — the second
  // line was never classified at all, it just inherited. categoryHint is
  // explicitly "what this INVOICE is for", which is the wrong question to ask
  // of a line.
  //
  // The bill-level suggestion is still the fallback, and a vendor RULE still
  // outranks everything: a rule is somebody's stated decision about this
  // vendor, and a per-line guess must not quietly overturn it.
  // What the model said about THIS line, by position. This is the only signal
  // here that was actually formed by looking at the line; the hint below is
  // prose off the document, and the bill-level suggestion is about the invoice
  // as a whole. Resolved against the picker's vocabulary like everything else,
  // because an account the picker cannot offer is not a suggestion.
  const modelLines = ocrCoding && Array.isArray(ocrCoding.lines)
    ? (ocrCoding.lines as Array<{ index?: unknown; accountName?: unknown }>)
    : [];
  const resolveModelLine = (index: number): string | null => {
    const hit = modelLines.find((l) => Number(l.index) === index);
    const name = hit ? str(hit.accountName) : null;
    if (!name) return null;
    const account = chart.find((a) => a.name === name || a.fullyQualifiedName === name);
    if (chart.length > 0) return account?.fullyQualifiedName ?? (chartNames.has(name) ? name : null);
    return categoryOptions.some((o) => o.value === name) ? name : null;
  };

  const resolveLineCategory = (hint: string | null): string | null => {
    // A vendor rule is the DEFAULT, not an override. It says "bills from this
    // vendor usually code to X", which is true of the bill and not necessarily
    // of every line on it — the travel line of a security-audit invoice is
    // still travel. A hint the picker recognises is specific evidence about
    // THIS line and wins; anything else falls back to the rule.
    if (!hint) return codingSuggestion;
    const match = categoryOptions.find((o) => o.value.toLowerCase() === hint.toLowerCase())
      ?? categoryOptions.find((o) => o.value.toLowerCase().includes(hint.toLowerCase()))
      ?? categoryOptions.find((o) => hint.toLowerCase().includes(o.value.toLowerCase()));
    return match?.value ?? codingSuggestion;
  };
  const proposedLines = extractedLines.filter(isRecord).map((line, i) => ({
    description: str(line.description) ?? '',
    quantity: num(line.quantity),
    unitPrice: num(line.unitPrice),
    amount: num(line.total),
    // The model's own reading of this line first; the document hint and the
    // bill-level guess are the fallbacks they always were.
    category: resolveModelLine(i) ?? resolveLineCategory(str(line.categoryHint)),
    source: lineSource(line),
  }));
  const lines = verifiedLines ?? proposedLines;

  // Remember the categories this screen is about to propose.
  //
  // Same rule the field corrections above already follow: "what was read" has
  // to mean what the DRAFT SCREEN SHOWED. For fields the raw extraction is
  // close enough to serve as that baseline; for categories it is not, because
  // the machine's per-line output is a document hint ("Analytics services")
  // and what the picker offers is a GL account ("Contractors"). Diffing those
  // two marks every bill edited and can say nothing about which line changed.
  //
  // Once a bill is confirmed the proposal is gone — verifiedLines replaces it —
  // so it has to be written down while it still exists. Recomputed on read
  // like the OCR coding above, and only written when it actually moved.
  if (!verifiedLines && proposedLines.length > 0) {
    const proposed = proposedLines.map((l, i) => ({ index: i, description: l.description, category: l.category ?? null }));
    const stored = metadata.proposedLineCategories;
    if (JSON.stringify(stored ?? null) !== JSON.stringify(proposed)) {
      await prisma.paymentOrder.update({
        where: { paymentOrderId: order.paymentOrderId },
        data: {
          metadataJson: { ...metadata, proposedLineCategories: proposed } as unknown as Prisma.InputJsonValue,
        },
      }).catch(() => { /* a baseline is worth having, never worth failing the read for */ });
    }
  }

  const taxAmount = verifiedFields && 'taxAmount' in verifiedFields ? num(verifiedFields.taxAmount) : num(extracted.taxAmount);

  // Flags: every reason to pause, from the one module that defines them
  // (bill-flags.ts). This screen and the workbench call the SAME evaluator, so
  // they cannot disagree about whether a bill is safe.
  const [ceilingMinor, duplicates] = await Promise.all([
    getBillCeilingMinor(prisma, organizationId),
    findDuplicateBills(organizationId, {
      excludePaymentOrderId: order.paymentOrderId,
      counterpartyId: order.counterpartyId,
      counterpartyWalletId: order.counterpartyWalletId,
      invoiceNumber: (verifiedFields ? str(verifiedFields.invoiceNumber) : null) ?? str(extracted.invoiceNumber) ?? order.invoiceNumber,
      amountRaw: order.amountRaw,
      createdAt: order.createdAt,
    }),
  ]);
  // A document that is not an invoice, and what it means against our records.
  // The classification is the model's; the reconciliation is a join.
  const declaredKind = str(extracted.documentKind);
  const notABillKind = declaredKind && declaredKind !== 'invoice' ? declaredKind : null;
  const statementRows = Array.isArray(extracted.statementRows)
    ? (extracted.statementRows as unknown[]).filter(isRecord)
    : [];
  const reconciliation = notABillKind === 'statement' && statementRows.length > 0
    ? await (await import('./document-reconcile.js')).reconcileStatement({
      organizationId,
      excludePaymentOrderId: order.paymentOrderId,
      counterpartyId: order.counterpartyId,
      rows: statementRows.map((r) => ({
        reference: str(r.reference),
        date: str(r.date),
        amount: num(r.amount),
        status: str(r.status),
      })),
    })
    : null;

  const flagOrg = await prisma.organization.findUniqueOrThrow({
    where: { organizationId },
    select: { organizationName: true, tradingNames: true },
  });
  const flags = evaluateBillFlags({
    vendorName: order.counterparty?.displayName ?? order.counterpartyWallet.label,
    organizationName: displayOrgName(flagOrg.organizationName),
    tradingNames: readTradingNames(flagOrg.tradingNames),
    amountRaw: order.amountRaw,
    billToName: str(extracted.billToName),
    triggeredRules: triggeredRules.map((r) => str(r.rule)).filter((r): r is string => Boolean(r)),
    vendorHold: order.counterparty ? readPayableHold(order.counterparty.metadataJson) : null,
    ceilingMinor,
    duplicates,
    duplicateOverride: readDuplicateOverride(metadata),
    shortPay: readShortPay(metadata),
    amounts: documentAmounts(extracted, verification),
    planAlerts: (await planAlertsByOrder(organizationId, [order.paymentOrderId])).get(order.paymentOrderId) ?? [],
    documentType: documentTypeSignals(extracted, order.invoiceNumber),
  });

  const sentBackRaw = isRecord(metadata.sentBack) ? metadata.sentBack : null;
  return {
    paymentOrderId: order.paymentOrderId,
    // Named so a resolution can ask a real question — "is Halcyon Labs a name
    // Decimal Labs trades under?" rather than "your organization".
    organizationName: displayOrgName(flagOrg.organizationName),
    // The thread, for BOTH people. A recorded question nothing reads back is
    // worse than none: the asker believes they raised something and the person
    // asked never learns they were asked.
    route: await approvalRouteFor(organizationId, order.paymentOrderId),
    // What has been done to this bill so far. Kept since the beginning, shown
    // only after confirm until now — so the phase in which somebody is
    // actually changing things was the one phase with no record on screen.
    workLog: await billWorkLog(organizationId, order.paymentOrderId),
    questions: (await listBillQuestions(organizationId, order.paymentOrderId)).map((q) => ({
      ...q,
      // Whose move it is, decided here rather than by the client comparing ids.
      youWereAsked: Boolean(viewerUserId && q.askedOfUserId === viewerUserId && !q.answeredAt),
      // A handed-back question is still open work for the ASKER — it came back
      // unresolved, so it must not look settled on their screen.
      stillOpen: q.outcome !== 'answered' && q.outcome !== 'forwarded',
      // What is still wanted: the asked fields minus anything already settled.
      // A partial answer must stop highlighting what it DID resolve, or the
      // next person cannot tell which half is left.
      openFields: q.highlightFields.filter((f) => !q.resolvedFields.includes(f)),
      youAsked: Boolean(viewerUserId && q.askedByUserId === viewerUserId),
    })),
    state: order.state,
    // Two different reasons a bill cannot be edited, and the screen needs both.
    //
    // The bill's own stage is one: a bill that has left draft is settled.
    // The reader's standing is the other, and it was missing — every field on
    // a draft was editable by anyone who could open it. Bringing a bill IN is
    // deliberately open to everyone but a Viewer (bills.create); PREPARING one
    // is the clerk's job (bills.edit), and the capability middleware has always
    // refused the save. So an approver who uploaded an invoice got a form that
    // typed, and lost the lot on navigating away.
    readOnly: order.state !== 'draft' || !viewerCanEdit,
    // Which of the two, so the screen can say something true rather than
    // greying out fields for no stated reason.
    readOnlyReason: order.state !== 'draft'
      ? 'settled' as const
      : (!viewerCanEdit ? 'not_your_job' as const : null),
    ...billSource(order.metadataJson, order.createdByUser?.displayName ?? null),
    // Present only when the document is not an invoice. The screen switches on
    // this rather than on whether a flag happens to be blocking: what a
    // document IS should pick the interface, not what it tripped.
    notABill: notABillKind
      ? {
        kind: notABillKind,
        appliesToInvoice: str(extracted.appliesToInvoice),
        statement: reconciliation,
      }
      : null,
    // An approver sent this bill back for changes — the bill clerk's homework.
    sentBack: sentBackRaw && order.state === 'draft'
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
        && !flags.some((f) => f.kind === 'payee_mismatch'),
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

// -----------------------------------------------------------------------------
// Confirm & send for approval — the one commit (spec §6)
// -----------------------------------------------------------------------------

/**
 * Fields a person changed from what the screen first showed them.
 *
 * Shared by confirm and by save, so a correction made while a bill is still
 * being worked reads the same as one made at the moment of confirming, and
 * saving twice does not record the same change twice.
 */
export function billFieldCorrections(
  extracted: Record<string, unknown>,
  fields: Record<string, unknown>,
  /**
   * Whoever made the change. Confirm used to leave this off and let the screen
   * fall back to the confirmer, which was close enough while confirming was the
   * only way to record anything. A saved draft has no confirmer, so the trail
   * read "changed by nobody" — and attributing each correction to the person
   * who actually made it is the more honest answer for both paths anyway.
   */
  byUserId?: string | null,
): Array<{ field: string; readValue: unknown; correctedValue: unknown; byUserId?: string | null }> {
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
    // The draft screen renders 0 when the document carries no tax line.
    taxAmount: num(extracted.taxAmount) ?? 0,
  };
  const out: Array<{ field: string; readValue: unknown; correctedValue: unknown; byUserId?: string | null }> = [];
  for (const [key, readValue] of Object.entries(readValues)) {
    if (!(key in fields)) continue;
    const corrected = (fields as Record<string, unknown>)[key] ?? null;
    if (corrected !== (readValue ?? null)) {
      out.push({ field: key, readValue: readValue ?? null, correctedValue: corrected, ...(byUserId ? { byUserId } : {}) });
    }
  }
  return out;
}

export type SubmitBillInput = {
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

export async function submitBillForApproval(input: SubmitBillInput) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId: input.organizationId, paymentOrderId: input.paymentOrderId },
    include: { counterpartyWallet: true, counterparty: true, transferRequests: true },
  });
  if (!order) throw new Error('Bill not found');
  if (order.state !== 'draft') {
    throw new Error(`This bill is ${order.state} — it has already left verification.`);
  }
  // Payable gate, re-checked at the moment of commitment (the vendor may have
  // been held while this draft sat open).
  const confirmHold = order.counterparty ? readPayableHold(order.counterparty.metadataJson) : null;
  if (confirmHold) {
    throw new Error(describePayableHold(order.counterparty?.displayName ?? order.counterpartyWallet.label, confirmHold));
  }
  // Org ceiling, same re-check (and against the CONFIRMED total, below).
  const confirmCeiling = await getBillCeilingMinor(prisma, input.organizationId);

  // Judge what is being submitted, not what was last written down.
  //
  // This read the STORED bill, so correcting the figures on screen and pressing
  // Confirm without saving first was refused — by a flag computed from numbers
  // that were no longer on the screen, quoting those numbers back. The only way
  // through was to save and then confirm, which nothing told anyone.
  //
  // The submitted body IS the bill at this moment: it is what the rest of this
  // function is about to commit. Gating on anything else means gating on a
  // different bill from the one being approved.
  const blocking = (await flagsForOrder(input.organizationId, input.paymentOrderId, {
    verification: { fields: input.fields, lines: input.lines },
  })).filter((f) => f.blocking);
  if (blocking.length > 0) {
    throw new Error(`Resolve the flagged issue first: ${blocking[0]!.message}`);
  }

  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const agent = isRecord(metadata.agent) ? metadata.agent : {};
  const extracted = isRecord(agent.extracted) ? agent.extracted : {};

  // Correction memory (spec §4): every field where the confirmed value differs
  // from what was read.
  //
  // "What was read" has to mean what the DRAFT SCREEN SHOWED, not the raw
  // extraction, or every default the form fills in is logged as a human
  // correction with that human's name on it. Tax is the case that exposed it:
  // the screen shows 0 when the document has no tax line, the extraction says
  // null, and confirming recorded "read as not on document -> 0, Omar
  // corrected it" for a field Omar never touched.
  //
  // That is worse than a cosmetic slip. This trail is the reason an approver
  // can trust the figures — it claims a person stands behind them — and a
  // false entry in it is a false attribution to a named colleague.
  //
  // Currency already did the right thing (?? 'USD' below, matching the form's
  // default). Every value here must line up with what the screen renders.
  const corrections: Array<{ field: string; readValue: unknown; correctedValue: unknown }> = [];
  corrections.push(...billFieldCorrections(extracted, input.fields, input.actorUserId));

  // A category the operator changed is a correction, and belongs in the trail
  // beside the others.
  //
  // Coding is a judgement an approver is being asked to trust, and until now a
  // line that a person deliberately recoded looked exactly like one the machine
  // got right: BW-2201's analytics retainer read "Contractors" on the bill with
  // nothing anywhere saying the machine had proposed advertising and a human
  // disagreed. The person who made the call got no credit and the approver got
  // no warning.
  const proposedLines = Array.isArray(metadata.proposedLineCategories)
    ? (metadata.proposedLineCategories as Array<{ index?: number; description?: string; category?: string | null }>)
    : [];
  for (const [i, line] of input.lines.entries()) {
    const was = proposedLines.find((p) => p.index === i);
    if (!was) continue;
    const before = was.category ?? null;
    const after = line.category ?? null;
    if (before === after) continue;
    corrections.push({
      // Named by the line it is about — "Category" alone, three times over,
      // tells the reader nothing about which line moved.
      field: `Category — ${line.description.trim() || was.description || `line ${i + 1}`}`,
      readValue: before,
      correctedValue: after,
    });
  }

  // What the operator kept, per line. 'edited' whenever any line's category
  // differs from what we proposed — the delta is the only thing that says which
  // KIND of line we get wrong, which a bill-level accept/reject cannot show.
  try {
    const { logSuggestionOutcome } = await import('./suggestion-log.js');
    const lineSuggestion = await prisma.aiSuggestion.findFirst({
      where: { organizationId: input.organizationId, stage: 'gl_coding', subjectType: 'payment_order_lines', subjectId: input.paymentOrderId },
      orderBy: { createdAt: 'desc' },
      select: { aiSuggestionId: true, suggested: true },
    });
    if (lineSuggestion) {
      const chosen = input.lines.map((l, i) => ({ index: i, category: l.category ?? null }));
      // Measured against what the screen proposed, not against the raw
      // document hint. The hint is prose off the invoice ("Analytics
      // services") and the choice is a GL account ("Contractors"), so
      // comparing them reported every bill as edited and the number meant
      // nothing. proposedLineCategories is the same baseline the corrections
      // above use, so the measurement and the audit trail agree.
      const changed = chosen.some((c) => {
        const p = proposedLines.find((x) => x.index === c.index);
        return p ? (p.category ?? null) !== c.category : false;
      });
      await logSuggestionOutcome({
        aiSuggestionId: lineSuggestion.aiSuggestionId,
        outcome: changed ? 'edited' : 'accepted',
        finalValue: chosen,
        decidedByUserId: input.actorUserId,
      });
    }
  } catch {
    // Never block a confirm to record a measurement.
  }

  // The confirm path recorded corrections with no user at all — the one moment
  // a person accepts responsibility for what the machine read, and the trail did
  // not say who. It does now.
  await recordFieldChanges({
    organizationId: input.organizationId,
    paymentOrderId: order.paymentOrderId,
    changedByUserId: input.actorUserId,
    phase: 'draft',
    reason: 'confirm',
    changes: corrections.map((c) => {
      const r = c as { field: string; readValue: unknown; correctedValue: unknown };
      return { field: r.field, from: r.readValue, to: r.correctedValue };
    }),
  });

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
  // Re-run the duplicate gate against the CONFIRMED values — the bill clerk may
  // have just edited the invoice number or total, and the draft-time flag
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

  // Marks it submitted, trusts the wallet (the operator just verified the document's
  // payment details — the R7 payment-method ceremony replaces this later), and
  // emits the submitted event.
  await markBillSubmitted({
    organizationId: input.organizationId,
    paymentOrderId: input.paymentOrderId,
    actorUserId: input.actorUserId,
    actorType: 'user',
    submitNote: 'Confirmed on the draft screen',
  });

  // Confirm is the door into the approval engine, and the only one.
  //
  // Intake used to submit as well, which meant routing was compiled on figures
  // nobody had checked and then recompiled here. Now a bill routes once, on
  // data a person has settled — which is what every AP product checked does,
  // and what this file's own header always claimed.
  //
  // The recompile path below still exists because it is genuinely needed: a
  // bill sent back for changes is re-confirmed, and a bill can be confirmed
  // twice. When an approvable is already there, push the corrected facts onto
  // it rather than creating a second one, which would leave two competing
  // plans for one bill.
  let approvableId: string | null = null;
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
  // What verification established. Intake could not know any of it, so it must
  // reach the approvable whichever path below runs — the pinned destination
  // especially: approvers authorize paying THIS address, and the release gate
  // refuses if the vendor's rail changes afterwards.
  const verifiedAttributes = {
    paymentOrderId: input.paymentOrderId,
    inputSource: 'invoice_upload',
    approvedDestination: {
      counterpartyWalletId: order.counterpartyWalletId,
      walletAddress: order.counterpartyWallet.walletAddress,
    },
    vendor_is_first_invoice: priorCount === 0,
    ...(lineCategories.length ? { categories: lineCategories } : {}),
    ...(verification.noteForApprovers ? { noteForApprovers: verification.noteForApprovers } : {}),
  };

  const existing = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM approval.approvables
    WHERE organization_id = ${input.organizationId}::uuid
      AND type = 'invoice'
      AND macro_state NOT IN ('rejected', 'cancelled')
      AND attributes->>'paymentOrderId' = ${input.paymentOrderId}
    ORDER BY id LIMIT 1`;
  if (existing.length > 0) {
    approvableId = existing[0]!.id;
    try {
      // Always applied, not only when the amount moved: the destination and
      // categories are set here for the first time. With no decisions yet this
      // is a silent recompile; if someone already approved, routing restarts,
      // which is the correct loud behaviour.
      const { applyMaterialChange } = await import('../approvals/lifecycle.js');
      await applyMaterialChange(approvableId, {
        totalMinorBase: confirmedAmountRaw,
        vendorId: order.counterpartyId ?? null,
        attributes: verifiedAttributes,
      });
    } catch (error) {
      logger.warn('bill_confirm.material_change_failed', {
        organizationId: input.organizationId,
        paymentOrderId: input.paymentOrderId,
        ...(error instanceof Error ? { message: error.message } : {}),
      });
    }
  }

  // The normal path: this bill has never been routed, so route it now.
  if (!approvableId) try {
    const { submitInvoiceForApproval } = await import('../approvals/wiring.js');
    const submitted = await submitInvoiceForApproval({
      organizationId: input.organizationId,
      requesterUserId: input.actorUserId,
      totalMinorBase: confirmedAmountRaw,
      vendorId: order.counterpartyId,
      attributes: verifiedAttributes,
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
  if (order.state !== 'draft' && order.state !== 'submitted') {
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
/**
 * Record a name this organization also answers to, clearing the
 * addressed_elsewhere flag for it from now on.
 *
 * Owner/admin only, and the restriction is the point. This is not a judgement
 * about one invoice — it permanently changes what the organization answers to
 * for every future bill, which is an identity claim. An approver who
 * recognizes the name asks for it; an admin decides it.
 *
 * Additive and idempotent: adding a name already on file is a no-op rather
 * than a duplicate, so a second click cannot corrupt the list.
 */
export async function addOrganizationTradingName(args: {
  organizationId: string;
  name: string;
  actorUserId: string;
  actorName: string;
  fromPaymentOrderId?: string | null;
}) {
  const name = args.name.trim();
  if (!name) throw new Error('A trading name cannot be blank.');

  const { getOrganizationMembership, isAdminRole } = await import('../auth/organization-access.js');
  const membership = await getOrganizationMembership(args.actorUserId, args.organizationId);
  // isAdminRole covers the owner too — one vocabulary, rather than this file
  // inventing its own idea of who counts as an admin.
  if (!isAdminRole(membership?.role)) {
    throw new Error('Only an owner or admin can record a name your organization trades under.');
  }

  const org = await prisma.organization.findUniqueOrThrow({
    where: { organizationId: args.organizationId },
    select: { tradingNames: true },
  });
  const existing = Array.isArray(org.tradingNames) ? (org.tradingNames as unknown[]) : [];
  if (readTradingNames(existing).some((n) => n.toLowerCase() === name.toLowerCase())) {
    return { added: false, tradingNames: readTradingNames(existing) };
  }

  // Who claimed this, and off which bill. An identity claim should say who made it.
  const entry = {
    name,
    addedByUserId: args.actorUserId,
    addedByName: args.actorName,
    addedAt: new Date().toISOString(),
    fromPaymentOrderId: args.fromPaymentOrderId ?? null,
  };
  const updated = await prisma.organization.update({
    where: { organizationId: args.organizationId },
    data: { tradingNames: [...existing, entry] as never },
    select: { tradingNames: true },
  });
  return { added: true, tradingNames: readTradingNames(updated.tradingNames) };
}

/**
 * Who this person could ask about this bill — every other active member, with
 * the history that makes the list meaningful rather than alphabetical.
 *
 * `answered` / `asked` is the beginning of routing: someone asked eight times
 * who answered eight times is a different proposition from someone asked once.
 * Nothing suggests yet; this only reports what happened, so a suggestion can
 * later be built on evidence instead of a guess.
 */
/**
 * Questions asked about a bill, newest first, with both people named.
 *
 * Recorded questions that nothing reads back are worse than no questions: the
 * asker believes they have raised something and the person asked never learns
 * they were asked. This is what puts the thread on the bill for both of them.
 */
export async function listBillQuestions(organizationId: string, paymentOrderId: string) {
  const rows = await prisma.billQuestion.findMany({
    where: { organizationId, paymentOrderId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.flatMap((r) => [r.askedByUserId, r.askedOfUserId]))];
  const users = await prisma.user.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, displayName: true },
  });
  const nameOf = new Map(users.map((u) => [u.userId, u.displayName]));
  return rows.map((r) => ({
    billQuestionId: r.billQuestionId,
    question: r.question,
    aboutFlag: r.aboutFlag,
    highlightFields: Array.isArray(r.highlightFields) ? (r.highlightFields as string[]) : [],
    askedByUserId: r.askedByUserId,
    askedByName: nameOf.get(r.askedByUserId) ?? 'Someone',
    askedOfUserId: r.askedOfUserId,
    askedOfName: nameOf.get(r.askedOfUserId) ?? 'Someone',
    answer: r.answer,
    outcome: r.outcome as 'answered' | 'partial' | 'handed_back' | 'forwarded' | null,
    resolvedFields: Array.isArray(r.resolvedFields) ? (r.resolvedFields as string[]) : [],
    forwardedFromQuestionId: r.forwardedFromQuestionId,
    answeredAt: r.answeredAt?.toISOString() ?? null,
    askedAt: r.createdAt.toISOString(),
  }));
}

/**
 * Answer a question someone asked you about a bill.
 *
 * Only the person asked may answer — an answer from anyone else is not the
 * thing the asker is waiting on. Un-parks the engine task when one is attached,
 * so the bill resumes instead of sitting answered-but-still-waiting.
 */
export async function answerBillQuestion(args: {
  organizationId: string;
  billQuestionId: string;
  answererUserId: string;
  answer: string;
  /**
   * Did this actually resolve what was asked?
   *
   * 'answered' means the person confirmed or corrected what the asker wanted.
   * 'handed_back' is a real and useful reply that does NOT resolve it — "I
   * don't know", "ask procurement". Both are legitimate; conflating them is
   * not. Treating a hand-back as an answer closes the asker's concern without
   * touching it, which manufactures confidence nobody earned.
   */
  outcome: 'answered' | 'partial' | 'handed_back' | 'forwarded';
  /** Which of the asked fields this reply settled. Empty for a hand-back. */
  resolvedFields?: string[] | null;
  /** When forwarding: who now gets asked, and what. */
  forwardTo?: { userId: string; question: string } | null;
}) {
  const answer = args.answer.trim();
  if (answer.length < 1) throw new Error('Write an answer.');
  const question = await prisma.billQuestion.findFirst({
    where: { billQuestionId: args.billQuestionId, organizationId: args.organizationId },
  });
  if (!question) throw new Error('Question not found');
  if (question.askedOfUserId !== args.answererUserId) {
    throw new Error('Only the person who was asked can answer this.');
  }
  if (question.answeredAt) throw new Error('That question has already been answered.');

  // Only a COMPLETE answer un-parks the bill. Partial, handed back and
  // forwarded all leave it waiting, because some of what the asker wanted is
  // still outstanding — and a bill that resumes on a half-answer is exactly the
  // false confidence this whole distinction exists to prevent.
  if (question.taskId && args.outcome === 'answered') {
    try {
      const { executeCommand } = await import('../approvals/lifecycle.js');
      const person = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM approval.people
        WHERE organization_id = ${args.organizationId}::uuid AND user_id = ${args.answererUserId}::uuid LIMIT 1`;
      if (person[0]) {
        await executeCommand({
          taskId: question.taskId,
          actorId: person[0].id,
          idempotencyKey: `answer:${args.billQuestionId}`,
          command: { kind: 'provide_info', answer } as never,
        });
      }
    } catch (error) {
      logger.warn('bill_answer.resume_failed', {
        organizationId: args.organizationId,
        billQuestionId: args.billQuestionId,
        ...(error instanceof Error ? { message: error.message } : {}),
      });
    }
  }

  // Forwarding raises a NEW question to the next person, linked both ways so a
  // chain reads end to end. It carries the fields still outstanding, not the
  // original list — passing along what someone already settled would have the
  // next person redo it.
  let forwardedToQuestionId: string | null = null;
  if (args.outcome === 'forwarded' && args.forwardTo) {
    const settled = new Set(args.resolvedFields ?? []);
    const stillOpen = (Array.isArray(question.highlightFields) ? (question.highlightFields as string[]) : [])
      .filter((f) => !settled.has(f));
    const next = await askAboutBill({
      organizationId: args.organizationId,
      paymentOrderId: question.paymentOrderId,
      askedByUserId: args.answererUserId,
      askedOfUserId: args.forwardTo.userId,
      question: args.forwardTo.question,
      aboutFlag: question.aboutFlag,
      highlightFields: stillOpen,
    });
    forwardedToQuestionId = next.billQuestionId;
    await prisma.billQuestion.update({
      where: { billQuestionId: next.billQuestionId },
      data: { forwardedFromQuestionId: args.billQuestionId },
    });
  }

  return prisma.billQuestion.update({
    where: { billQuestionId: args.billQuestionId },
    data: {
      answer,
      answeredAt: new Date(),
      outcome: args.outcome,
      resolvedFields: args.resolvedFields ?? [],
      ...(forwardedToQuestionId ? { forwardedToQuestionId } : {}),
    },
  });
}

export async function listAskCandidates(organizationId: string, viewerUserId: string) {
  const members = await prisma.organizationMembership.findMany({
    where: { organizationId, status: 'active', userId: { not: viewerUserId } },
    select: { userId: true, role: true, user: { select: { displayName: true, email: true } } },
  });
  const history = await prisma.billQuestion.groupBy({
    by: ['askedOfUserId'],
    where: { organizationId },
    _count: { _all: true },
  });
  const answered = await prisma.billQuestion.groupBy({
    by: ['askedOfUserId'],
    where: { organizationId, answeredAt: { not: null } },
    _count: { _all: true },
  });
  const askedBy = new Map(history.map((h) => [h.askedOfUserId, h._count._all]));
  const answeredBy = new Map(answered.map((h) => [h.askedOfUserId, h._count._all]));

  return members
    .map((m) => ({
      userId: m.userId,
      name: m.user.displayName,
      email: m.user.email,
      role: m.role,
      asked: askedBy.get(m.userId) ?? 0,
      answered: answeredBy.get(m.userId) ?? 0,
    }))
    // Most-answered first: the person who actually replies is the useful
    // default, not the one who happens to sort first by name.
    .sort((a, b) => b.answered - a.answered || b.asked - a.asked || a.name.localeCompare(b.name));
}

/**
 * Ask a colleague about a bill.
 *
 * Two things happen together and must not drift apart: the engine parks the
 * bill on the question (request_info), and we record who was asked about what.
 * The park is what stops the bill moving; the record is what teaches routing.
 *
 * Available to anyone. Asking is never the dangerous act, so it must never be
 * the thing an approver lacks the standing to do.
 */
export async function askAboutBill(args: {
  organizationId: string;
  paymentOrderId: string;
  askedByUserId: string;
  askedOfUserId: string;
  question: string;
  aboutFlag?: string | null;
  /**
   * The fields the ASKER confirmed they want filled.
   *
   * Suggested by the model, then shown to the asker before sending. Passing
   * them explicitly is what makes the highlight trustworthy: person B is
   * pointed at fields a human agreed to, not at a mapping nobody saw. Omitted
   * (API callers, older clients) falls back to the suggestion.
   */
  highlightFields?: string[] | null;
}) {
  const question = args.question.trim();
  if (question.length < 3) throw new Error('Say what you want to know.');

  const target = await prisma.organizationMembership.findFirst({
    where: { organizationId: args.organizationId, userId: args.askedOfUserId, status: 'active' },
  });
  if (!target) throw new Error('That person is not an active member of this organization.');

  // Park the bill via the engine when it has a live task, so the question
  // behaves like every other pause: it reminds, it escalates, it never
  // auto-denies. Best-effort — a recorded question with no park is still far
  // better than a park with no record of who was asked.
  let taskId: string | null = null;
  try {
    const [{ id }] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM approval.tasks t
      JOIN approval.approval_plans p ON p.id = t.plan_id
      JOIN approval.approvables a ON a.id = p.approvable_id
      WHERE a.organization_id = ${args.organizationId}::uuid
        AND a.attributes->>'paymentOrderId' = ${args.paymentOrderId}
        AND t.state IN ('open', 'info_requested')
      ORDER BY t.step_index LIMIT 1`;
    const { executeCommand } = await import('../approvals/lifecycle.js');
    const asker = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM approval.people
      WHERE organization_id = ${args.organizationId}::uuid AND user_id = ${args.askedByUserId}::uuid LIMIT 1`;
    const askedOf = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM approval.people
      WHERE organization_id = ${args.organizationId}::uuid AND user_id = ${args.askedOfUserId}::uuid LIMIT 1`;
    if (id && asker[0] && askedOf[0]) {
      await executeCommand({
        taskId: id,
        actorId: asker[0].id,
        idempotencyKey: `ask:${args.paymentOrderId}:${Date.now()}`,
        command: { kind: 'request_info', question, from: askedOf[0].id } as never,
      });
      taskId = id;
    }
  } catch (error) {
    logger.warn('bill_ask.park_failed', {
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }

  // Prefer what the asker confirmed; fall back to the suggestion only when a
  // caller did not go through the confirm step. Either way the closed
  // vocabulary is enforced, so a bad list cannot point anyone at a field that
  // does not exist.
  const { fieldsForQuestion, HIGHLIGHTABLE_FIELDS } = await import('./question-fields.js');
  const allowed = new Set<string>(HIGHLIGHTABLE_FIELDS);
  const highlightFields = args.highlightFields
    ? args.highlightFields.filter((f) => allowed.has(f))
    : await fieldsForQuestion(question);

  return prisma.billQuestion.create({
    data: {
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
      taskId,
      askedByUserId: args.askedByUserId,
      askedOfUserId: args.askedOfUserId,
      question,
      aboutFlag: args.aboutFlag ?? null,
      highlightFields,
    },
  });
}

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
  return getBillDraft(args.organizationId, args.paymentOrderId);
}

/**
 * Record the decision to pay what the bill itemises rather than what it prints.
 *
 * The other half of an invoice that disagrees with itself. "Correct the
 * figures" covers the case where the reading was wrong; this covers the case
 * where the document is. Short-paying to the itemised total and telling the
 * vendor is ordinary accounts-payable practice, and until now the only way to
 * express it was to retype the total — which reaches an approver looking
 * exactly like a fat finger.
 *
 * The reason is the product here. Changing the number is the easy part.
 */
export async function payItemisedTotal(args: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  actorName: string;
  reason: string;
}) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
    select: {
      paymentOrderId: true, state: true, metadataJson: true,
      transferRequests: { select: { transferRequestId: true }, take: 1 },
    },
  });
  if (!order) throw new Error('Bill not found');
  if (order.state !== 'draft') {
    throw new Error(`This bill is ${order.state} — its figures are settled.`);
  }

  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const extracted = extractedOf(order.metadataJson);
  const verification = isRecord(metadata.verification) ? metadata.verification : null;
  const amounts = documentAmounts(extracted, verification);

  if (amounts.lineItemsTotal === null) {
    throw new Error('The line items on this bill cannot be added up, so there is no itemised total to pay. Fill in the missing amounts first.');
  }
  const itemisedTotal = amounts.lineItemsTotal + (amounts.tax ?? 0);
  if (itemisedTotal <= 0) {
    throw new Error('The itemised total comes to nothing, which is not a bill to pay.');
  }
  if (amounts.total !== null && Math.abs(itemisedTotal - amounts.total) < 0.005) {
    throw new Error('The figures on this bill already agree — there is nothing to decide.');
  }

  const previousTotal = amounts.total;
  const fields = verification && isRecord(verification.fields) ? { ...verification.fields } : {};
  fields.total = itemisedTotal;

  // One instant for everything this action writes. The edit, the decision and
  // the flag it settles are one thing a person did; giving them three
  // timestamps milliseconds apart let them come back interleaved with each
  // other in an order nobody chose.
  const at = new Date();
  const shortPay = {
    byUserId: args.actorUserId,
    byName: args.actorName,
    reason: args.reason,
    itemisedTotal,
    documentTotal: previousTotal,
    at: at.toISOString(),
  };

  const flagsBefore = await flagsForOrder(args.organizationId, order.paymentOrderId);

  await prisma.$transaction([
    prisma.paymentOrder.update({
      where: { paymentOrderId: order.paymentOrderId },
      data: {
        // Nothing has been sent yet, but a bill already carrying a transfer
        // must not have its amount moved underneath it.
        amountRaw: order.transferRequests.length === 0
          ? BigInt(Math.round(itemisedTotal * 1_000_000))
          : undefined,
        metadataJson: {
          ...metadata,
          verification: { ...(verification ?? {}), fields },
          shortPay,
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
        payloadJson: {
          rule: 'pay_the_itemised_total',
          reason: args.reason,
          from: previousTotal,
          to: itemisedTotal,
        },
        createdAt: at,
      },
    }),
  ]);

  await recordFieldChanges({
    organizationId: args.organizationId,
    paymentOrderId: order.paymentOrderId,
    changedByUserId: args.actorUserId,
    phase: 'draft',
    reason: 'pay_the_itemised_total',
    changes: [{ field: 'total', from: previousTotal, to: itemisedTotal }],
    at,
  });

  await recordFlagChanges({
    organizationId: args.organizationId,
    paymentOrderId: order.paymentOrderId,
    actorUserId: args.actorUserId,
    before: flagsBefore,
    after: await flagsForOrder(args.organizationId, order.paymentOrderId),
    state: order.state,
    at,
  });

  return getBillDraft(args.organizationId, args.paymentOrderId, args.actorUserId);
}

// Send an already-APPROVED (but unpaid) bill back to draft — the recovery
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
  if (order.state !== 'submitted' || order.transferRequests.length > 0) {
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
        state: 'draft',
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
        beforeState: 'submitted',
        afterState: 'draft',
        payloadJson: { reason: args.reason, byName: args.actorName, afterApproval: true },
      },
    });
  });
  return getBillDraft(args.organizationId, args.paymentOrderId);
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

/**
 * Would this person's approval be refused, and why — asked BEFORE they press
 * anything.
 *
 * The engine re-checks separation of duties at decision time, which is right:
 * roles change mid-flight and a check done at routing time can be stale by the
 * time someone acts. But the only place that answer surfaced was a 409 on the
 * button, and the button was the sole thing the screen offered. A person who
 * submitted their own bill in a small org got "Separation-of-duties rule blocks
 * this action" after clicking Approve, with no indication of which rule, why it
 * applied to them, or what would change it.
 *
 * Same call the engine makes, run early. The engine still decides — this only
 * stops the UI offering an action it already knows will be refused.
 */
async function approvalBlockedFor(
  approvable: { id: string; organization_id: string } & Record<string, unknown>,
  personId: string | null,
  openTaskId: string | null,
): Promise<{ rule: string; why: string; remedy: string } | null> {
  if (!personId || !openTaskId) return null;
  const { vetoRule } = await import('../approvals/sod.js');
  const veto = await vetoRule(prisma, approvable as never, personId);
  if (!veto || veto.relaxed) return null;

  const WHY: Record<string, { why: string; remedy: string }> = {
    R1: {
      why: 'You submitted this bill, and your organization separates submitting from approving.',
      remedy: "An admin can turn that separation off on the Approval flow page if your team is too small for it, or add someone else to the flow. Either way it goes on the record.",
    },
    R2: {
      why: "You entered this bill's details, and your organization separates entering from approving.",
      remedy: 'An admin can turn that separation off on the Approval flow page, or add someone else to the flow.',
    },
    R7: {
      why: 'You asked for this payout detail change, so you cannot be the one who verifies it.',
      remedy: 'Someone else has to check it. This one cannot be turned off.',
    },
  };
  const copy = WHY[veto.rule] ?? {
    why: 'Your organization separates this decision from something else you already did on this bill.',
    remedy: 'An admin can review the separation settings on the Approval flow page.',
  };
  return { rule: veto.rule, ...copy };
}

export async function getBillDetail(organizationId: string, paymentOrderId: string, viewerUserId: string) {
  const billDraft = await getBillDraft(organizationId, paymentOrderId);
  if (!billDraft) return null;

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
  const approvables = await prisma.$queryRaw<{ id: string; macro_state: string; requester_id: string; organization_id: string; enterer_id: string | null; type: string; attributes: Record<string, unknown> | null }[]>`
    SELECT id, macro_state, requester_id, organization_id, enterer_id, type, attributes FROM approval.approvables
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
      draft: billDraft,
      corrections,
      recall: { open: null, history: [] },
      // A bill still in draft has a beginning even without an approval plan.
      history: await (await import('./bill-history.js')).billHistory({
        organizationId,
        paymentOrderId,
        approvableId: null,
        source: billDraft.source === 'email' ? 'email' : 'upload',
      }),
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
    /**
     * How many approvals this STEP needs — not how many people are on it.
     * An 'any' step lists two candidates and needs one of them; without this
     * the screen counts rows and reports two approvals required, which is a
     * different bill from the one the flow actually describes.
     */
    required: number;
    /** People invited to this step, so a screen can say "either of two". */
    candidates: number;
    state: 'done' | 'current' | 'upcoming' | 'declined' | 'stopped' | 'delegated' | 'skipped';
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
    const quorumM = isRecord(step.step) && typeof step.step.m === 'number' ? step.step.m : null;
    const candidates = step.approvers.length;
    // Same arithmetic settleStep uses to decide the step is done, so the screen
    // and the engine cannot disagree about what this bill needs.
    const required = mode === 'any' ? 1 : mode === 'quorum' ? (quorumM ?? 1) : candidates;
    // Once the step is satisfied the engine closes the siblings as obsolete.
    // They are not "not yet their turn" — they are never going to be asked.
    const approvedInStep = tasks.filter((t) => t.step_index === step.index && t.state === 'approved').length;
    const stepSatisfied = approvedInStep >= required;
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
        case 'obsolete':
          state = approvable.macro_state === 'rejected' || approvable.macro_state === 'cancelled'
            ? 'stopped'
            : stepSatisfied ? 'skipped' : 'upcoming';
          break;
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

      // An alternative who was never called on drops off the route entirely.
      //
      // On a satisfied "any" step the runner-up did nothing and is needed for
      // nothing, so a row for them says only that they exist — under a repeat
      // of the same routing reason, which is the noisiest way possible to say
      // it. The record does not depend on the row: the compiled plan keeps
      // every candidate forever, and the flow page says who was eligible.
      //
      // Unless they actually did something. Someone who asked a question
      // before the step settled is part of what happened to this bill, and
      // their thread stays whether or not their signature ended up mattering.
      if (state === 'skipped' && messages.length === 0) continue;

      nodes.push({
        stepIndex: step.index,
        person: personView(approver.personId),
        purpose: step.purpose,
        mode,
        required,
        candidates,
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
    vendorName: billDraft.vendor.name,
    history: await vendorHistory(organizationId, { counterpartyId: order.counterpartyId, counterpartyWalletId: order.counterpartyWalletId, paymentOrderId }),
    corrections,
  });

  // A frozen bill has to say so on the bill itself. The approvers looking at
  // it are the people whose work a grant would throw away, and finding that
  // out afterwards is how the mechanism loses their trust.
  const { billRecallState } = await import('./bill-recall.js');
  const recall = await billRecallState(organizationId, paymentOrderId);

  // The ends of the story the approval plan cannot tell: who brought the bill
  // in and who submitted it, and who releases the money once it is approved.
  const { billHistory } = await import('./bill-history.js');
  const history = await billHistory({
    organizationId,
    paymentOrderId,
    approvableId: approvable.id,
    source: billDraft.source === 'email' ? 'email' : 'upload',
  });

  return {
    draft: billDraft,
    corrections,
    signal,
    recall,
    history,
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
      cannotApprove: await approvalBlockedFor(approvable, viewerPerson?.id ?? null, viewerOpenTask?.id ?? null),
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
// trail the draft screen feeds. Material fields (total, currency, lines,
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

/**
 * Record field changes to the audit table.
 *
 * Best-effort by design: an audit write must never be the reason a person
 * cannot correct a bill. The trail is valuable, the edit is essential, and
 * inverting that would be the wrong trade — the `corrections` array on the bill
 * is still written either way, so nothing is lost outright if this fails.
 */
async function recordFieldChanges(args: {
  organizationId: string;
  paymentOrderId: string;
  changedByUserId: string | null;
  phase: 'draft' | 'approval';
  reason: string;
  /** Which request caused this, so a change can be explained after the fact. */
  correlationId?: string | null;
  /** A sweep must not look like a person. */
  actorType?: 'user' | 'system' | 'agent';
  changes: Array<{ field: string; key?: string; from: unknown; to: unknown }>;
  /** Stamp several writes from one action with one instant. */
  at?: Date;
}) {
  if (args.changes.length === 0) return;
  // Not every field is a scalar. The remit-to address arrives as an object, and
  // String() on it yields "[object Object]" — which is worse than recording
  // nothing, because it looks like a value somebody chose.
  const text = (v: unknown) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') {
      const parts = Object.values(v as Record<string, unknown>)
        .filter((x): x is string | number => typeof x === 'string' ? x.trim() !== '' : typeof x === 'number')
        .map(String);
      return parts.length > 0 ? parts.join(', ') : null;
    }
    return String(v);
  };
  try {
    // Callers hand us a change measured against what the DOCUMENT said, because
    // that is the comparison the correction blob wants. This table wants
    // something different: a chain of what actually happened, each link
    // starting where the last one ended.
    //
    // Told the same way, both a save and the confirm that follows it record
    // "tax 0 -> 820" — the same edit, twice, from two writers each measuring
    // from the original. Saving five times wrote it five times. It read as the
    // tax having been put back to nothing in between, which never happened.
    //
    // So: rebase each change onto the last value recorded for that field, and
    // drop the ones that turn out to say nothing. A repeat is not an event.
    const history = await prisma.billFieldChange.findMany({
      where: { organizationId: args.organizationId, paymentOrderId: args.paymentOrderId },
      orderBy: { changedAt: 'desc' },
      select: { fieldKey: true, newValue: true },
    });
    const lastRecorded = new Map<string, string | null>();
    for (const row of history) {
      if (!lastRecorded.has(row.fieldKey)) lastRecorded.set(row.fieldKey, row.newValue);
    }

    const links = args.changes
      .map((c) => {
        const fieldKey = c.key ?? c.field;
        return {
          fieldKey,
          previousValue: lastRecorded.has(fieldKey) ? lastRecorded.get(fieldKey)! : text(c.from),
          newValue: text(c.to),
        };
      })
      .filter((c) => c.previousValue !== c.newValue);
    if (links.length === 0) return;

    await prisma.billFieldChange.createMany({
      data: links.map((c) => ({
        organizationId: args.organizationId,
        paymentOrderId: args.paymentOrderId,
        fieldKey: c.fieldKey,
        previousValue: c.previousValue,
        newValue: c.newValue,
        changedByUserId: args.changedByUserId,
        phase: args.phase,
        reason: args.reason,
        correlationId: args.correlationId ?? null,
        actorType: args.actorType ?? (args.changedByUserId ? 'user' : 'system'),
        ...(args.at ? { changedAt: args.at } : {}),
      })),
    });
  } catch (error) {
    logger.warn('bill_field_changes.write_failed', {
      organizationId: args.organizationId,
      paymentOrderId: args.paymentOrderId,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }
}

export async function updateBillFacts(input: BillFactsInput) {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId: input.organizationId, paymentOrderId: input.paymentOrderId },
    select: { paymentOrderId: true, state: true, invoiceNumber: true, dueAt: true, metadataJson: true },
  });
  if (!order) throw new Error('Bill not found');
  if (order.state !== 'draft' && order.state !== 'submitted') {
    throw new Error(`This bill is ${order.state} — its details are settled.`);
  }

  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const verification = isRecord(metadata.verification) ? { ...metadata.verification } : {};
  const fields = isRecord(verification.fields) ? { ...verification.fields } : {};
  const corrections: unknown[] = Array.isArray(verification.corrections) ? [...verification.corrections] : [];

  const changes: Array<{ field: string; key?: string; from: unknown; to: unknown }> = [];
  const applyText = (key: keyof BillFactsInput['facts'] & string, label: string) => {
    const next = input.facts[key];
    if (next === undefined) return;
    const prev = (fields[key] as unknown) ?? null;
    const value = typeof next === 'string' ? (next.trim() || null) : next;
    if (value === prev) return;
    fields[key] = value;
    // The label is for the human-readable event; the KEY is what the audit
    // trail stores. A trail keyed on display text cannot be joined to the
    // review fields and fragments the moment anyone renames a label.
    changes.push({ field: label, key, from: prev, to: value });
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
      phase: order.state === 'submitted' ? 'approval' : 'draft',
      at: new Date().toISOString(),
    });
  }

  const dueDateInput = input.facts.dueDate;
  const nextDueAt = dueDateInput !== undefined && dueDateInput
    ? new Date(dueDateInput)
    : undefined;

  await recordFieldChanges({
    organizationId: input.organizationId,
    paymentOrderId: order.paymentOrderId,
    changedByUserId: input.actorUserId,
    phase: order.state === 'submitted' ? 'approval' : 'draft',
    reason: 'edit',
    changes,
  });

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


/**
 * Open questions put TO this person, with enough of each bill to know which one.
 *
 * Lifted out of the inbox because it is needed on both sides of the
 * engine-identity check: someone with no approval tasks can still have been
 * asked something, and that is precisely when they most need telling.
 */
async function questionsAskedOf(organizationId: string, viewerUserId: string) {
  const asked = await prisma.billQuestion.findMany({
    where: {
      organizationId,
      askedOfUserId: viewerUserId,
      OR: [{ answeredAt: null }, { outcome: { notIn: ['answered'] } }],
    },
    orderBy: { createdAt: 'asc' },
  });
  if (asked.length === 0) return [];

  const orders = await prisma.paymentOrder.findMany({
    where: { paymentOrderId: { in: [...new Set(asked.map((q) => q.paymentOrderId))] } },
    select: {
      paymentOrderId: true, amountRaw: true, invoiceNumber: true,
      counterparty: { select: { displayName: true } },
      counterpartyWallet: { select: { label: true } },
    },
  });
  const byOrder = new Map(orders.map((o) => [o.paymentOrderId, o]));
  const askers = await prisma.user.findMany({
    where: { userId: { in: [...new Set(asked.map((q) => q.askedByUserId))] } },
    select: { userId: true, displayName: true },
  });
  const askerName = new Map(askers.map((u) => [u.userId, u.displayName]));

  return asked
    .filter((q) => byOrder.has(q.paymentOrderId))
    .map((q) => {
      const order = byOrder.get(q.paymentOrderId)!;
      return {
        billQuestionId: q.billQuestionId,
        paymentOrderId: q.paymentOrderId,
        question: q.question,
        askedByName: askerName.get(q.askedByUserId) ?? 'Someone',
        askedAt: q.createdAt.toISOString(),
        vendorName: order.counterparty?.displayName ?? order.counterpartyWallet.label,
        invoiceNumber: order.invoiceNumber,
        amountUsd: amountRawToUsd(order.amountRaw),
      };
    });
}

export async function getApprovalsInbox(organizationId: string, viewerUserId: string) {
  const person = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM approval.people WHERE organization_id = ${organizationId}::uuid AND user_id = ${viewerUserId}::uuid LIMIT 1`;
  const personId = person[0]?.id ?? null;
  if (!personId) {
    // No engine identity — so no approval tasks, by definition. But questions
    // are not tasks: anyone can be asked about a bill, including someone who
    // will never approve one, and dropping their questions here was how a
    // person could be asked something they had no way of finding. Being asked
    // is the whole reason to open this screen for them.
    const questionsOnly = await questionsAskedOf(organizationId, viewerUserId);
    return {
      waitingOnYou: [],
      inFlight: [],
      questionsForYou: questionsOnly,
      summary: { flagCount: 0, cleanCount: 0, totalWaitingUsd: 0, questionCount: questionsOnly.length },
    };
  }

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
    // Grouped by STEP, because a step is the sequential unit and a person is
    // not: two people on one 'any' step come after each other in this array
    // while being alternatives to each other in the flow. Flattening them lost
    // that, and the inbox told the first approver "then Sam Okonkwo" about
    // somebody who was never going to follow them.
    return steps.map((step) => {
      const approvers = (Array.isArray(step.approvers) ? step.approvers : []) as Array<Record<string, unknown>>;
      const inner = isRecord(step.step) ? step.step : {};
      const mode = typeof inner.mode === 'string' ? inner.mode : 'all';
      const quorumM = typeof inner.m === 'number' ? inner.m : null;
      const required = mode === 'any' ? 1 : mode === 'quorum' ? (quorumM ?? 1) : approvers.length;
      return {
        index: Number(step.index),
        required,
        people: approvers.map((ap) => {
          const pid = String(ap.personId);
          const task = planTasks.find((t) => t.step_index === Number(step.index) && t.person_id === pid);
          return { personId: pid, state: task?.state ?? 'scheduled' };
        }),
      };
    });
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

    const chain = await buildChain(task.approvable_id);
    const myIndex = chain.findIndex((s) => s.people.some((p) => p.personId === personId));
    const total = chain.length;
    const doneNames = chain.flatMap((s) => s.people)
      .filter((p) => p.state === 'approved')
      .map((p) => nameOf.get(p.personId)?.split(' ')[0]).filter(Boolean);
    // Only people in LATER steps come after me. My own step's other members
    // are alternatives, and calling them "then" invents a queue.
    const afterMe = chain.slice(myIndex + 1).flatMap((s) => s.people)
      .map((p) => nameOf.get(p.personId)).filter(Boolean);
    const myStep = myIndex >= 0 ? chain[myIndex] : null;
    const alongsideMe = myStep && myStep.required < myStep.people.length
      ? myStep.people.filter((p) => p.personId !== personId)
          .map((p) => nameOf.get(p.personId)).filter(Boolean)
      : [];

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
      // Say it plainly when someone else can take this off your plate.
      if (alongsideMe.length) hintParts.push(`${alongsideMe.join(', ')} can approve instead`);
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
      const openNode = chain.flatMap((s) => s.people)
        .find((p) => p.state === 'open' || p.state === 'info_requested');
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

  // Questions asked OF you.
  //
  // These do not appear in the task query above and never could: request_info
  // parks the ASKER's task and names you only inside the command payload, so
  // there is no row anywhere that says "this is yours". A question that only
  // surfaces if somebody separately tells you to go and open that bill is not a
  // question the product asked on their behalf.
  const questionsForYou = await questionsAskedOf(organizationId, viewerUserId);

  return {
    waitingOnYou,
    inFlight,
    questionsForYou,
    summary: { flagCount, cleanCount, totalWaitingUsd, questionCount: questionsForYou.length },
  };
}

// -----------------------------------------------------------------------------
// Save the draft without sending it anywhere
// -----------------------------------------------------------------------------

/**
 * Keep what has been typed so far, and nothing else.
 *
 * Confirm was the only way to persist a draft, and confirm submits it for
 * approval. So a bill clerk who corrected a vendor's city, noticed the invoice
 * number needed checking with a colleague, and moved to another bill lost every
 * keystroke — the screen was rebuilt from the extraction on their return. The
 * expectation was that a bill is finished in one sitting, which is not how AP
 * is worked: several bills sit half-done while questions come back.
 *
 * Deliberately none of confirm's ceremony. No tier-1 completeness gate, because
 * a half-finished bill is exactly what this is for. No flag check, because a
 * blocked bill is precisely the one somebody is part-way through fixing. No
 * routing, no submitted event, no engine. It writes down what is on the screen.
 */
export async function saveBillDraft(input: {
  organizationId: string;
  paymentOrderId: string;
  actorUserId: string;
  fields: SubmitBillInput['fields'];
  lines: SubmitBillInput['lines'];
  confirmedFieldKeys?: string[];
  noteForApprovers?: string | null;
}): Promise<{ savedAt: string }> {
  const order = await prisma.paymentOrder.findFirst({
    where: { organizationId: input.organizationId, paymentOrderId: input.paymentOrderId },
    select: {
      paymentOrderId: true, state: true, invoiceNumber: true, dueAt: true,
      amountRaw: true, metadataJson: true,
      transferRequests: { select: { transferRequestId: true }, take: 1 },
    },
  });
  if (!order) throw new Error('Bill not found');
  if (order.state !== 'draft') {
    throw new Error(`This bill is ${order.state} — its details are settled.`);
  }

  const metadata = isRecord(order.metadataJson) ? order.metadataJson : {};
  const agent = isRecord(metadata.agent) ? metadata.agent : {};
  const extracted = agent && isRecord(agent.extracted) ? agent.extracted : {};
  const previous = isRecord(metadata.verification) ? metadata.verification : {};

  // The same trail confirm keeps, computed against the same baseline, so a
  // correction made today still reads as a correction when the bill is
  // confirmed next week. Recomputed rather than appended — saving twice must
  // not record the same change twice.
  const corrections = billFieldCorrections(extracted, input.fields, input.actorUserId);

  const savedAt = new Date().toISOString();
  const verification = {
    ...previous,
    fields: input.fields,
    lines: input.lines,
    confirmedFieldKeys: input.confirmedFieldKeys ?? [],
    corrections,
    noteForApprovers: str(input.noteForApprovers ?? null),
    savedByUserId: input.actorUserId,
    savedAt,
  };

  const total = input.fields.total;
  const savedAmountRaw = typeof total === 'number' && Number.isFinite(total) && total > 0
    ? BigInt(Math.round(total * 1_000_000))
    : null;
  const dueAt = input.fields.dueDate ? new Date(input.fields.dueDate) : null;

  // Taken on this side of the write on purpose. Asking afterwards what the
  // flags "would have been" means reconstructing a past state, and every other
  // thing the write touches — the amount, the invoice number — would already
  // have moved underneath the reconstruction.
  const flagsBefore = await flagsForOrder(input.organizationId, order.paymentOrderId);

  await prisma.paymentOrder.update({
    where: { paymentOrderId: order.paymentOrderId },
    data: {
      // The queue reads these columns, so a saved figure has to reach them or
      // the list keeps showing what the machine first read.
      amountRaw: savedAmountRaw !== null && order.transferRequests.length === 0 ? savedAmountRaw : undefined,
      invoiceNumber: str(input.fields.invoiceNumber ?? null) ?? order.invoiceNumber,
      dueAt: dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : order.dueAt,
      metadataJson: { ...metadata, verification } as Prisma.InputJsonValue,
    },
  });

  // Field-level history, same as an edit made after submission. A save is a
  // person changing a figure, and the record should not care which screen they
  // were on when they did it.
  await recordFieldChanges({
    organizationId: input.organizationId,
    paymentOrderId: order.paymentOrderId,
    changedByUserId: input.actorUserId,
    phase: 'draft',
    reason: 'save',
    changes: corrections.map((c) => ({ field: c.field, from: c.readValue, to: c.correctedValue })),
  });

  // And what the save did to the checks, so the history can say a flag was
  // raised and later cleared instead of it silently ceasing to be true.
  await recordFlagChanges({
    organizationId: input.organizationId,
    paymentOrderId: order.paymentOrderId,
    actorUserId: input.actorUserId,
    before: flagsBefore,
    after: await flagsForOrder(input.organizationId, order.paymentOrderId),
    state: order.state,
  });

  return { savedAt };
}
