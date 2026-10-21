// What Approval rules says about a step or a split, in one place: the canvas,
// the editors and Test a bill all word them the same way.
import type { FlowNode } from '../../api';
import { usd } from '../../kit/format';
import type { Split, Step } from './flowTree';

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** Numbers as words up to ten, as figures past it. */
export const numberWord = (n: number) => WORDS[n] ?? String(n);

const NO_NAME = 'Approval step';
/** A step's name, or "Approval step" for one that has none. */
export const stepTitle = (s: Step) => s.title.trim() || NO_NAME;
/** A step in a sentence: “Finance review”, or "an approval step". */
export const stepInSentence = (s: Step) => (stepTitle(s) === NO_NAME ? 'an approval step' : `“${stepTitle(s)}”`);

/** The caps on a step card: "Both", "Either one", "Any 2 of 3". Nothing for one person. */
export function quorumCaps(count: number, quorum: Step['quorum']) {
  if (count < 2) return '';
  if (count === 2) return quorum === 'all' ? 'Both' : quorum === 'any' ? 'Either one' : `Any ${quorum}`;
  return quorum === 'any' ? 'Any one' : quorum === 'all' ? `All ${count}` : `Any ${quorum} of ${count}`;
}

/** The same, in a sentence: "both", "either one", "any two". */
export function quorumWord(count: number, quorum: Step['quorum']) {
  if (count < 2) return '';
  if (count === 2) return quorum === 'all' ? 'both' : 'either one';
  return quorum === 'any' ? 'any one' : quorum === 'all' ? `all ${numberWord(count)}` : `any ${numberWord(quorum)}`;
}

/** "How many must approve", one choice per count. */
export function quorumChoices(count: number): Array<{ value: Step['quorum']; label: string; line: string }> {
  const out: Array<{ value: Step['quorum']; label: string; line: string }> = [];
  for (let k = 1; k <= count; k++) {
    const value: Step['quorum'] = k === 1 ? 'any' : k === count ? 'all' : k;
    if (count === 2) {
      out.push(k === 1
        ? { value, label: 'Either one', line: 'Either of them can approve it.' }
        : { value, label: 'Both', line: 'They both have to approve it.' });
    } else if (k === 1) {
      out.push({ value, label: 'Any one', line: `Any one of the ${numberWord(count)} can approve it.` });
    } else if (k === count) {
      out.push({ value, label: `All ${numberWord(count)}`, line: `All ${numberWord(count)} have to approve it.` });
    } else {
      out.push({ value, label: `Any ${numberWord(k)}`, line: `Any ${numberWord(k)} of the ${numberWord(count)} have to approve it.` });
    }
  }
  return out;
}

/** "Tom", "Tom or Ines", "Tom, Ines or Nadia". */
export function joinNames(names: string[], joiner: 'and' | 'or') {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1]}`;
}

export const joinerOf = (s: Step): 'and' | 'or' => (s.quorum === 'all' ? 'and' : 'or');

type Names = (id: string) => string;

/** What a split pill says, and whether it still needs picking. */
export function splitLabel(split: Split, vendorName: Names): { text: string; unset: boolean } {
  const s = split.split;
  if (!s) return split.amountGteUsd > 0 ? { text: `Bill is ${usd(split.amountGteUsd)} or more`, unset: false } : { text: 'Pick an amount', unset: true };
  if (s.kind === 'firstBill') return { text: 'A vendor’s first bill', unset: false };
  if (s.kind === 'vendor') {
    if (!s.vendorIds.length) return { text: 'Pick the vendors', unset: true };
    const more = s.vendorIds.length - 1;
    return { text: `From ${vendorName(s.vendorIds[0]!)}${more ? ` or ${more} more` : ''}`, unset: false };
  }
  if (!s.categories.length) return { text: 'Pick the categories', unset: true };
  const more = s.categories.length - 1;
  return { text: `Coded to ${s.categories[0]}${more ? ` or ${more} more` : ''}`, unset: false };
}

/** Why a test bill went the way it did at a split: "$25,000.00 or more", "Not from Anvil Works". */
export function splitAnswer(split: Split, yes: boolean, vendorName: Names) {
  const s = split.split;
  if (!s) return yes ? `${usd(split.amountGteUsd)} or more` : `Under ${usd(split.amountGteUsd)}`;
  if (s.kind === 'firstBill') return yes ? 'A vendor’s first bill' : 'Not a vendor’s first bill';
  if (s.kind === 'vendor') {
    const which = s.vendorIds.length === 1 ? vendorName(s.vendorIds[0]!) : 'those vendors';
    return `${yes ? 'From' : 'Not from'} ${which}`;
  }
  const which = s.categories.length === 1 ? s.categories[0] : 'those categories';
  return `${yes ? 'Coded to' : 'Not coded to'} ${which}`;
}

// ── Names for a screen reader: which path a control is on ──

type Find = (list: FlowNode[], id: string) => FlowNode | null;

/** "the path", or "the Yes path of “Bill is $25,000.00 or more”". */
export function pathName(flow: FlowNode[], key: string, vendorName: Names, find: Find) {
  if (key === 'root') return 'the path';
  const [id, side] = key.split('|');
  const n = find(flow, id ?? '');
  if (!n || n.type !== 'if') return 'this path';
  return `the ${side === 'then' ? 'Yes' : 'No'} path of “${splitLabel(n, vendorName).text}”`;
}

/** A node in a sentence: “Finance review”, the split “Bill is …”, the notification, the end. */
export function nodeName(n: FlowNode, vendorName: Names) {
  if (n.type === 'step') return `“${stepTitle(n)}”`;
  if (n.type === 'if') return `the split “${splitLabel(n, vendorName).text}”`;
  return n.type === 'notify' ? 'the notification' : 'the end';
}
