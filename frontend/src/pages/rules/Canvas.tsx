// The Approval rules canvas (Approval rules.dc.html 1a): the rules drawn as a
// tree on a dot grid that pans and zooms. Steps are cards, splits are pills
// with Yes and No under them, every finished path drops into Approved, and a
// test bill's route is drawn in maroon. The page owns the rules and floats its
// editors in here; the canvas draws, pans, zooms and says what was clicked.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { FlowNode } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { Icon } from '../../kit/icons';
import { Figures, TickGlyph } from '../bill/parts';
import { find, listAt, type ListKey, type Route } from './flowTree';
import { layout } from './layout';
import { nodeName, pathName, quorumCaps, splitLabel, stepTitle } from './words';

export type Person = {
  id: string;
  name: string;
  /** What the picker says they are: "Primary admin", "Admin", "Approver", "Bill clerk", "Viewer". */
  role: string;
  avatarUrl: string | null;
  canApprove: boolean;
  /** Why they can send a bill, if they can. */
  sends: 'Bill clerk' | 'Admin' | 'Primary admin' | null;
};

/** What floats over the canvas: a node's editor, or the menu under a "+". */
export type Open =
  | { kind: 'node'; id: string }
  | { kind: 'menu'; anchor: string; key: ListKey; index: number; tail: boolean };

type View = { x: number; y: number; z: number };

const MIN_Z = 0.3;
const MAX_Z = 1.6;

