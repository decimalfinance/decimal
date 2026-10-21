// The route a bill takes once it leaves review (5d, 60e, 62a/b, 5e, 5f): who
// brought it in, who sent it for approval, then each approval step, as beads
// on a line. The line is solid as far as the bill has got and dotted beyond.
// Decimal and QuickBooks are never on it, and only the latest round shows: a
// bill sent again starts its route afresh, and History keeps the rest.
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { BillDetail, BillDetailStepNode } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { firstName } from '../../kit/format';
import { stepGroups, takeBackAsked } from './model';
import { WaitBadge, dayAndTime } from './parts';

type Bead = { name: string; avatarUrl: string | null; look: 'on' | 'ahead' | 'spare' };
type Caption = { text: string; tone: 'plain' | 'turn' | 'ahead' | 'back' };
export type ChainNode = {
  key: string;
  beads: Bead[];
  badge: 'waiting' | 'approved' | 'back' | null;
  names: ReactNode;
  /** Not reached yet: drawn pale, and the line into it dotted. */
  ahead: boolean;
  time: string | null;
  caption: Caption;
};

const BEAD = 24;

function ApprovedBadge() {
  return (
    <span className="bp-badge is-good">
      <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m5.5 12.5 4 4 9-9" />
      </svg>
    </span>
  );
}

function BackBadge() {
  return (
    <span className="bp-badge is-back">
      <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9.5 6.5 5 11l4.5 4.5" />
        <path d="M5.5 11H15a4.5 4.5 0 0 1 0 9h-2.5" />
      </svg>
    </span>
  );
}

/** "Tom or Ines", with "(you)" after whoever is the viewer. */
function namesOf(people: Array<{ name: string; you: boolean }>, joiner: 'or' | 'and'): ReactNode {
  return people.map((p, i) => (
    <span key={`${p.name}-${i}`} style={{ display: 'contents' }}>
      {i > 0 ? <span className="bp-chain-or">{i === people.length - 1 ? joiner : ','}</span> : null}
      <span>{firstName(p.name)}</span>
      {p.you ? <span className="bp-chain-you">(you)</span> : null}
    </span>
  ));
}

/**
 * The route's nodes, from the bill as the viewer sees it. `sentBack` draws the
 * step that sent it back in the return colours (5e); elsewhere it's plain.
 */
export function chainOf(detail: BillDetail, opts: { sentBack?: boolean } = {}): ChainNode[] {
  const viewerId = detail.viewer.personId;
  const viewerName = detail.viewer.name;
  const nodes: ChainNode[] = [];
  const story = [...detail.history.before, ...detail.history.after]
    .filter((h) => h.at)
    .sort((a, b) => new Date(a.at!).getTime() - new Date(b.at!).getTime());
  const arrival = story.find((h) => (h.kind === 'uploaded' || h.kind === 'forwarded') && h.person) ?? null;
  const sends = story.filter((h) => h.kind === 'submitted');
  const lastSend = sends[sends.length - 1] ?? null;
  const sender = lastSend?.person ?? (detail.requester ? { name: detail.requester.name, avatarUrl: detail.requester.avatarUrl } : null);
  const senderIsViewer = detail.viewer.isRequester || (sender !== null && sender.name === viewerName);

  // Whoever brought it in, unless they sent it too: then one bead does both.
  const arrivedWord = arrival?.kind === 'forwarded' ? 'Forwarded' : 'Uploaded';
  const both = Boolean(arrival?.person && sender && arrival.person.name === sender.name);
  if (arrival?.person && !both) {
    nodes.push({
      key: 'arrival',
      beads: [{ name: arrival.person.name, avatarUrl: arrival.person.avatarUrl, look: 'on' }],
      badge: null,
      names: namesOf([{ name: arrival.person.name, you: arrival.person.name === viewerName }], 'and'),
      ahead: false,
      time: dayAndTime(arrival.at!),
      caption: { text: arrivedWord, tone: 'plain' },
    });
  }
  if (sender) {
    nodes.push({
      key: 'sender',
      beads: [{ name: sender.name, avatarUrl: sender.avatarUrl, look: 'on' }],
      badge: null,
      names: namesOf([{ name: sender.name, you: senderIsViewer }], 'and'),
      ahead: false,
      time: lastSend?.at ? dayAndTime(lastSend.at) : null,
      // One who brought it in and sent it is captioned by the sending, as 62a draws it.
      caption: { text: sends.length > 1 ? 'Sent for approval again' : 'Sent for approval', tone: 'plain' },
    });
  }

  const groups = stepGroups(detail);
  const stopped = groups.some((g) => g.steps.some((s) => s.state === 'declined'));
  // While a take-back waits on an admin, nobody on the open step can act.
  const held = takeBackAsked(detail) !== null;
  for (const { index, steps } of groups) {
    const either = steps[0]!.mode === 'any' && steps.length > 1;
    const joiner = either ? 'or' : 'and';
    const isYou = (s: BillDetailStepNode) => s.person!.personId === viewerId;
    const face = (s: BillDetailStepNode, look: Bead['look']): Bead => ({ name: s.person!.name, avatarUrl: s.person!.avatarUrl, look });
    const declined = steps.find((s) => s.state === 'declined');
    const done = steps.filter((s) => s.state === 'done');
    const current = steps.filter((s) => s.state === 'current');
    const complete = done.length > 0 && done.length >= Math.min(steps[0]!.required || 1, steps.length);

    if (declined) {
      nodes.push({
        key: `step-${index}`,
        beads: [face(declined, 'on')],
        badge: opts.sentBack ? 'back' : null,
        names: namesOf([{ name: declined.person!.name, you: isYou(declined) }], joiner),
        ahead: false,
        time: declined.actedAt ? dayAndTime(declined.actedAt) : null,
        caption: { text: 'Sent back', tone: opts.sentBack ? 'back' : 'plain' },
      });
    } else if (complete) {
      // Either of two: whoever approved sits on top, the other drawn pale, not needed.
      const spare = steps.filter((s) => !done.includes(s));
      const last = done.reduce((a, b) => (new Date(b.actedAt ?? 0) > new Date(a.actedAt ?? 0) ? b : a));
      nodes.push({
        key: `step-${index}`,
        beads: [...spare.map((s) => face(s, 'spare')), ...done.map((s) => face(s, 'on'))],
        badge: 'approved',
        names: namesOf(done.map((s) => ({ name: s.person!.name, you: isYou(s) })), 'and'),
        ahead: false,
        time: last.actedAt ? dayAndTime(last.actedAt) : null,
        caption: { text: 'Approved', tone: 'plain' },
      });
    } else if (current.length > 0) {
      const yours = current.some(isYou);
      nodes.push({
        key: `step-${index}`,
        beads: steps.map((s) => face(s, 'on')),
        badge: 'waiting',
        names: namesOf(steps.map((s) => ({ name: s.person!.name, you: isYou(s) })), joiner),
        ahead: false,
        time: null,
        caption: { text: held ? 'On hold' : yours ? 'Your turn' : either ? 'Either one' : 'Waiting', tone: 'turn' },
      });
    } else {
      nodes.push({
        key: `step-${index}`,
        beads: steps.map((s) => face(s, 'ahead')),
        badge: null,
        names: namesOf(steps.map((s) => ({ name: s.person!.name, you: isYou(s) })), joiner),
        ahead: true,
        time: null,
        caption: { text: stopped ? 'Not asked' : 'Next', tone: 'ahead' },
      });
    }
  }
  return nodes;
}

