// Where everything on the Approval rules canvas goes, at zoom 1: the design's
// own layout (Approval rules.dc.html). Steps are 232 wide; a split's two paths
// sit side by side 36 apart; 32 between nodes; every finished path drops into
// one line down to Approved. The route a test bill takes is drawn in its own
// path so it can be maroon.
import type { FlowNode } from '../../api';
import type { ListKey, Route, Split, Step } from './flowTree';

export const CARD_W = 232;
const GAP = 36;
const MIN_W = 160;
const PAD = 28;

export const cardHeight = (s: Step) => 37 + 20 * Math.max(1, s.approvers.length);

function width(list: FlowNode[]): number {
  let w = MIN_W;
  for (const n of list) {
    if (n.type === 'step') w = Math.max(w, CARD_W);
    else if (n.type === 'notify') w = Math.max(w, 200);
    else if (n.type === 'if') w = Math.max(w, 220, width(n.then) + GAP + width(n.otherwise));
  }
  return w;
}

/** From the split down and across to the top of one of its paths, round at the corner. */
function elbow(x1: number, y1: number, x2: number, y2: number) {
  if (Math.abs(x2 - x1) < 1) return `M${x1} ${y1}V${y2}`;
  const r = 8;
  const s = x2 > x1 ? 1 : -1;
  return `M${x1} ${y1}H${x2 - s * r}Q${x2} ${y1} ${x2} ${y1 + r}V${y2}`;
}

/** From the end of a finished path down and across into the line to Approved. */
function merge(x: number, y: number, cx: number, busY: number) {
  if (Math.abs(x - cx) < 1) return `M${x} ${y}V${busY}`;
  const r = 8;
  const s = cx > x ? 1 : -1;
  return `M${x} ${y}V${busY - r}Q${x} ${busY} ${x + s * r} ${busY}H${cx}`;
}

export type Notify = Extract<FlowNode, { type: 'notify' }>;

export type Layout = {
  w: number;
  h: number;
  /** Grey hairlines, the dotted tail of empty rules, and the test bill's route. */
  lines: string;
  dots: string;
  route: string;
  start: { x: number; y: number };
  steps: Array<{ node: Step; x: number; y: number; h: number }>;
  splits: Array<{ node: Split; x: number; y: number }>;
  labels: Array<{ yes: boolean; x: number; y: number; on: boolean }>;
  /** The "+" between nodes (centres), and "Finish this path" (top centres). */
  pluses: Array<{ key: ListKey; index: number; x: number; y: number }>;
  fins: Array<{ key: ListKey; index: number; x: number; y: number }>;
  /** Green ends (top-left corners). */
  ends: Array<{ node: FlowNode; key: ListKey; x: number; y: number; on: boolean }>;
  /** "Nothing on this path yet", for whoever can't edit. */
  empties: Array<{ x: number; y: number }>;
  notes: Array<{ node: Notify; x: number; y: number }>;
  ghost: { x: number; y: number } | null;
  end: { x: number; y: number; live: boolean; on: boolean };
};