export function Canvas({
  flow,
  editable,
  route,
  personOf,
  vendorName,
  ghostText,
  open,
  onOpen,
  onRemoveEnd,
  onRemoveNote,
  floating,
}: {
  flow: FlowNode[];
  editable: boolean;
  route: Route | null;
  personOf: (id: string) => Person | undefined;
  vendorName: (id: string) => string;
  /** What the empty rules' card says under "No approval rules yet". */
  ghostText: string;
  open: Open | null;
  onOpen: (open: Open | null) => void;
  onRemoveEnd: (id: string) => void;
  onRemoveNote: (id: string) => void;
  /** The open node's editor, or the insert menu's items. */
  floating: ReactNode;
}) {
  const ground = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const [fitZ, setFitZ] = useState(1);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const L = useMemo(() => layout(flow, { editable, route }), [flow, editable, route]);
  const size = useRef({ w: L.w, h: L.h });
  size.current = { w: L.w, h: L.h };
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // Fit: the whole tree in view, never larger than life, near the top when it fits.
  const fit = useCallback(() => {
    const el = ground.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const { w: W, h: H } = size.current;
    const z = Math.max(MIN_Z, Math.min(1, (w - 48) / W, (h - 32) / H));
    const y = H * z + 56 <= h ? 24 : (h - H * z) / 2;
    setView({ x: Math.round((w - W * z) / 2), y: Math.round(Math.max(8, y)), z });
    setFitZ(z);
  }, []);

  // On first sight and whenever the canvas changes size (the panel opening or
  // closing, the window). An edit never refits: the tree just grows.
  useLayoutEffect(() => {
    const el = ground.current;
    if (!el) return;
    let last = '';
    const ro = new ResizeObserver(() => {
      const key = `${el.clientWidth}x${el.clientHeight}`;
      if (key === last) return;
      last = key;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const zoomBy = useCallback((factor: number, px?: number, py?: number) => {
    setView((v) => {
      const el = ground.current;
      if (!el) return v;
      const cx = px ?? el.clientWidth / 2;
      const cy = py ?? el.clientHeight / 2;
      const z = Math.max(MIN_Z, Math.min(MAX_Z, v.z * factor));
      if (z === v.z) return v;
      return { x: Math.round(cx - ((cx - v.x) / v.z) * z), y: Math.round(cy - ((cy - v.y) / v.z) * z), z };
    });
  }, []);

  // Pan by dragging the empty canvas; a press that doesn't move closes whatever is open.
  const drag = useRef<{ mx: number; my: number; x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    function move(e: MouseEvent) {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.mx;
      const dy = e.clientY - d.my;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      d.moved = true;
      setView((v) => ({ ...v, x: Math.round(d.x + dx), y: Math.round(d.y + dy) }));
    }
    function up() {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (!d.moved) onOpenRef.current(null);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  // The wheel pans; with ctrl or ⌘ (a trackpad pinch) it zooms about the pointer.
  useEffect(() => {
    const el = ground.current;
    if (!el) return;
    function wheel(e: WheelEvent) {
      if ((e.target as HTMLElement).closest('[data-float]')) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el!.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) {
        const r = el!.getBoundingClientRect();
        zoomBy(Math.pow(1.0015, -e.deltaY * unit), e.clientX - r.left, e.clientY - r.top);
        return;
      }
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
      const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
      setView((v) => ({ ...v, x: Math.round(v.x - dx), y: Math.round(v.y - dy) }));
    }
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoomBy]);

  const path = (key: ListKey) => pathName(flow, key, vendorName, find);
  const onPath = (key: ListKey) => (key === 'root' ? '' : ` on ${path(key)}`);
  const plusLabel = (key: ListKey, index: number) => {
    const before = listAt(flow, key)?.[index - 1];
    return index === 0 || !before ? 'Add a step or a split at the start' : `Add a step or a split${onPath(key)}, after ${nodeName(before, vendorName)}`;
  };
  const isOpenNode = (id: string) => open?.kind === 'node' && open.id === id;
  const isOpenMenu = (anchor: string) => open?.kind === 'menu' && open.anchor === anchor;
  const toggleMenu = (anchor: string, key: ListKey, index: number, tail: boolean) =>
    onOpen(isOpenMenu(anchor) ? null : { kind: 'menu', anchor, key, index, tail });
  const dots = 20 * (view.z / fitZ);

  return (
    <div
      ref={ground}
      className="ar-ground"
      style={{ backgroundSize: `${dots}px ${dots}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onMouseDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('[data-nopan]')) return;
        drag.current = { mx: e.clientX, my: e.clientY, x: view.x, y: view.y, moved: false };
        e.preventDefault();
      }}
    >
      <div className="ar-layer" style={{ width: L.w, height: L.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        <svg className="ar-wires" width={L.w} height={L.h} aria-hidden>
          <path className="ar-wire" d={L.lines} transform="translate(.5 .5)" />
          {L.dots ? <path className="ar-wire is-dotted" d={L.dots} /> : null}
          {L.route ? <path className="ar-wire is-route" d={L.route} /> : null}
        </svg>

        <div className="ar-pill ar-start" style={{ left: L.start.x, top: L.start.y }}>
          <span className="ar-disc"><Icon.arrowDown size={9} /></span>
          Sent for approval
        </div>

        {L.steps.map(({ node, x, y, h }) => {
          const names = node.approvers;
          const caps = quorumCaps(names.length, node.quorum);
          const body = (
            <>
              <span className="ar-card-head">
                <span className="caps clip">{stepTitle(node)}</span>
                {caps ? <span className="caps">{caps}</span> : null}
              </span>
              <span className="ar-card-body">
                {names.length === 0 ? (
                  <span className="ar-card-row is-empty">
                    <span className="ar-ring" />
                    {editable ? 'Pick who approves' : 'Nobody picked yet'}
                  </span>
                ) : (
                  names.map((id) => {
                    const p = personOf(id);
                    return (
                      <span key={id} className="ar-card-row">
                        <Avatar name={p?.name ?? 'Someone who left'} src={p?.avatarUrl} size={16} />
                        <span className="clip">{p?.name ?? 'Someone who left'}</span>
                      </span>
                    );
                  })
                )}
              </span>
            </>
          );
          const cls = `ar-card${names.length === 0 ? ' is-empty' : ''}${isOpenNode(node.id) ? ' is-on' : ''}`;
          return editable ? (
            <button
              key={node.id}
              type="button"
              data-nopan
              data-node={node.id}
              className={cls}
              style={{ left: x, top: y, height: h }}
              aria-label={`Edit step “${stepTitle(node)}”`}
              aria-expanded={isOpenNode(node.id)}
              onClick={() => onOpen(isOpenNode(node.id) ? null : { kind: 'node', id: node.id })}
            >
              {body}
            </button>
          ) : (
            <div key={node.id} data-nopan className={cls} style={{ left: x, top: y, height: h }}>
              {body}
            </div>
          );
        })}

        {L.splits.map(({ node, x, y }) => {
          const label = splitLabel(node, vendorName);
          const cls = `ar-pill ar-split${label.unset ? ' is-unset' : ''}${isOpenNode(node.id) ? ' is-on' : ''}`;
          const body = (
            <>
              <Icon.fork size={11} />
              <span><Figures text={label.text} /></span>
            </>
          );
          return editable ? (
            <button
              key={node.id}
              type="button"
              data-nopan
              data-node={node.id}
              className={cls}
              style={{ left: x, top: y }}
              aria-label={`Edit the split “${label.text}”`}
              aria-expanded={isOpenNode(node.id)}
              onClick={() => onOpen(isOpenNode(node.id) ? null : { kind: 'node', id: node.id })}
            >
              {body}
            </button>
          ) : (
            <div key={node.id} data-nopan className={cls} style={{ left: x, top: y }}>
              {body}
            </div>
          );
        })}

        {L.labels.map((l, i) => (
          <span key={i} className={`ar-yesno${l.on ? ' is-on' : ''}`} style={{ left: l.x, top: l.y }}>
            {l.yes ? 'Yes' : 'No'}
          </span>
        ))}

        {L.pluses.map(({ key, index, x, y }) => {
          const anchor = `plus:${key}:${index}`;
          const label = plusLabel(key, index);
          return (
            <button
              key={anchor}
              type="button"
              data-nopan
              data-anchor={anchor}
              className={`ar-plus${isOpenMenu(anchor) ? ' is-on' : ''}`}
              style={{ left: x - 8, top: y - 8 }}
              aria-label={label}
              title="Add a step or a split here"
              aria-expanded={isOpenMenu(anchor)}
              onClick={() => toggleMenu(anchor, key, index, false)}
            >
              <Icon.plus size={8} strokeWidth={3.2} />
            </button>
          );
        })}

        {L.fins.map(({ key, index, x, y }) => {
          const anchor = `fin:${key}`;
          return (
            <button
              key={anchor}
              type="button"
              data-nopan
              data-anchor={anchor}
              className="ar-pill ar-fin"
              style={{ left: x, top: y }}
              aria-label={`Finish ${path(key)}`}
              title="This path isn’t finished: add a step, split it, or end it"
              aria-expanded={isOpenMenu(anchor)}
              onClick={() => toggleMenu(anchor, key, index, true)}
            >
              <Icon.plus size={8} strokeWidth={3.2} />
              Finish this path
            </button>
          );
        })}

        {L.empties.map((e, i) => (
          <span key={i} className="ar-nothing" style={{ left: e.x, top: e.y }}>Nothing on this path yet</span>
        ))}

        {L.notes.map(({ node, x, y }) => {
          const names = node.people.map((id) => personOf(id)?.name ?? 'someone');
          return (
            <span key={node.id} data-nopan className="ar-pill ar-note" style={{ left: x, top: y }} title="A heads-up only; nobody has to approve here">
              Lets {names.join(', ') || 'nobody'} know
              {editable ? (
                <button type="button" className="ar-note-x" aria-label="Remove this notification" onClick={() => onRemoveNote(node.id)}>
                  <Icon.x size={8} strokeWidth={2.6} />
                </button>
              ) : null}
            </span>
          );
        })}

        {L.ends.map(({ node, key, x, y, on }) =>
          editable ? (
            <button
              key={node.id}
              type="button"
              data-nopan
              className={`ar-end${on ? ' is-on' : ''}`}
              style={{ left: x, top: y }}
              aria-label={`Approved here. Remove the end to keep building ${path(key)}`}
              onMouseEnter={() => setTip({ x: x + 24, y: y - 4 })}
              onMouseLeave={() => setTip(null)}
              onClick={() => {
                setTip(null);
                onRemoveEnd(node.id);
              }}
            >
              <TickGlyph size={9} width={3.6} />
            </button>
          ) : (
            <span key={node.id} className={`ar-end${on ? ' is-on' : ''}`} style={{ left: x, top: y }}>
              <TickGlyph size={9} width={3.6} />
            </span>
          ),
        )}
        {tip ? (
          <span className="tip" style={{ left: tip.x, top: tip.y }}>Approved here · click to keep building this path</span>
        ) : null}

        {L.ghost ? (
          <div data-nopan className="ar-ghost" style={{ left: L.ghost.x, top: L.ghost.y }}>
            <span className="ar-ghost-title">No approval rules yet</span>
            <span className="ar-ghost-text">{ghostText}</span>
            {editable ? (
              <button
                type="button"
                data-anchor="ghost"
                className="btn is-primary ar-ghost-add"
                aria-expanded={isOpenMenu('ghost')}
                onClick={() => toggleMenu('ghost', 'root', 0, false)}
              >
                <Icon.plus size={9} />
                Add the first step
              </button>
            ) : null}
          </div>
        ) : null}

        <div className={`ar-pill ar-approved${L.end.live ? '' : ' is-dead'}${L.end.on ? ' is-on' : ''}`} style={{ left: L.end.x, top: L.end.y }}>
          <span className="ar-disc"><TickGlyph size={10} width={3.4} /></span>
          <b>Approved</b>
        </div>
      </div>

      {open && floating ? <Float open={open} ground={ground} view={view}>{floating}</Float> : null}

      <div className="ar-zoom" data-nopan>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.15)}>
          <Icon.minus size={11} />
        </button>
        <button type="button" className="ar-zoom-pct num" title="Fit the rules to the window" onClick={fit}>
          {Math.round((view.z / fitZ) * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.15)}>
          <Icon.plus size={11} strokeWidth={2.4} />
        </button>
        <span className="ar-zoom-rule" />
        <button type="button" aria-label="Fit to the window" title="Fit the rules to the window" onClick={fit}>
          <Icon.fit size={12} />
        </button>
      </div>
    </div>
  );
}

/**
 * An editor beside its node (to the right, else the left, never off the
 * canvas), or the insert menu under its "+" (above it when there's no room).
 * Placed from where the node really is, so it follows a pan or a zoom.
 */
function Float({ open, ground, view, children }: { open: Open; ground: RefObject<HTMLDivElement | null>; view: View; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const place = useCallback(() => {
    const el = ref.current;
    const g = ground.current;
    if (!el || !g) return;
    const anchor = g.querySelector<HTMLElement>(open.kind === 'node' ? `[data-node="${open.id}"]` : `[data-anchor="${open.anchor}"]`);
    if (!anchor) return;
    const gr = g.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const w = g.clientWidth;
    const h = g.clientHeight;
    const ew = el.offsetWidth;
    const eh = el.offsetHeight;
    let x: number;
    let y: number;
    if (open.kind === 'node') {
      const ax = ar.left - gr.left;
      x = ax + ar.width + 12;
      if (x + ew > w - 12) x = ax - ew - 12;
      if (x < 12) x = Math.min(Math.max(12, ax), w - ew - 12);
      y = ar.top - gr.top - 4;
      if (y + eh > h - 12) y = h - eh - 12;
      el.style.maxHeight = `${h - 24}px`;
    } else {
      x = Math.min(w - ew - 12, ar.left - gr.left + ar.width / 2 - ew / 2);
      y = ar.bottom - gr.top + 6;
      if (y + eh > h - 12) y = ar.top - gr.top - eh - 6;
    }
    el.style.left = `${Math.round(Math.max(12, x))}px`;
    el.style.top = `${Math.round(Math.max(12, y))}px`;
  }, [open, ground]);

  // Every render (a pan, a zoom, an edit can move the anchor) and every change of its own size.
  useLayoutEffect(() => place(), [place, view, children]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    return () => ro.disconnect();
  }, [place]);

  return (
    <div ref={ref} className={`ar-float ${open.kind === 'menu' ? 'is-menu' : 'is-editor'}`} data-nopan data-float>
      {children}
    </div>
  );
}
