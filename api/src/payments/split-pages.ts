// Which pages of an upload belong to which invoice, when one upload holds several.
//
// The extractor returns one row per invoice, but no page ranges. Each row's invoice
// number is the anchor: it belongs to that invoice alone, and it is printed on the
// invoice's own pages. An invoice starts on the first page carrying its number after
// the previous invoice's start, and runs to the page before the next one starts. Pages
// before the first invoice (a cover sheet) go to the first; pages after the last start
// go to the last.
//
// A page carrying several invoices' numbers (a cover sheet listing them, or two
// invoices printed on one page) says nothing about where either starts, so a page of
// a row's own is preferred to a shared one. Where a start can't be found for every
// invoice, there is no plan, and every bill keeps the whole upload, as before.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ExtractedInvoice } from './document-extract.js';

export type PageRange = { from: number; to: number };

/**
 * `numberPages[i]` is every page (1-based) where row i's invoice number is printed, or
 * null when the row has no number or it wasn't found. Returns a range per row, in the
 * rows' order, or null when the upload can't be split with confidence.
 */
export function planPageSplit(numberPages: Array<number[] | null>, pageCount: number): PageRange[] | null {
  const rows = numberPages.length;
  if (rows < 2 || pageCount < 2) return null;
  if (numberPages.some((p) => !p || p.length === 0)) return null;
  const pages = numberPages.map((p) => [...new Set(p!)].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b));
  if (pages.some((p) => p.length === 0)) return null;

  // A page more than one row's number sits on is shared.
  const seen = new Map<number, number>();
  for (const p of pages) for (const n of p) seen.set(n, (seen.get(n) ?? 0) + 1);
  const own = pages.map((p) => p.filter((n) => seen.get(n) === 1));

  // The order the invoices come in: by the first page that is theirs alone, else the
  // first page they appear on, ties kept in the order the rows came back.
  const order = pages
    .map((p, i) => ({ i, first: (own[i]!.length > 0 ? own[i]! : p)[0]! }))
    .sort((a, b) => a.first - b.first || a.i - b.i)
    .map((x) => x.i);

  const starts: Array<{ row: number; start: number }> = [];
  let previous = 0;
  for (const row of order) {
    const after = (list: number[]) => list.find((n) => n > previous);
    const start = after(own[row]!) ?? after(pages[row]!);
    if (start === undefined) return null;
    starts.push({ row, start });
    previous = start;
  }

  const ranges = new Array<PageRange>(rows);
  starts.forEach(({ row, start }, k) => {
    ranges[row] = { from: k === 0 ? 1 : start, to: k + 1 < starts.length ? starts[k + 1]!.start - 1 : pageCount };
  });
  return ranges;
}

// ─── Cutting the pages out ───────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

/** Pages `from` to `to` of a PDF, as a PDF of their own. Poppler, as the rest of the reading uses. */
export async function pdfPages(bytes: Buffer, range: PageRange): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'doc-split-'));
  try {
    const inPath = join(dir, 'upload.pdf');
    await writeFile(inPath, bytes);
    await execFileAsync('pdfseparate', ['-f', String(range.from), '-l', String(range.to), inPath, join(dir, 'page-%d.pdf')]);
    const parts = Array.from({ length: range.to - range.from + 1 }, (_, k) => join(dir, `page-${range.from + k}.pdf`));
    if (parts.length === 1) return await readFile(parts[0]!);
    const outPath = join(dir, 'pages.pdf');
    await execFileAsync('pdfunite', [...parts, outPath]);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The model's boxes, moved into the invoice's own pages: page 3 of the upload is page
 * 2 of pages 2 to 3. A box on a page outside them can't be this invoice's, so it goes,
 * and the measuring that follows looks again within its pages only.
 */
export function shiftSources(invoice: ExtractedInvoice, range: PageRange): void {
  const shift = (source: unknown) => {
    if (!source || typeof source !== 'object') return null;
    const page = Number((source as { page?: unknown }).page);
    if (!Number.isInteger(page) || page < range.from || page > range.to) return null;
    return { ...(source as Record<string, unknown>), page: page - range.from + 1 };
  };
  const record = invoice as unknown as Record<string, unknown>;
  if (record.fieldSources && typeof record.fieldSources === 'object') {
    record.fieldSources = Object.fromEntries(Object.entries(record.fieldSources as Record<string, unknown>).map(([key, s]) => [key, shift(s)]));
  }
  for (const line of Array.isArray(record.lineItems) ? record.lineItems : []) {
    if (line && typeof line === 'object' && 'source' in line) (line as Record<string, unknown>).source = shift((line as Record<string, unknown>).source);
  }
}

// ─── A bill's own pages ──────────────────────────────────────────────────────

/**
 * Where a bill's own pages are, when its upload held several invoices: a document of
 * their own, and which pages of the upload they were. Kept on the bill
 * (metadata.agent.sourceDocument.pages); the bill's invoiceDocumentId stays the upload,
 * which is the job everything about the reading hangs off.
 */
export type BillPages = { invoiceDocumentId: string; filename: string; from: number; to: number; of: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function pagesOf(metadata: unknown): BillPages | null {
  const agent = isRecord(metadata) && isRecord(metadata.agent) ? metadata.agent : null;
  const source = agent && isRecord(agent.sourceDocument) ? agent.sourceDocument : null;
  const p = source && isRecord(source.pages) ? source.pages : null;
  if (!p || typeof p.invoiceDocumentId !== 'string') return null;
  const [from, to, of] = [Number(p.from), Number(p.to), Number(p.of)];
  if (![from, to, of].every(Number.isInteger) || from < 1 || to < from || of < to) return null;
  return { invoiceDocumentId: p.invoiceDocumentId, filename: typeof p.filename === 'string' ? p.filename : 'pages.pdf', from, to, of };
}

/** The document that is this bill's: its own pages when it has them, else the upload. */
export function billDocumentIdOf(order: { invoiceDocumentId: string | null; metadataJson: unknown }): string | null {
  return pagesOf(order.metadataJson)?.invoiceDocumentId ?? order.invoiceDocumentId;
}