/** @param route the test bill's route, drawn maroon, or null */
export function layout(flow: FlowNode[], opts: { editable: boolean; route: Route | null }): Layout {
  const { editable, route } = opts;
  const grey: string[] = [];
  const maroon: string[] = [];
  const out: Layout = {
    w: 0, h: 0, lines: '', dots: '', route: '',
    start: { x: 0, y: PAD }, steps: [], splits: [], labels: [], pluses: [], fins: [], ends: [], empties: [], notes: [],
    ghost: null, end: { x: 0, y: 0, live: false, on: false },
  };
  const finished: Array<{ x: number; y: number; on: boolean }> = [];
  const seg = (d: string, on: boolean) => (on ? maroon : grey).push(d);
  const onRoute = (n: FlowNode) => Boolean(route?.ids.has(n.id));

  const place = (list: FlowNode[], key: ListKey, x0: number, y0: number): number => {
    const cx = Math.round(x0 + width(list) / 2);
    let y = y0;
    for (let i = 0; i < list.length; i++) {
      const n = list[i]!;
      if (i > 0) {
        const isEnd = n.type === 'auto';
        const g = isEnd ? 14 : 32;
        seg(`M${cx} ${y}V${y + g}`, onRoute(n));
        if (editable && !isEnd) out.pluses.push({ key, index: i, x: cx, y: Math.round(y + g / 2) });
        y += g;
      }
      if (n.type === 'step') {
        const h = cardHeight(n);
        const x = cx - CARD_W / 2;
        out.steps.push({ node: n, x, y, h });
        y += h;
      } else if (n.type === 'auto') {
        out.ends.push({ node: n, key, x: cx - 8, y, on: onRoute(n) });
        finished.push({ x: cx, y: y + 16, on: onRoute(n) });
        y += 16;
      } else if (n.type === 'notify') {
        out.notes.push({ node: n, x: cx, y });
        y += 22;
      } else {
        out.splits.push({ node: n, x: cx, y });
        const busY = y + 42;
        const top = busY + 40;
        const on = onRoute(n);
        const way = route?.taken[n.id];
        seg(`M${cx} ${y + 26}V${busY}`, on);
        const wl = width(n.then);
        const wr = width(n.otherwise);
        const fx = cx - Math.round((wl + GAP + wr) / 2);
        const lx = Math.round(fx + wl / 2);
        const rx = Math.round(fx + wl + GAP + wr / 2);
        const yesOn = on && way === 'then';
        const noOn = on && way === 'otherwise';
        seg(elbow(cx, busY, lx, top), yesOn);
        seg(elbow(cx, busY, rx, top), noOn);
        out.labels.push({ yes: true, x: lx, y: busY + 13, on: yesOn }, { yes: false, x: rx, y: busY + 13, on: noOn });
        return Math.max(place(n.then, `${n.id}|then`, fx, top), place(n.otherwise, `${n.id}|otherwise`, fx + wl + GAP, top));
      }
    }
    const last = list[list.length - 1];
    if (!last || last.type === 'step' || last.type === 'notify') {
      if (editable) {
        if (list.length) {
          seg(`M${cx} ${y}V${y + 12}`, false);
          y += 12;
        }
        out.fins.push({ key, index: list.length, x: cx, y });
        y += 22;
      } else if (!list.length) {
        out.empties.push({ x: cx, y });
        y += 16;
      }
    }
    return y;
  };

  const fw = width(flow);
  const w = Math.max(fw, 300);
  const cx = Math.round((w + PAD * 2) / 2);
  out.start = { x: cx, y: PAD };
  let y = PAD + 28;
  let bottom: number;
  if (!flow.length) {
    seg(`M${cx} ${y}V${y + 24}`, Boolean(route));
    out.ghost = { x: cx - 150, y: y + 24 };
    bottom = y + 24 + 120;
    out.dots = `M${cx} ${bottom + 6}V${bottom + 42}`;
  } else {
    seg(`M${cx} ${y}V${y + 32}`, Boolean(route));
    if (editable) out.pluses.push({ key: 'root', index: 0, x: cx, y: y + 16 });
    y += 32;
    bottom = place(flow, 'root', PAD + Math.round((w - fw) / 2), y);
  }
  const endY = bottom + 48;
  const busY = endY - 20;
  for (const f of finished) seg(merge(f.x, f.y, cx, busY), f.on);
  const reached = Boolean(route?.endId);
  if (finished.length) seg(`M${cx} ${busY}V${endY}`, reached);
  out.end = { x: cx, y: endY, live: finished.length > 0 || !flow.length, on: reached };
  out.w = w + PAD * 2;
  out.h = endY + 28 + PAD;
  out.lines = grey.join(' ');
  out.route = maroon.join(' ');
  return out;
}
