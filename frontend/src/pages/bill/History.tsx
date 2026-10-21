// History (5a, 38c): everything that happened to the bill, oldest first, in a
// pink box that folds to its latest line. Each entry has a face (Decimal's orb
// for what it did), a tick or cross badge when it was a decision, the time on
// the right, and Decimal's own steps folded under the reading. The lines use
// the design's words: "raised a finding: …", "fixed the total: …".
import { Fragment, useState, type ReactNode } from 'react';
import type { BillCompanionNote, BillDetail } from '../../api';
import { when } from '../../kit/format';
import { CLOSE_REASONS, DETAIL_FIELDS, FIELD_LABELS, VENDOR_FIELDS, fieldsFrom, type Face } from './model';
import { Badge, Chevron, FaceOf, Figures, dayAndTime } from './parts';

type Step = { text: string; status: string };
type Item = {
  id: string;
  at: Date;
  who: Face | 'decimal';
  badge?: 'good' | 'bad';
  line: ReactNode;
  plain: string;
  sub?: string;
  steps?: Step[];
};

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
const faceOf = (name: string | null | undefined): Face | 'decimal' =>
  !name || name === 'Decimal' ? 'decimal' : { name, avatarUrl: null };

function q(text: string) {
  return <q>{text}</q>;
}

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Something someone did at a moment, as the work log records it. */
type Moment = { at: string; byName: string | null };
/** One person, within a few seconds: the parts of one action. */
const sameMoment = (a: Moment, b: Moment) =>
  a.byName === b.byName && Math.abs(new Date(a.at).getTime() - new Date(b.at).getTime()) <= 5000;

