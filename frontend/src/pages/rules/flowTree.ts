// The rules as a tree, and every change Approval rules makes to it. Pure: the
// page keeps the history, these only say what the next flow is.
import type { FlowNode, FlowSplit } from '../../api';

export type Step = Extract<FlowNode, { type: 'step' }>;
export type Split = Extract<FlowNode, { type: 'if' }>;
export type SplitKind = 'amount' | 'vendor' | 'category' | 'firstBill';
/** Where a list sits: the top of the rules, or one side of a split ("id|then"). */
export type ListKey = string;

export const uid = () => `n${Math.random().toString(36).slice(2, 9)}`;

export function find(list: FlowNode[], id: string): FlowNode | null {
  for (const n of list) {
    if (n.id === id) return n;
    if (n.type === 'if') {
      const hit = find(n.then, id) ?? find(n.otherwise, id);
      if (hit) return hit;
    }
  }
  return null;
}

export function listAt(flow: FlowNode[], key: ListKey): FlowNode[] | null {
  if (key === 'root') return flow;
  const [id, side] = key.split('|');
  const n = find(flow, id ?? '');
  if (!n || n.type !== 'if') return null;
  return side === 'then' ? n.then : n.otherwise;
}

/** A copy with fresh ids, for the second path of a new split. */
export function reid(list: FlowNode[]): FlowNode[] {
  return list.map((n) => (n.type === 'if' ? { ...n, id: uid(), then: reid(n.then), otherwise: reid(n.otherwise) } : { ...n, id: uid() }));
}

export function kindOf(split: Split): SplitKind {
  return split.split?.kind ?? 'amount';
}

/** Does any split of this kind appear? It decides which Test fields show. */
export function uses(list: FlowNode[], kind: Exclude<SplitKind, 'amount'>): boolean {
  return list.some((n) => n.type === 'if' && (n.split?.kind === kind || uses(n.then, kind) || uses(n.otherwise, kind)));
}

const withoutEnd = (list: FlowNode[]) => (list[list.length - 1]?.type === 'auto' ? list.slice(0, -1) : list);

/**
 * The rules as this page draws them: a split ends its list. The engine runs
 * whatever follows a split on both of its paths, so that is where it goes; and
 * an end anywhere but last ends nothing (the engine passes over it). Flows the
 * old builder published can have either.
 */
export function normalize(list: FlowNode[]): FlowNode[] {
  const out: FlowNode[] = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    if (n.type === 'auto' && i < list.length - 1) continue;
    if (n.type === 'if') {
      const rest = list.slice(i + 1);
      const onto = (branch: FlowNode[], tail: FlowNode[]) => normalize(tail.length ? [...withoutEnd(branch), ...tail] : branch);
      out.push({ ...n, then: onto(n.then, rest), otherwise: onto(n.otherwise, reid(rest)) });
      return out;
    }
    out.push(n);
  }
  return out;
}

/** The rules with the parts that don't change routing left out: ids, the names kept beside vendor ids. */
function canonical(list: FlowNode[]): unknown[] {
  return list.map((n) => {
    if (n.type === 'step') return ['step', n.title, n.approvers, n.quorum];
    if (n.type === 'auto') return ['end'];
    if (n.type === 'notify') return ['notify', n.people];
    const s = n.split;
    const rule = !s ? ['amount', n.amountGteUsd] : s.kind === 'vendor' ? ['vendor', s.vendorIds] : s.kind === 'category' ? ['category', s.categories] : ['firstBill'];
    return ['split', rule, canonical(n.then), canonical(n.otherwise)];
  });
}

export function sameFlow(a: FlowNode[], b: FlowNode[]) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Every node, replaced through `fn` where it returns one. */
export function mapNode(list: FlowNode[], id: string, fn: (n: FlowNode) => FlowNode): FlowNode[] {
  return list.map((n) => {
    if (n.id === id) return fn(n);
    if (n.type === 'if') return { ...n, then: mapNode(n.then, id, fn), otherwise: mapNode(n.otherwise, id, fn) };
    return n;
  });
}

export function removeNode(list: FlowNode[], id: string): FlowNode[] {
  return list
    .filter((n) => n.id !== id)
    .map((n) => (n.type === 'if' ? { ...n, then: removeNode(n.then, id), otherwise: removeNode(n.otherwise, id) } : n));
}

/**
 * Takes a node out of the rules. An end left with nothing before it would
 * approve every bill on arrival, so the rules are empty again instead.
 */
export function removeFrom(flow: FlowNode[], id: string): FlowNode[] {
  const next = removeNode(flow, id);
  return next.length === 1 && next[0]!.type === 'auto' ? [] : next;
}

function replaceList(flow: FlowNode[], key: ListKey, next: FlowNode[]): FlowNode[] {
  if (key === 'root') return next;
  const [id, side] = key.split('|');
  return mapNode(flow, id ?? '', (n) => (n.type === 'if' ? { ...n, [side === 'then' ? 'then' : 'otherwise']: next } : n));
}

export type InsertKind = 'step' | 'split' | 'end';

/**
 * Adds a step, a split or an end at `index` of a list. A split takes
 * everything after it into both of its paths, so neither loses the rest of the
 * route.
 */
export function insertAt(flow: FlowNode[], key: ListKey, index: number, kind: InsertKind) {
  const list = listAt(flow, key);
  if (!list) return null;
  if (kind === 'step') {
    const step: Step = { id: uid(), type: 'step', title: 'Approval step', approvers: [], quorum: 'any' };
    return { flow: replaceList(flow, key, [...list.slice(0, index), step, ...list.slice(index)]), added: step.id, carried: false };
  }
  if (kind === 'split') {
    const rest = list.slice(index);
    const split: Split = { id: uid(), type: 'if', amountGteUsd: 0, split: null, then: rest, otherwise: reid(rest) };
    return { flow: replaceList(flow, key, [...list.slice(0, index), split]), added: split.id, carried: rest.length > 0 };
  }
  return { flow: replaceList(flow, key, [...list.slice(0, index), { id: uid(), type: 'auto' }, ...list.slice(index)]), added: null, carried: false };
}

