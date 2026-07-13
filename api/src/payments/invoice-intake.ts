import type { Counterparty, CounterpartyWallet, Prisma } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { deriveUsdcAtaForWallet, SOLANA_CHAIN, USDC_ASSET, USDC_DECIMALS } from '../solana.js';
import { createPaymentOrder } from './orders.js';
import {
  storeInvoiceDocument,
  storeInvoiceDocumentPages,
  setInvoiceDocumentPageCount,
  setInvoiceDocumentStatus,
} from './documents.js';
import { extractPaymentRowsFromDocument, renderDocumentToImages, type ExtractedRow } from './document-extract.js';
import { extractPdfTextLayer, refineInvoiceSources, PROVENANCE_VERSION } from './doc-provenance.js';
import { suggestOcrCodings } from '../accounting/ocr-coding.js';
import { INVOICE_IMPORT_REVIEW_NOTE } from '../counterparty-wallets.js';

const NEW_COUNTERPARTY_REVIEW_THRESHOLD_RAW = 1_000n * 10n ** BigInt(USDC_DECIMALS);
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

export async function uploadInvoiceToPaymentOrders(args: {
  organizationId: string;
  actorUserId: string;
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  sourceTreasuryWalletId?: string | null;
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
// already looking at the stored document on the review screen.
export async function processInvoiceDocument(args: {
  organizationId: string;
  actorUserId: string;
  invoiceDocumentId: string | null;
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  sourceTreasuryWalletId?: string | null;
}) {
  // Render page images once — the review screen displays these (never a PDF
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

  const invoiceDocumentId = args.invoiceDocumentId;
  const extraction = await runtime.extractRowsFromDocument({
    fileBytes: args.fileBytes,
    filename: args.filename,
    mimeType: args.mimeType,
    prerenderedPages,
  });

  // Exact provenance: re-locate every extracted value in the PDF's text layer
  // and replace the model's approximate boxes with real word coordinates.
  // Best-effort — scans and images have no text layer and keep the model's box.
  try {
    const textPages = await extractPdfTextLayer({
      fileBytes: args.fileBytes,
      filename: args.filename,
      mimeType: args.mimeType,
    });
    if (textPages) {
      let refined = 0;
      for (const row of extraction.rows) {
        if (row.source_invoice) refined += refineInvoiceSources(row.source_invoice, textPages).refined;
      }
      logger.info('invoice_intake.provenance_refined', {
        organizationId: args.organizationId,
        filename: args.filename,
        refined,
      });
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
      const triggeredRules = deriveReviewRules({
        row,
        amountRaw,
        counterpartyWallet,
        vendorAddressContext,
        nearDuplicate,
      });
      // Review is mandatory for EVERY uploaded bill — known vendor or not
      // (pipeline v3 ruling, 2026-07-07). The operator confirms what was read
      // from the document; "Confirm & send for approval" is the only door into
      // routing. triggeredRules still matter: they become the review screen's
      // flags and banners.
      const decision = 'needs_review';

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
        initialState: 'needs_review',
      });

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

// Async intake: store the document and return immediately so the review screen
// can open with the document visible while extraction runs in the background.
// Progress is observed via the document's status (processing → processed/failed).
export async function beginAsyncInvoiceIntake(args: {
  organizationId: string;
  actorUserId: string;
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  sourceTreasuryWalletId?: string | null;
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

  void (async () => {
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
  })();

  return { invoiceDocumentId: stored.invoiceDocumentId, reused: false };
}

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

function deriveReviewRules(args: {
  row: ExtractedRow;
  amountRaw: bigint;
  counterpartyWallet: Pick<CounterpartyWallet, 'trustState' | 'label' | 'walletAddress'> & { counterparty: Counterparty | null };
  vendorAddressContext: VendorAddressContext;
  nearDuplicate: NearDuplicateAddress | null;
}) {
  const rules: Array<{ rule: string; reason: string }> = [];

  if (args.counterpartyWallet.trustState === 'unreviewed') {
    rules.push({
      rule: args.amountRaw > NEW_COUNTERPARTY_REVIEW_THRESHOLD_RAW
        ? 'new_counterparty_threshold'
        : 'unreviewed_counterparty',
      reason:
        args.amountRaw > NEW_COUNTERPARTY_REVIEW_THRESHOLD_RAW
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