/** A finding's name; it leads up to Decimal's box, where findings are settled. */
function FindingName({ text }: { text: string }) {
  return (
    <a
      href="#decimal-agent"
      onClick={(e) => {
        e.preventDefault();
        document.querySelector('.bp-agentwrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }}
    >
      {text}
    </a>
  );
}

export function historyItems(detail: BillDetail, note: BillCompanionNote | null | undefined): Item[] {
  const draft = detail.draft;
  const log = draft.workLog;
  const items: Item[] = [];
  const nameOf = (who: Face | 'decimal') => (who === 'decimal' ? 'Decimal agent' : who.name);

  const push = (item: Omit<Item, 'plain'> & { plain?: string }) => {
    items.push({ ...item, plain: item.plain ?? `${nameOf(item.who)}` });
  };

  // What a person did and the findings it settled happened in one moment, so
  // they are one entry: the action carries the tick and the separate
  // "settled" lines go, as in the design.
  const taken = new Set<string>();
  const settles = (act: Moment) => {
    let any = false;
    for (const c of log) {
      if (c.kind !== 'flag_cleared' || taken.has(c.id) || !c.byName || !sameMoment(c, act)) continue;
      taken.add(c.id);
      any = true;
    }
    return any;
  };
  // Using the itemised total also rewrites the total; that is one decision.
  const itemisedAt = log.filter((e) => e.kind === 'policy_overridden' && e.rule === 'pay_the_itemised_total');
  const itemised = draft.flags.find((f) => f.kind === 'short_paid' && f.severity === 'info');
  const cleared = draft.flags.find((f) => f.kind === 'possible_duplicate' && f.severity === 'info');

  for (const e of log) {
    if (e.kind !== 'policy_overridden') continue;
    const who = faceOf(e.byName);
    const name = nameOf(who);
    const at = new Date(e.at);
    settles(e);
    const m = /^(.*?)\s*“(.*)”$/.exec(e.text);
    const reason = m?.[2] ?? null;
    const because = reason ? <> {q(reason)}</> : null;
    let line: ReactNode;
    let plain: string;
    if (e.rule === 'pay_the_itemised_total') {
      const f = itemised ? /Paying the (\$[\d,.]+) this bill itemises rather than the (\$[\d,.]+) printed/.exec(itemised.message) : null;
      const what = f ? `used the itemised total: ${f[1]}, not the ${f[2]} printed` : 'used the itemised total';
      line = <><b>{name}</b> <Figures text={what} />{reason ? ',' : null}{because}</>;
      plain = `${name} ${what}`;
    } else if (e.rule === 'duplicate_bill') {
      const other = cleared ? /duplicate of (invoice \S+|another bill)/.exec(cleared.message)?.[1]?.replace(/^invoice /, '') : null;
      const what = `cleared it: not a duplicate${other ? ` of ${other}` : ''}`;
      line = <><b>{name}</b> <Figures text={what} />{reason ? ',' : null}{because}</>;
      plain = `${name} ${what}`;
    } else if (e.rule === 'bill_ceiling') {
      line = <><b>{name}</b> allowed it over the bill limit, this bill only{reason ? ',' : null}{because}</>;
      plain = `${name} allowed it over the bill limit`;
    } else if (e.rule === 'similar_vendor' && reason && e.byName && reason.startsWith(`${e.byName} `)) {
      const rest = reason.slice(e.byName.length + 1);
      line = <><b>{name}</b> {rest}</>;
      plain = `${name} ${rest}`;
    } else {
      line = m ? <><b>{name}</b>: {lowerFirst(m[1]!)}{because}</> : <><b>{name}</b>: {e.text}</>;
      plain = `${name}: ${m ? lowerFirst(m[1]!) : e.text}`;
    }
    push({ id: e.id, at, who, badge: 'good', line, plain });
  }

  for (const t of draft.tradingNamesFromHere ?? []) {
    if (!t.at) continue;
    const who = faceOf(t.byName);
    const name = nameOf(who);
    settles({ at: t.at, byName: t.byName });
    push({
      id: `tn-${t.name}`, at: new Date(t.at), who, badge: 'good',
      line: <><b>{name}</b> recorded {t.name} as a name we trade under</>,
      plain: `${name} recorded ${t.name} as a name we trade under`,
    });
  }

  const steps = detail.approval?.steps ?? [];
  const declined = steps.some((s) => s.state === 'declined');
  let arrived: Date | null = null;
  for (const h of [...detail.history.before, ...detail.history.after]) {
    if (!h.at) continue;
    const who: Face | 'decimal' = h.person ? { name: h.person.name, avatarUrl: h.person.avatarUrl } : 'decimal';
    const at = new Date(h.at);
    const name = nameOf(who);
    if (h.kind === 'uploaded') {
      arrived = arrived ?? at;
      const file = draft.document?.filename ?? 'the document';
      push({ id: `h-up-${h.at}`, at, who, line: <><b>{name}</b> uploaded <span className="num">{file}</span></>, plain: `${name} uploaded ${file}` });
    } else if (h.kind === 'forwarded') {
      arrived = arrived ?? at;
      push({ id: `h-fw-${h.at}`, at, who, line: <><b>{name}</b> forwarded it by email</>, plain: `${name} forwarded it by email` });
    } else if (h.kind === 'submitted') {
      push({ id: `h-sub-${h.at}`, at, who, line: <><b>{name}</b> sent it for approval</>, plain: `${name} sent it for approval` });
    } else if (h.kind === 'sent_back' && !declined) {
      push({ id: `h-back-${h.at}`, at, who, badge: 'bad', line: <><b>{name}</b> sent it back</>, plain: `${name} sent it back` });
    } else if (h.kind === 'recalled') {
      push({ id: `h-rec-${h.at}`, at, who, line: <><b>{name}</b> took it back to review</>, plain: `${name} took it back to review` });
    } else if (h.kind === 'cancelled') {
      // Closing settles every finding on the bill; those go into this line.
      settles({ at: h.at, byName: h.person?.name ?? null });
      const reason = CLOSE_REASONS.find((r) => r.key === detail.closed?.reason);
      const what = reason && reason.key !== 'other' ? `closed it: ${lowerFirst(reason.label)}` : 'closed it';
      const said = detail.closed?.note ?? null;
      push({ id: `h-can-${h.at}`, at, who, line: <><b>{name}</b> {what}{said ? <> {q(said)}</> : null}</>, plain: `${name} ${what}` });
    }
  }

  // Decimal's reading, with its steps folded under it. It comes after the
  // arrival and before anything the reading found.
  if (arrived) {
    const did = note?.did ?? [];
    const firstFound = log.find((e) => e.kind === 'flag_raised');
    const found = firstFound ? new Date(firstFound.at).getTime() : Infinity;
    const readAt = Math.max(arrived.getTime() + 1, Math.min(arrived.getTime() + 1000, found - 1));
    const fields = fieldsFrom(draft);
    const filled = [...VENDOR_FIELDS, ...DETAIL_FIELDS].filter((d) => {
      const f = fields[d.key];
      return f && f.value.trim() !== '' && f.state !== 'not_on_document';
    }).length;
    const lines = draft.lines.length;
    const what = filled || lines
      ? `read the document and filled in ${counted(filled, 'field')} and ${counted(lines, 'line')}`
      : 'read the document';
    push({
      id: 'h-read',
      at: new Date(readAt),
      who: 'decimal',
      line: <><b>Decimal agent</b> <Figures text={what} /></>,
      plain: `Decimal agent ${what}`,
      steps: did.map((d) => ({ text: d.detail ? `${d.text} · ${d.detail}` : d.text, status: d.status === 'noted' ? 'Noted' : d.status === 'failed' ? 'Failed' : d.status === 'running' ? 'Working' : '' })),
    });
  }

  for (const e of log) {
    if (e.kind !== 'field_changed') continue;
    if (e.field === 'total' && itemisedAt.some((o) => sameMoment(o, e))) continue;
    const who = faceOf(e.byName);
    const name = nameOf(who);
    const at = new Date(e.at);
    const m = /^(.*?) changed from (.*) to (.*)$/.exec(e.text);
    const label = (e.field && FIELD_LABELS[e.field]) || m?.[1] || 'A field';
    const settled = who !== 'decimal' && settles(e);
    if (e.field === 'total' && settled && m) {
      push({
        id: e.id, at, who, badge: 'good',
        line: <><b>{name}</b> <Figures text={`fixed the total: it was read as ${m[2]} and is now ${m[3]}`} /></>,
        plain: `${name} fixed the total`,
      });
    } else {
      push({
        id: e.id, at, who, badge: settled ? 'good' : undefined,
        line: m ? <><b>{name}</b> changed the {lowerFirst(label)} from <span className="num">{m[2]}</span> to <span className="num">{m[3]}</span></> : <><b>{name}</b> {lowerFirst(e.text)}</>,
        plain: m ? `${name} changed the ${lowerFirst(label)}` : `${name} ${lowerFirst(e.text)}`,
      });
    }
  }

  for (const e of log) {
    const at = new Date(e.at);
    if (e.kind === 'flag_raised') {
      const what = e.text.replace(/^Flagged:\s*/, '');
      push({ id: e.id, at, who: 'decimal', badge: 'bad', line: <><b>Decimal agent</b> raised a finding: <FindingName text={what} /></>, plain: `Decimal agent raised a finding: ${what}` });
    } else if (e.kind === 'flag_cleared' && !taken.has(e.id)) {
      const what = e.text.replace(/^Resolved:\s*/, '');
      const who = faceOf(e.byName);
      const name = nameOf(who);
      push(who === 'decimal'
        ? { id: e.id, at, who, line: <><b>Decimal agent</b>: <FindingName text={what} /> no longer applies</>, plain: `Decimal agent: ${what} no longer applies` }
        : { id: e.id, at, who, badge: 'good', line: <><b>{name}</b> settled <FindingName text={what} /></>, plain: `${name} settled ${what}` });
    }
  }

  for (const question of draft.questions) {
    const asker = faceOf(question.askedByName);
    push({
      id: `q-${question.billQuestionId}`,
      at: new Date(question.askedAt),
      who: asker,
      line: <><b>{question.askedByName}</b> asked {question.askedOfName}: {q(question.question)}</>,
      plain: `${question.askedByName} asked ${question.askedOfName}`,
      sub: question.stillOpen ? `Waiting on ${question.askedOfName}` : undefined,
    });
    if (question.answeredAt) {
      const by = question.answeredByName ?? question.askedOfName;
      const at = new Date(question.answeredAt);
      const id = `qa-${question.billQuestionId}`;
      const said = question.answer ? <>: {q(question.answer)}</> : null;
      if (question.outcome === 'closed') {
        push({ id, at, who: faceOf(question.askedByName), line: <><b>{question.askedByName}</b> closed the question{said}</>, plain: `${question.askedByName} closed the question` });
      } else if (question.outcome === 'handed_back') {
        push({ id, at, who: faceOf(by), line: <><b>{by}</b> couldn’t answer{said}</>, plain: `${by} couldn’t answer` });
      } else if (question.outcome === 'forwarded') {
        push({ id, at, who: faceOf(by), line: <><b>{by}</b> passed the question on</>, plain: `${by} passed the question on` });
      } else if (question.outcome === 'partial') {
        push({ id, at, who: faceOf(by), line: <><b>{by}</b> answered part of it{said}</>, plain: `${by} answered part of it` });
      } else if (question.answer) {
        push({ id, at, who: faceOf(by), line: <><b>{by}</b> answered{said}</>, plain: `${by} answered` });
      }
    }
  }

  for (const s of steps) {
    if (!s.person || !s.actedAt) continue;
    const who: Face = { name: s.person.name, avatarUrl: s.person.avatarUrl };
    if (s.state === 'done') {
      push({ id: `ap-${s.stepIndex}-${s.person.personId}`, at: new Date(s.actedAt), who, badge: 'good', line: <><b>{who.name}</b> approved it</>, plain: `${who.name} approved it` });
    } else if (s.state === 'declined') {
      push({
        id: `dec-${s.stepIndex}-${s.person.personId}`, at: new Date(s.actedAt), who, badge: 'bad',
        line: <><b>{who.name}</b> sent it back{s.declineReason ? <>: {q(s.declineReason)}</> : null}</>,
        plain: `${who.name} sent it back`,
      });
    }
  }

  return items.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function History({ detail, note }: { detail: BillDetail; note: BillCompanionNote | null | undefined }) {
  const items = historyItems(detail, note);
  const [open, setOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState<Record<string, boolean>>({});
  if (items.length === 0) return null;
  const latest = items[items.length - 1]!;
  return (
    <div className={`bp-hist${open ? '' : ' is-folded'}`}>
      <button type="button" className="bp-hist-top" aria-expanded={open} aria-label="Fold or open History" onClick={() => setOpen((v) => !v)}>
        <span className="bp-hist-title">History</span>
        <span className="bp-hist-n">{items.length}</span>
        {!open ? (
          <span className="bp-hist-latest">
            <span>·</span>
            <span>{latest.plain},</span>
            <span className="num">{when(latest.at)}</span>
          </span>
        ) : null}
        <span className="bp-hist-chev"><Chevron /></span>
      </button>
      {open ? (
        <div className="bp-hist-list">
          {items.map((item, i) => {
            const prev = items[i - 1];
            const firstOfDay = !prev || prev.at.toDateString() !== item.at.toDateString();
            const time = firstOfDay ? dayAndTime(item.at) : `${item.at.getHours()}:${String(item.at.getMinutes()).padStart(2, '0')}`;
            const showSteps = stepsOpen[item.id] ?? false;
            return (
              <Fragment key={item.id}>
                <div className="bp-hist-item">
                  <span className="bp-hist-face">
                    <FaceOf who={item.who} size={16} orb="still" bg="white" />
                    {item.badge ? <Badge good={item.badge === 'good'} /> : null}
                  </span>
                  <div className="bp-hist-text">
                    <div className="bp-hist-line">
                      {item.line}
                      {item.steps && item.steps.length > 0 ? (
                        <button
                          type="button"
                          className={`bp-steps-btn${showSteps ? ' is-open' : ''}`}
                          onClick={() => setStepsOpen((s) => ({ ...s, [item.id]: !showSteps }))}
                        >
                          <span><span className="num">{item.steps.length}</span> {item.steps.length === 1 ? 'step' : 'steps'}</span>
                          <Chevron size={9} />
                        </button>
                      ) : null}
                    </div>
                    {item.sub ? <div className="bp-hist-sub">{item.sub}</div> : null}
                  </div>
                  <span className="bp-hist-time">{time}</span>
                </div>
                {showSteps && item.steps ? (
                  <div className="bp-steps">
                    {item.steps.map((s, j) => (
                      <div key={j} className="bp-step">
                        <span>{s.text}</span>
                        {s.status ? <span className="bp-step-status">{s.status}</span> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