export function togglePerson(step: Step, personId: string): Step {
  const approvers = step.approvers.includes(personId) ? step.approvers.filter((p) => p !== personId) : [...step.approvers, personId];
  let quorum = step.quorum;
  if (approvers.length < 2) quorum = 'any';
  else if (typeof quorum === 'number' && quorum >= approvers.length) quorum = 'all';
  return { ...step, approvers, quorum };
}

export function setSplitKind(split: Split, kind: SplitKind): Split {
  if (kindOf(split) === kind) return split;
  const next: FlowSplit | null =
    kind === 'vendor' ? { kind: 'vendor', vendorIds: [], vendorNames: [] }
    : kind === 'category' ? { kind: 'category', categories: [] }
    : kind === 'firstBill' ? { kind: 'firstBill' }
    : null;
  return { ...split, split: next };
}

export function toggleVendor(split: Split, vendor: { id: string; name: string }): Split {
  const cur = split.split?.kind === 'vendor' ? split.split : { kind: 'vendor' as const, vendorIds: [], vendorNames: [] };
  const at = cur.vendorIds.indexOf(vendor.id);
  const vendorIds = at >= 0 ? cur.vendorIds.filter((_, i) => i !== at) : [...cur.vendorIds, vendor.id];
  const vendorNames = at >= 0 ? cur.vendorNames.filter((_, i) => i !== at) : [...cur.vendorNames, vendor.name];
  return { ...split, split: { kind: 'vendor', vendorIds, vendorNames } };
}

export function toggleCategory(split: Split, name: string): Split {
  const cur = split.split?.kind === 'category' ? split.split.categories : [];
  const categories = cur.includes(name) ? cur.filter((c) => c !== name) : [...cur, name];
  return { ...split, split: { kind: 'category', categories } };
}

/** A split that can't yet say which way a bill goes. */
export function unsetSplit(split: Split) {
  const s = split.split;
  if (!s) return !(split.amountGteUsd > 0);
  if (s.kind === 'vendor') return s.vendorIds.length === 0;
  if (s.kind === 'category') return s.categories.length === 0;
  return false;
}

/**
 * What stands between these rules and publishing, in the order they're met.
 * Each is drawn in yellow on the canvas; the engine needs all of them settled
 * (a step with nobody, an unset split or a path nobody approves would hold
 * every bill that met it).
 */
export function problemsOf(flow: FlowNode[], stepName: (s: Step) => string): string[] {
  const out: string[] = [];
  const walk = (list: FlowNode[], approved: boolean) => {
    let seen = approved;
    for (const n of list) {
      if (n.type === 'step') {
        if (n.approvers.length === 0) out.push(`Pick who approves ${stepName(n)}`);
        seen = true;
      } else if (n.type === 'if') {
        if (unsetSplit(n)) {
          const k = kindOf(n);
          out.push(k === 'vendor' ? 'Pick the vendors on a split' : k === 'category' ? 'Pick the categories on a split' : 'Pick an amount on a split');
        }
        walk(n.then, seen);
        walk(n.otherwise, seen);
        return;
      }
    }
    if (!seen) out.push('Put someone on every path');
    else if (list[list.length - 1]?.type !== 'auto') out.push('Finish every path');
  };
  if (flow.length) walk(flow, false);
  return [...new Set(out)];
}

// ── A test bill's route ────────────────────────────────────

export type Sample = { amountUsd: number; firstBill: boolean; vendorId: string | null; category: string | null };

function goesYes(split: Split, sample: Sample) {
  const s = split.split;
  if (!s) return sample.amountUsd >= split.amountGteUsd;
  if (s.kind === 'firstBill') return sample.firstBill;
  if (s.kind === 'vendor') return Boolean(sample.vendorId && s.vendorIds.includes(sample.vendorId));
  return Boolean(sample.category && s.categories.includes(sample.category));
}

export type Route = {
  /** Every node the bill passes. */
  ids: Set<string>;
  /** Which way it goes at each split it meets. */
  taken: Record<string, 'then' | 'otherwise'>;
  /** The steps it meets, with the answers that led there. */
  steps: Array<{ node: Step; why: string[] }>;
  /** The end it reaches, if its path has one. */
  endId: string | null;
  /** The split it can't get past because it isn't set yet. */
  stoppedAt: Split | null;
};

/** The way a test bill takes, the same four comparisons the engine makes. */
export function routeOf(flow: FlowNode[], sample: Sample, answer: (split: Split, yes: boolean) => string): Route {
  const route: Route = { ids: new Set(), taken: {}, steps: [], endId: null, stoppedAt: null };
  const why: string[] = [];
  const walk = (list: FlowNode[]) => {
    for (const n of list) {
      route.ids.add(n.id);
      if (n.type === 'step') route.steps.push({ node: n, why: [...why] });
      else if (n.type === 'auto') {
        route.endId = n.id;
        return;
      } else if (n.type === 'if') {
        if (unsetSplit(n)) {
          route.stoppedAt = n;
          return;
        }
        const yes = goesYes(n, sample);
        route.taken[n.id] = yes ? 'then' : 'otherwise';
        why.push(answer(n, yes));
        walk(yes ? n.then : n.otherwise);
        return;
      }
    }
  };
  walk(flow);
  return route;
}
