// Test a bill (Approval rules.dc.html L108-L122): make a bill up and see who
// would approve it under the rules on the canvas, published or not. The route
// is walked here, the same four comparisons the engine makes; who actually
// gets each step comes from the API, which applies the organisation's own
// rules (whoever sent a bill can't approve it, roles that can't approve are
// left out, a step left with nobody goes to the approvers, then the admins).
import { Link } from 'react-router';
import type { FlowNode, FlowTest } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { usd } from '../../kit/format';
import { Icon } from '../../kit/icons';
import { Figures, TickGlyph } from '../bill/parts';
import type { Person } from './Canvas';
import { MoneyField } from './Editors';
import { kindOf, uses, type Route, type Sample, type Step } from './flowTree';
import { joinNames, quorumWord, stepInSentence, stepTitle } from './words';

export type TestSample = Sample & { senderId: string | null };

const SLIDER_MAX = 100_000;

type Who = { personId: string; name: string };

/** One step of the chain: who gets it, how many must approve, and why it's them. */
type Row = {
  key: string;
  title: string;
  people: Who[];
  needed: number;
  why: string;
  notes: string[];
  nobody: boolean;
  waits: boolean;
  /** Nobody named could take it, so it went to someone else. */
  filled: boolean;
};

function standInNotes(t: FlowTest['steps'][number] | undefined): string[] {
  if (!t) return [];
  const notes: string[] = [];
  if (t.filledBy) {
    const names = joinNames(t.people.map((p) => p.name), t.needed > 1 ? 'and' : 'or');
    notes.push(`${names} ${t.people.length === 1 ? 'stands' : 'stand'} in.`);
  }
  for (const d of t.dropped) {
    notes.push(d.why === 'sent' ? `${d.name} sent this bill, so they can’t approve it.` : `${d.name} isn’t an approver, so they can’t approve it.`);
  }
  return notes;
}

/** Up to three faces, overlapping; the chain widens its first column for three. */
const MAX_FACES = 3;

function Faces({ people, nobody }: { people: Who[]; nobody: boolean }) {
  if (nobody || people.length === 0) return <span className="ar-faces"><span className="ar-ring" /></span>;
  return (
    <span className="ar-faces">
      {people.slice(0, MAX_FACES).map((p) => (
        <Avatar key={p.personId} name={p.name} size={24} fontSize={9} />
      ))}
    </span>
  );
}

