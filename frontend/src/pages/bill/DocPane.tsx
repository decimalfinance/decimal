// The document beside the facts (5a): the file's name, its pages and the zoom
// along the top, the pages on grey below, and the spot a field was read from
// marked on the page. The hairline to its left drags to resize it.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { invoiceIntakeApi, type BillDraft, type DocSource } from '../../api';
import { Icon } from '../../kit/icons';

const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
export const DOC_DEFAULT_WIDTH = 366;
const DOC_MIN_WIDTH = 300;
/** The facts keep at least this much of the row. */
const FACTS_MIN_WIDTH = 561;

export function DocPane({
  organizationId,
  document: doc,
  upload,
  pagesStored,
  source,
  width,
  faint,
  onClose,
}: {
  organizationId: string;
  document: BillDraft['document'];
  /** The file the bill came in, when that held other bills: its own pages are shown, and the rest a click away. */
  upload?: BillDraft['upload'];
  /** While the file is still being read, how many pages exist so far. */
  pagesStored?: number;
  /** Where the field in hand was read from. */
  source: DocSource;
  width: number | string;
  /** A document nothing could be read from sits faded behind its fields. */
  faint?: boolean;
  /** In the approval sheet: a × to put it away. */
  onClose?: () => void;
}) {
  const [urls, setUrls] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(100);
  // A bill that is some pages of a bigger upload shows its own pages, and the whole
  // file when asked. Its marks are on its own pages: page 1 of them is page `from` of
  // the whole file.
  const own = upload?.pages ?? null;
  const [whole, setWhole] = useState(false);
  const showsWhole = Boolean(whole && upload && own);
  const shownId = showsWhole ? upload!.invoiceDocumentId : doc?.invoiceDocumentId ?? null;
  const name = own ? upload!.filename : doc?.filename ?? null;
  const offset = showsWhole ? own!.from - 1 : 0;
  const pageCount = pagesStored ?? (showsWhole ? upload!.pageCount : doc?.pageCount) ?? 0;
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const turn = (to: boolean) => {
    setUrls([]);
    setFailed(false);
    setWhole(to);
  };

  useEffect(() => {
    if (!doc || !shownId || pageCount <= 0) return;
    let cancelled = false;
    const made: string[] = [];
    (async () => {
      try {
        for (let i = 0; i < pageCount; i += 1) {
          const url = await invoiceIntakeApi.fetchPageObjectUrl(organizationId, shownId, i);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          made.push(url);
          setUrls([...made]);
        }
      } catch {
        if (!cancelled && made.length === 0) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [organizationId, shownId, pageCount, doc]);

  // Bring the marked spot into view when it moves to another page, and when its
  // page arrives (Show all loads the whole file afresh).
  const markedPage = source ? source.page - 1 + offset : null;
  const markedShown = markedPage !== null && urls.length > markedPage;
  useEffect(() => {
    if (markedPage === null || !markedShown) return;
    const page = pageRefs.current[markedPage];
    if (!page) return;
    // A page whose image hasn't loaded has no height yet, so it would count as in view.
    const image = page.querySelector('img');
    const bring = () => page.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!image || image.complete) {
      bring();
      return;
    }
    image.addEventListener('load', bring, { once: true });
    return () => image.removeEventListener('load', bring);
  }, [source, markedPage, markedShown]);

  const step = (dir: 1 | -1) => {
    setZoom((z) => (dir === 1
      ? ZOOM_STEPS.find((s) => s > z) ?? z
      : [...ZOOM_STEPS].reverse().find((s) => s < z) ?? z));
  };

  return (
    <div className="bp-doc" style={{ width }}>
      <div className="bp-doc-bar">
        <span className="bp-doc-name" title={name ?? undefined}>{name ?? 'No document'}</span>
        {own && !showsWhole ? (
          <span className="bp-doc-pages">{pagesOfText(own, upload!.pageCount)}</span>
        ) : pageCount > 0 ? <span className="bp-doc-pages">{pageCount} {pageCount === 1 ? 'page' : 'pages'}</span> : null}
        {own ? (
          <button type="button" className="bl-showall" onClick={() => turn(!showsWhole)}>
            {showsWhole ? `Show ${pagesText(own)}` : 'Show all'}
          </button>
        ) : null}
        <span className="bp-zoom">
          <button type="button" className="bp-zoom-btn" title="Zoom out" aria-label="Zoom out" disabled={zoom <= ZOOM_STEPS[0]!} onClick={() => step(-1)}>−</button>
          <span className="bp-zoom-pct num">{zoom}%</span>
          <button type="button" className="bp-zoom-btn" title="Zoom in" aria-label="Zoom in" disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!} onClick={() => step(1)}>+</button>
          <button type="button" className={`bp-zoom-btn${zoom === 100 ? ' is-on' : ''}`} title="Fit to width" aria-label="Fit to width" onClick={() => setZoom(100)}>⤢</button>
          {onClose ? (
            <button type="button" className="bp-doc-close" title="Close" aria-label="Close the document" onClick={onClose}>
              <Icon.x size={11} />
            </button>
          ) : null}
        </span>
      </div>
      <div className="bp-ground">
        {!doc ? (
          <div className="bp-doc-empty">No document on file for this bill.</div>
        ) : failed ? (
          <div className="bp-doc-empty">The document couldn’t be shown.</div>
        ) : urls.length === 0 ? (
          <div className="bp-page" style={{ width: `${zoom}%` }}><div className="bp-page-blank breathe" /></div>
        ) : (
          urls.map((url, i) => (
            <div
              key={url}
              ref={(el) => { pageRefs.current[i] = el; }}
              className={`bp-page${faint ? ' is-faint' : ''}`}
              style={{ width: `${zoom}%` }}
            >
              <img src={url} alt={`${name}, page ${i + 1}`} />
              {source && source.page - 1 + offset === i ? (
                <span
                  className="bp-hl"
                  style={{
                    left: `${source.box[0] * 100}%`,
                    top: `${source.box[1] * 100}%`,
                    width: `${Math.max(source.box[2] * 100, 1.5)}%`,
                    height: `${Math.max(source.box[3] * 100, 1)}%`,
                    // A photographed page is rarely square to the camera; the
                    // mark turns with the words it sits on.
                    ...(source.angle ? { transform: `rotate(${source.angle}deg)` } : null),
                  }}
                />
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const pagesText = ({ from, to }: { from: number; to: number }) => (from === to ? `page ${from}` : `pages ${from} to ${to}`);
/** "page 2 of 3": which of the upload's pages are this bill's. */
const pagesOfText = (pages: { from: number; to: number }, of: number | null) => `${pagesText(pages)}${of ? ` of ${of}` : ''}`;

/**
 * The hairline between the facts and the document. Resting on it thickens it,
 * dragging turns it maroon; double-click or Enter puts the document back to
 * 366px, and the arrows move it 16px (64 with Shift).
 */
export function useDocWidth(rowRef: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(DOC_DEFAULT_WIDTH);
  const clamp = (w: number) => {
    const row = rowRef.current?.getBoundingClientRect().width ?? 0;
    const max = Math.max(DOC_MIN_WIDTH, row - FACTS_MIN_WIDTH);
    return Math.min(max, Math.max(DOC_MIN_WIDTH, Math.round(w)));
  };
  return { width, setWidth: (w: number) => setWidth(clamp(w)) };
}

export function Separator({ rowRef, width, setWidth }: {
  rowRef: RefObject<HTMLDivElement | null>;
  width: number;
  setWidth: (w: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const [drag, setDrag] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const row = rowRef.current?.getBoundingClientRect();
      if (!row) return;
      setWidth(row.right - e.clientX);
    };
    const onUp = () => setDrag(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    const cursor = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = '';
    };
  }, [drag, rowRef, setWidth]);

  const onKey = (e: ReactKeyboardEvent) => {
    const by = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(width + by); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(width - by); }
    if (e.key === 'Enter') { e.preventDefault(); setWidth(DOC_DEFAULT_WIDTH); }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the document"
      aria-valuenow={width}
      tabIndex={0}
      className={`bp-sep${hover ? ' is-hover' : ''}${drag ? ' is-drag' : ''}`}
      onMouseDown={(e) => { e.preventDefault(); setDrag(true); }}
      onDoubleClick={() => setWidth(DOC_DEFAULT_WIDTH)}
      onKeyDown={onKey}
      onMouseEnter={() => { timer.current = window.setTimeout(() => setHover(true), 150); }}
      onMouseLeave={() => { window.clearTimeout(timer.current); setHover(false); }}
    />
  );
}
