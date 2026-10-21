// A bill past review, read rather than edited: in approval (5d, 60e, 61s/t),
// done (5f, 5g) and closed (5h). On the left the route it takes and its facts;
// on the right Decimal and History; along the bottom what the viewer can do
// about it now. The document opens over the page from the breadcrumb.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, approvalsApi, billsApi, type BillCompanionNote, type BillDetail, type BillDetailStepNode } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { useDismiss } from '../../kit/hooks';
import { Icon } from '../../kit/icons';
import { useToaster } from '../../kit/Toast';
import { calendarDay, daysPast, firstName, stamp, usd } from '../../kit/format';
import { AgentBox } from './AgentBox';
import { Chain, chainOf } from './Chain';
import { Facts } from './Facts';
import type { Access, OpenCard } from './Findings';
import { History } from './History';
import {
  fieldsFrom,
  headerOf,
  inApproval,
  linesFrom,
  linesSum,
  parseMoney,
  shown,
  duplicateOf,
  firstSentence,
  stepGroups,
  syncProblem,
  takeBackAsked,
  type Face,
} from './model';

const CHIP_CLASS = {
  yours: 'is-yours',
  checked: 'is-checked',
  blocking: 'is-blocking',
  warning: 'is-warning',
  waiting: 'is-waiting',
  finished: 'is-finished',
} as const;

const nothing = async () => {};

/** "13 Aug 2026, 16:41" with the date and the time in figures; "Today, 16:41" on the day. */
function When({ at }: { at: string }) {
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) {
    return <>Today, <span className="num">{`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`}</span></>;
  }
  const [day, time] = stamp(at).split(', ');
  return <><span className="num">{day}</span>, <span className="num">{time}</span></>;
}

/** Figures in a bar sentence set in mono, the rest as it is. */
function Num({ children }: { children: ReactNode }) {
  return <span className="num">{children}</span>;
}

/** How far QuickBooks got with it, after the stage word. Not a link: there's no address for the bill there. */
function QuickBooksTag({ posting }: { posting: NonNullable<BillDetail['posting']> }) {
  const failed = posting.status === 'failed';
  const word = posting.status === 'posted' ? 'Synced' : failed ? 'Couldn’t sync' : 'Syncing';
  return (
    <>
      <span className="bp-qb" title={failed ? 'Couldn’t sync to QuickBooks' : posting.status === 'posted' ? 'In QuickBooks' : 'On its way to QuickBooks'}>
        <img src="/quickbooks.svg" alt="QuickBooks" />
        <span className={`bp-qb-word${failed ? ' is-failed' : posting.status === 'pending' ? ' is-pending' : ''}`}>{word}</span>
      </span>
      {posting.at ? (
        <>
          <span className="bp-dot">·</span>
          <span className="bp-qb-time"><When at={posting.at} /></span>
        </>
      ) : null}
    </>
  );
}

// ── What Decimal says about a bill past review ──────────────────────────

const CHANGED_WORD: Record<string, string> = {
  vendorName: 'vendor name', vendorEmail: 'email', invoiceNumber: 'invoice number', invoiceDate: 'invoice date',
  dueDate: 'due date', terms: 'terms', poNumber: 'PO number', discount: 'discount', currency: 'currency',
  total: 'total', taxAmount: 'tax', tax: 'tax',
};
const MONEY = new Set(['total', 'taxAmount', 'tax']);
const DATES = new Set(['invoiceDate', 'dueDate']);
const COUNT = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

const valueOf = (field: string, v: string) => shown(MONEY.has(field) ? 'money' : DATES.has(field) ? 'date' : 'text', v) || v;

/** "a, b and c" */
const listed = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

type Lead = { text: string; working: boolean; points?: Array<{ tone: 'ok' | 'bad'; text: string }>; at?: string | null; actions?: ReactNode };

/**
 * The bill as Decimal hands it on: checked, and what people changed on the way.
 * Worked out from what the bill records, so it is the same for everyone.
 */
