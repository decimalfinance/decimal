// The conversation on a bill, wherever the bill is being looked at.
//
// It lived inside the draft screen, so the people it matters most to could not
// see it: an approver opened a bill and found none of the discussion that led
// to it being sent to them. Same shape as every other bug in this area — one
// thing, implemented on one screen, absent on the other.
//
// Two kinds of message share the stream. A QUESTION names one person and parks
// the bill in request_info until they answer; a COMMENT names nobody and holds
// nothing. That difference is the whole value of the feature — "waiting on
// Zara" is a true statement about a payable rather than a status label — so the
// two are drawn differently and only one of them can be answered.
//
// Threads, not a flat stream, and two levels rather than arbitrary depth: what
// makes this readable is knowing which SUBJECT a remark belongs to. Depth is
// flattened server-side in commentOnBill, so this renders what it is given.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { billsApi, type AskCandidate, type BillDraft } from '../api';
import { Ico } from './icons';
import { useToast } from '../ui/Toast';

type BillComment = BillDraft['comments'][number];
type BillQuestion = BillDraft['questions'][number];

type Thread = {
  id: string;
  at: string;
  head: { kind: 'question'; question: BillQuestion } | { kind: 'comment'; comment: BillComment };
  replies: BillComment[];
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// A stable colour per person, so the same face keeps the same circle down the
// thread. Hue only — saturation and lightness are fixed so nothing comes out
// unreadable against white text.
function tone(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${hash}, 42%, 45%)`;
}

// Time of day for today, "27 Aug" before that. A full date on every line is
// noise when they all happened this afternoon.
function when(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  const sameDay = at.getFullYear() === now.getFullYear()
    && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function BillConversation(props: {
  organizationId: string;
  paymentOrderId: string;
  questions: BillQuestion[];
  comments: BillComment[];
  /** Names a field key the way the form does, so a pill reads like a label. */
  fieldLabel: (key: string) => string;
  /**
   * When the bill went for approval. Drawn as a line across the stream rather
   * than splitting it in two: a thread can start in draft and be replied to
   * after submission, and cutting the conversation there would tear it apart to
   * answer a question the reader can answer by looking.
   */
  submittedAt?: string | null;
  /** Live tick state, on the screen where fields can be ticked. */
  fieldStates?: Record<string, { state: string }>;
  /** Said above the composer when a flag a question came from is now settled. */
  flagSettledNote?: (question: BillQuestion) => string | null;
  readOnly?: boolean;
  onHoverQuestion?: (billQuestionId: string | null) => void;
  onChanged: () => void;
}) {
  const {
    organizationId, paymentOrderId, questions, comments, fieldLabel,
    submittedAt, fieldStates, flagSettledNote, readOnly, onHoverQuestion, onChanged,
  } = props;
  const toast = useToast();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState<Thread | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [answerFor, setAnswerFor] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [answering, setAnswering] = useState(false);
  const [settledFields, setSettledFields] = useState<string[]>([]);
  const [forwardTo, setForwardTo] = useState('');

  const candidates = useQuery({
    queryKey: ['ask-candidates', organizationId, paymentOrderId, null],
    queryFn: () => billsApi.askCandidates(organizationId, paymentOrderId),
    enabled: answerFor !== null,
  });

  const threads = useMemo(() => {
    const byId = new Map<string, Thread>();
    const order: string[] = [];
    const root = (id: string, at: string, head: Thread['head']) => {
      if (!byId.has(id)) { byId.set(id, { id, at, head, replies: [] }); order.push(id); }
      return byId.get(id)!;
    };
    for (const q of questions) root(q.billQuestionId, q.askedAt, { kind: 'question', question: q });
    for (const c of comments) {
      const parentId = c.inReplyToQuestionId ?? c.inReplyToCommentId;
      const parent = parentId ? byId.get(parentId) : null;
      // A reply whose root is not here — deleted, or out of order — stands on
      // its own rather than vanishing.
      if (parent) parent.replies.push(c);
      else root(c.billCommentId, c.at, { kind: 'comment', comment: c });
    }
    return order.map((id) => byId.get(id)!)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [questions, comments]);

  const isOpen = (t: Thread) => expanded[t.id]
    ?? (t.head.kind === 'question' ? t.head.question.stillOpen : true);

  const sendComment = async () => {
    if (commentText.trim().length < 1 || commenting) return;
    setCommenting(true);
    try {
      await billsApi.comment(organizationId, paymentOrderId, {
        body: commentText.trim(),
        inReplyToQuestionId: replyTo?.head.kind === 'question' ? replyTo.head.question.billQuestionId : null,
        inReplyToCommentId: replyTo?.head.kind === 'comment' ? replyTo.head.comment.billCommentId : null,
      });
      onChanged();
      setCommentText('');
      setReplyTo(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Try again.', 'Could not send that');
    } finally {
      setCommenting(false);
    }
  };

  const sendAnswer = async (
    q: BillQuestion,
    outcome: 'answered' | 'partial' | 'handed_back' | 'forwarded',
  ) => {
    if (answerText.trim().length < 1) return;
    if (outcome === 'forwarded' && !forwardTo) return;
    setAnswering(true);
    try {
      await billsApi.answerQuestion(organizationId, paymentOrderId, q.billQuestionId, {
        answer: answerText.trim(),
        outcome,
        resolvedFields: outcome === 'answered' ? q.openFields : settledFields,
        forwardTo: outcome === 'forwarded' ? { userId: forwardTo, question: answerText.trim() } : null,
      });
      onChanged();
      setAnswerFor(null);
      setAnswerText('');
      setSettledFields([]);
      setForwardTo('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Try again.', 'Could not send that');
    } finally {
      setAnswering(false);
    }
  };

  // Where the line goes: after the last thread that started before submission.
  const submittedTime = submittedAt ? new Date(submittedAt).getTime() : null;

  return (
    <div className="bthread">
      {threads.map((t, i) => {
        const open = isOpen(t);
        const q = t.head.kind === 'question' ? t.head.question : null;
        const answered = q?.outcome === 'answered';
        const named = q ? (q.openFields.length ? q.openFields : q.highlightFields) : [];
        const author = q ? q.askedByName : t.head.kind === 'comment' ? t.head.comment.authorName : '';
        const prior = i === 0 ? null : threads[i - 1]!;
        const crossesSubmission = submittedTime !== null
          && new Date(t.at).getTime() >= submittedTime
          && (prior === null || new Date(prior.at).getTime() < submittedTime);
        return (
          <div key={t.id}>
            {crossesSubmission ? (
              <div className="bt-divider"><span>Sent for approval · {when(submittedAt!)}</span></div>
            ) : null}
            <div
              className="bt-thread"
              onMouseEnter={() => q && onHoverQuestion?.(q.billQuestionId)}
              onMouseLeave={() => onHoverQuestion?.(null)}
            >
              <div className="bt-msg">
                <span className="bt-av" style={{ background: tone(author) }}>{initials(author)}</span>
                <div className="bt-col">
                  <div className="bt-who">
                    <strong>{author}</strong>
                    {q ? (
                      <>
                        <span>asked</span>
                        <strong>{q.askedOfName}</strong>
                        <span className={`pill pill-min ${answered ? 'pill-success' : 'pill-warning'}`}>
                          <span className="dot" />
                          {answered ? `${q.askedOfName.split(' ')[0]} answered`
                            : q.outcome === 'partial' ? 'Partly answered'
                            : q.outcome === 'forwarded' ? 'Passed on'
                            : q.outcome === 'handed_back' ? `${q.askedOfName.split(' ')[0]} could not answer`
                            : `Waiting on ${q.askedOfName.split(' ')[0]}`}
                        </span>
                      </>
                    ) : null}
                    <span className="bt-when">{when(t.at)}</span>
                    <span style={{ flex: 1 }} />
                    <button type="button" className="btn btn-ghost btn-icon btn-sm"
                      aria-expanded={open}
                      aria-label={open ? 'Collapse this thread' : 'Expand this thread'}
                      onClick={() => setExpanded({ ...expanded, [t.id]: !open })}>
                      <Ico.chevDown w={13} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 120ms' }} />
                    </button>
                  </div>

                  <div className={q ? `bt-bubble is-question${q.stillOpen ? ' is-waiting' : ''}` : 'bt-bubble'}>
                    {q ? q.question : t.head.kind === 'comment' ? t.head.comment.body : null}
                    {open && named.length > 0 ? (
                      <div className="bt-fields">
                        {named.map((f) => (
                          <span key={f} className="pill pill-min pill-neutral">{fieldLabel(f)}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {!open && t.replies.length > 0 ? (
                    <button type="button" className="bt-more"
                      onClick={() => setExpanded({ ...expanded, [t.id]: true })}>
                      {t.replies.length} {t.replies.length === 1 ? 'reply' : 'replies'}
                    </button>
                  ) : null}

                  {open ? (
                    <>
                      {/* The answer, spoken by whoever gave it. The name is not
                          repeated here: a settlement writes the actor into the
                          sentence itself, so prefixing it produced "Zara: Zara
                          Okafor checked the fields you asked about". */}
                      {q?.answer ? <div className="bt-note">“{q.answer}”</div> : null}

                      {q && fieldStates ? (() => {
                        if (!q.stillOpen || q.openFields.length === 0) return null;
                        const checked = q.openFields.filter((f) => fieldStates[f]?.state === 'confirmed');
                        if (checked.length === 0) return null;
                        return (
                          <div className="bt-note">
                            {checked.length === q.openFields.length
                              ? `You have checked all ${q.openFields.length} fields. Save the bill and that goes back as your answer.`
                              : `You have checked ${checked.length} of ${q.openFields.length}. Saving sends what you have done so far.`}
                          </div>
                        );
                      })() : null}

                      {q && flagSettledNote?.(q) ? (
                        <div className="bt-note">{flagSettledNote(q)}</div>
                      ) : null}

                      {t.replies.length > 0 ? (
                        <div className="bt-replies">
                          {t.replies.map((r) => (
                            <div key={r.billCommentId} className="bt-msg">
                              <span className="bt-av is-sm" style={{ background: tone(r.authorName) }}>
                                {initials(r.authorName)}
                              </span>
                              <div className="bt-col">
                                <div className="bt-who">
                                  <strong>{r.authorName}</strong>
                                  <span className="bt-when">{when(r.at)}</span>
                                </div>
                                <div className="bt-bubble">{r.body}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {q && q.youWereAsked && answerFor === q.billQuestionId ? (
                        <AnswerBox
                          question={q}
                          named={named}
                          fieldLabel={fieldLabel}
                          text={answerText}
                          setText={setAnswerText}
                          settled={settledFields}
                          setSettled={setSettledFields}
                          forwardTo={forwardTo}
                          setForwardTo={setForwardTo}
                          candidates={candidates.data?.candidates ?? []}
                          busy={answering}
                          onSend={(outcome) => void sendAnswer(q, outcome)}
                          onCancel={() => { setAnswerFor(null); setAnswerText(''); setSettledFields([]); setForwardTo(''); }}
                        />
                      ) : !readOnly ? (
                        <div className="bt-actions">
                          {q?.youWereAsked ? (
                            <button type="button" className="btn btn-secondary btn-sm"
                              onClick={() => { setAnswerFor(q.billQuestionId); setAnswerText(''); setSettledFields([]); setForwardTo(''); }}>
                              Answer
                            </button>
                          ) : null}
                          {/* Open to everybody, the asker included. Helping is
                              not releasing the bill. */}
                          <button type="button" className="btn btn-ghost btn-sm"
                            onClick={() => { setReplyTo(t); setCommentText(''); }}>
                            Reply
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {/* Nothing said yet, and somewhere to say the first thing. */}
      {threads.length === 0 && readOnly ? (
        <div className="bt-note">Nothing has been asked or said about this bill.</div>
      ) : null}

      {!readOnly ? (
        <div className="bt-composer">
          <input
            className="input"
            value={commentText}
            placeholder={replyTo
              ? `Reply to ${replyTo.head.kind === 'question' ? replyTo.head.question.askedByName : replyTo.head.comment.authorName}…`
              : 'Say something about this bill…'}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void sendComment(); }}
            style={{ height: 32 }}
          />
          {replyTo ? (
            <button type="button" className="btn btn-ghost btn-sm"
              onClick={() => { setReplyTo(null); setCommentText(''); }}>
              Cancel reply
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary btn-sm"
            disabled={commenting || commentText.trim().length < 1}
            onClick={() => void sendComment()}>
            {commenting ? 'Sending…' : 'Send'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Answering: the one act in this thread that releases the bill.
function AnswerBox(props: {
  question: BillQuestion;
  named: string[];
  fieldLabel: (key: string) => string;
  text: string;
  setText: (v: string) => void;
  settled: string[];
  setSettled: (v: string[]) => void;
  forwardTo: string;
  setForwardTo: (v: string) => void;
  candidates: AskCandidate[];
  busy: boolean;
  onSend: (outcome: 'answered' | 'partial' | 'handed_back' | 'forwarded') => void;
  onCancel: () => void;
}) {
  const { question: q, named, fieldLabel, text, setText, settled, setSettled,
    forwardTo, setForwardTo, candidates, busy, onSend, onCancel } = props;
  const empty = text.trim().length < 1;
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <textarea className="input" autoFocus rows={2}
        style={{ resize: 'vertical', minHeight: 56, lineHeight: 1.5 }}
        placeholder={`Answer ${q.askedByName.split(' ')[0]}…`}
        value={text} onChange={(e) => setText(e.target.value)} />

      {named.length > 0 ? (
        <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-muted)' }}>
          {named.map((f) => (
            <label key={f} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <input type="checkbox" checked={settled.includes(f)}
                onChange={() => setSettled(settled.includes(f) ? settled.filter((k) => k !== f) : [...settled, f])} />
              {fieldLabel(f)}
            </label>
          ))}
        </span>
      ) : null}

      <span className="bt-actions">
        <select className="input" value={forwardTo} onChange={(e) => setForwardTo(e.target.value)}
          style={{ flex: '0 0 190px', height: 32 }}>
          <option value="">Pass to…</option>
          {candidates.filter((c) => c.userId !== q.askedByUserId).map((c) => (
            <option key={c.userId} value={c.userId}>{c.name}</option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || empty}
          title="You could not answer it — it goes back to them, still open."
          onClick={() => onSend('handed_back')}>
          Can't answer
        </button>
        {forwardTo ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || empty}
            onClick={() => onSend('forwarded')}>Pass it on</button>
        ) : null}
        {/* Partial only when they named fields and this settles some but not all
            of them — otherwise it is just an answer, and offering both would
            make somebody choose between synonyms. */}
        {named.length > 0 && settled.length > 0 && settled.length < named.length ? (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || empty}
            onClick={() => onSend('partial')}>{busy ? 'Sending…' : 'Answer what I can'}</button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || empty}
            onClick={() => onSend('answered')}>{busy ? 'Sending…' : 'Send answer'}</button>
        )}
      </span>
    </div>
  );
}
