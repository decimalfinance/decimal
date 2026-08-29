// Exact field→document provenance from the words actually printed on the page.
//
// The vision model's bounding boxes are not approximate. They are INVENTED, and
// the invention is tidy enough to look like data — C1 and C2, two unrelated
// invoices, both came back with vendorName at exactly [0.05, 0.05, 0.4, 0.07]
// and their header fields on a perfect 0.03 ladder. Asked where a value sits, a
// vision model writes down a plausible layout rather than a measurement.
//
// So a box is only ever shown if it was MEASURED, from one of two sources of
// real word coordinates:
//
//   digital PDF   → poppler `pdftotext -bbox`   (exact characters, exact boxes)
//   image / scan  → tesseract TSV               (OCR words, measured boxes)
//
// Both produce the same TextPage[], so one matcher serves both. Where neither
// can run, the model's guesses are STRIPPED rather than displayed: pointing
// confidently at the wrong part of the page is worse than not pointing, because
// the highlight is a claim about where the number came from.
//
// The model's box survives only as the disambiguation hint when a value appears
// more than once on the document — a rough location is enough to pick between
// two real matches, which is the one job it can do.
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
export const PROVENANCE_VERSION = 13; // v13: margins scale with the text

export type TextWord = { text: string; x0: number; y0: number; x1: number; y1: number }; // 0-1 fractions, top-left origin
export type TextPage = {
  words: TextWord[];
  /** Page width / height in pixels. Needed to reason about angles, which live
   *  in pixel space while every coordinate here is a fraction of a side. */
  aspect?: number;
  /** How far the printed text tilts, in degrees, clockwise-positive. Zero for
   *  a digital PDF; a photograph is rarely quite straight. */
  skewDeg?: number;
};

type Box = { page: number; x0: number; y0: number; x1: number; y1: number }; // page is 1-based
type SourceBox = {
  page: number;
  box: [number, number, number, number];
  /** Degrees to rotate the box about its own centre, when the page is tilted. */
  angle?: number;
};

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

/**
 * The document's own text, with its columns still standing.
 *
 * Sibling of extractPdfTextLayer, which returns word boxes — the right shape
 * for re-locating a value on a page and the wrong shape for reading. This is
 * the shape you put in front of a model.
 *
 * `-layout` rather than plain text, because an invoice is a table and plain
 * text destroys it: the description, the quantity and the amount collapse onto
 * one line with no way to tell which number belongs to which row. Column
 * spacing carries that meaning, and pdftotext preserves it as whitespace:
 *
 *     Dashboard build-out (3)        3     $540.00      $1,620.00
 *
 * A markdown/table converter (Docling, MinerU) is the answer if this proves
 * insufficient on harder layouts. Not yet: the grounding and arithmetic checks
 * downstream will say so, and a dependency added before it is earned is how a
 * pipeline gets slow.
 */