function checkedWords(detail: BillDetail, viewer: Face, yourTurn: boolean): Lead {
  const draft = detail.draft;
  const who = (name: string | null) => (!name ? 'someone' : name === viewer.name ? 'you' : name);
  const fields = detail.corrections.filter((c) => CHANGED_WORD[c.field]);
  const recoded = detail.corrections.filter((c) => c.field.startsWith('Category'));
  const facts = fieldsFrom(draft);
  const lines = linesFrom(draft);
  const tax = parseMoney(facts.taxAmount?.value) ?? 0;
  const itemised = Math.round((linesSum(lines) + tax) * 100) / 100;
  const total = parseMoney(facts.total?.value);

  let changed: string;
  if (draft.unreadable) {
    changed = 'Every figure on the bill was typed in by hand, as the document couldn’t be read.';
  } else if (fields.length === 0) {
    changed = 'Every figure on the bill is checked, and each is as the document shows it.';
  } else if (fields.length === 1) {
    const c = fields[0]!;
    const label = CHANGED_WORD[c.field]!;
    const by = who(c.by);
    const to = valueOf(c.field, c.to);
    const from = valueOf(c.field, c.from);
    changed = c.from === 'not on document' ? `Every figure on the bill is checked. One was added by a person: ${by} added the ${label}, ${to}, which isn’t on the document.`
      : c.to === 'removed' ? `Every figure on the bill is checked. One was taken out by a person: ${by} removed the ${label}, which the document prints as ${from}.`
      : c.field === 'total' && parseMoney(c.to) === itemised ? `Every figure on the bill is checked. One was changed by a person: ${by} fixed the total, which the document prints as ${from}, to the ${to} the ${tax > 0 ? 'lines and tax' : 'lines'} add up to.`
      : `Every figure on the bill is checked. One was changed by a person: ${by} changed the ${label}, which the document prints as ${from}, to ${to}.`;
  } else {
    const byPerson = new Map<string, string[]>();
    for (const c of fields) {
      const name = who(c.by);
      const words = byPerson.get(name) ?? [];
      if (!words.includes(`the ${CHANGED_WORD[c.field]}`)) words.push(`the ${CHANGED_WORD[c.field]}`);
      byPerson.set(name, words);
    }
    const parts = [...byPerson.entries()].map(([name, words]) => `${name} changed ${listed(words)}`);
    const n = COUNT[fields.length] ?? String(fields.length);
    changed = `Every figure on the bill is checked. ${n} were changed by ${byPerson.size > 1 ? 'people' : 'a person'}: ${parts.join(', and ')}.`;
  }

  const points: Lead['points'] = [];
  if (lines.length > 0 && total !== null && !draft.unreadable) {
    const what = tax > 0 ? 'The lines and tax add up to' : 'The lines add up to';
    points.push(itemised === total
      ? { tone: 'ok', text: `${what} ${usd(itemised)}, and the total matches them.` }
      : { tone: 'bad', text: `${what} ${usd(itemised)}, and the total is ${usd(total)}.` });
  }
  if (recoded.length > 2) {
    const people = [...new Set(recoded.map((c) => who(c.by)))];
    points.push({ tone: 'ok', text: capital(`${listed(people)} moved ${recoded.length} lines to other categories than Decimal picked.`) });
  } else {
    for (const c of recoded) {
      const line = c.field.replace(/^Category\s*—\s*/, '');
      points.push({
        tone: 'ok',
        text: capital(c.from === 'not on document' ? `${who(c.by)} put “${line}” under ${c.to}.` : `${who(c.by)} moved “${line}” from ${c.from} to ${c.to}.`),
      });
    }
  }
  const sends = [...detail.history.before, ...detail.history.after].filter((h) => h.kind === 'submitted' && h.at);
  return {
    text: `${yourTurn ? 'Ready for your approval. ' : ''}${changed}`,
    working: false,
    points,
    at: sends[sends.length - 1]?.at ?? null,
  };
}

// The finding a close settles, by the reason it was closed for.
const CLOSED_FOR: Record<string, string> = {
  duplicate: 'possible_duplicate', statement: 'looks_like_statement', credit_note: 'looks_like_credit_note', not_ours: 'addressed_elsewhere',
};

