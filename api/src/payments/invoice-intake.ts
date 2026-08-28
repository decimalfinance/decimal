import type { Counterparty, CounterpartyWallet, Prisma } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { trackBackgroundWork } from '../infra/background.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET, USDC_DECIMALS } from '../solana.js';
import { createPaymentOrder } from './orders.js';
import {
  storeInvoiceDocument,
  storeInvoiceDocumentPages,
  setInvoiceDocumentPageCount,
  setInvoiceDocumentStatus,
} from './documents.js';
import { extractPaymentRowsFromDocument, renderDocumentToImages, type ExtractedRow } from './document-extract.js';
import { extractPdfLayoutText, ungroundedFields } from './doc-provenance.js';
import {
  extractPdfTextLayer, extractImageTextLayer, refineInvoiceSources, stripUnmeasuredSources,
  PROVENANCE_VERSION,
} from './doc-provenance.js';
import { suggestOcrCodings } from '../accounting/ocr-coding.js';
import { INVOICE_IMPORT_REVIEW_NOTE } from '../counterparty-wallets.js';

const NEW_COUNTERPARTY_DRAFT_THRESHOLD_RAW = 1_000n * 10n ** BigInt(USDC_DECIMALS);
const LOW_CONFIDENCE_OVERALL_THRESHOLD = 0.72;
const LOW_CONFIDENCE_AMOUNT_THRESHOLD = 0.72;

type InvoiceIntakeRuntime = {
  extractRowsFromDocument: typeof extractPaymentRowsFromDocument;
};

const defaultRuntime: InvoiceIntakeRuntime = {
  extractRowsFromDocument: extractPaymentRowsFromDocument,
};

let runtime: InvoiceIntakeRuntime = defaultRuntime;

export function setInvoiceIntakeRuntimeForTests(nextRuntime: Partial<InvoiceIntakeRuntime> | null) {
  runtime = nextRuntime ? { ...defaultRuntime, ...nextRuntime } : defaultRuntime;
}

export type InvoiceIntakeSkippedRow = {
  counterparty: string;
  amount: number;
  currency: string;
  reference: string | null;
  walletAddress?: string | null;
  reason:
    | 'no_destination_or_wallet'
    | 'unsupported_currency'
    | 'blocked_counterparty'
    | 'invalid_amount'
    | 'invalid_wallet_address'
    | 'creation_failed';
  message: string;
};

/**
 * How a bill got here, when it wasn't a person clicking Upload. Purely
 * descriptive — it carries no actor semantics (the bill is still attributed to
 * a real user) and does not change `inputSource`, which the draft screen and
 * duplicate gate key off. Email is an invoice upload; this records the door.
 */
export type IntakeChannel = {
  kind: 'email';
  inboundEmailMessageId: string;
  fromAddress: string;
  subject: string | null;
  receivedAt: string;
};