function Beads({ node }: { node: ChainNode }) {
  const tone = (b: Bead) => (b.look === 'ahead' ? 'var(--bead-off)' : b.look === 'spare' ? 'var(--bead-spare)' : null);
  const badge = node.badge === 'waiting' ? <WaitBadge /> : node.badge === 'approved' ? <ApprovedBadge /> : node.badge === 'back' ? <BackBadge /> : null;
  const one = (b: Bead, i: number, last: boolean) => (
    <span key={`${b.name}-${i}`} className={b.look === 'on' ? undefined : `is-${b.look}`}>
      <Avatar name={b.name} src={b.look === 'on' ? b.avatarUrl : null} size={BEAD} tone={tone(b)} />
      {last ? badge : null}
    </span>
  );
  if (node.beads.length === 1) return one(node.beads[0]!, 0, true);
  return (
    <span className="bp-chain-pair">
      {node.beads.map((b, i) => one(b, i, i === node.beads.length - 1))}
    </span>
  );
}

export function Chain({ nodes }: { nodes: ChainNode[] }) {
  // Every moment shows its time while the labels have room. Where two would
  // run into each other (a long route, a narrow column), the times go.
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.classList.remove('is-tight');
      const boxes = [...el.querySelectorAll<HTMLElement>('.bp-chain-label > div')].map((d) => d.getBoundingClientRect());
      el.classList.toggle('is-tight', boxes.some((b, i) => i > 0 && b.left < boxes[i - 1]!.right + 12));
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [nodes]);
  if (nodes.length === 0) return null;
  const columns = nodes.map(() => 'auto').join(' minmax(0, 1fr) ');
  const cells: ReactNode[] = [];
  nodes.forEach((node, i) => {
    const column = i * 2 + 1;
    if (i > 0) {
      cells.push(<span key={`leg-${node.key}`} className={`bp-chain-leg${node.ahead ? ' is-ahead' : ''}`} style={{ gridColumn: column - 1 }} />);
    }
    cells.push(
      <span key={`bead-${node.key}`} className={`bp-chain-bead${node.ahead ? ' is-ahead' : ''}`} style={{ gridColumn: column }}>
        <Beads node={node} />
      </span>,
    );
    const place = i === 0 ? ' is-first' : i === nodes.length - 1 ? ' is-last' : '';
    cells.push(
      <span key={`label-${node.key}`} className={`bp-chain-label${place}`} style={{ gridColumn: column }}>
        <div>
          <div className={`bp-chain-name${node.ahead ? ' is-ahead' : ''}`}>
            {node.names}
            {node.time ? <span className="bp-chain-time">{node.time}</span> : null}
          </div>
          <div className="bp-chain-cap">
            <span className={node.caption.tone === 'plain' ? undefined : `is-${node.caption.tone}`}>{node.caption.text}</span>
          </div>
        </div>
      </span>,
    );
  });
  return (
    <div ref={ref} className="bp-chain" style={{ gridTemplateColumns: columns }}>
      {cells}
    </div>
  );
}
