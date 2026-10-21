// Where a bill stands, in Bills' words: which stage, which part of which tile,
// and the chip it wears. Bills sorts and filters by it; Home's answers wear the
// same chips.
import type { WorkbenchBill } from '../api';
import { firstName, when } from '../kit/format';

export type Stage = 'review' | 'approval' | 'done';
export type TileKey = 'you' | 'approvers' | 'done';
export type Tone = 'blocking' | 'warning' | 'yours' | 'checked' | 'waiting' | 'finished';

/** The stage bar over a table of bills, and what it says when a stage is empty. */
export const STAGES: Array<{ key: Stage | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'In review' },
  { key: 'approval', label: 'In approval' },
  { key: 'done', label: 'Done' },
];

export const STAGE_EMPTY: Record<Stage | 'all', string> = {
  all: 'No bills yet.',
  review: 'Nothing in review.',
  approval: 'Nothing with the approvers.',
  done: 'Nothing done yet.',
};

/** One row of a tile: every bill is in exactly one, and it names the bill's chip. */
export type Part = {
  key: string;
  tile: TileKey | null;
  label: string;
  /** Who an approval waits on, drawn as faces after the names. */
  people?: string[];
  tone: Tone;
  order: number;
};

const CLOSED_WHY: Record<string, string> = {
  duplicate: 'duplicate',
  not_ours: 'not ours',
  credit_note: 'credit note',
  statement: 'statement',
  unreadable: 'unreadable',
};

export function stageOf(bill: WorkbenchBill): Stage {
  if (bill.bucket === 'draft') return 'review';
  if (bill.state === 'cancelled') return 'done';
  if (bill.bucket === 'in_approval' || bill.bucket === 'needs_attention') return 'approval';
  // Approved, with someone still to act on the release.
  return bill.waitingOn.length > 0 ? 'approval' : 'done';
}

function part(key: string, tile: TileKey | null, label: string, tone: Tone, order: number, people?: string[]): Part {
  return { key, tile, label, tone, order, people };
}

/**
 * Which part of which tile a bill belongs to, and the words on its chip. One
 * each, so the parts of a tile add up to the tile.
 */
export function classify(bill: WorkbenchBill, viewer: { userId: string; canReview: boolean }) {
  const stage = stageOf(bill);
  const yours = viewer.canReview ? 'you' : null;
  const question = { stage, part: part('q', 'you', 'Question for you', 'yours', 4), chip: 'Question for you' };

  if (stage === 'review') {
    const blocking = bill.flags.find((f) => f.blocking);
    const warning = bill.flags.find((f) => !f.blocking && f.severity !== 'info');
    if (blocking) return { stage, part: part('blocks', yours, 'Blocks the bill', 'blocking', 0), chip: blocking.short };
    if (bill.questionForYou) return question;
    if (bill.sentBack) return { stage, part: part('back', yours, 'Sent back', 'yours', 3), chip: 'Sent back' };
    if (warning) return { stage, part: part('warn', yours, 'Warning', 'warning', 1), chip: warning.short };
    if (bill.readiness === 'ready') return { stage, part: part('checked', yours, 'Checked', 'checked', 6), chip: 'Checked' };
    return { stage, part: part('check', yours, 'Needs a check', 'yours', 2), chip: 'Needs a check' };
  }

  if (stage === 'approval') {
    if (bill.questionForYou) return question;
    const people = bill.waitingOn;
    if (people.some((p) => p.userId === viewer.userId)) {
      return { stage, part: part('mine', 'you', 'Your approval', 'yours', 5), chip: 'Your approval' };
    }
    if (people.length > 0) {
      const names = people.map((p) => p.name);
      return {
        stage,
        part: part(`w:${names.join('|')}`, 'approvers', names.join(' or '), 'waiting', 10, names),
        chip: `Waiting on ${names.map(firstName).join(' or ')}`,
      };
    }
    // Nobody to act: held, or a route with no one on it.
    return bill.subStatus.tone === 'danger'
      ? { stage, part: part('nobody', 'approvers', 'No one to approve', 'blocking', 20), chip: 'No one to approve' }
      : { stage, part: part('held', 'approvers', bill.subStatus.text, 'finished', 21), chip: bill.subStatus.text };
  }

  if (bill.state === 'cancelled') {
    const why = CLOSED_WHY[bill.closedReason ?? ''];
    return { stage, part: part('closed', 'done', 'Closed', 'finished', 5), chip: why ? `Closed · ${why}` : 'Closed' };
  }
  if (bill.posting?.status === 'failed') return { stage, part: part('failed', 'done', 'Couldn’t post', 'blocking', 0), chip: 'Couldn’t post' };
  if (bill.posting?.status === 'posted') {
    return { stage, part: part('posted', 'done', 'Synced to QuickBooks', 'finished', 1), chip: `Posted ${when(bill.posting.at)}` };
  }
  if (bill.posting?.status === 'pending') return { stage, part: part('posting', 'done', 'Posting to QuickBooks', 'finished', 2), chip: 'Posting' };
  if (bill.state === 'executed' || bill.state === 'settled') return { stage, part: part('paid', 'done', 'Paid', 'finished', 4), chip: 'Paid' };
  return { stage, part: part('approved', 'done', 'Approved', 'finished', 3), chip: 'Approved' };
}