export async function uploadInvoiceToPaymentOrders(args: {
  organizationId: string;
  actorUserId: string;
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  sourceTreasuryWalletId?: string | null;
  intakeChannel?: IntakeChannel | null;
}) {
  logger.info('invoice_intake.started', {
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    filename: args.filename,
    mimeType: args.mimeType,
    bytes: args.fileBytes.length,
    hasSourceTreasuryWallet: Boolean(args.sourceTreasuryWalletId),
  });

  // Persist the original file BEFORE extraction — a failed or empty extraction
  // must still leave the document retrievable. Non-fatal: a storage hiccup must
  // never block invoice capture.
  let invoiceDocumentId: string | null = null;
  try {
    const stored = await storeInvoiceDocument({
      organizationId: args.organizationId,
      uploadedByUserId: args.actorUserId,
      fileBytes: args.fileBytes,
      filename: args.filename,
      mimeType: args.mimeType,
    });
    invoiceDocumentId = stored.invoiceDocumentId;
  } catch (error) {
    logger.warn('invoice_intake.document_store_failed', {
      organizationId: args.organizationId,
      filename: args.filename,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }

  return processInvoiceDocument({ ...args, invoiceDocumentId });
}

// Everything after document storage: render pages → extract → create orders.
// The async intake path calls this in the background while the operator is
// already looking at the stored document on the draft screen.
export async function processInvoiceDocument(args: {
  organizationId: string;
  actorUserId: string;
  invoiceDocumentId: string | null;
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  sourceTreasuryWalletId?: string | null;
  intakeChannel?: IntakeChannel | null;
}) {
  // Render page images once — the draft screen displays these (never a PDF
  // viewer), and extraction reuses the same renders. Best-effort: if rendering
  // fails, extraction falls back to its own render and reports the real error.
  let prerenderedPages: Awaited<ReturnType<typeof renderDocumentToImages>> | undefined;
  try {
    prerenderedPages = await renderDocumentToImages({
      fileBytes: args.fileBytes,
      filename: args.filename,
      mimeType: args.mimeType,
    });
    if (args.invoiceDocumentId) {
      await storeInvoiceDocumentPages(args.invoiceDocumentId, prerenderedPages);
    }
  } catch (error) {
    logger.warn('invoice_intake.page_render_failed', {
      organizationId: args.organizationId,
      filename: args.filename,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }

  // The document's own text, pulled BEFORE extraction rather than after.
  //
  // It was always pulled here — a few lines further down, to fix up provenance
  // boxes once the model had guessed at them. Which meant we held the exact
  // characters, ignored them, rasterised the page, and paid a vision model to
  // read them back. Moving it above the call lets extraction read the text when
  // there is text, and keeps one pdftotext run doing both jobs.
  let textPages: Awaited<ReturnType<typeof extractPdfTextLayer>> = null;
  let layoutText: string | null = null;
  try {
    [textPages, layoutText] = await Promise.all([
      extractPdfTextLayer({ fileBytes: args.fileBytes, filename: args.filename, mimeType: args.mimeType }),
      extractPdfLayoutText({ fileBytes: args.fileBytes, filename: args.filename, mimeType: args.mimeType }),
    ]);
  } catch (error) {
    // Best-effort: no text layer simply means the vision path, which is what
    // every image takes anyway.
    logger.warn('invoice_intake.text_layer_failed', {
      organizationId: args.organizationId,
      filename: args.filename,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }

  // Where the highlight boxes come from, which is NOT the same question as
  // where the text comes from.
  //
  // A photograph has no text layer, so nothing could be measured and the
  // model's boxes were kept — and the model does not measure boxes, it invents
  // them. C1 and C2, two unrelated invoices, both came back with vendorName at
  // exactly [0.05, 0.05, 0.4, 0.07] and their header fields on a flat 0.03
  // ladder. Clicking a line item lit up blank paper well below it, with the
  // same confident pink as a box read off a real PDF.
  //
  // OCR gives those documents measured coordinates. It reads the page images
  // already rendered for the viewer, so the words are located in exactly the
  // picture the highlight is drawn over.
  //
  // Deliberately kept apart from `textPages`: OCR characters are a guess and
  // must never reach the extraction prompt or the grounding check. Position is
  // a measurement; text is not evidence.
  let boxPages = textPages;
  if (!boxPages && prerenderedPages?.length) {
    boxPages = await extractImageTextLayer(prerenderedPages);
  }

  const invoiceDocumentId = args.invoiceDocumentId;
  let extraction: Awaited<ReturnType<typeof runtime.extractRowsFromDocument>>;
  try {
    extraction = await runtime.extractRowsFromDocument({
      fileBytes: args.fileBytes,
      filename: args.filename,
      mimeType: args.mimeType,
      prerenderedPages,
      textPages,
      layoutText,
    });
  } catch (error) {
    // A document we could not read still becomes a bill.
    //
    // It used to throw, leaving a failed row on the list: visible, outside the
    // queue, and impossible to key in by hand. But a scan nobody can read is
    // still an invoice somebody owes money on, and the useful thing is a draft
    // with the fields marked unreadable — a person types what the machine
    // could not, and nothing is invented in the meantime.
    //
    // Only when the DOCUMENT defeated us. A provider being down is not a fact
    // about the invoice, and turning an outage into a queue full of empty
    // drafts somebody has to clean up would be worse than the outage.
    if (!isDocumentDefeatedUs(error)) throw error;
    const message = error instanceof Error ? error.message : 'Could not read this document.';
    logger.warn('invoice_intake.unreadable_document', {
      organizationId: args.organizationId,
      filename: args.filename,
      message,
    });
    extraction = { rows: [unreadableRow(args.filename, message)], modelLatencyMs: 0, pageCount: prerenderedPages?.length ?? 1 };
  }

  // Exact provenance: re-locate every extracted value among the words actually
  // printed on the page and replace the model's box with the real coordinates.
  //
  // Where nothing could be measured the model's boxes are thrown away rather
  // than drawn. A highlight is a claim that the value was read from THIS spot;
  // an authoritative pink rectangle over empty paper is a lie told in our
  // voice, and worse than no highlight at all.
  try {
    let refined = 0;
    for (const row of extraction.rows) {
      if (!row.source_invoice) continue;
      if (boxPages) refined += refineInvoiceSources(row.source_invoice, boxPages).refined;
      else stripUnmeasuredSources(row.source_invoice as unknown as Record<string, unknown>);
    }
    logger.info('invoice_intake.provenance_refined', {
      organizationId: args.organizationId,
      filename: args.filename,
      boxSource: boxPages ? (textPages ? 'text-layer' : 'ocr') : 'none',
      refined,
    });

    // And the grounding check, HERE, where a bill is born.
    //
    // It was only ever run by the provenance backfill in getBillDraft, which
    // skips any bill already stamped with the current version — and intake
    // stamps that at creation. So the one check that can catch a figure the
    // model produced from nowhere ran on old documents and never on a new
    // upload, which is exactly backwards.
    //
    // Null for anything with no text layer: "we could not check" is not
    // "we checked and it was fine", and the photographs are where an
    // invented figure is most likely and least detectable.
    for (const row of extraction.rows) {
      if (!row.source_invoice) continue;
      (row.source_invoice as unknown as Record<string, unknown>).ungrounded =
        ungroundedFields(row.source_invoice as unknown as Record<string, unknown>, textPages);
    }
  } catch (error) {
    logger.warn('invoice_intake.provenance_refine_failed', {
      organizationId: args.organizationId,
      filename: args.filename,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }

  if (invoiceDocumentId && extraction.pageCount != null) {
    await setInvoiceDocumentPageCount(invoiceDocumentId, extraction.pageCount).catch(() => {});
  }

  if (extraction.rows.length === 0) {
    throw new Error('No payable invoice rows were extracted from this document.');
  }

  // OCR-driven coding: map each invoice's "what it's for" to an expense account in the
  // org's chart (no-op when QuickBooks isn't connected). Surfaced later as a candidate.
  const ocrCodings = await suggestOcrCodings(
    args.organizationId,
    extraction.rows.map((r) => ({
      categoryHint: r.source_invoice?.categoryHint ?? null,
      lineItems: r.source_invoice?.lineItems ?? [],
    })),
  );

  const created = [];
  const skipped: InvoiceIntakeSkippedRow[] = [];

  for (const [index, row] of extraction.rows.entries()) {
    try {
      if (!isUsdLikeCurrency(row.currency)) {
        skipped.push(buildSkippedRow(row, 'unsupported_currency', `Currency ${row.currency} is not supported for USDC payout creation yet.`));
        continue;
      }

      const amountRaw = parseUsdcAmountToRaw(row.amount);
      const counterpartyWallet = await resolveInvoiceCounterpartyWallet({
        organizationId: args.organizationId,
        row,
        rowNumber: index + 1,
      });

      if (!counterpartyWallet) {
        const extractedWalletAddress = normalizeOptionalText(row.wallet_address);
        if (extractedWalletAddress && !isValidSolanaWalletAddress(extractedWalletAddress)) {
          skipped.push(buildSkippedRow(
            row,
            'invalid_wallet_address',
            `Extracted wallet "${extractedWalletAddress}" is not a valid Solana base58 address. This is usually OCR ambiguity; review the invoice or add the counterparty wallet manually.`,
          ));
        } else {
          skipped.push(buildSkippedRow(row, 'no_destination_or_wallet', 'No matching counterparty wallet was found and the invoice did not include a Solana wallet address.'));
        }
        continue;
      }

      if (counterpartyWallet.trustState === 'blocked') {
        skipped.push(buildSkippedRow(row, 'blocked_counterparty', `Counterparty wallet "${counterpartyWallet.label}" is blocked.`));
        continue;
      }

      const vendorAddressContext = await computeVendorAddressContext({
        organizationId: args.organizationId,
        wallet: counterpartyWallet,
      });
      const nearDuplicate = await computeNearDuplicateAddress({
        organizationId: args.organizationId,
        wallet: counterpartyWallet,
      });
      const triggeredRules = deriveIntakeFlags({
        row,
        amountRaw,
        counterpartyWallet,
        vendorAddressContext,
        nearDuplicate,
      });
      // Preparation is mandatory for EVERY uploaded bill — known vendor or not
      // (pipeline v3 ruling, 2026-07-07). The operator confirms what was read
      // from the document; "Confirm & send for approval" is the only door into
      // routing. triggeredRules still matter: they become the draft screen's
      // flags and banners.
      const decision = 'draft';

      const paymentOrder = await createPaymentOrder({
        organizationId: args.organizationId,
        actorUserId: args.actorUserId,
        counterpartyWalletId: counterpartyWallet.counterpartyWalletId,
        sourceTreasuryWalletId: args.sourceTreasuryWalletId ?? null,
        amountRaw,
        asset: USDC_ASSET,
        memo: row.notes ?? `Pay ${row.counterparty}`,
        externalReference: row.reference,
        invoiceNumber: row.reference,
        invoiceDocumentId,
        dueAt: parseOptionalDate(row.due_date),
        metadataJson: {
          inputSource: 'invoice_upload',
          ...(args.intakeChannel ? { intakeChannel: args.intakeChannel } : {}),
          ocrCoding: ocrCodings[index] ?? null,
          agent: {
            name: 'ap-intake',
            version: 'api-native-v1',
            provenanceVersion: PROVENANCE_VERSION,
            decision,
            triggeredRules,
            extracted: row.source_invoice ?? {
              vendorName: row.counterparty,
              vendorAddress: null,
              vendorEmail: null,
              amount: row.amount,
              currency: row.currency,
              invoiceNumber: row.reference,
              invoiceDate: null,
              dueDate: row.due_date,
              walletAddress: row.wallet_address,
              lineItems: [],
              confidence: {
                vendor: 1,
                amount: 1,
                overall: 1,
              },
            },
            sourceDocument: {
              invoiceDocumentId,
              filename: args.filename,
              mimeType: args.mimeType,
              pageCount: extraction.pageCount,
              modelLatencyMs: extraction.modelLatencyMs,
              rowIndex: index,
            },
          },
        },
        initialState: 'draft',
      });

      // What this document arrived carrying. Flags are derived, so nothing
      // records the ones a bill is born with — and a bill that came in broken
      // and was then fixed would show the fix with no trace of the fault.
      {
        const { recordOpeningFlags } = await import('./bills.js');
        await recordOpeningFlags({
          organizationId: args.organizationId,
          paymentOrderId: paymentOrder.paymentOrderId,
          actorUserId: args.actorUserId ?? null,
        });
      }

      // The bill enters the approval engine HERE, not at confirm.
      //
      // Until this, a bill sat outside the engine until someone confirmed it,
      // so it had no TASK — and without a task none of the engine's commands
      // are reachable. That is precisely backwards: the moment a bill clerk most
      // needs to ask a question, delegate, push back or escalate is when a flag
      // says something is wrong, which is BEFORE they would ever confirm.
      //
      // Editing the bill afterwards is safe: applyMaterialChange treats a
      // change with no decisions yet as a silent recompile, so correcting an
      // amount while it is still a draft re-routes without disturbing anyone.
      //
      // Best-effort — an engine failure must not lose an ingested bill. The
      // order exists either way and confirm will submit as a fallback.
      // What we proposed for each LINE, recorded before anyone sees it.
      //
      // The bill-level GL prediction is already logged; per-line categories were
      // not, so the one thing a person visibly corrects most often — a line in
      // the wrong category — produced no record of having been suggested. The
      // override you can see by eye is exactly the signal worth keeping.
      try {
        const { logSuggestion } = await import('./suggestion-log.js');
        const hinted = (row.source_invoice?.lineItems ?? []) as Array<Record<string, unknown>>;
        const perLine = hinted
          .map((l, i) => ({ index: i, description: String(l.description ?? ''), categoryHint: l.categoryHint ?? null }))
          .filter((l) => l.categoryHint);
        if (perLine.length > 0) {
          await logSuggestion({
            organizationId: args.organizationId,
            stage: 'gl_coding',
            subjectType: 'payment_order_lines',
            subjectId: paymentOrder.paymentOrderId,
            suggested: perLine,
            producer: 'extraction/line-category-v1',
            inputs: { lineCount: hinted.length },
          });
        }
      } catch {
        // Instrumentation never blocks an ingest.
      }

      // A bill does NOT enter the approval engine here.
      //
      // It used to, so that a flagged bill had a task to ask about or escalate.
      // The cost was that every bill was `draft` and `pending_approval`
      // at the same time — routing compiled on figures nobody had checked yet,
      // then recompiled when Confirm corrected them. No AP product models a
      // bill as awaiting review and pending approval simultaneously; the ones
      // that were checked either withhold the record until it is verified
      // (Bill.com) or keep a wide Draft state that approval never starts from
      // (Ramp, Xero, Coupa, NetSuite). Ramp is explicit about the direction:
      // a bill created through their API with data already confirmed skips
      // Draft entirely, because routing is gated on the data being settled,
      // not on the bill existing. See review-vs-approve/lifecycle-states.md.
      //
      // Nothing is lost by waiting. Flagging never needed the engine —
      // evaluateBillFlags is a pure function over the bill's own facts plus a
      // duplicate match against other bills, so addressed-elsewhere,
      // arithmetic, duplicates, vendor holds and the ceiling all still fire in
      // draft. The one flag that does need it, approval_weakened, is about an
      // approval that has not started yet.
      //
      // Confirm is the door. It is the only door.

      created.push({
        rowIndex: index,
        decision,
        triggeredRules,
        paymentOrder,
      });
    } catch (error) {
      skipped.push(buildSkippedRow(
        row,
        error instanceof RangeError ? 'invalid_amount' : 'creation_failed',
        error instanceof Error ? error.message : 'Payment order creation failed.',
      ));
    }
  }

  if (created.length === 0) {
    const detail = skipped.slice(0, 3).map((row) => `${row.counterparty}: ${row.message}`).join(' | ');
    logger.warn('invoice_intake.no_orders_created', {
      organizationId: args.organizationId,
      filename: args.filename,
      extractedRows: extraction.rows.length,
      skippedCount: skipped.length,
      skippedRows: skipped.slice(0, 10),
    });
    throw new Error(`Invoice upload did not create any payment orders.${detail ? ` ${detail}` : ''}`);
  }

  logger.info('invoice_intake.completed', {
    organizationId: args.organizationId,
    filename: args.filename,
    extractedRows: extraction.rows.length,
    createdCount: created.length,
    skippedCount: skipped.length,
    decisions: created.map((item) => ({
      paymentOrderId: item.paymentOrder.paymentOrderId,
      decision: item.decision,
      triggeredRules: item.triggeredRules.map((rule) => rule.rule),
    })),
  });

  return {
    inputSource: 'invoice_upload',
    invoiceDocumentId,
    filename: args.filename,
    modelLatencyMs: extraction.modelLatencyMs,
    pageCount: extraction.pageCount,
    extractedRows: extraction.rows,
    createdCount: created.length,
    skippedCount: skipped.length,
    primaryPaymentOrder: created[0]?.paymentOrder ?? null,
    paymentOrders: created,
    skippedRows: skipped,
  };
}

// Async intake: store the document and return immediately so the draft screen
// can open with the document visible while extraction runs in the background.
// Progress is observed via the document's status (processing → processed/failed).
export async function beginAsyncInvoiceIntake(args: {
  organizationId: string;
  actorUserId: string;
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  sourceTreasuryWalletId?: string | null;
  intakeChannel?: IntakeChannel | null;
}) {
  const stored = await storeInvoiceDocument({
    organizationId: args.organizationId,
    uploadedByUserId: args.actorUserId,
    fileBytes: args.fileBytes,
    filename: args.filename,
    mimeType: args.mimeType,
    status: 'processing',
  });

  if (stored.reused) {
    const current = await prisma.invoiceDocument.findUnique({
      where: { invoiceDocumentId: stored.invoiceDocumentId },
      select: { status: true },
    });
    // Same file again: already processed (or mid-processing) — nothing to redo.
    if (current && current.status !== 'failed') {
      return { invoiceDocumentId: stored.invoiceDocumentId, reused: true };
    }
    await setInvoiceDocumentStatus(stored.invoiceDocumentId, 'processing');
  }

  trackBackgroundWork((async () => {
    try {
      await processInvoiceDocument({ ...args, invoiceDocumentId: stored.invoiceDocumentId });
      await setInvoiceDocumentStatus(stored.invoiceDocumentId, 'processed');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Processing failed.';
      logger.error('invoice_intake.async_failed', {
        organizationId: args.organizationId,
        invoiceDocumentId: stored.invoiceDocumentId,
        message,
      });
      await setInvoiceDocumentStatus(stored.invoiceDocumentId, 'failed', message).catch(() => {});
    }
  })());

  return { invoiceDocumentId: stored.invoiceDocumentId, reused: false };
}

/**
 * Was that failure about the document, or about us?
 *
 * A schema violation, an empty completion, a reply that would not parse — the
 * document defeated the extractor, and a draft with the fields marked
 * unreadable is the honest outcome. A network error or a 5xx is not a fact
 * about the invoice: it will read fine when the provider is back, and turning
 * an outage into a queue of empty drafts somebody has to clear is worse than
 * the outage.
 */
function isDocumentDefeatedUs(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/OpenAI \d{3}:/.test(message)) return false;          // provider returned an error status
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(message)) return false;
  if (/is not configured/i.test(message)) return false;      // no API key: our problem
  return true;
}

/**
 * A bill for a document nothing could read.
 *
 * Everything null, every field marked unreadable, and the real error carried in
 * issues so the person looking at it knows what went wrong rather than facing a
 * blank form. The amount is 0.01 because the row schema requires a positive
 * number and the extraction prompt already uses that value for "undeterminable"
 * — one convention, not two.
 */
function unreadableRow(filename: string, message: string): ExtractedRow {
  const unreadable = [
    'vendorName', 'invoiceNumber', 'invoiceDate', 'dueDate', 'total', 'lineItems',
  ];
  return {
    counterparty: 'Unreadable document',
    amount: 0.01,
    currency: 'USD',
    reference: null,
    due_date: null,
    wallet_address: null,
    notes: `Could not be read: ${filename}`,
    source_invoice: {
      documentKind: 'invoice',
      statementRows: null,
      appliesToInvoice: null,
      vendorName: 'Unreadable document',
      vendorAddress: null,
      vendorEmail: null,
      amount: 0.01,
      currency: 'USD',
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      terms: null,
      poNumber: null,
      earlyPayDiscount: null,
      subtotal: null,
      taxAmount: null,
      billToName: null,
      remitTo: null,
      paymentDetails: null,
      walletAddress: null,
      lineItems: [],
      categoryHint: null,
      confidence: { vendor: 0, amount: 0, overall: 0 },
      fieldConfidence: null,
      fieldStatus: Object.fromEntries(unreadable.map((f) => [f, 'unreadable' as const])),
      // The same sentence against every field, deliberately: when the whole
      // document defeated us the reason IS the same for each one, and a field
      // that says "could not be read" without saying why sends the reader
      // hunting for an explanation that exists one level up.
      issues: [
        { field: 'document', note: message },
        ...unreadable.map((field) => ({ field, note: message })),
      ],
      fieldSources: null,
    },
  };
}

/** Re-exported so tests keep one obvious place to drain from. */
export { drainBackgroundWork as drainAsyncIntake } from '../infra/background.js';

async function resolveInvoiceCounterpartyWallet(args: {
  organizationId: string;
  row: ExtractedRow;
  rowNumber: number;
}): Promise<(CounterpartyWallet & { counterparty: Counterparty | null }) | null> {
  const walletAddress = normalizeOptionalText(args.row.wallet_address);

  if (walletAddress && isValidSolanaWalletAddress(walletAddress)) {
    const byAddress = await prisma.counterpartyWallet.findFirst({
      where: {
        organizationId: args.organizationId,
        isActive: true,
        OR: [
          { walletAddress },
          { tokenAccountAddress: walletAddress },
        ],
      },
      include: { counterparty: true },
    });
    if (byAddress) return byAddress;

    return createInvoiceCounterpartyWalletFromAddress({
      organizationId: args.organizationId,
      walletAddress,
      labelFromInvoice: args.row.counterparty,
      rowNumber: args.rowNumber,
    });
  }

  const counterpartyName = normalizeOptionalText(args.row.counterparty);
  if (!counterpartyName) return null;

  const byName = await prisma.counterpartyWallet.findFirst({
    where: {
      organizationId: args.organizationId,
      isActive: true,
      OR: [
        { label: { equals: counterpartyName, mode: 'insensitive' } },
        { counterparty: { displayName: { equals: counterpartyName, mode: 'insensitive' } } },
        { label: { contains: counterpartyName, mode: 'insensitive' } },
        { counterparty: { displayName: { contains: counterpartyName, mode: 'insensitive' } } },
      ],
    },
    // An invoice that names the vendor but carries no address routes to the
    // vendor's designated primary (default) payout address, not an arbitrary row.
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    include: { counterparty: true },
  });
  if (byName) return byName;

  // A normal (bank-only, crypto-free) invoice from a vendor we don't know yet:
  // create the vendor with a PENDING payment method so the bill still flows
  // through review + approval. The verified payout method is supplied later
  // (vendor portal / Bridge liquidation address) — that's what release waits on,
  // never approval. See project_vendor_payment_methods.
  return createPendingMethodCounterpartyWallet({
    organizationId: args.organizationId,
    labelFromInvoice: counterpartyName,
    documentPaymentDetails: args.row.source_invoice?.paymentDetails ?? null,
  });
}

// A vendor whose payout destination isn't known yet — placeholder address so the
// NOT-NULL/UNIQUE wallet_address constraint holds; the real method arrives later.
async function createPendingMethodCounterpartyWallet(args: {
  organizationId: string;
  labelFromInvoice: string;
  documentPaymentDetails: unknown;
}) {
  const label = normalizeOptionalText(args.labelFromInvoice) ?? 'Vendor';
  const placeholder = `pending:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}`;

  return prisma.$transaction(async (tx) => {
    const counterparty = await findOrCreateCounterparty(tx, args.organizationId, label);
    const existing = await tx.counterpartyWallet.findUnique({
      where: { organizationId_walletAddress: { organizationId: args.organizationId, walletAddress: placeholder } },
      include: { counterparty: true },
    });
    if (existing) return existing;

    return tx.counterpartyWallet.create({
      data: {
        organizationId: args.organizationId,
        counterpartyId: counterparty.counterpartyId,
        chain: SOLANA_CHAIN,
        asset: USDC_ASSET,
        walletAddress: placeholder,
        tokenAccountAddress: null,
        walletType: 'pending_method',
        trustState: 'unreviewed',
        label,
        notes: 'Awaiting a verified payment method from the vendor.',
        isInternal: false,
        isActive: true,
        metadataJson: {
          inputSource: 'invoice_upload',
          pendingMethod: true,
          createdFromInvoiceUploadAt: new Date().toISOString(),
          ...(isRecordLike(args.documentPaymentDetails) ? { documentPaymentDetails: args.documentPaymentDetails } : {}),
        } as Prisma.InputJsonValue,
      },
      include: { counterparty: true },
    });
  });
}

async function createInvoiceCounterpartyWalletFromAddress(args: {
  organizationId: string;
  walletAddress: string;
  labelFromInvoice: string | null;
  rowNumber: number;
}) {
  let tokenAccountAddress: string;
  try {
    tokenAccountAddress = deriveUsdcAtaForWallet(args.walletAddress);
  } catch {
    throw new Error(`Row ${args.rowNumber}: "${args.walletAddress}" is not a valid Solana wallet address`);
  }

  const label = normalizeOptionalText(args.labelFromInvoice) ?? shortenAddress(args.walletAddress);

  return prisma.$transaction(async (tx) => {
    const counterparty = await findOrCreateCounterparty(tx, args.organizationId, label);
    const existing = await tx.counterpartyWallet.findUnique({
      where: {
        organizationId_walletAddress: {
          organizationId: args.organizationId,
          walletAddress: args.walletAddress,
        },
      },
      include: { counterparty: true },
    });

    if (existing) {
      return tx.counterpartyWallet.update({
        where: { counterpartyWalletId: existing.counterpartyWalletId },
        data: {
          isActive: true,
          counterpartyId: existing.counterpartyId ?? counterparty.counterpartyId,
          tokenAccountAddress: existing.tokenAccountAddress ?? tokenAccountAddress,
          metadataJson: {
            ...(isRecordLike(existing.metadataJson) ? existing.metadataJson : {}),
            lastSeenInInvoiceUploadAt: new Date().toISOString(),
          },
        },
        include: { counterparty: true },
      });
    }

    return tx.counterpartyWallet.create({
      data: {
        organizationId: args.organizationId,
        counterpartyId: counterparty.counterpartyId,
        chain: SOLANA_CHAIN,
        asset: USDC_ASSET,
        walletAddress: args.walletAddress,
        tokenAccountAddress,
        walletType: 'invoice_imported',
        trustState: 'unreviewed',
        label,
        notes: INVOICE_IMPORT_REVIEW_NOTE,
        isInternal: false,
        isActive: true,
        metadataJson: {
          inputSource: 'invoice_upload',
          createdFromInvoiceUploadAt: new Date().toISOString(),
        },
      },
      include: { counterparty: true },
    });
  });
}

async function findOrCreateCounterparty(
  tx: Prisma.TransactionClient,
  organizationId: string,
  displayName: string,
) {
  const existing = await tx.counterparty.findFirst({
    where: {
      organizationId,
      displayName: { equals: displayName, mode: 'insensitive' },
    },
  });
  if (existing) return existing;

  return tx.counterparty.create({
    data: {
      organizationId,
      displayName,
      category: 'vendor',
      metadataJson: {
        inputSource: 'invoice_upload',
      },
    },
  });
}

type VendorAddressContext = {
  otherAddressCount: number;
  otherTrustedAddressCount: number;
};

// Look up the OTHER active payout addresses the org already holds for the same
// vendor as `wallet` — matched by linked counterparty and by label (the address
// book is a flat list of labeled wallets; many rows have no counterparty link),
// excluding the routed address itself. Computed fresh on every intake so the
// account-change check is robust to re-uploads and pre-existing rows.
async function computeVendorAddressContext(args: {
  organizationId: string;
  wallet: Pick<CounterpartyWallet, 'walletAddress' | 'label' | 'counterpartyId'> & { counterparty: Counterparty | null };
}): Promise<VendorAddressContext> {
  const vendorName = args.wallet.counterparty?.displayName ?? args.wallet.label;
  const matchers: Prisma.CounterpartyWalletWhereInput[] = [
    { label: { equals: vendorName, mode: 'insensitive' } },
    { counterparty: { displayName: { equals: vendorName, mode: 'insensitive' } } },
  ];
  if (args.wallet.counterpartyId) {
    matchers.push({ counterpartyId: args.wallet.counterpartyId });
  }

  const others = await prisma.counterpartyWallet.findMany({
    where: {
      organizationId: args.organizationId,
      isActive: true,
      walletAddress: { not: args.wallet.walletAddress },
      OR: matchers,
    },
    select: { trustState: true },
  });

  return {
    otherAddressCount: others.length,
    otherTrustedAddressCount: others.filter((w) => w.trustState === 'trusted').length,
  };
}

type NearDuplicateAddress = { address: string; label: string };

// Bounded Levenshtein — bails out to max+1 as soon as it's clearly over budget.
function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur[j] = v;
      if (v < rowBest) rowBest = v;
    }
    if (rowBest > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

// Two DIFFERENT addresses that look almost identical: a case-only difference
// (base58 is case-sensitive, so this is a real but near-invisible change) or
// within one or two characters. This is the OCR/transcription corruption class
// — e.g. an invoice address read back with a single character's case flipped.
function isNearDuplicateAddress(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  return boundedEditDistance(a, b, 2) <= 2;
}

// Find an existing active address in the org that the routed address is a
// near-duplicate of. Checks ALL vendors, not just the matched one — look-alike
// corruption and typo-squatting aren't limited to the same vendor. Org address
// counts are small today; at scale this moves to an indexed pre-filter.
async function computeNearDuplicateAddress(args: {
  organizationId: string;
  wallet: Pick<CounterpartyWallet, 'walletAddress'>;
}): Promise<NearDuplicateAddress | null> {
  const others = await prisma.counterpartyWallet.findMany({
    where: {
      organizationId: args.organizationId,
      isActive: true,
      walletAddress: { not: args.wallet.walletAddress },
    },
    select: { walletAddress: true, label: true },
  });
  for (const o of others) {
    if (isNearDuplicateAddress(args.wallet.walletAddress, o.walletAddress)) {
      return { address: o.walletAddress, label: o.label };
    }
  }
  return null;
}

function deriveIntakeFlags(args: {
  row: ExtractedRow;
  amountRaw: bigint;
  counterpartyWallet: Pick<CounterpartyWallet, 'trustState' | 'label' | 'walletAddress'> & { counterparty: Counterparty | null };
  vendorAddressContext: VendorAddressContext;
  nearDuplicate: NearDuplicateAddress | null;
}) {
  const rules: Array<{ rule: string; reason: string }> = [];

  if (args.counterpartyWallet.trustState === 'unreviewed') {
    rules.push({
      rule: args.amountRaw > NEW_COUNTERPARTY_DRAFT_THRESHOLD_RAW
        ? 'new_counterparty_threshold'
        : 'unreviewed_counterparty',
      reason:
        args.amountRaw > NEW_COUNTERPARTY_DRAFT_THRESHOLD_RAW
          ? `New counterparty "${args.counterpartyWallet.label}" exceeds the $1000 review threshold.`
          : `Counterparty wallet "${args.counterpartyWallet.label}" has not been reviewed yet.`,
    });
  }

  if (args.counterpartyWallet.trustState === 'restricted') {
    rules.push({
      rule: 'restricted_counterparty',
      reason: `Counterparty wallet "${args.counterpartyWallet.label}" is restricted.`,
    });
  }

  const extractedWalletAddress = normalizeOptionalText(args.row.wallet_address);
  if (extractedWalletAddress && !isValidSolanaWalletAddress(extractedWalletAddress)) {
    rules.push({
      rule: 'invalid_extracted_wallet_address',
      reason:
        `Invoice wallet "${extractedWalletAddress}" is not a valid Solana base58 address. ` +
        `It may be OCR-confused and needs human review before proposal creation.`,
    });
  } else if (
    extractedWalletAddress
    && args.counterpartyWallet.counterparty
    && args.counterpartyWallet.walletAddress !== extractedWalletAddress
  ) {
    rules.push({
      rule: 'known_counterparty_wallet_changed',
      reason: `Invoice wallet ${shortenAddress(extractedWalletAddress)} differs from the matched wallet for ${args.counterpartyWallet.counterparty.displayName}.`,
    });
  }

  // The invoice routes to an address that is NOT this vendor's established
  // (trusted) one, while the vendor already has other known address(es) — the
  // classic account-change (BEC) fraud signal. Computed live per intake (see
  // computeVendorAddressContext) so it fires for re-uploads and rows that
  // predate this check, not just at first creation. Only surfaced while the
  // routed address is still unverified — once trusted, the operator has already
  // confirmed it, so we stop flagging it on every future invoice.
  const { otherAddressCount, otherTrustedAddressCount } = args.vendorAddressContext;
  if (args.counterpartyWallet.trustState !== 'trusted' && otherAddressCount > 0) {
    const vendorName = args.counterpartyWallet.counterparty?.displayName ?? args.counterpartyWallet.label;
    rules.push({
      rule: 'known_counterparty_wallet_changed',
      reason:
        `"${vendorName}" already has ${otherAddressCount} other known payout address${otherAddressCount === 1 ? '' : 'es'}` +
        `${otherTrustedAddressCount > 0 ? ` (${otherTrustedAddressCount} trusted)` : ''}. This invoice routes to a ` +
        `different, unverified address ${shortenAddress(args.counterpartyWallet.walletAddress)} — confirm the vendor ` +
        `actually changed accounts before paying.`,
    });
  }

  if (args.nearDuplicate) {
    rules.push({
      rule: 'near_duplicate_address',
      reason:
        `This address ${shortenAddress(args.counterpartyWallet.walletAddress)} is almost identical to an existing ` +
        `address for "${args.nearDuplicate.label}" (${shortenAddress(args.nearDuplicate.address)}) — they differ by only ` +
        `a character or two. base58 is case-sensitive, so a look-alike like this is usually an OCR/transcription error ` +
        `pointing at the wrong wallet. Confirm the address is exactly correct before paying.`,
    });
  }

  const confidence = args.row.source_invoice?.confidence;
  if (confidence && confidence.overall < LOW_CONFIDENCE_OVERALL_THRESHOLD) {
    rules.push({
      rule: 'low_extraction_confidence',
      reason: `Overall extraction confidence ${confidence.overall.toFixed(2)} below threshold ${LOW_CONFIDENCE_OVERALL_THRESHOLD}.`,
    });
  }

  if (confidence && confidence.amount < LOW_CONFIDENCE_AMOUNT_THRESHOLD) {
    rules.push({
      rule: 'amount_ambiguous',
      reason: `Amount confidence ${confidence.amount.toFixed(2)} below threshold ${LOW_CONFIDENCE_AMOUNT_THRESHOLD}.`,
    });
  }

  return rules;
}

function parseUsdcAmountToRaw(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RangeError('Amount must be positive.');
  }
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

function parseOptionalDate(value: string | null | undefined) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUsdLikeCurrency(currency: string): boolean {
  const normalized = currency.trim().toUpperCase();
  return normalized === 'USDC' || normalized === 'USD' || normalized === '$';
}

function buildSkippedRow(
  row: ExtractedRow,
  reason: InvoiceIntakeSkippedRow['reason'],
  message: string,
): InvoiceIntakeSkippedRow {
  return {
    counterparty: row.counterparty,
    amount: row.amount,
    currency: row.currency,
    reference: row.reference,
    walletAddress: normalizeOptionalText(row.wallet_address),
    reason,
    message,
  };
}

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isValidSolanaWalletAddress(value: string): boolean {
  try {
    deriveUsdcAtaForWallet(value);
    return true;
  } catch {
    return false;
  }
}

function shortenAddress(address: string) {
  return address.length <= 12 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