export async function extractPdfLayoutText(args: {
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
}): Promise<string | null> {
  const isPdf = args.mimeType === 'application/pdf' || args.filename.toLowerCase().endsWith('.pdf');
  if (!isPdf) return null;

  const dir = await mkdtemp(join(tmpdir(), 'doc-text-'));
  try {
    const inPath = join(dir, 'input.pdf');
    await writeFile(inPath, args.fileBytes);
    const { stdout } = await execFileAsync('pdftotext', ['-layout', inPath, '-'], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim() ? stdout : null;
  } catch (error) {
    logger.warn('doc_provenance.layout_text_failed', {
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
    // A digital PDF's text layer is not tilted — it has no camera. Geometry is
    // reported anyway so every TextPage answers the same questions.
    pages.push({ words, aspect: width / height, skewDeg: 0 });
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
// Word coordinates from an image (OCR)
// ---------------------------------------------------------------------------

/**
 * Real word boxes for a page image, via tesseract's TSV output.
 *
 * This is the half of provenance that never existed. Photographs and scans have
 * no text layer, so nothing could be measured and the model's invented boxes
 * were rendered as though they were facts — which is what put the highlight on
 * blank paper three lines below the line item somebody clicked.
 *
 * OCR is used for POSITION ONLY, never to decide what the document says. Its
 * characters are a guess; its coordinates are a measurement. Grounding stays on
 * the PDF text layer, where the characters are exact, so a misread digit can
 * never claim a figure is missing from the page.
 *
 * Returns null when tesseract is not installed, so the app runs without it —
 * boxes are then stripped rather than faked.
 */
export async function extractImageTextLayer(
  pageImages: Array<{ bytes: Buffer }>,
): Promise<TextPage[] | null> {
  if (pageImages.length === 0) return null;
  const dir = await mkdtemp(join(tmpdir(), 'doc-ocr-'));
  try {
    const pages: TextPage[] = [];
    for (const [index, page] of pageImages.entries()) {
      const raw = join(dir, `page-${index}.png`);
      await writeFile(raw, page.bytes);
      const enlarged = await upscaleForOcr(raw, dir, index);

      // Several passes over the same page, because they fail differently and
      // the union of what they find is strictly better than any one of them.
      //
      //   psm 3   reads the page as a laid-out document; its tokenization is
      //           what the matcher needs
      //   psm 11  treats it as scattered text and picks up words psm 3 walks
      //           past
      //   1x/2x   enlarging resolves characters on a soft scan, but changes
      //           how words are split — C1's vendor name matched at the stored
      //           size and stopped matching when enlarged, while its invoice
      //           number and due date did the opposite
      //
      // Reading order survives because each pass's words are appended as a
      // block: the matcher slides its window over consecutive words, and every
      // pass's own run stays contiguous.
      //
      // Measured on the C series, not assumed. Four passes cost about two
      // seconds on a document that is read once.
      const scales = enlarged === raw ? [raw] : [raw, enlarged];
      const passes = await Promise.all(
        scales.flatMap((path) => ['3', '11'].map(async (psm) => {
          const { stdout } = await execFileAsync(
            'tesseract',
            [path, 'stdout', '--psm', psm, 'tsv'],
            { maxBuffer: 64 * 1024 * 1024 },
          );
          return parseTesseractTsv(stdout);
        })),
      );
      pages.push(mergeWordPages(passes));
    }
    return pages.some((p) => p.words.length > 0) ? pages : null;
  } catch (error) {
    // ENOENT means tesseract is not installed. Everything still works; images
    // just get no highlights, which is the honest outcome.
    const code = (error as { code?: string }).code;
    logger.warn('doc_provenance.ocr_failed', {
      ...(code === 'ENOENT'
        ? { message: 'tesseract not installed — image documents get no source highlights. brew install tesseract' }
        : {}),
      ...(error instanceof Error ? { message: error.message } : {}),
    });
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Small scans read far better enlarged.
 *
 * The single biggest thing between a photograph and a working highlight. C2 is
 * a soft 150dpi scan: at its stored size tesseract located 4 fields and neither
 * line item; at twice the size, 12 fields and both lines. Nothing else tried
 * came close — more page-segmentation modes, different confidence floors —
 * because the characters were simply too few pixels to resolve.
 *
 * Only ever enlarges. `sips -Z` resizes to fit, so running it unconditionally
 * would SHRINK a high-resolution scan and undo the very thing this is for.
 *
 * Returns the original path on any failure, so a machine without sips still
 * does OCR, just on the smaller image.
 */
async function upscaleForOcr(imgPath: string, dir: string, index: number): Promise<string> {
  const ENOUGH = 3000;
  try {
    const { stdout } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imgPath]);
    const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    const longest = Math.max(width || 0, height || 0);
    if (!longest || longest >= ENOUGH) return imgPath;
    const outPath = join(dir, `page-${index}-big.png`);
    await execFileAsync('sips', ['-Z', String(Math.min(longest * 2, 4000)), imgPath, '--out', outPath]);
    return outPath;
  } catch {
    return imgPath;
  }
}

/**
 * One word list from several OCR passes over the same image.
 *
 * Concatenated, NOT deduplicated, and that is the whole subtlety. The matcher
 * slides a window over consecutive words, so each pass's output has to stay a
 * contiguous run. Dropping a word from the second pass because the first pass
 * already found it punches a hole in the second pass's run and breaks every
 * multi-word match across it — which cost three fields when tried, including
 * two the extra pass had just gained.
 *
 * Duplicates are harmless: they produce duplicate candidate matches in the same
 * place, and pickMatch picks one.
 */
export function mergeWordPages(pages: TextPage[]): TextPage {
  const skews = pages.map((p) => p.skewDeg ?? 0).filter((d) => d !== 0).sort((a, b) => a - b);
  return {
    words: pages.flatMap((page) => page.words),
    aspect: pages.find((p) => p.aspect)?.aspect,
    // Each pass measures the same page, so they should agree; the median is
    // there so one bad pass cannot tilt every box.
    skewDeg: skews.length ? skews[Math.floor(skews.length / 2)] : 0,
  };
}

/**
 * tesseract TSV: level, page_num, block_num, par_num, line_num, word_num,
 * left, top, width, height, conf, text — coordinates in PIXELS, so the
 * page-level row (level 1) carries the image dimensions we normalise against.
 */
export function parseTesseractTsv(tsv: string): TextPage {
  const lines = tsv.split(/\r?\n/);
  const header = lines[0]?.split('\t') ?? [];
  const col = (name: string) => header.indexOf(name);
  const iLevel = col('level'), iLeft = col('left'), iTop = col('top');
  const iWidth = col('width'), iHeight = col('height'), iConf = col('conf'), iText = col('text');
  if (iLevel < 0 || iLeft < 0 || iText < 0) return { words: [] };

  // Tesseract's OWN line segmentation, which is the only grouping that follows
  // tilted text. Kept for the skew estimate below and nothing else.
  const iBlock = col('block_num'), iPar = col('par_num'), iLine = col('line_num');

  let pageWidth = 0;
  let pageHeight = 0;
  type Row = { left: number; top: number; width: number; height: number; conf: number; text: string; line: string };
  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    if (cells.length <= iText) continue;
    const level = Number(cells[iLevel]);
    const left = Number(cells[iLeft]), top = Number(cells[iTop]);
    const width = Number(cells[iWidth]), height = Number(cells[iHeight]);
    if (level === 1) { pageWidth = width; pageHeight = height; continue; }
    if (level !== 5) continue; // 5 = word
    const text = cells[iText] ?? '';
    if (!text.trim()) continue;
    rows.push({
      left, top, width, height, conf: Number(cells[iConf]), text,
      line: `${cells[iBlock]}/${cells[iPar]}/${cells[iLine]}`,
    });
  }
  if (!pageWidth || !pageHeight) return { words: [] };

  // Low-confidence tokens are usually paper texture read as punctuation. They
  // cannot help a match and can only drag a box somewhere wrong.
  const MIN_CONF = 30;
  const kept = rows.filter((r) => !Number.isFinite(r.conf) || r.conf >= MIN_CONF);
  const words: TextWord[] = kept.map((r) => ({
    text: r.text,
    x0: r.left / pageWidth,
    y0: r.top / pageHeight,
    x1: (r.left + r.width) / pageWidth,
    y1: (r.top + r.height) / pageHeight,
  }));

  // Skew, from the word centres of each tesseract line, in PIXELS — an angle is
  // a fact about pixels, and these coordinates are about to become fractions of
  // two different page dimensions.
  const byLine = new Map<string, Array<{ x: number; y: number }>>();
  for (const r of kept) {
    const at = byLine.get(r.line) ?? [];
    at.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    byLine.set(r.line, at);
  }
  return {
    words,
    aspect: pageWidth / pageHeight,
    skewDeg: estimateSkewDeg([...byLine.values()], pageWidth * 0.08),
  };
}

// Below this the tilt is not worth correcting, and a small misestimate would
// move boxes for no reason.
const MIN_SKEW_DEG = 0.5;

/**
 * How far the printed text tilts, from the lines tesseract itself found.
 *
 * The grouping has to be tesseract's own (block/paragraph/line), not ours by
 * vertical proximity. On tilted text a line drifts further vertically than a
 * word is tall, so proximity grouping chops it into level fragments and every
 * slope it measures comes out near zero — which is exactly what a first attempt
 * at this reported for C1: 0.15°, for a page that is tilted 1.94°.
 *
 * Median rather than mean: one misread line with a stray word at the far edge
 * would drag an average a long way, and a page has one tilt.
 */
export function estimateSkewDeg(lines: Array<Array<{ x: number; y: number }>>, minSpanPx = 100): number {
  const angles: number[] = [];
  for (const words of lines) {
    if (words.length < 3) continue;
    const sorted = [...words].sort((a, b) => a.x - b.x);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const dx = last.x - first.x;
    // A short line cannot pin down an angle: a couple of pixels of noise at
    // each end is degrees of slope.
    if (dx < minSpanPx) continue;
    angles.push(Math.atan2(last.y - first.y, dx) * 180 / Math.PI);
  }
  if (angles.length === 0) return 0;
  angles.sort((a, b) => a - b);
  return angles[Math.floor(angles.length / 2)]!;
}

export type WordSource = 'text-layer' | 'ocr' | 'none';

/**
 * The words on this document, however they can be got.
 *
 * `source` matters to the caller: only `text-layer` may be used for grounding
 * (see ungroundedFields), because only exact characters can prove a value is
 * absent. `ocr` is good for position and nothing else.
 */
export async function locateDocumentWords(args: {
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
  /** Rendered page images, for when there is no text layer to read. */
  renderPages?: () => Promise<Array<{ bytes: Buffer }>>;
}): Promise<{ pages: TextPage[] | null; source: WordSource }> {
  const textLayer = await extractPdfTextLayer(args);
  if (textLayer) return { pages: textLayer, source: 'text-layer' };
  if (!args.renderPages) return { pages: null, source: 'none' };
  try {
    const ocr = await extractImageTextLayer(await args.renderPages());
    return ocr ? { pages: ocr, source: 'ocr' } : { pages: null, source: 'none' };
  } catch (error) {
    logger.warn('doc_provenance.render_for_ocr_failed', {
      filename: args.filename,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
    return { pages: null, source: 'none' };
  }
}

/**
 * Throw away every box we could not measure.
 *
 * Called when no word coordinates could be got at all. The alternative is
 * leaving the model's invented ladder in place, which is what shipped: a
 * highlight is a claim that the value was read from THIS spot, and an
 * authoritative-looking box over blank paper is a lie the UI tells in our voice.
 * A field with no box simply does not highlight, which the viewer already
 * handles.
 */
export function stripUnmeasuredSources(invoice: Record<string, unknown>): void {
  delete invoice.fieldSources;
  const lines = invoice.lineItems;
  if (Array.isArray(lines)) {
    for (const line of lines) {
      if (line && typeof line === 'object') delete (line as Record<string, unknown>).source;
    }
  }
}

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
  //
  // A NEWLINE is the third separator, and the one a letterhead actually uses:
  //
  //     340 Congress St
  //     Austin, TX 78701
  //
  // It only started arriving once extraction began reading the PDF's own text,
  // because pdftotext preserves the document's line breaks and the vision model
  // had been quietly converting them to "·". So this had been correct against
  // every input it was ever shown, and wrong about the format the document is
  // actually written in — the street came out "340 Congress St\nAustin", which
  // the browser then collapsed into "340 Congress StAustin".
  const parts = address
    .replace(/[·•|\r\n]+/g, ',')
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
  // Exact figures first; same figure with the opposite sign as a fallback.
  //
  // A credit note prints "-$240.00" and the extraction reports 240, so the
  // signed comparison was off by 480 and found nothing at all — leaving the
  // model's guessed box in place, which pointed at blank paper halfway down
  // the page. The number on the document IS the number in the field; the sign
  // is a disagreement about whether it is owed or owing, and losing the
  // highlight is the wrong way to express that.
  //
  // Kept as a fallback rather than matching magnitudes outright, so a document
  // carrying both +240 and -240 still anchors to the one that actually agrees.
  const exact: Box[] = [];
  const sameMagnitude: Box[] = [];
  pages.forEach((page, pageIndex) => {
    for (let i = 0; i < page.words.length; i += 1) {
      for (let len = 1; len <= 2 && i + len <= page.words.length; len += 1) {
        const words = page.words.slice(i, i + len);
        if (!words.every((w) => isMoneyToken(w.text))) break;
        const n = numOf(words.map((w) => w.text).join(''));
        if (n == null) continue;
        if (Math.abs(n - value) < 0.005) {
          exact.push(unionBox(pageIndex + 1, words));
          break;
        }
        if (Math.abs(Math.abs(n) - Math.abs(value)) < 0.005) {
          sameMagnitude.push(unionBox(pageIndex + 1, words));
          break;
        }
      }
    }
  });
  return dedupeBoxes(exact.length > 0 ? exact : sameMagnitude);
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
/**
 * Is this word on the same printed row as the match?
 *
 * "At the same height" is the obvious test and it is wrong on a tilted page,
 * which is most photographs. C1 slopes 1.79° down to the right, so a row's
 * amount sits LOWER than its own description by about as much as one row is
 * tall — and a flat band around "Drayage — Port of Oakland" cannot reach the
 * $450.00 that belongs to it, while the $950.00 belonging to the row ABOVE
 * falls squarely inside. The highlight then spans one row's description and the
 * previous row's money, which is a worse mistake than not highlighting at all:
 * it points at a real figure and says it belongs to this line.
 *
 * Measured on C1: "Drayage" sits at y 0.2317 and its own amount at 0.2463 —
 * 0.0146 apart, against a tolerance of about 0.007. Following the slope
 * predicts 0.2471 for it, which is 0.0008 out, comfortably inside.
 *
 * So the band follows the text rather than the page edge. On a digital PDF the
 * slope is zero and this is exactly the old flat band.
 */
function sameRowAs(page: TextPage, match: Box): (w: TextWord) => boolean {
  const tan = Math.tan((page.skewDeg ?? 0) * Math.PI / 180);
  const aspect = page.aspect ?? 1;
  const cx = (match.x0 + match.x1) / 2;
  const cy = (match.y0 + match.y1) / 2;
  const h = match.y1 - match.y0;
  return (w: TextWord) => {
    const wcx = (w.x0 + w.x1) / 2;
    const wcy = (w.y0 + w.y1) / 2;
    // Where this row's text has fallen to by the time it reaches this word.
    const expected = cy + (wcx - cx) * aspect * tan;
    return Math.abs(wcy - expected) < Math.max(h, w.y1 - w.y0) * 0.7;
  };
}

/**
 * A table row: the description, its figures, and nothing from the next column.
 *
 * "Every word at this height" was the whole rule, and on a two-column invoice it
 * reaches straight across the gutter. C4 puts its line items in a right-hand
 * column and its BILL TO block on the left, and "Dashboard build-out (3)" sits
 * level with "BILL TO" — so the highlight stretched from the middle of the
 * address block to the right margin.
 *
 * A gap threshold cannot fix it, which is worth stating because it is the
 * obvious fix. Measured on that row:
 *
 *     BILL TO  ->  Dashboard    gap 0.215     the gutter, to exclude
 *     (3)      ->  3            gap 0.222     description to QTY, to keep
 *
 * The gutter is SMALLER than the gap inside the table. Any threshold that drops
 * one drops the other.
 *
 * So the row is bounded by things we know rather than by whitespace: the
 * description on the left, and the line's own amount on the right. Both ends are
 * values we already hold, and the row is what lies between them.
 */
export function expandToRow(page: TextPage, match: Box, amount?: number | null): Box {
  const rowWords = page.words.filter(sameRowAs(page, match));
  if (rowWords.length === 0) return match;

  // Right edge: the line's own amount, when it is printed on this line. Past it
  // is a different column, and on a one-column invoice there is nothing there
  // anyway — so this costs nothing where it is not needed.
  let right = Infinity;
  if (amount != null) {
    for (const w of rowWords) {
      const n = numOf(w.text);
      if (n != null && Math.abs(Math.abs(n) - Math.abs(amount)) < 0.005) right = Math.max(right === Infinity ? 0 : right, w.x1);
    }
  }

  // Left edge: the description. A line item reads left to right — description
  // first, then its figures — so anything left of the description is another
  // column, not part of this row. Short hops are still allowed, for a row
  // number or a bullet printed just before the text.
  const LEFT_REACH = 0.03;
  let left = match.x0;
  for (const w of [...rowWords].sort((a, b) => b.x0 - a.x0)) {
    if (w.x1 > left) continue;
    if (w.x1 < left - LEFT_REACH) break;
    left = w.x0;
  }

  const kept = rowWords.filter((w) => w.x1 <= right + 1e-6 && w.x0 >= left - 1e-6);
  if (kept.length === 0) return match;
  const u = unionBox(match.page, kept);
  return {
    page: match.page,
    x0: Math.min(u.x0, match.x0),
    y0: Math.min(u.y0, match.y0),
    x1: Math.max(u.x1, match.x1),
    y1: Math.max(u.y1, match.y1),
  };
}

const PAD = 0.006;

// A tilted box is built from the measured height of its own text, so these are
// in multiples of that: the box is 2 x 0.6 tall with 0.25 of margin each side.
//
// These were briefly a fifth larger. The box looked cropped, and growing it was
// the wrong answer — the outline was 2px, so most of what read as "cutting into
// the text" was the border itself, and a bigger box only left slack below the
// words for the border to sit in. A hairline outline fixed the look; the extra
// height is back off.
const TILTED_HALF_HEIGHT = 0.6;
// Vertical margin as a multiple of the text's own height. A box round one line
// of a tightly-set letterhead has very little room before it starts covering
// the line beneath.
const BOX_PAD = 0.25;

/**
 * The box the viewer draws — tightened and tilted to sit on tilted text.
 *
 * Every box here is an axis-aligned rectangle around a run of words, which is
 * right for a PDF and wrong for a photograph. C1 is tilted 1.94°: across a line
 * item spanning some 790px, the text falls 28px from its start to its end while
 * standing only about 13px tall, so the rectangle enclosing it comes out three
 * times taller than the words and reads as a band floating around them.
 *
 * The height it should have is recoverable from the tilt, without needing the
 * individual words back:
 *
 *     enclosing height  =  text height  +  width x tan(tilt)
 *
 * Subtract the drift and what remains is the height of the text itself. Keep
 * the centre, hand the viewer the angle, and let it rotate the box about that
 * centre onto the words.
 *
 * The multiplication by `aspect` is the part that is easy to get wrong: an
 * angle is a fact about pixels, while x and y here are fractions of two
 * different page dimensions. A drift of `width x tan(t)` pixels is
 * `width x aspect x tan(t)` in fractions of the height.
 */
function toSource(b: Box, page?: TextPage): SourceBox {
  let { y0, y1 } = b;
  const skew = page?.skewDeg ?? 0;
  const tilted = page != null && Math.abs(skew) >= MIN_SKEW_DEG;

  // How tall the text in this box actually is, measured from the words in it.
  //
  // Measured for EVERY box now, not only tilted ones. A flat margin is a
  // sensible-looking number and it is more than half the height of a box round
  // one line of an address block: D4's street came out 31px tall around 12px of
  // text, reaching into the line beneath and highlighting words that are not
  // the answer. Letterheads are set tightly, so the margin has to know how big
  // the type is.
  const inside = page
    ? page.words.filter((w) => {
        const cx = (w.x0 + w.x1) / 2;
        const cy = (w.y0 + w.y1) / 2;
        return cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1;
      })
    : [];
  const heights = inside.map((w) => w.y1 - w.y0).sort((a, b2) => a - b2);
  // Median, so one tall glyph or one misread speck does not set the height for
  // the whole run.
  const line = heights.length > 0 ? heights[Math.floor(heights.length / 2)]! : null;
  const padY = line ? Math.min(PAD, line * BOX_PAD) : PAD;

  if (tilted && page) {
    if (line) {
      // The CENTRE comes from the words too, not from the middle of the
      // rectangle that encloses them.
      //
      // C1's first row sat visibly high, and one token was the whole reason:
      // tesseract read its em dash as "~" and gave that a box 0.0187 tall
      // against 0.005 for every real word beside it. The enclosing rectangle
      // takes its top edge from whatever reaches highest, so a single misread
      // glyph pulled the centre up by a third of a line — enough to lift a
      // 16px-tall highlight clear of the text it belongs to.
      //
      // Each word says where the line sits at the box's midpoint, by walking
      // its own centre back along the slope. The median of those answers is
      // immune to the one word that is wrong.
      const midX = (b.x0 + b.x1) / 2;
      const tan = Math.tan(skew * Math.PI / 180);
      const aspect = page.aspect ?? 1;
      const centres = inside
        .map((w) => (w.y0 + w.y1) / 2 - ((w.x0 + w.x1) / 2 - midX) * aspect * tan)
        .sort((a, b2) => a - b2);
      const cy = centres[Math.floor(centres.length / 2)]!;
      y0 = cy - line * TILTED_HALF_HEIGHT;
      y1 = cy + line * TILTED_HALF_HEIGHT;
    }
  }
  const px0 = Math.max(0, b.x0 - PAD);
  const py0 = Math.max(0, y0 - padY);
  const px1 = Math.min(1, b.x1 + PAD);
  const py1 = Math.min(1, y1 + padY);
  return {
    page: b.page,
    box: [px0, py0, px1 - px0, py1 - py0],
    ...(tilted ? { angle: skew } : {}),
  };
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

/**
 * Address parts, each accepted only if something corroborates it.
 *
 * A postal address is mostly short strings, and short strings turn up all over
 * an invoice. C1's letterhead is a photograph of small grey type that OCR could
 * not read at all — not the street, not the city, not the zip, not the email.
 * "CA" it did find, in the customer's address further down the page, and with a
 * single match and nothing to compare it against that became the vendor's
 * state highlight. A two-character coincidence pointing at the wrong company's
 * address.
 *
 * So a part needs an ANCHOR: the whole address if it matched, otherwise the
 * longest part that did. Everything else has to sit near that anchor, because
 * the lines of one address are printed together. With no anchor at all, only
 * parts long enough to stand alone are kept — a lone "CA" is a coincidence, a
 * lone "9 Cannery Row" is not.
 */
function anchoredAddressParts(
  pages: TextPage[],
  parts: Record<string, string | null>,
  whole: SourceBox | null,
): Record<string, Box> {
  // Long enough that finding it twice on one page would be a surprise.
  const STANDS_ALONE = 5;
  // An address occupies a few lines; anything further off is a different one.
  const NEAR = 0.05;

  const found: Array<[part: string, value: string, matches: Box[]]> = [];
  for (const [part, value] of Object.entries(parts)) {
    if (!value) continue;
    const matches = findTextMatches(pages, [value]);
    if (matches.length > 0) found.push([part, value, matches]);
  }
  if (found.length === 0) return {};

  // The anchor: the whole address if we have it, else the longest part that
  // matched exactly once — an unambiguous long string is a reliable landmark.
  let anchor: Box | null = null;
  if (whole) {
    anchor = { page: whole.page, x0: whole.box[0], y0: whole.box[1], x1: whole.box[0] + whole.box[2], y1: whole.box[1] + whole.box[3] };
  } else {
    const longestFirst = [...found].sort((a, b) => b[1].length - a[1].length);
    const landmark = longestFirst.find(([, value, matches]) => value.length >= STANDS_ALONE && matches.length === 1);
    if (landmark) anchor = landmark[2][0]!;
  }

  const out: Record<string, Box> = {};
  for (const [part, value, matches] of found) {
    if (!anchor) {
      // Nothing to corroborate against. Keep only what could not plausibly be
      // a coincidence, and only when the page agrees it appears once.
      if (value.length >= STANDS_ALONE && matches.length === 1) out[part] = matches[0]!;
      continue;
    }
    const near = matches
      .filter((m) => m.page === anchor!.page && Math.abs((m.y0 + m.y1) / 2 - (anchor!.y0 + anchor!.y1) / 2) < NEAR)
      .sort((a, b) => Math.abs(a.y0 - anchor!.y0) - Math.abs(b.y0 - anchor!.y0));
    if (near.length > 0) out[part] = near[0]!;
  }
  return out;
}

export function refineInvoiceSources(invoice: ExtractedInvoice, pages: TextPage[]): { refined: number } {
  let refined = 0;
  const sources: Record<string, SourceBox | null> = { ...(invoice.fieldSources ?? {}) };
  const hint = (key: string) => sources[key] ?? null;

  // Which boxes were MEASURED on this page, as opposed to guessed by the model.
  // Everything else is dropped at the end.
  //
  // Overwriting only what matched left the rest of the model's invented ladder
  // in place, which is how a document could be refined and still point at blank
  // paper: on C1 eight fields were relocated and dueDate, currency and
  // invoiceNumber quietly kept their fabricated rectangles, indistinguishable
  // in the UI from the eight real ones. Half-measured is the worst state to be
  // in — it looks like the fix worked.
  const measured = new Set<string>();

  const setIfFound = (key: string, matches: Box[], prefer: 'first' | 'bottom' = 'first') => {
    const chosen = pickMatch(matches, hint(key), prefer);
    if (chosen) {
      sources[key] = toSource(chosen, pages[chosen.page - 1]);
      measured.add(key);
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

  // The letterhead address, which is where MOST invoices print it.
  //
  // This was never refined at all, and the draft screen asks for it by a key
  // (`vendorAddress`) that nothing ever produced — so street, city, state and
  // zip failed to highlight on every document, digital PDFs included, where
  // the exact characters were sitting right there. Sixteen of the thirty
  // missing boxes across the C series were these four fields.
  //
  // Refined per part as well as whole: the four inputs are four questions, and
  // pointing all of them at the same block would be a worse answer than the one
  // the page can actually give. The whole-address box doubles as the
  // disambiguation hint, which matters for a two-letter state code that could
  // appear anywhere.
  if (invoice.vendorAddress) {
    setIfFound('vendorAddress', findTextMatches(pages, [invoice.vendorAddress]));
    const parts = splitPostalAddress(invoice.vendorAddress);
    for (const [part, box] of Object.entries(anchoredAddressParts(pages, parts, sources.vendorAddress ?? null))) {
      sources[`vendorAddress.${part}`] = toSource(box, pages[box.page - 1]);
      measured.add(`vendorAddress.${part}`);
      refined += 1;
    }
  }

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
        sources[key] = toSource(chosen, pages[chosen.page - 1]);
        measured.add(key);
        refined += 1;
      }
    }
  }

  // Only what was found on the page survives. The model's boxes did their one
  // useful job above — as a hint for picking between two real matches — and are
  // not evidence of anything on their own.
  invoice.fieldSources = Object.fromEntries(
    Object.entries(sources).filter(([key]) => measured.has(key)),
  );

  // Line items: locate the description, then take the whole table row —
  // preferring, among duplicate descriptions, the row that carries the
  // line's own amount.
  for (const item of invoice.lineItems) {
    if (!item.description) continue;
    const matches = findTextMatches(pages, [item.description]);
    if (matches.length === 0) {
      // Same rule as the header fields: a row we could not find on the page
      // gets no highlight rather than the model's guess at where it might be.
      item.source = null;
      continue;
    }
    let rows = matches.map((m) => ({ m, row: expandToRow(pages[m.page - 1]!, m, item.total) }));
    if (item.total != null && rows.length > 1) {
      const withAmount = rows.filter(({ m }) => {
        const page = pages[m.page - 1]!;
        // Against the DESCRIPTION's row, following the page's slope — the same
        // band expandToRow uses. Measured off the expanded row instead, this
        // was asking whether the amount lies inside a box that was built to
        // contain that amount, which is a question with a foregone answer.
        const onThisRow = sameRowAs(page, m);
        return page.words.some((w) => {
          const n = numOf(w.text);
          return n != null && Math.abs(n - (item.total ?? 0)) < 0.005 && onThisRow(w);
        });
      });
      if (withAmount.length > 0) rows = withAmount;
    }
    const chosen = pickMatch(rows.map((r) => r.row), item.source, 'first');
    if (chosen) {
      item.source = toSource(chosen, pages[chosen.page - 1]);
      refined += 1;
    }
  }

  return { refined };
}


// ---------------------------------------------------------------------------
// Grounding: did the value we are about to pay actually appear on the page?
// ---------------------------------------------------------------------------

/**
 * Check extracted values against the document's own text layer.
 *
 * This is the one confidence signal that is not the model's opinion of itself.
 * The model saying "0.98" and the page containing "5,420.00" are different
 * kinds of claim, and only the second can be checked. It costs nothing: the
 * text layer is already pulled for highlighting, so this is a string search
 * over words we have in hand.
 *
 * Deliberately narrow. Only the values that decide identity and money, and
 * only where a comparison is honest:
 *
 *   - amounts, compared digit-by-digit, because "$5,420.00" and 5420 are the
 *     same number written two ways
 *   - the invoice number, compared alphanumerically for the same reason
 *
 * Dates, terms and addresses are skipped on purpose. A document printing
 * "August 5, 2026" against an extracted "2026-08-05" is correct, and flagging
 * it would produce a warning on almost every invoice — which is how a warning
 * stops being read. A grounding check that cries wolf is worse than none.
 *
 * Returns the fields whose values could NOT be found. An empty array from a
 * document with no text layer means "we could not check", never "verified" —
 * callers get null for that case instead.
 */
export function ungroundedFields(
  invoice: Record<string, unknown>,
  pages: TextPage[] | null,
): string[] | null {
  if (!pages || pages.length === 0) return null;

  const words = pages.flatMap((page) => page.words.map((w) => w.text));
  const haystack = words.join(' ');
  // Digits only: "$5,420.00" and "5420" and "5 420,00" all reduce the same way.
  const digits = haystack.replace(/[^0-9]/g, '');
  // Letters and digits only, lowercased: "ZA-8102" matches "za8102".
  const alnum = haystack.toLowerCase().replace(/[^a-z0-9]/g, '');

  const missing: string[] = [];

  const amountFound = (value: unknown): boolean => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return true;
    // Both the exact printed form and the whole-currency form, since a document
    // may print "5,420" where the extraction says 5420.00.
    const withCents = Math.abs(value).toFixed(2).replace(/[^0-9]/g, '');
    const whole = String(Math.round(Math.abs(value)));
    return digits.includes(withCents) || digits.includes(whole);
  };

  if (!amountFound(invoice.amount)) missing.push('total');
  if (invoice.subtotal != null && !amountFound(invoice.subtotal)) missing.push('subtotal');

  const invoiceNumber = invoice.invoiceNumber;
  if (typeof invoiceNumber === 'string' && invoiceNumber.trim()) {
    const needle = invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (needle && !alnum.includes(needle)) missing.push('invoiceNumber');
  }

  return missing;
}