function closedWords(detail: BillDetail): Lead {
  const draft = detail.draft;
  const flag = draft.flags.find((f) => f.kind === CLOSED_FOR[detail.closed?.reason ?? '']);
  const text = flag?.brief?.status === 'ready' && flag.brief.headline ? flag.brief.headline
    : flag?.finding?.status === 'ready' ? flag.finding.headline
    : flag ? firstSentence(flag.message)
    : 'Closed, so it won’t be approved or posted. Its details and its document stay here to read.';
  const raised = draft.workLog.find((e) => e.kind === 'flag_raised')?.at ?? null;
  return { text, working: false, at: flag ? raised ?? detail.closed?.at ?? null : detail.closed?.at ?? null };
}

// ── The closed box (5h) ─────────────────────────────────────────────────

function ClosedBox({ organizationId, detail }: { organizationId: string; detail: BillDetail }) {
  const closed = detail.closed!;
  const draft = detail.draft;
  const original = closed.reason === 'duplicate' ? duplicateOf(detail) : null;
  const words: ReactNode = closed.reason === 'duplicate'
    ? original?.invoiceNumber
      ? <>a duplicate of {original.paymentOrderId
        ? <Link to={`/organizations/${organizationId}/bills/${original.paymentOrderId}`}>{original.invoiceNumber}</Link>
        : <span className="num">{original.invoiceNumber}</span>}</>
      : 'a duplicate'
    : closed.reason === 'statement' ? 'a statement'
    : closed.reason === 'credit_note' ? 'a credit note'
    : closed.reason === 'not_ours' ? 'not ours'
    : closed.reason === 'unreadable' ? 'it can’t be read'
    : null;
  return (
    <div className="bp-closed">
      <div className="bp-closed-text">
        {closed.by ? (
          <>
            <Avatar name={closed.by.name} src={closed.by.avatarUrl} size={14} />
            <b>{closed.by.name}</b> closed it{words ? <>: {words}</> : null}.
          </>
        ) : (
          <>Closed{words ? <>: {words}</> : null}.</>
        )}
        {closed.note ? <> <span className="bp-closed-said">“{closed.note}”</span></> : null}
      </div>
      {closed.at ? (
        <div className={`bp-closed-meta${closed.by ? '' : ' is-flush'}`}>
          <span className="bp-closed-time"><When at={closed.at} /></span>
        </div>
      ) : null}
    </div>
  );
}

// ── The bar ─────────────────────────────────────────────────────────────

