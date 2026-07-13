// Exact field→document provenance from the PDF text layer.
//
// The vision model's bounding boxes are approximate at best. For digital PDFs,
// poppler's `pdftotext -bbox` gives EXACT per-word coordinates, so after
// extraction we re-locate every extracted value in the text layer and replace
// the model's guess with the real box. The model's box survives only as a
// fallback (scanned PDFs and image uploads have no text layer) and as the
// disambiguation hint when a value appears more than once on the document.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../infra/logger.js';
import type { ExtractedInvoice } from './document-extract.js';

const execFileAsync = promisify(execFile);

// Version of the matcher; stamped wherever refinement ran so the review path
// knows to re-run after matcher improvements.
export const PROVENANCE_VERSION = 3; // v3: vendor name/email + per-part remit-to anchors

export type TextWord = { text: string; x0: number; y0: number; x1: number; y1: number }; // 0-1 fractions, top-left origin
export type TextPage = { words: TextWord[] };

type Box = { page: number; x0: number; y0: number; x1: number; y1: number }; // page is 1-based
type SourceBox = { page: number; box: [number, number, number, number] };

// ---------------------------------------------------------------------------
// Text-layer extraction (PDF only)
// ---------------------------------------------------------------------------

export async function extractPdfTextLayer(args: {
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
}): Promise<TextPage[] | null> {
  const isPdf = args.mimeType === 'application/pdf' || args.filename.toLowerCase().endsWith('.pdf');
  if (!isPdf) return null;

  const dir = await mkdtemp(join(tmpdir(), 'doc-prov-'));
  try {
    const inPath = join(dir, 'input.pdf');
    await writeFile(inPath, args.fileBytes);
    const { stdout } = await execFileAsync('pdftotext', ['-bbox', inPath, '-'], { maxBuffer: 64 * 1024 * 1024 });
    const pages = parseBboxXml(stdout);
    // A scanned PDF has a page skeleton but no words — treat as no text layer.
    return pages.some((p) => p.words.length > 0) ? pages : null;
  } catch (error) {
    logger.warn('doc_provenance.text_layer_failed', {
      filename: args.filename,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function parseBboxXml(xml: string): TextPage[] {
  const pages: TextPage[] = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
  let pageMatch: RegExpExecArray | null;
  while ((pageMatch = pageRe.exec(xml)) !== null) {
    const width = Number(pageMatch[1]);
    const height = Number(pageMatch[2]);
    const words: TextWord[] = [];
    let wordMatch: RegExpExecArray | null;
    while ((wordMatch = wordRe.exec(pageMatch[3]!)) !== null) {
      if (!width || !height) continue;
      words.push({
        text: unescapeXml(wordMatch[5]!),
        x0: Number(wordMatch[1]) / width,
        y0: Number(wordMatch[2]) / height,
        x1: Number(wordMatch[3]) / width,
        y1: Number(wordMatch[4]) / height,
      });
    }
    pages.push({ words });
  }
  return pages;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function numOf(s: string): number | null {
  const cleaned = s.replace(/[^0-9.\-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const MAX_WINDOW = 14;

// Every place a text value appears: sliding window over consecutive words,
// comparing punctuation-free concatenations (robust to tokenization — the
// value "INV-20411" matches the word "INV-20411"; "Net 30" matches two words).
export function findTextMatches(pages: TextPage[], variants: string[]): Box[] {
  const targets = [...new Set(variants.map(norm).filter((t) => t.length >= 2))];
  if (targets.length === 0) return [];
  const out: Box[] = [];
  pages.forEach((page, pageIndex) => {
    for (let i = 0; i < page.words.length; i += 1) {
      let joined = '';
      for (let len = 1; len <= MAX_WINDOW && i + len <= page.words.length; len += 1) {
        const w = page.words[i + len - 1]!;
        joined += norm(w.text);
        if (joined.length > 80) break;
        for (const target of targets) {
          const hit = joined === target
            // A value embedded in a single larger word ("ap@acme.example" ⊃ "acme"),
            // only for reasonably long targets so "1" can't match everything.
            || (len === 1 && target.length >= 5 && joined.includes(target));
          if (hit) {
            out.push(unionBox(pageIndex + 1, page.words.slice(i, i + len)));
          }
        }
        if (joined.length >= Math.max(...targets.map((t) => t.length)) && len > 1) break;
      }
    }
  });
  return dedupeBoxes(out);
}

// Every place an amount appears (1-2 word windows: "$4,820.00" or "$ 4,820.00").
// Every word in the window must be money-shaped — otherwise a label glued to
// its figure ("Subtotal" + "$0.15") would also read as the amount.
const isMoneyToken = (t: string) => /^[$€£¥]$/.test(t) || /^[($€£¥-]{0,2}[\d,]+(\.\d+)?\)?$/.test(t);

export function findAmountMatches(pages: TextPage[], value: number): Box[] {
  const out: Box[] = [];
  pages.forEach((page, pageIndex) => {
    for (let i = 0; i < page.words.length; i += 1) {
      for (let len = 1; len <= 2 && i + len <= page.words.length; len += 1) {
        const words = page.words.slice(i, i + len);
        if (!words.every((w) => isMoneyToken(w.text))) break;
        const n = numOf(words.map((w) => w.text).join(''));
        if (n != null && Math.abs(n - value) < 0.005) {
          out.push(unionBox(pageIndex + 1, words));
          break;
        }
      }
    }
  });
  return dedupeBoxes(out);
}

function unionBox(page: number, words: TextWord[]): Box {
  return {
    page,
    x0: Math.min(...words.map((w) => w.x0)),
    y0: Math.min(...words.map((w) => w.y0)),
    x1: Math.max(...words.map((w) => w.x1)),
    y1: Math.max(...words.map((w) => w.y1)),
  };
}

function dedupeBoxes(boxes: Box[]): Box[] {
  const out: Box[] = [];
  for (const b of boxes) {
    const dup = out.some((o) =>
      o.page === b.page
      && Math.abs(o.x0 - b.x0) < 0.005 && Math.abs(o.y0 - b.y0) < 0.005
      && Math.abs(o.x1 - b.x1) < 0.005 && Math.abs(o.y1 - b.y1) < 0.005);
    if (!dup) out.push(b);
  }
  return out;
}

// Choose among multiple occurrences: nearest to the model's approximate box
// when we have one; otherwise bottom-most for totals, first for everything else.
function pickMatch(matches: Box[], hint: SourceBox | null | undefined, prefer: 'first' | 'bottom' = 'first'): Box | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  if (hint && Array.isArray(hint.box)) {
    const hx = hint.box[0] + hint.box[2] / 2;
    const hy = hint.box[1] + hint.box[3] / 2;
    let best = matches[0]!;
    let bestScore = Infinity;
    for (const m of matches) {
      const cx = (m.x0 + m.x1) / 2;
      const cy = (m.y0 + m.y1) / 2;
      const pagePenalty = m.page === hint.page ? 0 : 10;
      const score = Math.hypot(cx - hx, cy - hy) + pagePenalty;
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }
  if (prefer === 'bottom') {
    return matches.reduce((a, b) => (b.page > a.page || (b.page === a.page && b.y1 > a.y1) ? b : a));
  }
  return matches[0]!;
}

// All words sharing the matched words' text line — the full table row.
export function expandToRow(page: TextPage, match: Box): Box {
  const cy = (match.y0 + match.y1) / 2;
  const h = match.y1 - match.y0;
  const rowWords = page.words.filter((w) => {
    const wc = (w.y0 + w.y1) / 2;
    return Math.abs(wc - cy) < Math.max(h, w.y1 - w.y0) * 0.7;
  });
  if (rowWords.length === 0) return match;
  const u = unionBox(match.page, rowWords);
  return {
    page: match.page,
    x0: Math.min(u.x0, match.x0),
    y0: Math.min(u.y0, match.y0),
    x1: Math.max(u.x1, match.x1),
    y1: Math.max(u.y1, match.y1),
  };
}

const PAD = 0.006;

function toSource(b: Box): SourceBox {
  const x0 = Math.max(0, b.x0 - PAD);
  const y0 = Math.max(0, b.y0 - PAD);
  const x1 = Math.min(1, b.x1 + PAD);
  const y1 = Math.min(1, b.y1 + PAD);
  return { page: b.page, box: [x0, y0, x1 - x0, y1 - y0] };
}

export function dateVariants(iso: string): string[] {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [iso];
  const [, yyyy, mm, dd] = m;
  const monthIndex = Number(mm) - 1;
  if (monthIndex < 0 || monthIndex > 11) return [iso];
  const long = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][monthIndex]!;
  const short = long.slice(0, 3);
  const d = String(Number(dd));
  const mo = String(Number(mm));
  return [
    iso,
    `${mo}/${d}/${yyyy}`, `${mm}/${dd}/${yyyy}`,
    `${d}/${mo}/${yyyy}`, `${dd}/${mm}/${yyyy}`,
    `${mm}-${dd}-${yyyy}`, `${dd}-${mm}-${yyyy}`,
    `${long} ${d}, ${yyyy}`, `${short} ${d}, ${yyyy}`,
    `${long} ${dd}, ${yyyy}`, `${short} ${dd}, ${yyyy}`,
    `${d} ${long} ${yyyy}`, `${d} ${short} ${yyyy}`,
    `${dd} ${long} ${yyyy}`, `${dd} ${short} ${yyyy}`,
  ];
}

// ---------------------------------------------------------------------------
// Refinement
// ---------------------------------------------------------------------------

export function refineInvoiceSources(invoice: ExtractedInvoice, pages: TextPage[]): { refined: number } {
  let refined = 0;
  const sources: Record<string, SourceBox | null> = { ...(invoice.fieldSources ?? {}) };
  const hint = (key: string) => sources[key] ?? null;

  const setIfFound = (key: string, matches: Box[], prefer: 'first' | 'bottom' = 'first') => {
    const chosen = pickMatch(matches, hint(key), prefer);
    if (chosen) {
      sources[key] = toSource(chosen);
      refined += 1;
    }
  };

  if (invoice.invoiceNumber) setIfFound('invoiceNumber', findTextMatches(pages, [invoice.invoiceNumber]));
  if (invoice.invoiceDate) setIfFound('invoiceDate', findTextMatches(pages, dateVariants(invoice.invoiceDate)));
  if (invoice.dueDate) setIfFound('dueDate', findTextMatches(pages, dateVariants(invoice.dueDate)));
  if (invoice.terms) setIfFound('terms', findTextMatches(pages, [invoice.terms]));
  if (invoice.poNumber) setIfFound('poNumber', findTextMatches(pages, [invoice.poNumber]));
  if (invoice.earlyPayDiscount) setIfFound('earlyPayDiscount', findTextMatches(pages, [invoice.earlyPayDiscount]));
  if (invoice.currency) setIfFound('currency', findTextMatches(pages, [invoice.currency]));
  if (invoice.amount) setIfFound('total', findAmountMatches(pages, invoice.amount), 'bottom');
  // Subtotal/tax live in the totals block near the bottom; the same figure may
  // also appear as a line amount above, so prefer the bottom occurrence.
  if (invoice.subtotal) setIfFound('subtotal', findAmountMatches(pages, invoice.subtotal), 'bottom');
  if (invoice.taxAmount) setIfFound('taxAmount', findAmountMatches(pages, invoice.taxAmount), 'bottom');
  if (invoice.vendorName) setIfFound('vendorName', findTextMatches(pages, [invoice.vendorName]));
  if (invoice.vendorEmail) setIfFound('vendorEmail', findTextMatches(pages, [invoice.vendorEmail]));

  const remit = invoice.remitTo;
  if (remit) {
    const variants: string[] = [];
    if (remit.street) variants.push(remit.street);
    const cityLine = [remit.city, remit.state, remit.zip].filter(Boolean).join(' ');
    if (cityLine) variants.push(cityLine);
    setIfFound('remitTo', findTextMatches(pages, variants));
    // Per-part anchors so each address field highlights its own words; the
    // combined remitTo box acts as the disambiguation hint (short values like
    // a state code can appear elsewhere on the page).
    const parts: Array<[string, string | null]> = [
      ['remitStreet', remit.street],
      ['remitCity', remit.city],
      ['remitState', remit.state],
      ['remitZip', remit.zip],
    ];
    for (const [key, value] of parts) {
      if (!value) continue;
      const matches = findTextMatches(pages, [value]);
      const chosen = pickMatch(matches, sources.remitTo ?? hint(key), 'first');
      if (chosen) {
        sources[key] = toSource(chosen);
        refined += 1;
      }
    }
  }

  invoice.fieldSources = sources;

  // Line items: locate the description, then take the whole table row —
  // preferring, among duplicate descriptions, the row that carries the
  // line's own amount.
  for (const item of invoice.lineItems) {
    if (!item.description) continue;
    const matches = findTextMatches(pages, [item.description]);
    if (matches.length === 0) continue;
    let rows = matches.map((m) => ({ m, row: expandToRow(pages[m.page - 1]!, m) }));
    if (item.total != null && rows.length > 1) {
      const withAmount = rows.filter(({ row, m }) => {
        const page = pages[m.page - 1]!;
        const cy = (row.y0 + row.y1) / 2;
        return page.words.some((w) => {
          const wc = (w.y0 + w.y1) / 2;
          const n = numOf(w.text);
          return n != null && Math.abs(n - (item.total ?? 0)) < 0.005 && Math.abs(wc - cy) < (row.y1 - row.y0);
        });
      });
      if (withAmount.length > 0) rows = withAmount;
    }
    const chosen = pickMatch(rows.map((r) => r.row), item.source, 'first');
    if (chosen) {
      item.source = toSource(chosen);
      refined += 1;
    }
  }

  return { refined };
}