export function TestPanel({
  flow,
  route,
  sample,
  onSample,
  senders,
  vendors,
  categories,
  result,
  stale,
  personOf,
  vendorName,
  policiesHref,
  onClose,
}: {
  flow: FlowNode[];
  route: Route;
  sample: TestSample;
  onSample: (next: TestSample) => void;
  /** Who can send a bill: bill clerks, then admins, then the primary admin. */
  senders: Person[];
  vendors: Array<{ id: string; name: string }>;
  categories: string[];
  result: FlowTest | undefined;
  /** The API is working out a newer answer: the one shown is about to change. */
  stale: boolean;
  personOf: (id: string) => Person | undefined;
  vendorName: (id: string) => string;
  /** Where the sender rule is changed, for whoever may change it. */
  policiesHref: string | null;
  onClose: () => void;
}) {
  const sender = senders.find((p) => p.id === sample.senderId) ?? senders[0];
  const byFirst = uses(flow, 'firstBill');
  const byVendor = uses(flow, 'vendor');
  const byCategory = uses(flow, 'category');
  const tested = new Map((result?.steps ?? []).map((t) => [t.stepId, t]));
  const nameOf = (id: string): Who => ({ personId: id, name: personOf(id)?.name ?? 'Someone who left' });

  const rows: Row[] = [];
  if (flow.length === 0 && result?.builtIn) {
    for (const [i, t] of result.steps.entries()) {
      rows.push({
        key: `built-in-${i}`,
        title: 'The built-in route',
        people: t.people,
        needed: t.needed,
        why: 'Until rules are published, every bill goes this way',
        notes: standInNotes(t),
        nobody: t.people.length === 0,
        waits: t.waits,
        filled: Boolean(t.filledBy),
      });
    }
  } else {
    for (const { node, why } of route.steps) {
      const t = tested.get(node.id);
      const people = t ? t.people : node.approvers.map(nameOf);
      rows.push({
        key: node.id,
        title: stepTitle(node),
        people,
        needed: t ? t.needed : node.quorum === 'all' ? node.approvers.length : node.quorum === 'any' ? 1 : node.quorum,
        why: why.join(' · ') || 'Every bill',
        notes: standInNotes(t),
        nobody: node.approvers.length === 0,
        waits: t ? t.waits : node.approvers.length === 0,
        filled: Boolean(t?.filledBy),
      });
    }
  }

  // Where the bill would stop: a step with nobody picked, or one only its sender could approve.
  const stuckRow = rows.find((r) => r.waits);
  const stuckStep: Step | undefined = stuckRow ? route.steps.find((s) => s.node.id === stuckRow.key)?.node : undefined;
  let stuck: string | null = null;
  if (stuckRow) {
    const where = stuckStep ? stepInSentence(stuckStep) : null;
    stuck = stuckRow.nobody
      ? `${where ? where.replace(/^an /, 'An ') : 'The built-in route'} has nobody picked yet, so the bill would wait there.`
      : `${sender?.name ?? 'Whoever sent it'} sent this bill and no one else can approve it, so it would wait${where ? ` at ${where}` : ''}.`;
  }
  const reachesEnd = Boolean(route.endId) || Boolean(flow.length === 0 && result?.builtIn);
  let open: string | null = null;
  if (!stuck && !reachesEnd && (flow.length > 0 || result)) {
    if (route.stoppedAt) {
      const k = kindOf(route.stoppedAt);
      const what = k === 'vendor' ? 'the vendors' : k === 'category' ? 'the categories' : 'the amount';
      open = `A split on its way has no ${what.replace('the ', '')} picked yet, so the bill can’t go past it. Pick ${what} to send it on.`;
    } else if (rows.length) {
      const last = rows[rows.length - 1]!;
      open = `As it stands the bill is approved after ${joinNames(last.people.map((p) => p.name), last.needed > 1 ? 'and' : 'or')}. End the path there, or add who approves next.`;
    } else {
      open = 'Nothing is on its path yet.';
    }
  }

  const sampleLine = [
    usd(sample.amountUsd),
    byFirst ? (sample.firstBill ? 'a vendor’s first bill' : 'not a vendor’s first bill') : null,
    byVendor && sample.vendorId ? `from ${vendorName(sample.vendorId)}` : null,
    byCategory && sample.category ? `coded to ${sample.category}` : null,
  ].filter(Boolean).join(', ');

  return (
    <aside className="ar-panel" data-nopan aria-label="Test a bill">
      <div className="ar-panel-head">
        <h2 className="ar-panel-title">Test a bill</h2>
        <button type="button" className="ar-x" aria-label="Close the panel" onClick={onClose}>
          <Icon.x size={12} strokeWidth={2.2} />
        </button>
      </div>
      <div className="ar-panel-body">
        <p className="ar-intro">Make one up to see who would approve it. Nothing is sent.</p>

        <div className="field">
          <label className="field-label" htmlFor="ar-test-amount">Amount</label>
          <MoneyField id="ar-test-amount" label="Amount" value={sample.amountUsd} onValue={(n) => onSample({ ...sample, amountUsd: n })} />
          <input
            type="range"
            className="ar-slider"
            aria-label="Amount"
            min={0}
            max={SLIDER_MAX}
            step={500}
            value={Math.min(sample.amountUsd, SLIDER_MAX)}
            onChange={(e) => onSample({ ...sample, amountUsd: Number(e.target.value) })}
          />
          <span className="ar-slider-ends num">
            <span>{usd(0)}</span>
            <span>{usd(SLIDER_MAX)}</span>
          </span>
        </div>

        {byFirst ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={sample.firstBill}
            className={`ar-check is-plain${sample.firstBill ? ' is-on' : ''}`}
            onClick={() => onSample({ ...sample, firstBill: !sample.firstBill })}
          >
            <span className="ar-box-tick">{sample.firstBill ? <TickGlyph size={8} width={3.4} /> : null}</span>
            It’s the vendor’s first bill
          </button>
        ) : null}

        {byVendor ? (
          <div className="field">
            <label className="field-label" htmlFor="ar-test-vendor">From vendor</label>
            <select id="ar-test-vendor" className="input ar-input" value={sample.vendorId ?? ''} onChange={(e) => onSample({ ...sample, vendorId: e.target.value || null })}>
              <option value="">Any other vendor</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
        ) : null}

        {byCategory ? (
          <div className="field">
            <label className="field-label" htmlFor="ar-test-category">Coded to</label>
            <select id="ar-test-category" className="input ar-input" value={sample.category ?? ''} onChange={(e) => onSample({ ...sample, category: e.target.value || null })}>
              <option value="">Any other category</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="field">
          <span className="field-label" id="ar-test-sender">Sent by</span>
          <div className="ar-senders" role="radiogroup" aria-labelledby="ar-test-sender">
            {senders.map((p) => {
              const on = p.id === sender?.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`ar-sender${on ? ' is-on' : ''}${senders.length === 1 ? ' is-only' : ''}`}
                  onClick={() => onSample({ ...sample, senderId: p.id })}
                >
                  <span className="ar-radio" />
                  <Avatar name={p.name} src={p.avatarUrl} size={16} />
                  <span className="ar-sender-name clip">{p.name}</span>
                  <span className="ar-sender-role">{p.sends}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className={`ar-result${stale ? ' is-stale' : ''}`}>
          <span className="caps">Who approves it</span>
          {stuck ? (
            <div className="ar-say is-stuck" role="status">
              <b>This bill would get stuck</b>
              <span>{stuck}</span>
            </div>
          ) : null}
          {open ? (
            <div className="ar-say is-open" role="status">
              <b>This path isn’t finished</b>
              <span>{open}</span>
            </div>
          ) : null}

          <ol className={`ar-chain${rows.some((r) => !r.nobody && r.people.length >= MAX_FACES) ? ' is-wide' : ''}`}>
            <li className="ar-link">
              <span className="ar-chain-disc"><Icon.arrowDown size={11} strokeWidth={2.8} /></span>
              <span className="ar-chain-text">
                <b>Sent for approval by {sender?.name ?? 'someone'}</b>
                <span><Figures text={sampleLine} /></span>
              </span>
            </li>
            {rows.map((r) => {
              const joiner = r.needed > 1 ? 'and' : 'or';
              const word = r.filled ? '' : quorumWord(r.people.length, r.needed <= 1 ? 'any' : r.needed >= r.people.length ? 'all' : r.needed);
              return (
                <li key={r.key} className="ar-link">
                  <Faces people={r.people} nobody={r.nobody} />
                  <span className="ar-chain-text">
                    <b>
                      {r.people.length === 0
                        ? <span className="ar-joiner">Nobody picked yet</span>
                        : r.people.map((p, i) => (
                            <span key={p.personId}>
                              {i === 0 ? null : <span className="ar-joiner">{i === r.people.length - 1 ? ` ${joiner} ` : ', '}</span>}
                              {p.name}
                            </span>
                          ))}
                    </b>
                    <span>{word ? `${r.title} · ${word}` : r.title}</span>
                    <span><Figures text={r.why} /></span>
                    {r.notes.map((n) => (
                      <span key={n} className="ar-chain-note">{n}</span>
                    ))}
                  </span>
                </li>
              );
            })}
            {reachesEnd && !stuck ? (
              <li className="ar-link is-end">
                <span className="ar-chain-disc is-done"><TickGlyph size={12} width={3.2} /></span>
                <span className="ar-chain-text"><b>Approved</b></span>
              </li>
            ) : null}
          </ol>

          {result && !result.sendersMayApprove ? (
            <p className="ar-foot">
              Whoever sent a bill can’t approve it. Change this on{' '}
              {policiesHref ? <Link to={policiesHref} title="Opens Organisation">Organisation</Link> : 'Organisation'}.
            </p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

const SEND_ORDER = ['Bill clerk', 'Admin', 'Primary admin'];

/** Who can send a bill, in the order Sent by lists them: bill clerks, then admins, then the primary admin. */
export function sendersOf(team: Person[]) {
  return team
    .filter((p) => p.sends)
    .sort((a, b) => SEND_ORDER.indexOf(a.sends!) - SEND_ORDER.indexOf(b.sends!) || a.name.localeCompare(b.name));
}