/** A reason typed in the bar (Send back, Take it back): required, Enter confirms, Esc cancels. */
function ReasonEntry({
  placeholder,
  confirm,
  busy,
  onCancel,
  onConfirm,
}: {
  placeholder: string;
  confirm: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [text, setText] = useState('');
  const [needed, setNeeded] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const go = () => {
    const words = text.trim();
    if (words.length < 3) {
      setNeeded(true);
      input.current?.focus();
      return;
    }
    onConfirm(words);
  };
  return (
    <span className="bp-foot-group">
      <input
        ref={input}
        className={`bp-foot-input${needed ? ' is-needed' : ''}`}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={busy}
        onChange={(e) => {
          setText(e.target.value);
          if (needed) setNeeded(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            go();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <button type="button" className="btn is-quiet" onClick={onCancel}>Cancel</button>
      <button type="button" className="btn is-primary" disabled={busy} onClick={go}>{confirm}</button>
    </span>
  );
}

/** Asking the person who sent the bill (61t). It holds nothing: Approve stays live. */
function AskBox({
  organizationId,
  billId,
  sender,
  onClose,
  onSent,
}: {
  organizationId: string;
  billId: string;
  sender: { userId: string; name: string; avatarUrl: string | null };
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const toaster = useToaster();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    area.current?.focus();
  }, []);
  const first = firstName(sender.name);
  const send = async () => {
    const question = text.trim();
    if (question.length < 3) {
      area.current?.focus();
      return;
    }
    if (sending) return;
    setSending(true);
    try {
      await billsApi.ask(organizationId, billId, { askedOfUserId: sender.userId, question, aboutFlag: null });
      toaster.show(`Asked ${sender.name}.`);
      await onSent();
      onClose();
    } catch (e) {
      toaster.show(e instanceof Error ? e.message : 'That didn’t go through. Try again.');
    } finally {
      setSending(false);
    }
  };
  return (
    <div
      className="bp-askbox"
      role="dialog"
      aria-label={`Ask ${sender.name}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="bp-askbox-head">
        <Avatar name={sender.name} src={sender.avatarUrl} size={20} />
        <div className="bp-askbox-who">
          <div className="bp-askbox-title">Ask {sender.name}</div>
          <div className="bp-askbox-sub">{first} sent this bill for approval.</div>
        </div>
        <button type="button" className="bp-askbox-x" aria-label="Close" onClick={onClose}>
          <Icon.x size={11} />
        </button>
      </div>
      <div className="bp-askbox-field">
        <textarea
          ref={area}
          value={text}
          placeholder={`What would you like to ask ${first}?`}
          aria-label={`Your question for ${sender.name}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
      </div>
      <div className="bp-askbox-hint">Nothing waits on it: you can still approve while {first} answers.</div>
      <div className="bp-askbox-foot">
        <button type="button" className="btn is-quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="btn is-primary" disabled={sending} onClick={() => void send()}>{sending ? 'Sending…' : 'Send question'}</button>
      </div>
    </div>
  );
}

/** Why the viewer holds the step but can't approve it, in the note on the greyed button. */
function cannotApproveWords(rule: string) {
  if (rule === 'R1') return 'You sent this bill, so someone else approves it.';
  if (rule === 'R2') return 'You entered this bill, so someone else approves it.';
  return 'Someone else has to approve this one.';
}

/** "Tom or Ines", "Tom Whitfield or Ines Volkov", without whoever is left out. */
function namesOf(steps: BillDetailStepNode[], first: boolean, leaveOut?: string | null) {
  const people = steps.filter((s) => s.person && s.person.personId !== leaveOut).map((s) => (first ? firstName(s.person!.name) : s.person!.name));
  const joiner = steps[0]?.mode === 'all' ? 'and' : 'or';
  return people.length <= 1 ? people.join('') : `${people.slice(0, -1).join(', ')} ${joiner} ${people[people.length - 1]}`;
}

function Bar({
  organizationId,
  detail,
  access,
  onChanged,
}: {
  organizationId: string;
  detail: BillDetail;
  access: Access;
  onChanged: () => Promise<void>;
}) {
  const toaster = useToaster();
  const draft = detail.draft;
  const billId = draft.paymentOrderId;
  const [mode, setMode] = useState<null | 'back' | 'take' | 'unwind'>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState(false);
  const askRef = useRef<HTMLSpanElement | null>(null);
  useDismiss(asking, askRef, () => setAsking(false));

  const viewerId = detail.viewer.personId;
  const sender = detail.requester;
  const groups = stepGroups(detail);
  const n = groups.length;
  const at = groups.findIndex((g) => g.steps.some((s) => s.state === 'current'));
  const now = at >= 0 ? groups[at]!.steps : [];
  const next = at >= 0 ? groups[at + 1]?.steps ?? null : null;
  const open = inApproval(detail);
  const asked = takeBackAsked(detail);
  const taskId = detail.viewer.openTaskId;
  const yourTurn = open && !asked && Boolean(taskId);
  const approvedByYou = open && groups.some((g) => g.steps.some((s) => s.state === 'done' && s.person?.personId === viewerId));

  // When the open step opened: the sending, or the last approval before it.
  const sends = [...detail.history.before, ...detail.history.after].filter((h) => h.kind === 'submitted' && h.at);
  const opened = [sends[sends.length - 1]?.at ?? null, ...groups.slice(0, Math.max(at, 0)).flatMap((g) => g.steps.map((s) => s.actedAt))]
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop() ?? null;

  const act = async (run: () => Promise<unknown>, done: string, failed: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
      setMode(null);
      toaster.show(done);
      await onChanged();
    } catch (e) {
      toaster.show(e instanceof Error ? e.message : failed);
    } finally {
      setBusy(false);
    }
  };

  const approve = () => act(() => approvalsApi.actOnTask(organizationId, taskId!, { kind: 'approve' }), 'Approved.', 'It couldn’t be approved. Try again.');
  const sendBack = (reason: string) => act(
    () => approvalsApi.actOnTask(organizationId, taskId!, { kind: 'reject', reason }),
    'Sent back for review.',
    'It couldn’t be sent back. Try again.',
  );
  const takeBack = (reason: string) => {
    if (busy) return;
    setBusy(true);
    void billsApi.requestRecall(organizationId, billId, reason)
      .then(async (r) => {
        setMode(null);
        toaster.show(r.granted ? 'Taken back to review.' : 'Asked. An admin decides.');
        await onChanged();
      })
      .catch((e) => toaster.show(e instanceof Error ? e.message : 'That didn’t go through. Try again.'))
      .finally(() => setBusy(false));
  };
  const unwind = (reason: string) => act(() => billsApi.sendBack(organizationId, billId, reason), 'Sent back to review.', 'It couldn’t be sent back. Try again.');

  const stepNo = n > 1 && at >= 0 ? <> · step <Num>{at + 1}</Num> of <Num>{n}</Num></> : null;
  const withText = now.length > 0
    ? <>With {namesOf(now, false)}{opened ? <> since <When at={opened} /></> : null}{stepNo}</>
    : <>{detail.status.subStatus.text}</>;

  // An admin answers a take-back; the one who asked can withdraw it.
  if (open && asked) {
    if (detail.viewer.isRequester) {
      return (
        <div className="bp-foot">
          <span className="bp-foot-note">You asked to take it back · an admin decides</span>
          <span className="bp-foot-gap" />
          <button
            type="button"
            className="btn is-quiet"
            disabled={busy}
            onClick={() => void act(() => billsApi.withdrawRecall(organizationId, asked.recallRequestId), 'Withdrawn. It stays in approval.', 'That didn’t go through. Try again.')}
          >
            Withdraw
          </button>
        </div>
      );
    }
    return (
      <div className="bp-foot">
        <span className="bp-foot-note" title={asked.reason}>
          {asked.requestedBy} asked to take it back: “{asked.reason}”
        </span>
        <span className="bp-foot-gap" />
        {access.isAdmin ? (
          <span className="bp-foot-group">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void act(() => billsApi.decideRecall(organizationId, asked.recallRequestId, false), 'Kept in approval.', 'That didn’t go through. Try again.')}
            >
              Keep it in approval
            </button>
            <button
              type="button"
              className="btn is-primary"
              disabled={busy}
              onClick={() => void act(() => billsApi.decideRecall(organizationId, asked.recallRequestId, true), 'Back in review.', 'That didn’t go through. Try again.')}
            >
              Give it back
            </button>
          </span>
        ) : <span className="bp-foot-note">An admin decides</span>}
      </div>
    );
  }

  if (yourTurn) {
    const blocked = detail.viewer.cannotApprove;
    const others = namesOf(now, true, viewerId);
    const joiner = now[0]?.mode === 'all' ? 'and' : 'or';
    const stepText = (
      <>
        {n > 1 ? <>Step <Num>{at + 1}</Num> of <Num>{n}</Num></> : 'One step'}
        {' · you'}{others ? ` ${joiner} ${others}` : ''}
        {next ? `, then ${namesOf(next, true)}` : ''}
      </>
    );
    const canAsk = Boolean(sender?.userId && !detail.viewer.isRequester && sender.personId !== viewerId);
    return (
      <div className="bp-foot">
        <span className="bp-foot-gap" />
        {mode === 'back' ? (
          <ReasonEntry
            placeholder={`Why send it back? ${sender?.name ?? 'Whoever reviews it'} will see this.`}
            confirm="Send back"
            busy={busy}
            onCancel={() => setMode(null)}
            onConfirm={(reason) => void sendBack(reason)}
          />
        ) : (
          <span className="bp-foot-group">
            <span className="bp-foot-note">{stepText}</span>
            {canAsk ? (
              <span className="bp-askwrap" ref={askRef}>
                <button type="button" className={`btn is-ask${asking ? ' is-open' : ''}`} aria-expanded={asking} onClick={() => setAsking((v) => !v)}>
                  Ask a question
                </button>
                {asking && sender?.userId ? (
                  <AskBox
                    organizationId={organizationId}
                    billId={billId}
                    sender={{ userId: sender.userId, name: sender.name, avatarUrl: sender.avatarUrl }}
                    onClose={() => setAsking(false)}
                    onSent={onChanged}
                  />
                ) : null}
              </span>
            ) : null}
            <button type="button" className="btn" disabled={busy} onClick={() => setMode('back')}>Send back</button>
            {blocked ? (
              <span className="bp-tipwrap" onMouseEnter={() => setTip(true)} onMouseLeave={() => setTip(false)} onFocus={() => setTip(true)} onBlur={() => setTip(false)}>
                <button type="button" className="btn is-primary" aria-disabled onClick={() => setTip(true)}>Approve</button>
                {tip ? <span className="tip">{cannotApproveWords(blocked.rule)}</span> : null}
              </span>
            ) : (
              <button type="button" className="btn is-primary" disabled={busy} onClick={() => void approve()}>Approve</button>
            )}
          </span>
        )}
      </div>
    );
  }

  if (open) {
    const mayTakeBack = detail.viewer.isRequester && access.canEdit;
    const takeWord = access.isAdmin ? 'Take it back' : 'Ask to take it back';
    return (
      <div className="bp-foot">
        {mode === 'take' ? (
          <>
            <span className="bp-foot-gap" />
            <ReasonEntry
              placeholder={access.isAdmin ? 'Why take it back? It goes back to review.' : 'Why take it back? An admin will see this.'}
              confirm={takeWord}
              busy={busy}
              onCancel={() => setMode(null)}
              onConfirm={takeBack}
            />
          </>
        ) : (
          <>
            <span className="bp-foot-note">
              {approvedByYou && now.length > 0 ? <>You approved it · now with {namesOf(now, false)}</> : withText}
            </span>
            <span className="bp-foot-gap" />
            {mayTakeBack ? <button type="button" className="btn" disabled={busy} onClick={() => setMode('take')}>{takeWord}</button> : null}
          </>
        )}
      </div>
    );
  }

  // Approved and not in QuickBooks yet: an admin can still send it back to be put right.
  const approved = ['approved', 'auto_approved'].includes(detail.approval?.macroState ?? '');
  const mayUnwind = access.isAdmin && draft.state === 'submitted' && approved && (!detail.posting || detail.posting.status === 'failed');
  if (!mayUnwind) return null;
  return (
    <div className="bp-foot">
      <span className="bp-foot-gap" />
      {mode === 'unwind' ? (
        <ReasonEntry
          placeholder="Why send it back? Whoever reviews it will see this."
          confirm="Send back"
          busy={busy}
          onCancel={() => setMode(null)}
          onConfirm={(reason) => void unwind(reason)}
        />
      ) : (
        <button type="button" className="btn" onClick={() => setMode('unwind')}>Send back to review</button>
      )}
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────

export function Record({
  organizationId,
  detail,
  note,
  viewer,
  access,
  onRefetch,
}: {
  organizationId: string;
  detail: BillDetail;
  note: BillCompanionNote | null | undefined;
  viewer: Face;
  access: Access;
  onRefetch: () => Promise<unknown>;
}) {
  const draft = detail.draft;
  const billId = draft.paymentOrderId;
  const toaster = useToaster();
  const queryClient = useQueryClient();
  const [card, setCard] = useState<OpenCard | null>(null);
  const [retrying, setRetrying] = useState(false);

  const fields = useMemo(() => fieldsFrom(draft), [draft]);
  const lines = useMemo(() => linesFrom(draft), [draft]);
  const header = headerOf(detail, fields);
  const closed = draft.state === 'cancelled';
  const nodes = useMemo(() => (closed ? [] : chainOf(detail)), [detail, closed]);
  const yourTurn = inApproval(detail) && !takeBackAsked(detail) && Boolean(detail.viewer.openTaskId);

  const refreshAround = async () => {
    await Promise.all([
      onRefetch(),
      queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] }),
      queryClient.invalidateQueries({ queryKey: ['inbox', organizationId] }),
      queryClient.invalidateQueries({ queryKey: ['bill-note', organizationId, billId] }),
    ]);
  };

  const retrySync = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const { outcome } = await api.syncPaymentOrderAccounting(organizationId, billId);
      toaster.show(outcome === 'synced' ? 'Synced to QuickBooks.' : outcome === 'error' ? 'QuickBooks refused it again.' : 'Nothing was sent to QuickBooks.');
      await refreshAround();
    } catch (e) {
      toaster.show(e instanceof Error ? e.message : 'That didn’t go through. Try again.');
    } finally {
      setRetrying(false);
    }
  };

  const failedSync = detail.posting?.status === 'failed' ? detail.posting : null;
  const lead: Lead = closed ? closedWords(detail)
    : failedSync ? {
      text: `QuickBooks refused it: ${syncProblem(failedSync.error) ?? 'it gave no reason'}.${failedSync.retrying ? ' I’ll try again by itself a few times.' : ''}`,
      working: false,
      at: failedSync.at,
      actions: access.canEdit ? (
        <button type="button" className="bp-pill is-white" disabled={retrying} onClick={() => void retrySync()}>Try again</button>
      ) : null,
    }
    : checkedWords(detail, viewer, yourTurn);

  const total = parseMoney(fields.total?.value);
  const dueDay = fields.dueDate?.value && /^\d{4}-\d{2}-\d{2}/.test(fields.dueDate.value) ? fields.dueDate.value : null;
  const late = dueDay !== null && header.stage !== 'done' && daysPast(dueDay) > 0;
  const number = fields.invoiceNumber?.value.trim() ?? '';
  const vendorName = fields['vendor.name']?.value || draft.vendor.name;
  const chip = header.chip;

  return (
    <>
      <div className="bp-body">
        <div className="bp-panel">
          <div className="bp-head">
            <div style={{ minWidth: 0 }}>
              <h1 className="bp-title">{number || vendorName || 'A bill'}</h1>
              <div className="bp-status">
                <span>{vendorName}</span>
                <span className="bp-dot">·</span>
                <span className="bp-stage">{header.stageText}</span>
                {chip ? (
                  <>
                    <span className="bp-dot">·</span>
                    <span className={`chip ${CHIP_CLASS[chip.tone]}`}>{chip.text}</span>
                  </>
                ) : null}
                {detail.posting && !closed ? (
                  <>
                    <span className="bp-dot">·</span>
                    <QuickBooksTag posting={detail.posting} />
                  </>
                ) : null}
              </div>
            </div>
            <div className="bp-amount">
              {total !== null && total > 0 ? <span className="bp-total">{usd(total)}</span> : null}
              {dueDay ? <span className={`bp-due${late ? ' is-late' : ''}`}>Due <span className="num">{calendarDay(dueDay)}</span></span> : null}
            </div>
          </div>

          <div className="bp-rec">
            <div className="bp-rec-col">
              {closed && detail.closed ? <ClosedBox organizationId={organizationId} detail={detail} />
                : nodes.length > 0 ? <div className="bp-route"><Chain nodes={nodes} /></div>
                : null}
              <Facts detail={detail} />
            </div>
            <div className="bp-rec-col">
              <AgentBox
                organizationId={organizationId}
                detail={detail}
                note={note}
                fields={fields}
                lines={lines}
                viewer={viewer}
                access={access}
                editable={false}
                card={card}
                setCard={setCard}
                onFixTotal={nothing}
                onSaveNow={nothing}
                onChanged={refreshAround}
                lead={lead}
              />
              <History detail={detail} note={note} startOpen />
            </div>
          </div>
        </div>
      </div>
      <Bar organizationId={organizationId} detail={detail} access={access} onChanged={refreshAround} />
    </>
  );
}
